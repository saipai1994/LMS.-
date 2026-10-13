import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Res } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, can, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { studentAccess } from '../sis/access';

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const FALLBACK = [{ min: 90, grade: 'A' }, { min: 75, grade: 'B' }, { min: 60, grade: 'C' }, { min: 40, grade: 'D' }, { min: 0, grade: 'F' }];
const MARKS_SQL = `select om.assessment_name, ay.name as year, sub.name as subject, c.title as course, om.max_marks,
  coalesce((select new_marks from official_mark_corrections oc where oc.official_mark_id = om.id order by oc.id desc limit 1), om.marks) as marks
  from official_marks om join courses c on c.id = om.course_id join subjects sub on sub.id = c.subject_id join academic_years ay on ay.id = om.academic_year_id`;

@Controller()
export class ReportCardsController {
  constructor(private db: DbService) {}

  private async scale(tx: Tx) {
    const rows = (await tx.query('select min_percent, grade from grade_scales order by min_percent desc')).rows;
    return rows.length ? rows.map((r) => ({ min: Number(r.min_percent), grade: r.grade as string })) : FALLBACK;
  }
  private grade(sc: { min: number; grade: string }[], pct: number) { return (sc.find((b) => pct >= b.min) ?? sc[sc.length - 1]).grade; }

