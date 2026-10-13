import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Query, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, campusScope, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { guardianUserIds, notify, studentAccess } from '../sis/access';
import { staffCourse } from './access';

const pubS = z.object({ assessmentName: z.string().min(2).max(100), assignmentIds: z.array(uuid).min(1).max(30) });
const scaleS = z.object({ bands: z.array(z.object({ minPercent: z.number().min(0).max(100), grade: z.string().min(1).max(5), points: z.number().min(0).max(10).optional() })).min(2).max(20) });
const FALLBACK = [{ min: 90, grade: 'A' }, { min: 75, grade: 'B' }, { min: 60, grade: 'C' }, { min: 40, grade: 'D' }, { min: 0, grade: 'F' }];

@Controller()
export class GradesController {
  constructor(private db: DbService) {}

  /** Teacher proposes official marks from graded assignments; nothing reaches the ERP until approved. */
  @Post('courses/:id/grade-publications')
  propose(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(pubS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const c = await staffCourse(tx, a, id);
      const asg = (await tx.query('select id, max_marks from assignments where course_id = $1 and id = any($2)', [id, b.assignmentIds])).rows;
      if (asg.length !== new Set(b.assignmentIds).size) throw new UnprocessableEntityException({ error: 'assignment_not_in_course' });
      const dup = await tx.query(`select 1 from grade_publications where course_id = $1 and assessment_name = $2 and status in ('submitted','approved')`, [id, b.assessmentName]);
      if (dup.rowCount) throw new ConflictException({ error: 'assessment_already_proposed' });
      const max = asg.reduce((t, x) => t + Number(x.max_marks), 0);
      const rows = (await tx.query(
        `select ce.student_id, coalesce(sum(sub.marks) filter (where sub.status = 'graded'), 0) as marks,
           count(*) filter (where sub.status = 'graded')::int as graded
         from course_enrollments ce left join submissions sub on sub.student_id = ce.student_id and sub.assignment_id = any($2)
         where ce.course_id = $1 and ce.status = 'active' group by ce.student_id`, [id, b.assignmentIds])).rows;
      const ungraded = rows.filter((r) => r.graded < b.assignmentIds.length).map((r) => r.student_id);
      if (ungraded.length) throw new UnprocessableEntityException({ error: 'ungraded_work', studentIds: ungraded });
      const { rows: [p] } = await tx.query('insert into grade_publications(tenant_id, course_id, assessment_name, source_assignment_ids, submitted_by) values ($1,$2,$3,$4,$5) returning id, status', [a.tenantId, id, b.assessmentName, b.assignmentIds, a.userId]);
      for (const r of rows) await tx.query('insert into publication_entries(tenant_id, publication_id, student_id, marks, max_marks) values ($1,$2,$3,$4,$5)', [a.tenantId, p.id, r.student_id, r.marks, max]);
      await audit(tx, a, a.tenantId, 'grades.propose', 'grade_publication', p.id, c.campus_id);
      return { ...p, students: rows.length, maxMarks: max };
    });
  }

  @Get('grade-publications')
  list(@Auth() a: AuthContext, @Query('status') status?: string) {
    needs(a, 'grades.approve');
    const scope = campusScope(a, 'grades.approve');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select gp.id, gp.assessment_name, gp.status, gp.created_at, c.title as course, (select count(*) from publication_entries where publication_id = gp.id)::int as students
       from grade_publications gp join courses c on c.id = gp.course_id join sections s on s.id = c.section_id
       where ($1::uuid[] is null or s.campus_id = any($1)) and ($2::text is null or gp.status = $2) order by gp.created_at desc`, [scope, status ?? null])).rows);
  }

  @Post('grade-publications/:id/decision')
  decide(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const { decision } = parse(z.object({ decision: z.enum(['approve', 'reject']) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [p] } = await tx.query('select gp.*, s.campus_id, s.academic_year_id from grade_publications gp join courses c on c.id = gp.course_id join sections s on s.id = c.section_id where gp.id = $1 for update of gp', [id]);
      if (!p) throw new NotFoundException({ error: 'not_found' });
      needs(a, 'grades.approve', p.campus_id);
      if (p.status !== 'submitted') throw new ConflictException({ error: 'already_decided' });
      if (p.submitted_by === a.userId) throw new UnprocessableEntityException({ error: 'cannot_approve_own_submission' });
      await tx.query('update grade_publications set status = $2, decided_by = $3, decided_at = now() where id = $1', [id, decision === 'approve' ? 'approved' : 'rejected', a.userId]);
      if (decision === 'approve') {
        const entries = (await tx.query('select * from publication_entries where publication_id = $1', [id])).rows;
        for (const e of entries) {
          await tx.query('insert into official_marks(tenant_id, student_id, course_id, academic_year_id, assessment_name, marks, max_marks, publication_id) values ($1,$2,$3,$4,$5,$6,$7,$8)',
            [a.tenantId, e.student_id, p.course_id, p.academic_year_id, p.assessment_name, e.marks, e.max_marks, id]);
          await notify(tx, a.tenantId, await guardianUserIds(tx, e.student_id), 'results.published', 'Results published', `${p.assessment_name}: ${Number(e.marks)}/${Number(e.max_marks)}.`);
        }
      }
      await audit(tx, a, a.tenantId, `grades.${decision}`, 'grade_publication', id, p.campus_id);
      return { decision };
    });
  }

  @Get('students/:id/report-card')
  reportCard(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      if (!s || !(await studentAccess(tx, a, s))) throw new NotFoundException({ error: 'not_found' });
      const scale = await this.scale(tx);
      const rows = (await tx.query(
        `select om.assessment_name, coalesce((select new_marks from official_mark_corrections oc where oc.official_mark_id = om.id order by oc.id desc limit 1), om.marks) as marks, om.max_marks, (exists (select 1 from official_mark_corrections oc where oc.official_mark_id = om.id)) as revised, c.title as course, sub.name as subject, ay.name as academic_year
         from official_marks om join courses c on c.id = om.course_id join subjects sub on sub.id = c.subject_id join academic_years ay on ay.id = om.academic_year_id
         where om.student_id = $1 order by sub.name, om.published_at`, [id])).rows;
      const items = rows.map((r) => { const pct = Math.round((Number(r.marks) / Number(r.max_marks)) * 1000) / 10; return { ...r, marks: Number(r.marks), max_marks: Number(r.max_marks), percent: pct, grade: this.gradeFor(scale, pct) }; });
      const tm = items.reduce((t, r) => t + r.marks, 0), tx_ = items.reduce((t, r) => t + r.max_marks, 0);
      const overall = tx_ ? Math.round((tm / tx_) * 1000) / 10 : null;
      return {
        student: { id: s.id, name: `${s.first_name} ${s.last_name}`, admissionNo: s.admission_no },
        items, overallPercent: overall, overallGrade: overall === null ? null : this.gradeFor(scale, overall),
        scale: scale.source, note: scale.source === 'default-fallback' ? 'No grading scale configured; using a generic fallback scale.' : undefined,
      };
    });
  }

  @Post('grade-scales')
  setScale(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'academic.manage');
    const b = parse(scaleS, body);
    if (!b.bands.some((x) => x.minPercent === 0)) throw new UnprocessableEntityException({ error: 'scale_must_start_at_zero' });
    return this.db.withTenant(a.tenantId, async (tx) => {
      await tx.query('delete from grade_scales where tenant_id = $1', [a.tenantId]);
      for (const x of b.bands) await tx.query('insert into grade_scales(tenant_id, min_percent, grade, points) values ($1,$2,$3,$4)', [a.tenantId, x.minPercent, x.grade, x.points ?? null]);
      await audit(tx, a, a.tenantId, 'academic.grade_scale_set', 'tenant', a.tenantId);
      return { bands: b.bands.length };
    });
  }

  private async scale(tx: Tx) {
    const rows = (await tx.query('select min_percent, grade from grade_scales order by min_percent desc')).rows;
    return rows.length ? { source: 'configured', bands: rows.map((r) => ({ min: Number(r.min_percent), grade: r.grade as string })) } : { source: 'default-fallback', bands: FALLBACK };
  }
  private gradeFor(scale: { bands: { min: number; grade: string }[] }, pct: number) {
    return (scale.bands.find((b) => pct >= b.min) ?? scale.bands[scale.bands.length - 1]).grade;
  }
}
