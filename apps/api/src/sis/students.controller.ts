import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, can, campusScope, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { studentAccess } from './access';

const residence = z.object({ residenceType: z.enum(['boarder', 'day_scholar']), effectiveFrom: z.string().date(), note: z.string().max(500).optional() });
const transfer = z.object({ sectionId: uuid, effectiveFrom: z.string().date(), reason: z.string().max(500).optional() });
const alert = z.object({ alert: z.string().min(1).max(500), severity: z.enum(['info', 'important', 'critical']) });

const dayBefore = (d: string) => new Date(Date.parse(d) - 86_400_000).toISOString().slice(0, 10);

@Controller()
export class StudentsController {
  constructor(private db: DbService) {}

  @Get('students')
  list(@Auth() a: AuthContext, @Query('q') q?: string, @Query('limit') limit = '50', @Query('offset') offset = '0') {
    needs(a, 'student.read');
    const scope = campusScope(a, 'student.read');
    const lim = Math.min(Math.max(parseInt(limit) || 50, 1), 200), off = Math.max(parseInt(offset) || 0, 0);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select id, admission_no, first_name, last_name, status, campus_id from students
       where ($1::uuid[] is null or campus_id = any($1)) and ($2::text is null or (first_name || ' ' || last_name || ' ' || admission_no) ilike '%' || $2 || '%')
       order by last_name, first_name limit $3 offset $4`, [scope, q ?? null, lim, off])).rows);
  }

  /** Parent portal: only children linked to the signed-in guardian. */
  @Get('me/children')
  children(@Auth() a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select s.id, s.admission_no, s.first_name, s.last_name, sg.relationship from students s
       join student_guardians sg on sg.student_id = s.id join guardians g on g.id = sg.guardian_id
       where g.user_id = $1 order by s.first_name`, [a.userId])).rows);
  }

  @Get('students/:id/overview')
  overview(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      if (!s) throw new NotFoundException({ error: 'not_found' });
      const access = await this.accessLevel(tx, a, s);
      if (!access) throw new NotFoundException({ error: 'not_found' }); // do not reveal existence
      const [enr, res, courses, guardians] = await Promise.all([
        tx.query(`select e.id, e.effective_from, e.effective_to, e.end_reason, sec.name as section, gl.name as grade, ay.name as academic_year
                  from enrollments e join sections sec on sec.id = e.section_id join grade_levels gl on gl.id = sec.grade_level_id join academic_years ay on ay.id = e.academic_year_id
                  where e.student_id = $1 order by e.effective_from desc`, [id]),
        tx.query('select id, residence_type, effective_from, effective_to, note from residence_assignments where student_id = $1 order by effective_from desc', [id]),
        tx.query(`select c.id, c.title, sub.name as subject from course_enrollments ce join courses c on c.id = ce.course_id join subjects sub on sub.id = c.subject_id where ce.student_id = $1 and ce.status = 'active' order by c.title`, [id]),
        tx.query(`select g.id, g.full_name, g.phone, sg.relationship, sg.can_pickup from student_guardians sg join guardians g on g.id = sg.guardian_id where sg.student_id = $1`, [id]),
      ]);
      const out: any = {
        student: { id: s.id, admissionNo: s.admission_no, firstName: s.first_name, lastName: s.last_name, dateOfBirth: s.date_of_birth, status: s.status },
        enrollments: enr.rows, residence: res.rows, courses: courses.rows,
        guardians: access === 'teacher' ? [] : guardians.rows, // teachers do not need family contact details
      };
      if (can(a, 'medical.read', s.campus_id)) {
        out.medicalAlerts = (await tx.query('select id, alert, severity from student_medical_alerts where student_id = $1', [id])).rows;
        await audit(tx, a, a.tenantId, 'medical.read', 'student', id, s.campus_id);
      }
      return out;
    });
  }

  @Post('students/:id/residence')
  changeResidence(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(residence, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const s = await this.staffStudent(tx, a, id, 'student.write');
      if (b.residenceType === 'boarder') {
        const { rows: [c] } = await tx.query('select is_boarding from campuses where id = $1', [s.campus_id]);
        if (!c.is_boarding) throw new UnprocessableEntityException({ error: 'campus_has_no_boarding' });
      }
      const { rows: [cur] } = await tx.query('select * from residence_assignments where student_id = $1 and effective_to is null for update', [id]);
      if (cur) {
        if (cur.residence_type === b.residenceType) throw new ConflictException({ error: 'no_change' });
        if (b.effectiveFrom <= cur.effective_from) throw new UnprocessableEntityException({ error: 'effective_date_before_current' });
        await tx.query('update residence_assignments set effective_to = $2 where id = $1', [cur.id, dayBefore(b.effectiveFrom)]);
      }
      const { rows: [r] } = await tx.query('insert into residence_assignments(tenant_id, student_id, residence_type, effective_from, note) values ($1,$2,$3,$4,$5) returning *', [a.tenantId, id, b.residenceType, b.effectiveFrom, b.note ?? null]);
      await audit(tx, a, a.tenantId, 'student.residence_change', 'student', id, s.campus_id, { to: b.residenceType, from: cur?.residence_type });
      return r;
    });
  }

  /** Move a student between sections: history preserved, LMS access re-synced. */
  @Post('students/:id/section-transfer')
  transferSection(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(transfer, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const s = await this.staffStudent(tx, a, id, 'student.write');
      const { rows: [sec] } = await tx.query('select * from sections where id = $1 for update', [b.sectionId]);
      if (!sec || sec.campus_id !== s.campus_id) throw new UnprocessableEntityException({ error: 'section_not_on_campus' });
      const { rows: [{ n }] } = await tx.query('select count(*)::int as n from enrollments where section_id = $1 and effective_to is null', [sec.id]);
      if (n >= sec.capacity) throw new ConflictException({ error: 'section_full' });
      const { rows: [cur] } = await tx.query('select * from enrollments where student_id = $1 and effective_to is null for update', [id]);
      if (cur) {
        if (cur.section_id === sec.id) throw new ConflictException({ error: 'no_change' });
        if (b.effectiveFrom <= cur.effective_from) throw new UnprocessableEntityException({ error: 'effective_date_before_current' });
        await tx.query('update enrollments set effective_to = $2, end_reason = $3 where id = $1', [cur.id, dayBefore(b.effectiveFrom), b.reason ?? 'section_transfer']);
        await tx.query(`update course_enrollments set status = 'dropped' where student_id = $1 and course_id in (select id from courses where section_id = $2)`, [id, cur.section_id]);
      }
      await tx.query('insert into enrollments(tenant_id, student_id, section_id, academic_year_id, effective_from) values ($1,$2,$3,$4,$5)', [a.tenantId, id, sec.id, sec.academic_year_id, b.effectiveFrom]);
      await tx.query(`insert into course_enrollments(tenant_id, course_id, student_id) select $1, c.id, $2 from courses c where c.section_id = $3
                      on conflict (course_id, student_id) do update set status = 'active'`, [a.tenantId, id, sec.id]);
      await audit(tx, a, a.tenantId, 'student.section_transfer', 'student', id, s.campus_id, { from: cur?.section_id, to: sec.id });
      return { transferred: true };
    });
  }

  @Post('students/:id/medical-alerts')
  addAlert(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(alert, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const s = await this.staffStudent(tx, a, id, 'medical.write');
      const { rows: [r] } = await tx.query('insert into student_medical_alerts(tenant_id, student_id, alert, severity, created_by) values ($1,$2,$3,$4,$5) returning id, alert, severity', [a.tenantId, id, b.alert, b.severity, a.userId]);
      await audit(tx, a, a.tenantId, 'medical.alert_add', 'student', id, s.campus_id);
      return r;
    });
  }

  private async staffStudent(tx: Tx, a: AuthContext, id: string, perm: 'student.write' | 'medical.write') {
    const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
    if (!s || !can(a, perm, s.campus_id)) throw new NotFoundException({ error: 'not_found' });
    return s;
  }

  private accessLevel(tx: Tx, a: AuthContext, s: { id: string; campus_id: string; user_id: string | null }) {
    return studentAccess(tx, a, s);
  }
}