  /** Teacher/class-teacher remark printed on the report card (one per author per year). */
  @Post('students/:id/remarks')
  remark(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(z.object({ academicYearId: uuid, remark: z.string().min(3).max(600) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const teaches = await tx.query(`select 1 from course_enrollments ce join courses c on c.id = ce.course_id where ce.student_id = $1 and c.teacher_user_id = $2 and ce.status = 'active' union select 1 from enrollments e join sections s on s.id = e.section_id where e.student_id = $1 and e.effective_to is null and s.class_teacher_user_id = $2`, [id, a.userId]);
      if (!teaches.rowCount) throw new NotFoundException({ error: 'not_found' });
      await tx.query(`insert into report_remarks(tenant_id, student_id, academic_year_id, remark, author_user_id) values ($1,$2,$3,$4,$5) on conflict (student_id, academic_year_id, author_user_id) do update set remark = excluded.remark`, [a.tenantId, id, b.academicYearId, b.remark, a.userId]);
      return { saved: true };
    });
  }

  /** Class ranking by overall percentage of approved results. Restricted to result approvers and academic managers. */
  @Get('sections/:id/rank-list')
  rank(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [sec] } = await tx.query('select * from sections where id = $1', [id]);
      if (!sec || !(can(a, 'grades.approve', sec.campus_id) || can(a, 'academic.manage', sec.campus_id))) throw new NotFoundException({ error: 'not_found' });
      const rows = (await tx.query(
        `select s.id, s.admission_no, s.first_name, s.last_name, sum(m.marks)::float as marks, sum(m.max_marks)::float as max from enrollments e join students s on s.id = e.student_id
         join (${MARKS_SQL.replace('select om.assessment_name,', 'select om.student_id, om.assessment_name,')}) m on m.student_id = s.id where e.section_id = $1 and e.effective_to is null group by s.id order by sum(m.marks) / sum(m.max_marks) desc, s.admission_no`, [id])).rows;
      let rank = 0, prev: number | null = null, i = 0;
      return rows.map((r) => { i++; const pct = Math.round((r.marks / r.max) * 1000) / 10; if (pct !== prev) rank = i; prev = pct; return { rank, admissionNo: r.admission_no, name: `${r.first_name} ${r.last_name}`, percent: pct }; });
    });
  }

  /** Printable report card (HTML — use the browser to print or save as PDF). Approved results only. */
  @Get('students/:id/report-card.html')
  html(@Auth() a: AuthContext, @Param('id') id: string, @Res() res: any) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      if (!s || !(await studentAccess(tx, a, s))) throw new NotFoundException({ error: 'not_found' });
      const yr = (await tx.query('select id, name from academic_years where is_current')).rows[0];
      const sc = await this.scale(tx);
      const items = (await tx.query(`${MARKS_SQL.replace('select om.assessment_name,', 'select om.student_id, om.assessment_name,')} where om.student_id = $1 and ay.id = $2 order by sub.name, om.assessment_name`, [id, yr?.id])).rows;
      if (!items.length) throw new ConflictException({ error: 'no_published_results' });
      const total = items.reduce((t, r) => t + Number(r.marks), 0), max = items.reduce((t, r) => t + Number(r.max_marks), 0), pct = Math.round((total / max) * 1000) / 10;
      const cls = (await tx.query(`select g.name as grade, sec.name as section from enrollments e join sections sec on sec.id = e.section_id join grade_levels g on g.id = sec.grade_level_id where e.student_id = $1 and e.effective_to is null`, [id])).rows[0];
      const att = (await tx.query(`select round(100.0 * count(*) filter (where status in ('present','late')) / nullif(count(*),0), 1) p from attendance_records where student_id = $1 and period = 0`, [id])).rows[0].p;
      const remarks = (await tx.query(`select r.remark, u.full_name from report_remarks r join users u on u.id = r.author_user_id where r.student_id = $1 and r.academic_year_id = $2 order by r.created_at`, [id, yr?.id])).rows;
      const tenant = (await tx.query('select name from tenants where id = $1', [a.tenantId])).rows[0];
      await audit(tx, a, a.tenantId, 'reportcard.view', 'student', id, s.campus_id);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      res.send(`<!doctype html><meta charset="utf-8"><title>Report card — ${esc(s.first_name)} ${esc(s.last_name)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:800px;margin:2rem auto;padding:1rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:.4rem .6rem;text-align:left}h1,h2{margin:.2rem 0}.r{text-align:right}@media print{body{margin:0}}</style>
<h1>${esc(tenant?.name)}</h1><h2>Report card — ${esc(yr?.name)}</h2>
<p><strong>${esc(s.first_name)} ${esc(s.last_name)}</strong> · Adm. no. ${esc(s.admission_no)} · ${esc(cls?.grade)} ${esc(cls?.section)}</p>
<table><thead><tr><th>Subject</th><th>Assessment</th><th class="r">Marks</th><th class="r">%</th><th>Grade</th></tr></thead><tbody>
${items.map((r) => { const p = Math.round((Number(r.marks) / Number(r.max_marks)) * 1000) / 10; return `<tr><td>${esc(r.subject)}</td><td>${esc(r.assessment_name)}</td><td class="r">${esc(Number(r.marks))}/${esc(Number(r.max_marks))}</td><td class="r">${esc(p)}</td><td>${esc(this.grade(sc, p))}</td></tr>`; }).join('')}
</tbody></table><p><strong>Overall:</strong> ${esc(pct)}% — grade ${esc(this.grade(sc, pct))} · <strong>Attendance:</strong> ${att === null ? 'n/a' : esc(att) + '%'}</p>
${remarks.map((r) => `<p><em>“${esc(r.remark)}”</em> — ${esc(r.full_name)}</p>`).join('')}<p style="margin-top:3rem">Class teacher ______________ &nbsp; Principal ______________</p>`);
    });
  }

  /** Transcript: every approved result across years (history including re-evaluated marks). */
  @Get('students/:id/transcript')
  transcript(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      const acc = s && await studentAccess(tx, a, s);
      if (!s || !acc || acc === 'teacher') throw new NotFoundException({ error: 'not_found' });
      const sc = await this.scale(tx);
      const rows = (await tx.query(`${MARKS_SQL.replace('select om.assessment_name,', 'select om.student_id, om.assessment_name,')} where om.student_id = $1 order by ay.name, sub.name, om.assessment_name`, [id])).rows;
      const years: Record<string, any[]> = {};
      for (const r of rows) { const p = Math.round((Number(r.marks) / Number(r.max_marks)) * 1000) / 10; (years[r.year] ??= []).push({ subject: r.subject, assessment: r.assessment_name, marks: Number(r.marks), maxMarks: Number(r.max_marks), percent: p, grade: this.grade(sc, p) }); }
      return { student: { name: `${s.first_name} ${s.last_name}`, admissionNo: s.admission_no, status: s.status }, years: Object.entries(years).map(([year, results]) => ({ year, results, overallPercent: Math.round((results.reduce((t, r) => t + r.marks, 0) / results.reduce((t, r) => t + r.maxMarks, 0)) * 1000) / 10 })) };
    });
  }
}
void needs;
