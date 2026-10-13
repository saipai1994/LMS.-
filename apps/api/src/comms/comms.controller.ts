import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, can, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';

const annS = z.object({
  title: z.string().min(3).max(200), body: z.string().min(3).max(5000),
  audienceType: z.enum(['all', 'staff', 'parents', 'students', 'grade', 'section', 'hostel']), audienceRef: uuid.optional(),
  channels: z.array(z.enum(['in_app', 'email', 'sms'])).min(1).default(['in_app']), priority: z.enum(['normal', 'emergency']).default('normal'),
  scheduledFor: z.string().datetime().optional(),
});
const tplS = z.object({ key: z.string().min(2).max(60), channel: z.enum(['in_app', 'email', 'sms']), language: z.string().min(2).max(5).default('en'), subject: z.string().max(200).optional(), body: z.string().min(2).max(2000) });
const ticketS = z.object({ category: z.enum(['request', 'complaint', 'fees', 'academic', 'transport', 'hostel', 'other']), subject: z.string().min(3).max(200), body: z.string().min(3).max(4000), studentId: uuid.optional() });
const SLA_HOURS: Record<string, number> = { complaint: 24, fees: 48, request: 72, academic: 72, transport: 24, hostel: 24, other: 96 };

/** Resolves the users an announcement targets. */
async function audience(tx: Tx, type: string, ref: string | null): Promise<string[]> {
  const q = async (sql: string, p: unknown[] = []) => (await tx.query(sql, p)).rows.map((r) => r.id as string);
  const guardiansOf = `select distinct g.user_id as id from student_guardians sg join guardians g on g.id = sg.guardian_id where g.user_id is not null`;
  switch (type) {
    case 'all': return q(`select id from users where status = 'active'`);
    case 'staff': return q(`select distinct u.id from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where u.status = 'active' and r.key not in ('parent','student')`);
    case 'parents': return q(`select distinct g.user_id as id from guardians g join users u on u.id = g.user_id where u.status = 'active'`);
    case 'students': return q(`select user_id as id from students where user_id is not null and status = 'active'`);
    case 'grade': return q(`select distinct x.id from (${guardiansOf} and sg.student_id in (select e.student_id from enrollments e join sections s on s.id = e.section_id where e.effective_to is null and s.grade_level_id = $1) union select st.user_id from students st join enrollments e on e.student_id = st.id and e.effective_to is null join sections s on s.id = e.section_id where s.grade_level_id = $1 and st.user_id is not null) x`, [ref]);
    case 'section': return q(`select distinct x.id from (${guardiansOf} and sg.student_id in (select student_id from enrollments where section_id = $1 and effective_to is null) union select st.user_id from students st join enrollments e on e.student_id = st.id and e.effective_to is null where e.section_id = $1 and st.user_id is not null) x`, [ref]);
    case 'hostel': return q(`select distinct x.id from (${guardiansOf} and sg.student_id in (select ba.student_id from bed_assignments ba join beds b on b.id = ba.bed_id join rooms r on r.id = b.room_id where r.hostel_id = $1 and ba.effective_to is null)) x`, [ref]);
    default: return [];
  }
}

@Controller()
export class CommsController {
  constructor(private db: DbService) {}

