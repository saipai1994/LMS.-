import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, can, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';

const createS = z.object({
  campusId: uuid, category: z.enum(['safety', 'discipline', 'medical', 'safeguarding', 'maintenance', 'missing_student']),
  severity: z.enum(['low', 'medium', 'high', 'critical']), title: z.string().min(3).max(200), description: z.string().min(3).max(4000), studentId: uuid.optional(),
});
const assignS = z.object({ assignTo: uuid, note: z.string().max(1000).optional() });
const noteS = z.object({ note: z.string().min(3).max(2000) });

@Controller('incidents')
export class IncidentsController {
  constructor(private db: DbService) {}

  /** Visible to: the reporter, the assignee, or incident.manage on the campus. Safeguarding needs safeguarding.manage. */
  private visible(a: AuthContext, i: { campus_id: string; category: string; reported_by: string; assigned_to: string | null }) {
    if (i.category === 'safeguarding') return can(a, 'safeguarding.manage', i.campus_id) || i.reported_by === a.userId;
    return can(a, 'incident.manage', i.campus_id) || i.reported_by === a.userId || i.assigned_to === a.userId;
  }

  @Post()
  create(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(createS, body);
    needs(a, 'incident.report', b.campusId);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [i] } = await tx.query(
        'insert into incidents(tenant_id, campus_id, category, severity, title, description, student_id, reported_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, status, category, severity, title',
        [a.tenantId, b.campusId, b.category, b.severity, b.title, b.description, b.studentId ?? null, a.userId]);
      await this.event(tx, a, i.id, 'created');
      await audit(tx, a, a.tenantId, 'incident.create', 'incident', i.id, b.campusId, { category: b.category, severity: b.severity });
      return i;
    });
  }

  @Get()
  list(@Auth() a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select id, campus_id, category, severity, title, status, student_id, assigned_to, reported_by, created_at from incidents order by created_at desc limit 200`)).rows
      .filter((i) => this.visible(a, i)));
  }

  @Get(':id')
  get(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const i = await this.load(tx, a, id);
      const events = (await tx.query('select action, note, actor_user_id, at from incident_events where incident_id = $1 order by id', [id])).rows;
      await audit(tx, a, a.tenantId, 'incident.read', 'incident', id, i.campus_id);
      return { ...i, events };
    });
  }

  @Post(':id/assign')
  assign(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(assignS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const i = await this.load(tx, a, id);
      this.manage(a, i);
      if (i.status === 'closed') throw new ConflictException({ error: 'closed' });
      const assignee = (await tx.query(`select u.id from users u where u.id = $1 and u.status = 'active'`, [b.assignTo])).rows[0];
      if (!assignee) throw new UnprocessableEntityException({ error: 'invalid_assignee' });
      // the assignee must themselves be allowed to see this kind of incident
      const ok = (await tx.query(`select 1 from user_roles ur join role_permissions rp on rp.role_id = ur.role_id where ur.user_id = $1 and rp.permission = $2 and (ur.campus_id is null or ur.campus_id = $3)`,
        [b.assignTo, i.category === 'safeguarding' ? 'safeguarding.manage' : 'incident.manage', i.campus_id])).rowCount;
      if (!ok) throw new UnprocessableEntityException({ error: 'assignee_lacks_permission' });
      await tx.query(`update incidents set assigned_to = $2, status = case when status = 'open' then 'investigating' else status end where id = $1`, [id, b.assignTo]);
      await this.event(tx, a, id, 'assigned', b.note ?? null);
      await audit(tx, a, a.tenantId, 'incident.assign', 'incident', id, i.campus_id, { assignTo: b.assignTo });
      return { assigned: true };
    });
  }

  @Post(':id/escalate')
  escalate(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(noteS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const i = await this.load(tx, a, id);
      this.manage(a, i);
      if (i.status === 'closed') throw new ConflictException({ error: 'closed' });
      await tx.query(`update incidents set status = 'escalated' where id = $1`, [id]);
      await this.event(tx, a, id, 'escalated', b.note);
      await audit(tx, a, a.tenantId, 'incident.escalate', 'incident', id, i.campus_id);
      return { status: 'escalated' };
    });
  }

  @Post(':id/note')
  note(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(noteS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const i = await this.load(tx, a, id);
      this.manage(a, i);
      await this.event(tx, a, id, 'note', b.note);
      return { ok: true };
    });
  }

  @Post(':id/close')
  close(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(noteS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const i = await this.load(tx, a, id);
      this.manage(a, i);
      if (i.status === 'closed') throw new ConflictException({ error: 'closed' });
      await tx.query(`update incidents set status = 'closed', closure_note = $2 where id = $1`, [id, b.note]);
      await this.event(tx, a, id, 'closed', b.note);
      await audit(tx, a, a.tenantId, 'incident.close', 'incident', id, i.campus_id);
      return { status: 'closed' };
    });
  }

  private manage(a: AuthContext, i: { campus_id: string; category: string; assigned_to: string | null }) {
    const perm = i.category === 'safeguarding' ? 'safeguarding.manage' : 'incident.manage';
    if (!can(a, perm, i.campus_id) && i.assigned_to !== a.userId) throw new NotFoundException({ error: 'not_found' });
  }
  private async load(tx: Tx, a: AuthContext, id: string) {
    const { rows: [i] } = await tx.query('select * from incidents where id = $1', [id]);
    if (!i || !this.visible(a, i)) throw new NotFoundException({ error: 'not_found' });
    return i;
  }
  private event(tx: Tx, a: AuthContext, incidentId: string, action: string, note: string | null = null) {
    return tx.query('insert into incident_events(tenant_id, incident_id, actor_user_id, action, note) values ($1,$2,$3,$4,$5)', [a.tenantId, incidentId, a.userId, action, note]);
  }
}
