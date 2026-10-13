import { Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Post, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, campusScope, can, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { currentResidence, isGuardianOf, scopedStudent } from '../sis/access';

const hostelS = z.object({ campusId: uuid, name: z.string().min(1).max(100) });
const roomS = z.object({ floor: z.number().int().min(0).max(50), number: z.string().min(1).max(20), beds: z.number().int().min(1).max(12) });
const allocS = z.object({ studentId: uuid, bedId: uuid, effectiveFrom: z.string().date() });
const leaveS = z.object({
  studentId: uuid, leaveType: z.enum(['weekend', 'home_visit', 'overnight', 'outing', 'emergency']),
  destination: z.string().min(2).max(300), responsibleAdult: z.string().min(2).max(200),
  departAt: z.string().datetime(), expectedReturnAt: z.string().datetime(),
});
const decisionS = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).optional() });
const rollS = z.object({
  session: z.enum(['morning', 'evening', 'bedtime']), date: z.string().date(),
  entries: z.array(z.object({ studentId: uuid, status: z.enum(['present', 'absent', 'on_leave', 'excused']) })).min(1).max(500),
});
const dayBefore = (d: string) => new Date(Date.parse(d) - 86_400_000).toISOString().slice(0, 10);

@Controller()
export class HostelController {
  constructor(private db: DbService) {}

