import { Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Put, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { Auth, AuthContext, campusScope, can, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { currentResidence, guardianUserIds, isGuardianOf, notify, scopedStudent } from '../sis/access';

const addS = z.object({ fullName: z.string().min(2).max(200), relationship: z.string().min(2).max(100), idHint: z.string().max(20).optional(), validUntil: z.string().date().optional() });
const handoverS = z.object({
  studentId: uuid, guardianId: uuid.optional(), authorizedPickupId: uuid.optional(), idVerified: z.boolean(),
}).refine((v) => !!v.guardianId !== !!v.authorizedPickupId, { message: 'exactly one of guardianId / authorizedPickupId' });

@Controller()
export class DismissalController {
  constructor(private db: DbService) {}

  /** A linked guardian (or staff with student.write) maintains who may collect the child. */
  @Post('students/:id/authorized-pickups')
  add(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(addS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      if (!s || !((await isGuardianOf(tx, a.userId, id)) || can(a, 'student.write', s.campus_id))) throw new NotFoundException({ error: 'not_found' });
      const { rows: [r] } = await tx.query('insert into authorized_pickups(tenant_id, student_id, full_name, relationship, id_hint, valid_until, added_by) values ($1,$2,$3,$4,$5,$6,$7) returning *',
        [a.tenantId, id, b.fullName, b.relationship, b.idHint ?? null, b.validUntil ?? null, a.userId]);
      await audit(tx, a, a.tenantId, 'pickup.authorize', 'student', id, s.campus_id, { person: b.fullName });
      return r;
    });
  }

  @Post('authorized-pickups/:id/revoke')
  revoke(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [p] } = await tx.query('select * from authorized_pickups where id = $1', [id]);
      const { rows: [s] } = p ? await tx.query('select * from students where id = $1', [p.student_id]) : { rows: [] as any[] };
      if (!p || !((await isGuardianOf(tx, a.userId, p.student_id)) || can(a, 'student.write', s.campus_id))) throw new NotFoundException({ error: 'not_found' });
      await tx.query('update authorized_pickups set active = false where id = $1', [id]);
      await audit(tx, a, a.tenantId, 'pickup.revoke', 'authorized_pickup', id, s.campus_id);
      return { revoked: true };
    });
  }

  /** Gate staff view: who may collect this child today (guardians flagged can_pickup + valid authorized persons). */
  @Get('students/:id/pickup-list')
  pickupList(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const s = await scopedStudent(tx, a, id, 'dismissal.record');
      return {
        guardians: (await tx.query('select g.id, g.full_name, sg.relationship from student_guardians sg join guardians g on g.id = sg.guardian_id where sg.student_id = $1 and sg.can_pickup', [s.id])).rows,
        authorized: (await tx.query('select id, full_name, relationship, id_hint from authorized_pickups where student_id = $1 and active and valid_from <= current_date and (valid_until is null or valid_until >= current_date)', [s.id])).rows,
      };
    });
  }

  @Post('dismissal/handover')
  handover(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(handoverS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const s = await scopedStudent(tx, a, b.studentId, 'dismissal.record');
      if (await currentResidence(tx, s.id) !== 'day_scholar') throw new UnprocessableEntityException({ error: 'not_day_scholar' });
      if (!b.idVerified) throw new UnprocessableEntityException({ error: 'identity_not_verified' });
      // Campuses that configure a dismissal time only release children earlier on an approved early-dismissal request.
      const cfg = await this.campusConfig(tx, s.campus_id);
      if (cfg.dismissalTime) {
        const nowLocal = (await tx.query(`select to_char(now() at time zone $1, 'HH24:MI') t, (now() at time zone $1)::date d`, [cfg.timezone])).rows[0];
        if (nowLocal.t < cfg.dismissalTime) {
          const ok = await tx.query(`select 1 from early_dismissal_requests where student_id = $1 and for_date = $2 and status = 'approved'`, [s.id, nowLocal.d]);
          if (!ok.rowCount) throw new UnprocessableEntityException({ error: 'early_dismissal_not_approved', dismissalTime: cfg.dismissalTime });
        }
      }
      const dup = await tx.query('select 1 from pickup_events where student_id = $1 and event_date = current_date', [s.id]);
      if (dup.rowCount) throw new ConflictException({ error: 'already_handed_over' });
      let name: string | null = null;
      if (b.guardianId) {
        const g = await tx.query('select g.full_name from student_guardians sg join guardians g on g.id = sg.guardian_id where sg.student_id = $1 and g.id = $2 and sg.can_pickup', [s.id, b.guardianId]);
        name = g.rows[0]?.full_name ?? null;
      } else {
        const p = await tx.query('select full_name from authorized_pickups where id = $1 and student_id = $2 and active and valid_from <= current_date and (valid_until is null or valid_until >= current_date)', [b.authorizedPickupId, s.id]);
        name = p.rows[0]?.full_name ?? null;
      }
      if (!name) {
        // Persist the refusal for the audit trail, then reject.
        await audit(tx, a, a.tenantId, 'dismissal.unauthorized_attempt', 'student', s.id, s.campus_id, { guardianId: b.guardianId, authorizedPickupId: b.authorizedPickupId });
        throw Object.assign(new ForbiddenException({ error: 'not_authorized_for_pickup' }), { commit: true });
      }
      const { rows: [e] } = await tx.query('insert into pickup_events(tenant_id, student_id, guardian_id, authorized_pickup_id, collected_by_name, id_verified, recorded_by) values ($1,$2,$3,$4,$5,true,$6) returning id, at',
        [a.tenantId, s.id, b.guardianId ?? null, b.authorizedPickupId ?? null, name, a.userId]);
      await notify(tx, a.tenantId, await guardianUserIds(tx, s.id), 'dismissal.handover', 'Child collected', `${s.first_name} was handed over to ${name}.`);
      await audit(tx, a, a.tenantId, 'dismissal.handover', 'student', s.id, s.campus_id, { collectedBy: name });
      return { id: e.id, at: e.at, collectedBy: name };
    });
  }

  /** Daily reconciliation of day scholars: collected vs still on campus. */
  @Get('dismissal/today')
  today(@Auth() a: AuthContext) {
    needs(a, 'dismissal.record');
    const scope = campusScope(a, 'dismissal.record');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const rows = (await tx.query(
        `select s.id, s.admission_no, s.first_name, s.last_name, pe.collected_by_name, pe.at,
           (pe.id is not null) as collected
         from students s join residence_assignments ra on ra.student_id = s.id and ra.effective_to is null and ra.residence_type = 'day_scholar'
         left join pickup_events pe on pe.student_id = s.id and pe.event_date = current_date
         where s.status = 'active' and ($1::uuid[] is null or s.campus_id = any($1)) order by collected, s.last_name`, [scope])).rows;
      return { collected: rows.filter((r) => r.collected).length, pending: rows.filter((r) => !r.collected).length, students: rows };
    });
  }

  private async campusConfig(tx: import('../db/db.service').Tx, campusId: string) {
    const { rows: [c] } = await tx.query('select settings from campuses where id = $1', [campusId]);
    const st = c?.settings ?? {};
    return { dismissalTime: (st.dismissalTime as string | undefined) ?? null, graceMinutes: Number(st.lateGraceMinutes ?? 20), escalateMinutes: Number(st.lateEscalateMinutes ?? 60), timezone: (st.timezone as string | undefined) ?? 'Asia/Kolkata' };
  }

  // ---------------- early dismissal requests ----------------
  @Post('dismissal/early-requests')
  requestEarly(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(z.object({ studentId: uuid, forDate: z.string().date(), pickupTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), reason: z.string().min(3).max(300) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [b.studentId]);
      if (!s || !(await isGuardianOf(tx, a.userId, s.id))) throw new NotFoundException({ error: 'not_found' });
      if (await currentResidence(tx, s.id) !== 'day_scholar') throw new UnprocessableEntityException({ error: 'not_day_scholar' });
      if (b.forDate < new Date().toISOString().slice(0, 10)) throw new UnprocessableEntityException({ error: 'date_in_past' });
      const dup = await tx.query(`select 1 from early_dismissal_requests where student_id = $1 and for_date = $2 and status in ('requested','approved')`, [s.id, b.forDate]);
      if (dup.rowCount) throw new ConflictException({ error: 'request_exists' });
      const r = (await tx.query('insert into early_dismissal_requests(tenant_id, student_id, requested_by, for_date, pickup_time, reason) values ($1,$2,$3,$4,$5,$6) returning id, status', [a.tenantId, s.id, a.userId, b.forDate, b.pickupTime, b.reason])).rows[0];
      return r;
    });
  }
  @Get('dismissal/early-requests')
  earlyList(@Auth() a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select r.id, r.for_date, r.pickup_time, r.reason, r.status, s.first_name, s.last_name, s.admission_no, s.campus_id, r.requested_by,
         exists (select 1 from enrollments e join sections sec on sec.id = e.section_id where e.student_id = s.id and e.effective_to is null and sec.class_teacher_user_id = $1) as my_class
       from early_dismissal_requests r join students s on s.id = r.student_id order by r.for_date desc, r.created_at desc limit 100`, [a.userId])).rows
      .filter((r) => r.requested_by === a.userId || r.my_class || can(a, 'dismissal.approve', r.campus_id) || can(a, 'dismissal.record', r.campus_id)).map(({ requested_by, campus_id, ...r }) => r));
  }
  /** Approved by the child's class teacher or a dismissal approver; never by the requesting guardian. */
  @Post('dismissal/early-requests/:id/decision')
  earlyDecide(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const { decision } = parse(z.object({ decision: z.enum(['approve', 'reject']) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [r] } = await tx.query('select r.*, s.campus_id, s.first_name from early_dismissal_requests r join students s on s.id = r.student_id where r.id = $1 for update of r', [id]);
      if (!r) throw new NotFoundException({ error: 'not_found' });
      const classTeacher = await tx.query(`select 1 from enrollments e join sections sec on sec.id = e.section_id where e.student_id = $1 and e.effective_to is null and sec.class_teacher_user_id = $2`, [r.student_id, a.userId]);
      if (!(classTeacher.rowCount || can(a, 'dismissal.approve', r.campus_id))) throw new NotFoundException({ error: 'not_found' });
      if (r.status !== 'requested') throw new ConflictException({ error: 'not_pending' });
      await tx.query('update early_dismissal_requests set status = $2, decided_by = $3, decided_at = now() where id = $1', [id, decision === 'approve' ? 'approved' : 'rejected', a.userId]);
      await notify(tx, a.tenantId, [r.requested_by], 'dismissal.early_decision', 'Early dismissal', `${r.first_name}: early dismissal on ${r.for_date} ${decision === 'approve' ? 'approved' : 'declined'}.`);
      await audit(tx, a, a.tenantId, `dismissal.early_${decision}`, 'student', r.student_id, r.campus_id);
      return { decision };
    });
  }

  // ---------------- late pickup alerts and escalation ----------------
  @Get('dismissal/late')
  late(@Auth() a: AuthContext) {
    needs(a, 'dismissal.record'); const scope = campusScope(a, 'dismissal.record');
    return this.db.withTenant(a.tenantId, async (tx) => this.lateRows(tx, scope));
  }
  private async lateRows(tx: import('../db/db.service').Tx, scope: string[] | null) {
    const rows = (await tx.query(
      `select s.id, s.admission_no, s.first_name, s.last_name, s.campus_id, c.settings from students s join campuses c on c.id = s.campus_id
       join residence_assignments ra on ra.student_id = s.id and ra.effective_to is null and ra.residence_type = 'day_scholar'
       where s.status = 'active' and ($1::uuid[] is null or s.campus_id = any($1)) and not exists (select 1 from pickup_events pe where pe.student_id = s.id and pe.event_date = current_date)`, [scope])).rows;
    const out: any[] = [];
    for (const r of rows) {
      const cfg = await this.campusConfig(tx, r.campus_id);
      if (!cfg.dismissalTime) continue;
      const lateBy = Number((await tx.query(`select floor(extract(epoch from ((now() at time zone $1)::time - $2::time)) / 60)::int m`, [cfg.timezone, cfg.dismissalTime])).rows[0].m);
      if (lateBy >= cfg.graceMinutes) out.push({ studentId: r.id, admissionNo: r.admission_no, name: `${r.first_name} ${r.last_name}`, minutesLate: lateBy, escalate: lateBy >= cfg.escalateMinutes, campusId: r.campus_id });
    }
    return out.sort((x, y) => y.minutesLate - x.minutesLate);
  }
  /** Notifies guardians (once a day per child) and opens an incident for children still uncollected past the escalation threshold. */
  @Post('dismissal/late/notify')
  lateNotify(@Auth() a: AuthContext) {
    needs(a, 'dismissal.record'); const scope = campusScope(a, 'dismissal.record');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const rows = await this.lateRows(tx, scope);
      let notified = 0, escalated = 0;
      for (const r of rows) {
        const users = await guardianUserIds(tx, r.studentId);
        const done = users.length ? await tx.query(`select 1 from notifications where user_id = any($1) and kind = 'dismissal.late' and created_at::date = current_date and body like $2`, [users, `${r.name.split(' ')[0]}%`]) : { rowCount: 0 };
        if (!done.rowCount) { await notify(tx, a.tenantId, users, 'dismissal.late', 'Late pickup', `${r.name.split(' ')[0]} is still waiting to be collected (${r.minutesLate} min after dismissal). Please collect or call the school.`); notified++; }
        if (r.escalate) {
          const title = `Uncollected student: ${r.name}`;
          const dup = await tx.query(`select 1 from incidents where student_id = $1 and category = 'safety' and title = $2 and created_at::date = current_date`, [r.studentId, title]);
          if (!dup.rowCount) {
            const inc = (await tx.query(`insert into incidents(tenant_id, campus_id, category, severity, title, description, student_id, reported_by) values ($1,$2,'safety','high',$3,$4,$5,$6) returning id`, [a.tenantId, r.campusId, title, `Not collected ${r.minutesLate} minutes after dismissal; guardians notified.`, r.studentId, a.userId])).rows[0];
            await tx.query(`insert into incident_events(tenant_id, incident_id, actor_user_id, action, note) values ($1,$2,$3,'created','Auto-raised by late-pickup escalation')`, [a.tenantId, inc.id, a.userId]);
            escalated++;
          }
        }
      }
      return { late: rows.length, notified, escalated };
    });
  }
}
