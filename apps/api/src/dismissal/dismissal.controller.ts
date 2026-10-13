import { Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Post, UnprocessableEntityException } from '@nestjs/common';
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
}
