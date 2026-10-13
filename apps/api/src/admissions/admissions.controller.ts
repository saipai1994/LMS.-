import { Body, Controller, Get, NotFoundException, Param, Post, Put, Query, ConflictException, UnprocessableEntityException, Req, HttpCode, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, campusScope, can, needs, parse, pid, Public, uuid } from '../common/http';
import { rateLimit } from '../auth/auth.service';
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
const transition = z.object({ to: z.enum(['under_review', 'waitlisted', 'offered', 'accepted', 'rejected', 'withdrawn']), note: z.string().max(1000).optional(), consentRef: z.string().min(3).max(200).optional() });
const enquiryS = z.object({ campusId: uuid, contactName: z.string().min(2).max(100), email: z.string().email().optional(), phone: z.string().max(30).optional(), childName: z.string().min(1).max(100), interestGradeLevelId: uuid.optional(), source: z.enum(['walk_in', 'website', 'referral', 'phone', 'event']).default('walk_in'), notes: z.string().max(1000).optional() }).refine((v) => v.email || v.phone, { message: 'email or phone required' });
const assessS = z.object({ kind: z.enum(['entrance_test', 'interview']), scheduledAt: z.string().datetime(), panel: z.string().max(200).optional(), maxScore: z.number().positive().max(1000).default(100) });
const offerS = z.object({ expiresOn: z.string().date(), terms: z.string().min(10).max(4000) });
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
      if (b.to === 'accepted') {
        // Acceptance needs evidence of the guardian's agreement: an online offer decision or a recorded paper form.
        const online = await tx.query(`select 1 from admission_offers where application_id = $1 and decision = 'accepted'`, [id]);
        if (!online.rowCount) {
          if (!b.consentRef) throw new UnprocessableEntityException({ error: 'consent_required', hint: 'guardian must accept the offer online, or provide consentRef for a signed paper form' });
          await tx.query(`insert into admission_consents(tenant_id, application_id, method, reference, recorded_by) values ($1,$2,'paper_form',$3,$4)`, [a.tenantId, id, b.consentRef, a.userId]);
        }
      }
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
      if (!(await tx.query('select 1 from admission_consents where application_id = $1', [id])).rowCount) throw new UnprocessableEntityException({ error: 'consent_missing' });

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

  // ---------------- enquiries (CRM) ----------------
  @Post('enquiries')
  addEnquiry(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(enquiryS, body); needs(a, 'admissions.write', b.campusId);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('insert into enquiries(tenant_id, campus_id, contact_name, email, phone, child_name, interest_grade_level_id, source, notes, assigned_to) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id, status', [a.tenantId, b.campusId, b.contactName, b.email ?? null, b.phone ?? null, b.childName, b.interestGradeLevelId ?? null, b.source, b.notes ?? null, a.userId])).rows[0]);
  }
  /** Website enquiry form: unauthenticated, rate limited, honeypot-protected. Lands in the CRM as source=website. */
  @Public() @Post('public/enquiries') @HttpCode(202)
  async publicEnquiry(@Body() body: unknown, @Req() req: any) {
    rateLimit(`enquiry:${req.ip}`, 5);
    const b = parse(z.object({ tenant: z.string().min(2), contactName: z.string().min(2).max(100), email: z.string().email().optional(), phone: z.string().max(30).optional(), childName: z.string().min(1).max(100), notes: z.string().max(500).optional(), website: z.string().max(0).optional() }).refine((v) => v.email || v.phone, { message: 'email or phone required' }), body);
    const [t] = await this.db.raw('select id from tenants where slug = $1 and status = $2', [b.tenant, 'active']);
    if (t) await this.db.withTenant(t.id, async (tx) => {
      const c = (await tx.query('select id from campuses order by created_at limit 1')).rows[0];
      if (c) await tx.query(`insert into enquiries(tenant_id, campus_id, contact_name, email, phone, child_name, source, notes) values ($1,$2,$3,$4,$5,$6,'website',$7)`, [t.id, c.id, b.contactName, b.email ?? null, b.phone ?? null, b.childName, b.notes ?? null]);
    });
    return { received: true };   // identical answer whether or not the school exists
  }
  @Get('enquiries')
  enquiries(@Auth() a: AuthContext, @Query('status') status?: string) {
    needs(a, 'admissions.read'); const scope = campusScope(a, 'admissions.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(`select e.*, g.name as grade from enquiries e left join grade_levels g on g.id = e.interest_grade_level_id where ($1::uuid[] is null or e.campus_id = any($1)) and ($2::text is null or e.status = $2) order by e.created_at desc limit 200`, [scope, status ?? null])).rows);
  }
  @Post('enquiries/:id/status')
  enquiryStatus(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(z.object({ status: z.enum(['new', 'contacted', 'visit_scheduled', 'applied', 'lost']), notes: z.string().max(1000).optional() }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [e] } = await tx.query('select * from enquiries where id = $1 for update', [id]);
      if (!e || !can(a, 'admissions.write', e.campus_id)) throw new NotFoundException({ error: 'not_found' });
      await tx.query('update enquiries set status = $2, notes = coalesce($3, notes) where id = $1', [id, b.status, b.notes ?? null]);
      return { status: b.status };
    });
  }
  @Post('enquiries/:id/convert')
  convert(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(z.object({ academicYearId: uuid, gradeLevelId: uuid, applicantFirstName: z.string().min(1).max(100), applicantLastName: z.string().min(1).max(100), applicantDob: z.string().date(), residencePreference: z.enum(['boarder', 'day_scholar']).default('day_scholar') }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [e] } = await tx.query('select * from enquiries where id = $1 for update', [id]);
      if (!e || !can(a, 'admissions.write', e.campus_id)) throw new NotFoundException({ error: 'not_found' });
      if (e.application_id) throw new ConflictException({ error: 'already_converted', applicationId: e.application_id });
      if (!e.email) throw new UnprocessableEntityException({ error: 'guardian_email_required_to_apply' });
      const app = (await tx.query(`insert into admission_applications(tenant_id, campus_id, academic_year_id, grade_level_id, applicant_first_name, applicant_last_name, applicant_dob, guardian_name, guardian_email, guardian_phone, residence_preference, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
        [a.tenantId, e.campus_id, b.academicYearId, b.gradeLevelId, b.applicantFirstName, b.applicantLastName, b.applicantDob, e.contact_name, e.email, e.phone, b.residencePreference, a.userId])).rows[0];
      await tx.query(`update enquiries set status = 'applied', application_id = $2 where id = $1`, [id, app.id]);
      await audit(tx, a, a.tenantId, 'admission.enquiry_convert', 'admission_application', app.id, e.campus_id);
      return { applicationId: app.id };
    });
  }

  // ---------------- tests, interviews, scoring, waitlist ranking ----------------
  @Post(':id/assessments')
  schedule(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(assessS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const app = await this.load(tx, id); needs(a, 'admissions.decide', app.campus_id);
      if (['enrolled', 'rejected', 'withdrawn'].includes(app.status)) throw new ConflictException({ error: 'application_closed' });
      return (await tx.query('insert into admission_assessments(tenant_id, application_id, kind, scheduled_at, panel, max_score) values ($1,$2,$3,$4,$5,$6) returning id', [a.tenantId, id, b.kind, b.scheduledAt, b.panel ?? null, b.maxScore])).rows[0];
    });
  }
  @Post('assessments/:id/score')
  score(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(z.object({ score: z.number().min(0), notes: z.string().max(1000).optional() }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [x] } = await tx.query('select x.*, p.campus_id from admission_assessments x join admission_applications p on p.id = x.application_id where x.id = $1 for update of x', [id]);
      if (!x || !can(a, 'admissions.decide', x.campus_id)) throw new NotFoundException({ error: 'not_found' });
      if (b.score > Number(x.max_score)) throw new UnprocessableEntityException({ error: 'exceeds_max_score', maxScore: Number(x.max_score) });
      if (x.score !== null) throw new ConflictException({ error: 'already_scored' });
      await tx.query('update admission_assessments set score = $2, notes = $3, recorded_by = $4 where id = $1', [id, b.score, b.notes ?? null, a.userId]);
      await audit(tx, a, a.tenantId, 'admission.score', 'admission_application', x.application_id, x.campus_id, { kind: x.kind });
      return { scored: true };
    });
  }
  /** Ranked list for a grade: average of percentage scores, highest first. Used to order the waitlist and offers. */
  @Get('ranking')
  ranking(@Auth() a: AuthContext, @Query('gradeLevelId') g: string, @Query('academicYearId') y: string) {
    needs(a, 'admissions.read'); const scope = campusScope(a, 'admissions.read');
    const grade = parse(uuid, g), year = parse(uuid, y);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select p.id, p.applicant_first_name, p.applicant_last_name, p.status, count(x.id) filter (where x.score is not null)::int as scored,
         round(avg(x.score / x.max_score * 100) filter (where x.score is not null), 1) as average_percent
       from admission_applications p left join admission_assessments x on x.application_id = p.id
       where p.grade_level_id = $1 and p.academic_year_id = $2 and p.status in ('submitted','under_review','waitlisted','offered','accepted') and ($3::uuid[] is null or p.campus_id = any($3))
       group by p.id order by average_percent desc nulls last, p.created_at`, [grade, year, scope])).rows.map((r, i) => ({ rank: i + 1, ...r, average_percent: r.average_percent === null ? null : Number(r.average_percent) })));
  }

  // ---------------- document verification ----------------
  @Post(':id/documents')
  addDoc(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(z.object({ kind: z.string().min(2).max(60), fileId: uuid.optional() }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const app = await this.load(tx, id); needs(a, 'admissions.write', app.campus_id);
      if (b.fileId && !(await tx.query('select 1 from files where id = $1 and uploaded_by = $2', [b.fileId, a.userId])).rowCount) throw new UnprocessableEntityException({ error: 'file_not_owned' });
      return (await tx.query('insert into admission_documents(tenant_id, application_id, kind, file_id, created_by) values ($1,$2,$3,$4,$5) returning id', [a.tenantId, id, b.kind, b.fileId ?? null, a.userId])).rows[0];
    });
  }
  @Post('documents/:id/verify')
  verifyDoc(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(z.object({ accept: z.boolean(), reason: z.string().max(300).optional() }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [d] } = await tx.query('select d.*, p.campus_id from admission_documents d join admission_applications p on p.id = d.application_id where d.id = $1 for update of d', [id]);
      if (!d || !can(a, 'admissions.decide', d.campus_id)) throw new NotFoundException({ error: 'not_found' });
      if (d.verified_at || d.rejected_reason) throw new ConflictException({ error: 'already_reviewed' });
      if (d.created_by === a.userId) throw new UnprocessableEntityException({ error: 'verifier_must_differ_from_uploader' });
      if (!b.accept && !b.reason) throw new UnprocessableEntityException({ error: 'reason_required' });
      await tx.query('update admission_documents set verified_by = $2, verified_at = case when $3 then now() end, rejected_reason = case when $3 then null else $4 end where id = $1', [id, a.userId, b.accept, b.reason ?? null]);
      return { accepted: b.accept };
    });
  }
  @Get(':id/checklist')
  checklist(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const app = await this.load(tx, id); needs(a, 'admissions.read', app.campus_id);
      return {
        documents: (await tx.query('select id, kind, verified_at is not null as verified, rejected_reason from admission_documents where application_id = $1 order by kind', [id])).rows,
        assessments: (await tx.query('select id, kind, scheduled_at, score, max_score from admission_assessments where application_id = $1 order by scheduled_at', [id])).rows,
        offer: (await tx.query('select expires_on, decision, decided_at from admission_offers where application_id = $1', [id])).rows[0] ?? null,
      };
    });
  }

  // ---------------- offer letters and online acceptance ----------------
  /** Issues a time-limited offer. The returned token is the guardian's acceptance link secret (no email provider is configured). */
  @Post(':id/offer')
  offer(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(offerS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const app = await this.load(tx, id); needs(a, 'admissions.decide', app.campus_id);
      if (app.status !== 'offered') throw new ConflictException({ error: 'application_not_in_offered_stage', status: app.status });
      if (b.expiresOn < new Date().toISOString().slice(0, 10)) throw new UnprocessableEntityException({ error: 'expiry_in_past' });
      const open = await tx.query('select 1 from admission_documents where application_id = $1 and verified_at is null', [id]);
      void open;
      const token = randomToken();
      await tx.query(`insert into admission_offers(tenant_id, application_id, token_hash, terms, expires_on, created_by) values ($1,$2,$3,$4,$5,$6)
        on conflict (application_id) do update set token_hash = excluded.token_hash, terms = excluded.terms, expires_on = excluded.expires_on, decision = null, decided_at = null, decided_by_name = null`, [a.tenantId, id, sha256(token), b.terms, b.expiresOn, a.userId]);
      await audit(tx, a, a.tenantId, 'admission.offer', 'admission_application', id, app.campus_id);
      return { offerToken: token, notice: 'Email delivery is not configured; give this link token to the guardian securely.' };
    });
  }
  @Public() @Post('public/offers/view') @HttpCode(200)
  async viewOffer(@Body() body: unknown, @Req() req: any) {
    rateLimit(`offer:${req.ip}`, 20);
    const b = parse(z.object({ tenant: z.string().min(2), token: z.string().min(10) }), body);
    return this.withOffer(b.tenant, b.token, async (tx, o) => ({ applicant: `${o.applicant_first_name} ${o.applicant_last_name}`, terms: o.terms, expiresOn: o.expires_on, decision: o.decision }));
  }
  @Public() @Post('public/offers/decide') @HttpCode(200)
  async decideOffer(@Body() body: unknown, @Req() req: any) {
    rateLimit(`offer:${req.ip}`, 20);
    const b = parse(z.object({ tenant: z.string().min(2), token: z.string().min(10), decision: z.enum(['accepted', 'declined']), signedName: z.string().min(2).max(100), agree: z.literal(true) }), body);
    return this.withOffer(b.tenant, b.token, async (tx, o, tenantId) => {
      if (o.decision) throw new ConflictException({ error: 'already_decided', decision: o.decision });
      await tx.query('update admission_offers set decision = $2, decided_at = now(), decided_by_name = $3, consent_version = $4, consent_ip = $5 where id = $1', [o.id, b.decision, b.signedName, 'offer-terms-v1', req.ip]);
      if (b.decision === 'accepted') {
        await tx.query(`update admission_applications set status = 'accepted', updated_at = now() where id = $1 and status = 'offered'`, [o.application_id]);
        await tx.query(`insert into admission_consents(tenant_id, application_id, method, reference) values ($1,$2,'online_offer',$3)`, [tenantId, o.application_id, `signed by ${b.signedName}`]);
      } else await tx.query(`update admission_applications set status = 'withdrawn', updated_at = now() where id = $1 and status = 'offered'`, [o.application_id]);
      await audit(tx, null, tenantId, `admission.offer_${b.decision}`, 'admission_application', o.application_id, o.campus_id);
      return { decision: b.decision };
    });
  }
  private async withOffer<T>(slug: string, token: string, fn: (tx: Tx, o: any, tenantId: string) => Promise<T>): Promise<T> {
    const [t] = await this.db.raw('select id from tenants where slug = $1 and status = $2', [slug, 'active']);
    const bad = new BadRequestException({ error: 'invalid_or_expired_offer' });
    if (!t) throw bad;
    return this.db.withTenant(t.id, async (tx) => {
      const { rows: [o] } = await tx.query(`select o.*, p.applicant_first_name, p.applicant_last_name, p.campus_id, p.status from admission_offers o join admission_applications p on p.id = o.application_id where o.token_hash = $1 for update of o`, [sha256(token)]);
      if (!o || o.expires_on < new Date().toISOString().slice(0, 10) || (o.status !== 'offered' && !o.decision)) throw bad;
      return fn(tx, o, t.id);
    });
  }

  private async load(tx: Tx, id: string) {
    const { rows: [app] } = await tx.query('select * from admission_applications where id = $1 for update', [id]);
    if (!app) throw new NotFoundException({ error: 'not_found' });
    return app;
  }
}