  // ---------- infrastructure ----------
  @Post('hostels')
  createHostel(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(hostelS, body);
    needs(a, 'hostel.manage', b.campusId);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [c] } = await tx.query('select is_boarding from campuses where id = $1', [b.campusId]);
      if (!c?.is_boarding) throw new UnprocessableEntityException({ error: 'campus_has_no_boarding' });
      const { rows: [h] } = await tx.query('insert into hostels(tenant_id, campus_id, name) values ($1,$2,$3) returning *', [a.tenantId, b.campusId, b.name]);
      await audit(tx, a, a.tenantId, 'hostel.create', 'hostel', h.id, b.campusId);
      return h;
    });
  }

  @Post('hostels/:id/rooms')
  createRoom(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(roomS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const h = await this.hostel(tx, id);
      needs(a, 'hostel.manage', h.campus_id);
      const { rows: [r] } = await tx.query('insert into rooms(tenant_id, hostel_id, floor, number) values ($1,$2,$3,$4) returning *', [a.tenantId, id, b.floor, b.number]);
      for (let i = 0; i < b.beds; i++) await tx.query('insert into beds(tenant_id, room_id, label) values ($1,$2,$3)', [a.tenantId, r.id, String.fromCharCode(65 + i)]);
      return { ...r, beds: b.beds };
    });
  }

  @Get('hostels')
  list(@Auth() a: AuthContext) {
    needs(a, 'hostel.read');
    const scope = campusScope(a, 'hostel.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select h.id, h.name, h.campus_id,
         count(b.id) filter (where not b.out_of_service)::int as capacity,
         count(ba.id)::int as occupied
       from hostels h left join rooms r on r.hostel_id = h.id left join beds b on b.room_id = r.id
       left join bed_assignments ba on ba.bed_id = b.id and ba.effective_to is null
       where ($1::uuid[] is null or h.campus_id = any($1)) group by h.id order by h.name`, [scope])).rows
      .map((h) => ({ ...h, vacant: h.capacity - h.occupied })));
  }

  @Get('hostels/:id/rooms')
  rooms(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const h = await this.hostel(tx, id);
      needs(a, 'hostel.read', h.campus_id);
      return (await tx.query(
        `select r.id as room_id, r.floor, r.number, b.id as bed_id, b.label, b.out_of_service, st.id as student_id, st.first_name, st.last_name, st.admission_no
         from rooms r join beds b on b.room_id = r.id
         left join bed_assignments ba on ba.bed_id = b.id and ba.effective_to is null left join students st on st.id = ba.student_id
         where r.hostel_id = $1 order by r.floor, r.number, b.label`, [id])).rows;
    });
  }

  // ---------- allocation & transfer ----------
  @Post('hostel/allocations')
  allocate(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(allocS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const s = await scopedStudent(tx, a, b.studentId, 'hostel.manage');
      const { rows: [bed] } = await tx.query(
        'select b.*, h.campus_id from beds b join rooms r on r.id = b.room_id join hostels h on h.id = r.hostel_id where b.id = $1', [b.bedId]);
      if (!bed || bed.campus_id !== s.campus_id) throw new UnprocessableEntityException({ error: 'bed_not_on_student_campus' });
      if (bed.out_of_service) throw new UnprocessableEntityException({ error: 'bed_out_of_service' });
      if (await currentResidence(tx, s.id) !== 'boarder') throw new UnprocessableEntityException({ error: 'student_not_boarder' });
      const occ = await tx.query('select 1 from bed_assignments where bed_id = $1 and effective_to is null for update', [b.bedId]);
      if (occ.rowCount) throw new ConflictException({ error: 'bed_occupied' });
      const { rows: [cur] } = await tx.query('select * from bed_assignments where student_id = $1 and effective_to is null for update', [s.id]);
      if (cur) {
        if (cur.bed_id === b.bedId) throw new ConflictException({ error: 'no_change' });
        if (b.effectiveFrom <= cur.effective_from) throw new UnprocessableEntityException({ error: 'effective_date_before_current' });
        await tx.query('update bed_assignments set effective_to = $2 where id = $1', [cur.id, dayBefore(b.effectiveFrom)]);
      }
      const { rows: [r] } = await tx.query('insert into bed_assignments(tenant_id, student_id, bed_id, effective_from) values ($1,$2,$3,$4) returning *', [a.tenantId, s.id, b.bedId, b.effectiveFrom]);
      await audit(tx, a, a.tenantId, cur ? 'hostel.room_transfer' : 'hostel.allocate', 'student', s.id, s.campus_id, { bedId: b.bedId, from: cur?.bed_id });
      return r;
    });
  }

  @Post('hostel/allocations/:studentId/release')
  release(@Auth() a: AuthContext, @Param('studentId') sid: string, @Body() body: unknown) {
    pid(sid);
    const { effectiveTo } = parse(z.object({ effectiveTo: z.string().date() }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const s = await scopedStudent(tx, a, sid, 'hostel.manage');
      const r = await tx.query('update bed_assignments set effective_to = $2 where student_id = $1 and effective_to is null and effective_from <= $2 returning id', [sid, effectiveTo]);
      if (!r.rowCount) throw new NotFoundException({ error: 'no_active_allocation' });
      await audit(tx, a, a.tenantId, 'hostel.release', 'student', sid, s.campus_id);
      return { released: true };
    });
  }

  // ---------- leave & gate passes ----------
  @Post('leave-requests')
  requestLeave(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(leaveS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [b.studentId]);
      const guardian = s && await isGuardianOf(tx, a.userId, s.id);
      if (!s || !(guardian || can(a, 'leave.approve', s.campus_id))) throw new NotFoundException({ error: 'not_found' });
      if (await currentResidence(tx, s.id) !== 'boarder') throw new UnprocessableEntityException({ error: 'student_not_boarder' });
      if (Date.parse(b.expectedReturnAt) <= Date.parse(b.departAt)) throw new UnprocessableEntityException({ error: 'return_before_departure' });
      const { rows: [open] } = await tx.query(`select id from leave_requests where student_id = $1 and status in ('requested','approved','out')`, [s.id]);
      if (open) throw new ConflictException({ error: 'open_leave_exists', leaveRequestId: open.id });
      const { rows: [r] } = await tx.query(
        'insert into leave_requests(tenant_id, student_id, requested_by, leave_type, destination, responsible_adult, depart_at, expected_return_at) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *',
        [a.tenantId, s.id, a.userId, b.leaveType, b.destination, b.responsibleAdult, b.departAt, b.expectedReturnAt]);
      await audit(tx, a, a.tenantId, 'leave.request', 'leave_request', r.id, s.campus_id);
      return r;
    });
  }

  /** Staff view (leave.approve) or, with no staff grant, only the caller's own children's requests. */
  @Get('leave-requests')
  listLeave(@Auth() a: AuthContext) {
    const scope = campusScope(a, 'leave.approve');
    const staff = can(a, 'leave.approve');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select l.*, s.first_name, s.last_name, s.admission_no,
        (l.status = 'out' and l.expected_return_at < now()) as overdue
       from leave_requests l join students s on s.id = l.student_id
       where ($3::boolean and ($1::uuid[] is null or s.campus_id = any($1)))
          or exists (select 1 from student_guardians sg join guardians g on g.id = sg.guardian_id where sg.student_id = l.student_id and g.user_id = $2)
       order by l.created_at desc limit 200`, [scope, a.userId, staff])).rows);
  }

  @Post('leave-requests/:id/decision')
  decide(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(decisionS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { l, s } = await this.leave(tx, id);
      needs(a, 'leave.approve', s.campus_id);
      if (l.status !== 'requested') throw new ConflictException({ error: 'not_pending', status: l.status });
      const status = b.decision === 'approve' ? 'approved' : 'rejected';
      const { rows: [r] } = await tx.query('update leave_requests set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1 returning *', [id, status, a.userId, b.note ?? null]);
      await audit(tx, a, a.tenantId, `leave.${status}`, 'leave_request', id, s.campus_id);
      return r;
    });
  }

  @Post('leave-requests/:id/cancel')
  cancel(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { l, s } = await this.leave(tx, id);
      const mine = l.requested_by === a.userId || (await isGuardianOf(tx, a.userId, s.id));
      if (!mine) needs(a, 'leave.approve', s.campus_id);
      if (!['requested', 'approved'].includes(l.status)) throw new ConflictException({ error: 'cannot_cancel', status: l.status });
      const { rows: [r] } = await tx.query(`update leave_requests set status = 'cancelled' where id = $1 returning *`, [id]);
      await audit(tx, a, a.tenantId, 'leave.cancel', 'leave_request', id, s.campus_id);
      return r;
    });
  }

  @Post('leave-requests/:id/gate-out')
  gateOut(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { l, s } = await this.leave(tx, id);
      needs(a, 'gate.record', s.campus_id);
      if (l.status !== 'approved') throw new ConflictException({ error: 'not_approved', status: l.status });
      const { rows: [r] } = await tx.query(`update leave_requests set status = 'out', gate_out_at = now() where id = $1 returning *`, [id]);
      await tx.query(`insert into gate_movements(tenant_id, student_id, direction, leave_request_id, recorded_by) values ($1,$2,'out',$3,$4)`, [a.tenantId, s.id, id, a.userId]);
      await audit(tx, a, a.tenantId, 'gate.out', 'student', s.id, s.campus_id, { leaveRequestId: id });
      return r;
    });
  }

  @Post('leave-requests/:id/gate-in')
  gateIn(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { l, s } = await this.leave(tx, id);
      needs(a, 'gate.record', s.campus_id);
      if (l.status !== 'out') throw new ConflictException({ error: 'not_out', status: l.status });
      const { rows: [r] } = await tx.query(`update leave_requests set status = 'returned', gate_in_at = now() where id = $1 returning *, (expected_return_at < now()) as returned_late`, [id]);
      await tx.query(`insert into gate_movements(tenant_id, student_id, direction, leave_request_id, recorded_by) values ($1,$2,'in',$3,$4)`, [a.tenantId, s.id, id, a.userId]);
      await audit(tx, a, a.tenantId, 'gate.in', 'student', s.id, s.campus_id, { leaveRequestId: id, late: r.returned_late });
      return r;
    });
  }

  /** Who is on campus, on approved leave, or overdue right now (boarders only). */
  @Get('hostel/status')
  status(@Auth() a: AuthContext) {
    needs(a, 'hostel.read');
    const scope = campusScope(a, 'hostel.read');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const rows = (await tx.query(
        `select s.id, s.admission_no, s.first_name, s.last_name, h.name as hostel, r.number as room, b.label as bed,
           l.id as leave_request_id, l.expected_return_at,
           case when l.status = 'out' and l.expected_return_at < now() then 'overdue'
                when l.status = 'out' then 'on_leave' else 'on_campus' end as presence
         from students s join residence_assignments ra on ra.student_id = s.id and ra.effective_to is null and ra.residence_type = 'boarder'
         left join bed_assignments ba on ba.student_id = s.id and ba.effective_to is null left join beds b on b.id = ba.bed_id
         left join rooms r on r.id = b.room_id left join hostels h on h.id = r.hostel_id
         left join leave_requests l on l.student_id = s.id and l.status = 'out'
         where s.status = 'active' and ($1::uuid[] is null or s.campus_id = any($1)) order by s.last_name, s.first_name`, [scope])).rows;
      const summary = { on_campus: 0, on_leave: 0, overdue: 0 } as Record<string, number>;
      for (const r of rows) summary[r.presence]++;
      return { summary, students: rows };
    });
  }

  // ---------- roll calls ----------
  @Post('hostels/:id/roll-calls')
  rollCall(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(rollS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const h = await this.hostel(tx, id);
      needs(a, 'rollcall.record', h.campus_id);
      const residents = (await tx.query(
        `select s.id, (select 1 from leave_requests l where l.student_id = s.id and l.status = 'out') as is_out
         from bed_assignments ba join beds bd on bd.id = ba.bed_id join rooms r on r.id = bd.room_id join students s on s.id = ba.student_id
         where r.hostel_id = $1 and ba.effective_to is null`, [id])).rows;
      const expected = new Map(residents.map((r) => [r.id as string, !!r.is_out]));
      const given = new Set(b.entries.map((e) => e.studentId));
      if (given.size !== b.entries.length) throw new UnprocessableEntityException({ error: 'duplicate_entries' });
      const unknown = [...given].filter((s) => !expected.has(s));
      const missing = [...expected.keys()].filter((s) => !given.has(s));
      if (unknown.length || missing.length) throw new UnprocessableEntityException({ error: 'roll_call_incomplete', missing, unknown });
      const { rows: [rc] } = await tx.query('insert into roll_calls(tenant_id, hostel_id, session, roll_date, recorded_by) values ($1,$2,$3,$4,$5) returning id', [a.tenantId, id, b.session, b.date, a.userId]);
      const unaccounted: string[] = []; const conflicts: string[] = [];
      for (const e of b.entries) {
        const out = expected.get(e.studentId)!;
        let flag: string | null = null;
        if (e.status === 'present' && out) { flag = 'present_but_gated_out'; conflicts.push(e.studentId); }
        if (e.status === 'on_leave' && !out) { flag = 'on_leave_without_gate_out'; conflicts.push(e.studentId); }
        if (e.status === 'absent' && !out) { flag = 'unaccounted'; unaccounted.push(e.studentId); }
        await tx.query('insert into roll_call_entries(tenant_id, roll_call_id, student_id, status, flag) values ($1,$2,$3,$4,$5)', [a.tenantId, rc.id, e.studentId, e.status, flag]);
      }
      // Unaccounted-for students open a missing-student incident for escalation.
      for (const sid of unaccounted) {
        const { rows: [inc] } = await tx.query(
          `insert into incidents(tenant_id, campus_id, category, severity, title, description, student_id, reported_by) values ($1,$2,'missing_student','critical','Student unaccounted for at roll call',$3,$4,$5) returning id`,
          [a.tenantId, h.campus_id, `Absent at ${b.session} roll call (${b.date}) with no approved leave on record.`, sid, a.userId]);
        await tx.query(`insert into incident_events(tenant_id, incident_id, actor_user_id, action, note) values ($1,$2,$3,'created','Auto-raised by roll call')`, [a.tenantId, inc.id, a.userId]);
      }
      await audit(tx, a, a.tenantId, 'rollcall.record', 'roll_call', rc.id, h.campus_id, { session: b.session, unaccounted: unaccounted.length, conflicts: conflicts.length });
      return { id: rc.id, unaccounted, conflicts };
    });
  }

  private async hostel(tx: Tx, id: string) {
    const { rows: [h] } = await tx.query('select * from hostels where id = $1', [id]);
    if (!h) throw new NotFoundException({ error: 'not_found' });
    return h;
  }
  private async leave(tx: Tx, id: string) {
    const { rows: [l] } = await tx.query('select * from leave_requests where id = $1 for update', [id]);
    if (!l) throw new NotFoundException({ error: 'not_found' });
    const { rows: [s] } = await tx.query('select * from students where id = $1', [l.student_id]);
    return { l, s };
  }
}
void ForbiddenException;