  @Post('announcements')
  create(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'comms.manage'); const b = parse(annS, body);
    if (['grade', 'section', 'hostel'].includes(b.audienceType) && !b.audienceRef) throw new UnprocessableEntityException({ error: 'audience_ref_required' });
    if (b.priority === 'emergency' && b.scheduledFor) throw new UnprocessableEntityException({ error: 'emergency_cannot_be_scheduled' });
    return this.db.withTenant(a.tenantId, async (tx) => {
      const ann = (await tx.query('insert into announcements(tenant_id, title, body, audience_type, audience_ref, channels, priority, scheduled_for, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id', [a.tenantId, b.title, b.body, b.audienceType, b.audienceRef ?? null, b.channels, b.priority, b.scheduledFor ?? null, a.userId])).rows[0];
      await audit(tx, a, a.tenantId, 'comms.announcement', 'announcement', ann.id, null, { audience: b.audienceType, priority: b.priority });
      if (!b.scheduledFor || Date.parse(b.scheduledFor) <= Date.now()) return { id: ann.id, ...(await this.dispatch(tx, a.tenantId, ann.id)) };
      return { id: ann.id, status: 'scheduled' };
    });
  }

  /** Sends all announcements whose time has come. Called by the in-process scheduler and by operators. */
  @Post('announcements/dispatch-due')
  dispatchDue(@Auth() a: AuthContext) {
    needs(a, 'comms.manage');
    return this.dispatchDueFor(a.tenantId);
  }
  async dispatchDueFor(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const due = (await tx.query(`select id from announcements where status = 'scheduled' and (scheduled_for is null or scheduled_for <= now()) for update skip locked`)).rows;
      let sent = 0;
      for (const d of due) { await this.dispatch(tx, tenantId, d.id); sent++; }
      return { dispatched: sent };
    });
  }
  private async dispatch(tx: Tx, tenantId: string, id: string) {
    const { rows: [ann] } = await tx.query('select * from announcements where id = $1 for update', [id]);
    if (ann.status !== 'scheduled') return { status: ann.status, recipients: ann.recipients };
    const users = await audience(tx, ann.audience_type, ann.audience_ref);
    const prefs = new Map<string, boolean>((await tx.query('select user_id || channel as k, enabled from notification_prefs')).rows.map((r) => [r.k, r.enabled]));
    const emergency = ann.priority === 'emergency';
    for (const u of users) {
      // Emergency broadcasts ignore opt-outs; ordinary announcements respect them.
      if (ann.channels.includes('in_app') && (emergency || prefs.get(`${u}in_app`) !== false))
        await tx.query(`insert into notifications(tenant_id, user_id, kind, title, body) values ($1,$2,$3,$4,$5)`, [tenantId, u, emergency ? 'announcement.emergency' : 'announcement', ann.title, ann.body]);
      for (const ch of ['email', 'sms'] as const) {
        if (!ann.channels.includes(ch)) continue;
        if (!emergency && prefs.get(`${u}${ch}`) === false) { await tx.query(`insert into delivery_attempts(tenant_id, announcement_id, user_id, channel, status) values ($1,$2,$3,$4,'skipped_by_preference')`, [tenantId, id, u, ch]); continue; }
        // No provider is configured: record the truth instead of pretending delivery happened.
        await tx.query(`insert into delivery_attempts(tenant_id, announcement_id, user_id, channel, status, error) values ($1,$2,$3,$4,'not_configured',$5)`, [tenantId, id, u, ch, `No ${ch} provider is configured`]);
      }
    }
    await tx.query(`update announcements set status = 'sent', sent_at = now(), recipients = $2 where id = $1`, [id, users.length]);
    return { status: 'sent', recipients: users.length };
  }

  @Get('announcements')
  list(@Auth() a: AuthContext) {
    needs(a, 'comms.manage');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(`select id, title, audience_type, priority, channels, status, scheduled_for, sent_at, recipients from announcements order by created_at desc limit 100`)).rows);
  }
  @Get('announcements/:id/delivery')
  delivery(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id); needs(a, 'comms.manage');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [ann] } = await tx.query('select id, status, recipients from announcements where id = $1', [id]);
      if (!ann) throw new NotFoundException({ error: 'not_found' });
      const by = (await tx.query('select channel, status, count(*)::int n from delivery_attempts where announcement_id = $1 group by channel, status', [id])).rows;
      return { ...ann, inApp: 'delivered', external: by, note: by.some((x) => x.status === 'not_configured') ? 'Email/SMS providers are not configured; those messages were NOT delivered.' : undefined };
    });
  }
  @Post('announcements/:id/cancel')
  cancel(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id); needs(a, 'comms.manage');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const r = await tx.query(`update announcements set status = 'cancelled' where id = $1 and status = 'scheduled' returning id`, [id]);
      if (!r.rowCount) throw new ConflictException({ error: 'not_cancellable' });
      return { cancelled: true };
    });
  }

  @Post('templates')
  tpl(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'comms.manage'); const b = parse(tplS, body);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(`insert into message_templates(tenant_id, key, channel, language, subject, body) values ($1,$2,$3,$4,$5,$6) on conflict (tenant_id, key, channel, language) do update set subject = excluded.subject, body = excluded.body returning id`, [a.tenantId, b.key, b.channel, b.language, b.subject ?? null, b.body])).rows[0]);
  }
  @Post('templates/render')
  render(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'comms.manage'); const b = parse(z.object({ key: z.string(), channel: z.enum(['in_app', 'email', 'sms']), language: z.string().default('en'), vars: z.record(z.string(), z.string().max(200)).default({}) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [t] } = await tx.query('select * from message_templates where key = $1 and channel = $2 and language = $3', [b.key, b.channel, b.language]);
      if (!t) throw new NotFoundException({ error: 'template_not_found' });
      const fill = (s: string | null) => s?.replace(/\{\{(\w+)\}\}/g, (_m, k) => b.vars[k] ?? `{{${k}}}`) ?? null;
      const missing = [...(t.body as string).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).filter((k) => !(k in b.vars));
      if (missing.length) throw new UnprocessableEntityException({ error: 'missing_variables', missing });
      return { subject: fill(t.subject), body: fill(t.body) };
    });
  }

  @Post('me/notification-prefs')
  prefs(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(z.object({ channel: z.enum(['in_app', 'email', 'sms']), enabled: z.boolean() }), body);
    return this.db.withTenant(a.tenantId, async (tx) => { await tx.query('insert into notification_prefs(tenant_id, user_id, channel, enabled) values ($1,$2,$3,$4) on conflict (user_id, channel) do update set enabled = excluded.enabled', [a.tenantId, a.userId, b.channel, b.enabled]); return b; });
  }

  // ---------------- support tickets with SLA ----------------
  @Post('tickets')
  openTicket(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(ticketS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      if (b.studentId) {
        const ok = await tx.query('select 1 from student_guardians sg join guardians g on g.id = sg.guardian_id where sg.student_id = $1 and g.user_id = $2 union select 1 from students where id = $1 and user_id = $2', [b.studentId, a.userId]);
        if (!ok.rowCount && !can(a, 'tickets.manage')) throw new NotFoundException({ error: 'not_found' });
      }
      const t = (await tx.query(`insert into tickets(tenant_id, requester_id, student_id, category, subject, body, sla_due_at) values ($1,$2,$3,$4,$5,$6, now() + ($7 || ' hours')::interval) returning id, status, sla_due_at`, [a.tenantId, a.userId, b.studentId ?? null, b.category, b.subject, b.body, SLA_HOURS[b.category]])).rows[0];
      return t;
    });
  }
  @Get('tickets')
  tickets(@Auth() a: AuthContext) {
    const staff = can(a, 'tickets.manage');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select t.id, t.category, t.subject, t.status, t.created_at, t.sla_due_at, t.assigned_to, u.full_name as requester, (t.status <> 'resolved' and t.sla_due_at < now()) as sla_breached
       from tickets t join users u on u.id = t.requester_id where ($1::boolean or t.requester_id = $2) order by t.created_at desc limit 200`, [staff, a.userId])).rows);
  }
  @Get('tickets/:id')
  ticket(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const t = await this.load(tx, a, id);
      const staff = can(a, 'tickets.manage');
      const comments = (await tx.query(`select c.body, c.internal, c.at, u.full_name as author from ticket_comments c join users u on u.id = c.author_id where c.ticket_id = $1 and ($2::boolean or not c.internal) order by c.id`, [id, staff])).rows;
      return { ...t, comments };
    });
  }
  @Post('tickets/:id/comments')
  comment(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(z.object({ body: z.string().min(1).max(4000), internal: z.boolean().default(false) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const t = await this.load(tx, a, id);
      if (b.internal && !can(a, 'tickets.manage')) throw new NotFoundException({ error: 'not_found' });
      await tx.query('insert into ticket_comments(tenant_id, ticket_id, author_id, body, internal) values ($1,$2,$3,$4,$5)', [a.tenantId, id, a.userId, b.body, b.internal]);
      if (!b.internal && t.requester_id !== a.userId) await tx.query(`insert into notifications(tenant_id, user_id, kind, title, body) values ($1,$2,'ticket.reply','Reply to your request',$3)`, [a.tenantId, t.requester_id, `Re: ${t.subject}`]);
      return { added: true };
    });
  }
  @Post('tickets/:id/status')
  setStatus(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); needs(a, 'tickets.manage'); const b = parse(z.object({ status: z.enum(['open', 'in_progress', 'resolved']), assignTo: uuid.optional() }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const r = await tx.query(`update tickets set status = $2, assigned_to = coalesce($3, assigned_to), resolved_at = case when $2 = 'resolved' then now() else null end where id = $1 returning id`, [id, b.status, b.assignTo ?? null]);
      if (!r.rowCount) throw new NotFoundException({ error: 'not_found' });
      await audit(tx, a, a.tenantId, 'tickets.status', 'ticket', id, null, { status: b.status });
      return { status: b.status };
    });
  }
  private async load(tx: Tx, a: AuthContext, id: string) {
    const { rows: [t] } = await tx.query('select * from tickets where id = $1', [id]);
    if (!t || !(t.requester_id === a.userId || can(a, 'tickets.manage'))) throw new NotFoundException({ error: 'not_found' });
    return t;
  }
}
