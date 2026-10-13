import { Controller, Get, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, campusScope, needs, parse } from '../common/http';
import { audit } from '../common/audit';

/** Neutralises spreadsheet formula injection ("=cmd|...") and quotes cells. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export const toCsv = (cols: string[], rows: Record<string, unknown>[]) => [cols.map(csvCell).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');

@Controller('reports')
export class ReportsController {
  constructor(private db: DbService) {}

  private async send(tx: Tx, a: AuthContext, res: any, name: string, cols: string[], rows: Record<string, unknown>[]) {
    await audit(tx, a, a.tenantId, 'report.export', 'report', name, null, { rows: rows.length });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(toCsv(cols, rows));
  }

  @Get('students.csv')
  students(@Auth() a: AuthContext, @Res() res: any) {
    needs(a, 'reports.export'); needs(a, 'student.read'); const scope = campusScope(a, 'student.read');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const rows = (await tx.query(
        `select s.admission_no, s.first_name, s.last_name, s.date_of_birth, s.gender, s.status, g.name as grade, sec.name as section, ra.residence_type
         from students s left join enrollments e on e.student_id = s.id and e.effective_to is null left join sections sec on sec.id = e.section_id left join grade_levels g on g.id = sec.grade_level_id
         left join residence_assignments ra on ra.student_id = s.id and ra.effective_to is null where ($1::uuid[] is null or s.campus_id = any($1)) order by s.admission_no`, [scope])).rows;
      await this.send(tx, a, res, 'students', ['admission_no', 'first_name', 'last_name', 'date_of_birth', 'gender', 'status', 'grade', 'section', 'residence_type'], rows);
    });
  }
  @Get('fees-outstanding.csv')
  fees(@Auth() a: AuthContext, @Res() res: any) {
    needs(a, 'reports.export'); needs(a, 'finance.read'); const scope = campusScope(a, 'finance.read');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const rows = (await tx.query(
        `select s.admission_no, s.first_name, s.last_name, i.number as invoice, i.due_date, (i.total_minor - coalesce(adj.n,0) - coalesce(al.n,0))::bigint / 100.0 as outstanding_inr, (current_date - i.due_date) as days_overdue
         from invoices i join students s on s.id = i.student_id
         left join lateral (select sum(amount_minor) n from invoice_adjustments where invoice_id = i.id) adj on true left join lateral (select sum(amount_minor) n from payment_allocations where invoice_id = i.id) al on true
         where i.status <> 'void' and i.total_minor - coalesce(adj.n,0) - coalesce(al.n,0) > 0 and ($1::uuid[] is null or s.campus_id = any($1)) order by i.due_date, s.admission_no`, [scope])).rows;
      await this.send(tx, a, res, 'fees-outstanding', ['admission_no', 'first_name', 'last_name', 'invoice', 'due_date', 'outstanding_inr', 'days_overdue'], rows);
    });
  }
  @Get('attendance.csv')
  attendance(@Auth() a: AuthContext, @Res() res: any, @Query('from') from: string, @Query('to') to: string) {
    needs(a, 'reports.export'); needs(a, 'attendance.read'); const scope = campusScope(a, 'attendance.read');
    const f = parse(z.string().date(), from), t = parse(z.string().date(), to);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const rows = (await tx.query(
        `select s.admission_no, s.first_name, s.last_name, count(*) as days, count(*) filter (where ar.status in ('present','late')) as attended, count(*) filter (where ar.status = 'absent') as absent,
           round(100.0 * count(*) filter (where ar.status in ('present','late')) / count(*), 1) as percent
         from attendance_records ar join students s on s.id = ar.student_id where ar.period = 0 and ar.att_date between $1 and $2 and ($3::uuid[] is null or s.campus_id = any($3)) group by s.id order by percent, s.admission_no`, [f, t, scope])).rows;
      await this.send(tx, a, res, 'attendance', ['admission_no', 'first_name', 'last_name', 'days', 'attended', 'absent', 'percent'], rows);
    });
  }

  // ---- analytics (JSON), campus-scoped ----
  @Get('enrollment')
  enrollment(@Auth() a: AuthContext) {
    needs(a, 'student.read'); const scope = campusScope(a, 'student.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select g.name as grade, sec.name as section, sec.capacity, count(e.id)::int as enrolled,
         count(*) filter (where ra.residence_type = 'boarder')::int as boarders, count(*) filter (where ra.residence_type = 'day_scholar')::int as day_scholars
       from sections sec join grade_levels g on g.id = sec.grade_level_id left join enrollments e on e.section_id = sec.id and e.effective_to is null
       left join residence_assignments ra on ra.student_id = e.student_id and ra.effective_to is null where ($1::uuid[] is null or sec.campus_id = any($1)) group by g.ordinal, g.name, sec.id order by g.ordinal, sec.name`, [scope])).rows);
  }
  @Get('admission-funnel')
  funnel(@Auth() a: AuthContext) {
    needs(a, 'admissions.read'); const scope = campusScope(a, 'admissions.read');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const rows = (await tx.query(`select status, count(*)::int n from admission_applications where ($1::uuid[] is null or campus_id = any($1)) group by status`, [scope])).rows;
      const by = Object.fromEntries(rows.map((r) => [r.status, r.n])); const total = rows.reduce((t, r) => t + r.n, 0);
      const offered = (by.offered ?? 0) + (by.accepted ?? 0) + (by.enrolled ?? 0);
      return { total, byStatus: by, offerRatePercent: total ? Math.round((offered / total) * 1000) / 10 : null, conversionPercent: total ? Math.round(((by.enrolled ?? 0) / total) * 1000) / 10 : null };
    });
  }
  @Get('academic-performance')
  performance(@Auth() a: AuthContext) {
    needs(a, 'student.read'); const scope = campusScope(a, 'student.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select g.name as grade, sub.name as subject, count(*)::int as results, round(avg(coalesce((select new_marks from official_mark_corrections oc where oc.official_mark_id = om.id order by oc.id desc limit 1), om.marks) / om.max_marks * 100), 1) as average_percent
       from official_marks om join courses c on c.id = om.course_id join sections sec on sec.id = c.section_id join grade_levels g on g.id = sec.grade_level_id join subjects sub on sub.id = c.subject_id
       where ($1::uuid[] is null or sec.campus_id = any($1)) group by g.ordinal, g.name, sub.name order by g.ordinal, sub.name`, [scope])).rows.map((r) => ({ ...r, average_percent: Number(r.average_percent) })));
  }
}
