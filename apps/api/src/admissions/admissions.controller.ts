import { Body, Controller, Get, NotFoundException, Param, Post, Query, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, campusScope, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { randomToken, sha256 } from '../common/crypto';

const createApp = z.object({
  campusId: uuid, academicYearId: uuid, gradeLevelId: uuid,
  applicantFirstName: z.string().min(1).max(100), applicantLastName: z.string().min(1).max(100),
  applicantDob: z.string().date(), applicantGender: z.string().max(20).optional(),
  guardianName: z.string().min(1).max(200), guardianEmail: z.string().email(), guardianPhone: z.string().max(30).optional(),
  guardianRelationship: z.string().max(50).default('parent'),
  residencePreference: z.enum(['boarder', 'day_scholar']).default('day_scholar'),
});
const transition = z.object({ to: z.enum(['under_review', 'waitlisted', 'offered', 'accepted', 'rejected', 'withdrawn']), note: z.string().max(1000).optional() });
const enrollSchema = z.object({ sectionId: uuid, effectiveFrom: z.string().date().optional() });

const TRANSITIONS: Record<string, string[]> = {
  submitted: ['under_review', 'rejected', 'withdrawn'],
  under_review: ['waitlisted', 'offered', 'rejected', 'withdrawn'],
  waitlisted: ['offered', 'rejected', 'withdrawn'],
  offered: ['accepted', 'rejected', 'withdrawn'],
  accepted: ['withdrawn'],
};

@Controller('admissions')
export class AdmissionsController {
  constructor(private db: DbService) {}

  @Post()
  create(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(createApp, body);
    needs(a, 'admissions.write', b.campusId);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [r] } = await tx.query(
        `insert into admission_applications(tenant_id, campus_id, academic_year_id, grade_level_id, applicant_first_name, applicant_last_name, applicant_dob, applicant_gender, guardian_name, guardian_email, guardian_phone, guardian_relationship, residence_preference, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
        [a.tenantId, b.campusId, b.academicYearId, b.gradeLevelId, b.applicantFirstName, b.applicantLastName, b.applicantDob, b.applicantGender ?? null, b.guardianName, b.guardianEmail, b.guardianPhone ?? null, b.guardianRelationship, b.residencePreference, a.userId]);
      await audit(tx, a, a.tenantId, 'admission.create', 'admission_application', r.id, b.campusId);
      return r;
    });
  }

  @Get()
  list(@Auth() a: AuthContext, @Query('status') status?: string, @Query('limit') limit = '50', @Query('offset') offset = '0') {
    needs(a, 'admissions.read');
    const scope = campusScope(a, 'admissions.read');
    const lim = Math.min(Math.max(parseInt(limit) || 50, 1), 200), off = Math.max(parseInt(offset) || 0, 0);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select * from admission_applications where ($1::uuid[] is null or campus_id = any($1)) and ($2::text is null or status = $2) order by created_at desc limit $3 offset $4`,
      [scope, status ?? null, lim, off])).rows);
  }

  @Post(':id/transition')
  transition(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(transition, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const app = await this.load(tx, id);
      needs(a, 'admissions.decide', app.campus_id);
      if (!TRANSITIONS[app.status]?.includes(b.to)) throw new ConflictException({ error: 'invalid_transition', from: app.status, to: b.to });
      const { rows: [r] } = await tx.query('update admission_applications set status = $2, decision_note = coalesce($3, decision_note), updated_at = now() where id = $1 returning *', [id, b.to, b.note ?? null]);
      await audit(tx, a, a.tenantId, 'admission.transition', 'admission_application', id, app.campus_id, { from: app.status, to: b.to });
      return r;
    });
  }

  /**
   * Accepted application -> student identity, guardian, parent account, enrollment,
   * residence assignment and LMS course access, in one transaction.
   */
  @Post(':id/enroll')
  enroll(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(enrollSchema, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const app = await this.load(tx, id);
      needs(a, 'admissions.enroll', app.campus_id);
      if (app.status === 'enrolled') throw new ConflictException({ error: 'already_enrolled', studentId: app.student_id });
      if (app.status !== 'accepted') throw new ConflictException({ error: 'not_accepted', status: app.status });

      const { rows: [sec] } = await tx.query('select * from sections where id = $1 for update', [b.sectionId]);
      if (!sec || sec.campus_id !== app.campus_id || sec.academic_year_id !== app.academic_year_id || sec.grade_level_id !== app.grade_level_id)
        throw new UnprocessableEntityException({ error: 'section_mismatch' });
      const { rows: [{ n }] } = await tx.query('select count(*)::int as n from enrollments where section_id = $1 and effective_to is null', [sec.id]);
      if (n >= sec.capacity) throw new ConflictException({ error: 'section_full' });

      const { rows: [campus] } = await tx.query('select is_boarding from campuses where id = $1', [app.campus_id]);
      if (app.residence_preference === 'boarder' && !campus.is_boarding) throw new UnprocessableEntityException({ error: 'campus_has_no_boarding' });

      const { rows: [seq] } = await tx.query('update document_sequences set next_value = next_value + 1 where key = $1 returning prefix, next_value - 1 as v', ['student_admission_no']);
      const admissionNo = `${seq.prefix}${String(seq.v).padStart(5, '0')}`;
      const from = b.effectiveFrom ?? new Date().toISOString().slice(0, 10);

      const { rows: [st] } = await tx.query(
        `insert into students(tenant_id, campus_id, admission_no, first_name, last_name, date_of_birth, gender) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [a.tenantId, app.campus_id, admissionNo, app.applicant_first_name, app.applicant_last_name, app.applicant_dob, app.applicant_gender]);

      // Guardian + parent account (reuse for siblings).
      let { rows: [g] } = await tx.query('select id, user_id from guardians where email = $1', [app.guardian_email]);
      let inviteToken: string | null = null;
      if (!g) {
        let { rows: [u] } = await tx.query('select id from users where email = $1', [app.guardian_email]);
        if (!u) {
          inviteToken = randomToken();
          ({ rows: [u] } = await tx.query(`insert into users(tenant_id, email, full_name, status, invite_token_hash, invite_expires_at) values ($1,$2,$3,'invited',$4, now() + interval '7 days') returning id`,
            [a.tenantId, app.guardian_email, app.guardian_name, sha256(inviteToken)]));
          await tx.query(`insert into user_roles(tenant_id, user_id, role_id) select $1, $2, id from roles where key = 'parent'`, [a.tenantId, u.id]);
        }
        ({ rows: [g] } = await tx.query('insert into guardians(tenant_id, user_id, full_name, phone, email) values ($1,$2,$3,$4,$5) returning id, user_id', [a.tenantId, u.id, app.guardian_name, app.guardian_phone, app.guardian_email]));
      }
      await tx.query('insert into student_guardians(tenant_id, student_id, guardian_id, relationship, is_primary, can_pickup) values ($1,$2,$3,$4,true,true)', [a.tenantId, st.id, g.id, app.guardian_relationship]);

      await tx.query('insert into enrollments(tenant_id, student_id, section_id, academic_year_id, effective_from) values ($1,$2,$3,$4,$5)', [a.tenantId, st.id, sec.id, sec.academic_year_id, from]);
      await tx.query('insert into residence_assignments(tenant_id, student_id, residence_type, effective_from) values ($1,$2,$3,$4)', [a.tenantId, st.id, app.residence_preference, from]);
      await tx.query('insert into course_enrollments(tenant_id, course_id, student_id) select $1, c.id, $2 from courses c where c.section_id = $3', [a.tenantId, st.id, sec.id]);
      await tx.query(`update admission_applications set status = 'enrolled', student_id = $2, updated_at = now() where id = $1`, [id, st.id]);
      await audit(tx, a, a.tenantId, 'admission.enroll', 'student', st.id, app.campus_id, { applicationId: id, sectionId: sec.id, admissionNo });
      return {
        studentId: st.id, admissionNo, guardianId: g.id,
        parentInviteToken: inviteToken,
        notice: inviteToken ? 'Email delivery is not configured; deliver the invite token to the parent securely.' : undefined,
      };
    });
  }

  private async load(tx: Tx, id: string) {
    const { rows: [app] } = await tx.query('select * from admission_applications where id = $1 for update', [id]);
    if (!app) throw new NotFoundException({ error: 'not_found' });
    return app;
  }
}
