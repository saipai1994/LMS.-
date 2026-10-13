import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Query, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, can, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { guardianUserIds, notify, studentAccess } from '../sis/access';

const status = z.enum(['present', 'absent', 'late', 'excused']);
const markS = z.object({
  date: z.string().date(), period: z.number().int().min(0).max(20).default(0),
  entries: z.array(z.object({ studentId: uuid, status, reason: z.string().max(300).optional() })).min(1).max(200),
});
const corrS = z.object({ newStatus: status, reason: z.string().min(3).max(500) });

@Controller()
export class AttendanceController {
  constructor(private db: DbService) {}

  /** Class teacher, a teacher of a course in the section, or attendance.manage on the campus. */
  private async canMark(tx: Tx, a: AuthContext, sec: { id: string; campus_id: string; class_teacher_user_id: string | null }) {
    if (can(a, 'attendance.manage', sec.campus_id) || sec.class_teacher_user_id === a.userId) return true;
    return !!(await tx.query('select 1 from courses where section_id = $1 and teacher_user_id = $2', [sec.id, a.userId])).rowCount;
  }

  @Post('sections/:id/attendance')
  mark(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(markS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [sec] } = await tx.query('select * from sections where id = $1', [id]);
      if (!sec || !(await this.canMark(tx, a, sec))) throw new NotFoundException({ error: 'not_found' });
      const ids = b.entries.map((e) => e.studentId);
      if (new Set(ids).size !== ids.length) throw new UnprocessableEntityException({ error: 'duplicate_entries' });
      if (b.date > new Date().toISOString().slice(0, 10)) throw new UnprocessableEntityException({ error: 'future_date' });
      const enrolled = new Set((await tx.query(
        'select student_id from enrollments where section_id = $1 and effective_from <= $2 and (effective_to is null or effective_to >= $2)', [id, b.date])).rows.map((r) => r.student_id));
      const bad = ids.filter((s) => !enrolled.has(s));
      if (bad.length) throw new UnprocessableEntityException({ error: 'not_enrolled_in_section', studentIds: bad });
      const locked: string[] = [];
      let absences = 0;
      for (const e of b.entries) {
        const { rows: [ex] } = await tx.query('select id, status, created_at < now() - interval \'24 hours\' as old from attendance_records where student_id = $1 and att_date = $2 and period = $3 for update', [e.studentId, b.date, b.period]);
        if (ex?.old && ex.status !== e.status) { locked.push(e.studentId); continue; }
        if (ex) await tx.query('update attendance_records set status = $2, reason = $3, marked_by = $4, updated_at = now() where id = $1', [ex.id, e.status, e.reason ?? null, a.userId]);
        else await tx.query('insert into attendance_records(tenant_id, student_id, section_id, att_date, period, status, reason, marked_by) values ($1,$2,$3,$4,$5,$6,$7,$8)', [a.tenantId, e.studentId, id, b.date, b.period, e.status, e.reason ?? null, a.userId]);
        if (e.status === 'absent' && ex?.status !== 'absent') {
          absences++;
          const { rows: [st] } = await tx.query('select first_name from students where id = $1', [e.studentId]);
          await notify(tx, a.tenantId, await guardianUserIds(tx, e.studentId), 'attendance.absent', 'Absence recorded', `${st.first_name} was marked absent on ${b.date}.`);
        }
      }
      if (locked.length) throw Object.assign(new ConflictException({ error: 'requires_correction_request', studentIds: locked }), {});
      await audit(tx, a, a.tenantId, 'attendance.mark', 'section', id, sec.campus_id, { date: b.date, period: b.period, count: b.entries.length, absences });
      return { saved: b.entries.length, absences };
    });
  }

  @Get('sections/:id/attendance')
  sectionDay(@Auth() a: AuthContext, @Param('id') id: string, @Query('date') date: string) {
    pid(id);
    const d = parse(z.string().date(), date);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [sec] } = await tx.query('select * from sections where id = $1', [id]);
      if (!sec || !((await this.canMark(tx, a, sec)) || can(a, 'attendance.read', sec.campus_id))) throw new NotFoundException({ error: 'not_found' });
      return (await tx.query(
        `select s.id as student_id, s.admission_no, s.first_name, s.last_name, ar.status, ar.reason
         from enrollments e join students s on s.id = e.student_id
         left join attendance_records ar on ar.student_id = s.id and ar.att_date = $2 and ar.period = 0
         where e.section_id = $1 and e.effective_from <= $2 and (e.effective_to is null or e.effective_to >= $2) order by s.last_name, s.first_name`, [id, d])).rows;
    });
  }

  @Get('students/:id/attendance')
  student(@Auth() a: AuthContext, @Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      if (!s || !(await studentAccess(tx, a, s))) throw new NotFoundException({ error: 'not_found' });
      const f = from ? parse(z.string().date(), from) : '1900-01-01', t = to ? parse(z.string().date(), to) : '2999-12-31';
      const rows = (await tx.query('select id, att_date, period, status, reason from attendance_records where student_id = $1 and att_date between $2 and $3 order by att_date desc, period', [id, f, t])).rows;
      const days = rows.filter((r) => r.period === 0);
      const attended = days.filter((r) => r.status === 'present' || r.status === 'late').length;
      return { records: rows, summary: { days: days.length, attended, percentage: days.length ? Math.round((attended / days.length) * 1000) / 10 : null } };
    });
  }

  @Post('attendance/:recordId/corrections')
  requestCorrection(@Auth() a: AuthContext, @Param('recordId') rid: string, @Body() body: unknown) {
    pid(rid);
    const b = parse(corrS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [r] } = await tx.query('select ar.*, sec.campus_id, sec.class_teacher_user_id from attendance_records ar join sections sec on sec.id = ar.section_id where ar.id = $1', [rid]);
      if (!r || !(await this.canMark(tx, a, { id: r.section_id, campus_id: r.campus_id, class_teacher_user_id: r.class_teacher_user_id }))) throw new NotFoundException({ error: 'not_found' });
      if (r.status === b.newStatus) throw new UnprocessableEntityException({ error: 'no_change' });
      const { rows: [c] } = await tx.query('insert into attendance_corrections(tenant_id, record_id, requested_by, new_status, reason) values ($1,$2,$3,$4,$5) returning *', [a.tenantId, rid, a.userId, b.newStatus, b.reason]);
      await audit(tx, a, a.tenantId, 'attendance.correction_request', 'attendance_record', rid, r.campus_id);
      return c;
    });
  }

  @Post('attendance/corrections/:id/decision')
  decide(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const { decision } = parse(z.object({ decision: z.enum(['approve', 'reject']) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [c] } = await tx.query('select c.*, sec.campus_id from attendance_corrections c join attendance_records ar on ar.id = c.record_id join sections sec on sec.id = ar.section_id where c.id = $1 for update of c', [id]);
      if (!c) throw new NotFoundException({ error: 'not_found' });
      needs(a, 'attendance.manage', c.campus_id);
      if (c.status !== 'pending') throw new ConflictException({ error: 'already_decided' });
      if (c.requested_by === a.userId) throw new UnprocessableEntityException({ error: 'cannot_approve_own_request' });
      await tx.query('update attendance_corrections set status = $2, decided_by = $3, decided_at = now() where id = $1', [id, decision === 'approve' ? 'approved' : 'rejected', a.userId]);
      if (decision === 'approve') await tx.query('update attendance_records set status = $2, updated_at = now() where id = $1', [c.record_id, c.new_status]);
      await audit(tx, a, a.tenantId, `attendance.correction_${decision}`, 'attendance_correction', id, c.campus_id);
      return { decision };
    });
  }
}
