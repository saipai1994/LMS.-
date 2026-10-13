import { Controller, Get } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Auth, AuthContext, campusScope, can } from '../common/http';

/** Aggregates for role dashboards; every figure is derived from stored data and respects the caller's permissions. */
@Controller()
export class DashboardController {
  constructor(private db: DbService) {}

  @Get('me/profile')
  profile(@Auth() a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [u] } = await tx.query('select id, email, full_name from users where id = $1', [a.userId]);
      const roles = (await tx.query('select distinct r.key from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1', [a.userId])).rows.map((r) => r.key);
      const { rows: [t] } = await tx.query('select name, branding from tenants where id = $1', [a.tenantId]).catch(() => ({ rows: [] as any[] }));
      return { id: u.id, email: u.email, fullName: u.full_name, roles, grants: a.grants, mfaEnabled: a.mfaEnabled, tenant: t ?? null };
    });
  }

  /** Courses the caller teaches (staff) or is enrolled in (student). */
  @Get('me/courses')
  courses(@Auth() a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select c.id, c.title, sub.name as subject, g.name as grade, s.name as section,
         (select count(*) from course_enrollments ce where ce.course_id = c.id and ce.status = 'active')::int as students,
         (c.teacher_user_id = $1) as teaching
       from courses c join sections s on s.id = c.section_id join grade_levels g on g.id = s.grade_level_id join subjects sub on sub.id = c.subject_id
       where c.teacher_user_id = $1 or exists (select 1 from course_enrollments ce join students st on st.id = ce.student_id where ce.course_id = c.id and ce.status = 'active' and st.user_id = $1)
       order by g.ordinal, s.name, sub.name`, [a.userId])).rows);
  }

  /** Sections the caller may take attendance for, with today's marking state. */
  @Get('me/sections')
  sections(@Auth() a: AuthContext) {
    const scope = campusScope(a, 'attendance.manage');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select s.id, g.name as grade, s.name, (select count(*) from enrollments e where e.section_id = s.id and e.effective_to is null)::int as students,
         (select count(*) from attendance_records ar where ar.section_id = s.id and ar.att_date = current_date and ar.period = 0)::int as marked_today
       from sections s join grade_levels g on g.id = s.grade_level_id
       where s.class_teacher_user_id = $1 or exists (select 1 from courses c where c.section_id = s.id and c.teacher_user_id = $1) or ($2::boolean and ($3::uuid[] is null or s.campus_id = any($3)))
       order by g.ordinal, s.name`, [a.userId, can(a, 'attendance.manage'), scope])).rows);
  }

  @Get('dashboard/principal')
  principal(@Auth() a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => {
      const n = async (sql: string) => Number((await tx.query(sql)).rows[0].n);
      const out: Record<string, unknown> = {};
      if (can(a, 'student.read')) {
        out.students = await n(`select count(*) n from students where status = 'active'`);
        out.boarders = await n(`select count(*) n from residence_assignments where effective_to is null and residence_type = 'boarder'`);
        out.dayScholars = await n(`select count(*) n from residence_assignments where effective_to is null and residence_type = 'day_scholar'`);
      }
      if (can(a, 'attendance.read')) {
        const r = (await tx.query(`select att_date, round(100.0 * count(*) filter (where status in ('present','late')) / count(*), 1) as pct from attendance_records where period = 0 group by att_date order by att_date desc limit 10`)).rows;
        out.attendanceTrend = r.map((x) => ({ date: x.att_date, percent: Number(x.pct) })).reverse();
      }
      if (can(a, 'hostel.read')) {
        out.hostel = (await tx.query(
          `select count(*) filter (where l.id is null)::int as on_campus, count(*) filter (where l.status = 'out' and l.expected_return_at >= now())::int as on_leave, count(*) filter (where l.status = 'out' and l.expected_return_at < now())::int as overdue
           from residence_assignments ra left join leave_requests l on l.student_id = ra.student_id and l.status = 'out' where ra.effective_to is null and ra.residence_type = 'boarder'`)).rows[0];
      }
      if (can(a, 'incident.manage')) {
        out.openIncidents = (await tx.query(`select category, severity, count(*)::int as n from incidents where status <> 'closed' and category <> 'safeguarding' group by category, severity order by n desc`)).rows;
      }
      if (can(a, 'admissions.read')) out.admissions = (await tx.query(`select status, count(*)::int as n from admission_applications group by status order by status`)).rows;
      if (can(a, 'finance.read')) {
        const r = (await tx.query(`select coalesce(sum(total_minor),0) as invoiced from invoices where status <> 'void'`)).rows[0];
        const c = (await tx.query(`select coalesce(sum(amount_minor),0) as collected from payment_allocations`)).rows[0];
        out.finance = { invoicedMinor: Number(r.invoiced), collectedMinor: Number(c.collected) };
      }
      return out;
    });
  }
}
