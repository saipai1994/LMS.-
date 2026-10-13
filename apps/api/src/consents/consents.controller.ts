import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Req, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, can, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { guardianUserIds, isGuardianOf, notify } from '../sis/access';

const formS = z.object({ title: z.string().min(3).max(200), body: z.string().min(10).max(5000), audienceType: z.enum(['all', 'grade', 'section', 'activity']), audienceRef: uuid.optional(), dueOn: z.string().date().optional() });
const respondS = z.object({ studentId: uuid, decision: z.enum(['agree', 'decline']), signedName: z.string().min(2).max(100), confirm: z.literal(true) });

/** Students a form applies to. */
async function targets(tx: Tx, f: { audience_type: string; audience_ref: string | null }): Promise<{ id: string; first_name: string; last_name: string; admission_no: string }[]> {
  const base = `select s.id, s.first_name, s.last_name, s.admission_no from students s where s.status = 'active'`;
  switch (f.audience_type) {
    case 'all': return (await tx.query(base)).rows;
    case 'grade': return (await tx.query(`${base} and exists (select 1 from enrollments e join sections sec on sec.id = e.section_id where e.student_id = s.id and e.effective_to is null and sec.grade_level_id = $1)`, [f.audience_ref])).rows;
    case 'section': return (await tx.query(`${base} and exists (select 1 from enrollments e where e.student_id = s.id and e.effective_to is null and e.section_id = $1)`, [f.audience_ref])).rows;
    default: return (await tx.query(`${base} and exists (select 1 from activity_registrations r where r.student_id = s.id and r.activity_id = $1 and r.status <> 'withdrawn')`, [f.audience_ref])).rows;
  }
}

/** Digital consent forms with a recorded acknowledgement per child. Responses are evidence: they cannot be changed, only superseded by the school closing the form. */
@Controller('consents')
export class ConsentsController {
  constructor(private db: DbService) {}

  @Post()
  create(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(formS, body);
    if (b.audienceType !== 'all' && !b.audienceRef) throw new UnprocessableEntityException({ error: 'audience_ref_required' });
    return this.db.withTenant(a.tenantId, async (tx) => {
      if (!(can(a, 'consents.manage') || can(a, 'activities.manage'))) throw new NotFoundException({ error: 'not_found' });
      const f = (await tx.query('insert into consent_forms(tenant_id, title, body, audience_type, audience_ref, due_on, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id, audience_type, audience_ref', [a.tenantId, b.title, b.body, b.audienceType, b.audienceRef ?? null, b.dueOn ?? null, a.userId])).rows[0];
      const kids = await targets(tx, f);
      let notified = 0;
      for (const k of kids) { const u = await guardianUserIds(tx, k.id); await notify(tx, a.tenantId, u, 'consent.requested', 'Consent requested', `${b.title} — please respond for ${k.first_name}${b.dueOn ? ` by ${b.dueOn}` : ''}.`); notified += u.length; }
      await audit(tx, a, a.tenantId, 'consent.form_create', 'consent_form', f.id, null, { students: kids.length });
      return { id: f.id, students: kids.length, notified };
    });
  }
  @Get()
  list(@Auth() a: AuthContext) {
    needs(a, 'consents.manage');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(`select f.id, f.title, f.audience_type, f.due_on, f.status, (select count(*) from consent_responses r where r.form_id = f.id)::int as responses, (select count(*) from consent_responses r where r.form_id = f.id and r.decision = 'agree')::int as agreed from consent_forms f order by f.created_at desc`)).rows);
  }
  @Get('status/:id')
  status(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const f = await this.form(tx, a, id); needs(a, 'consents.manage');
      const kids = await targets(tx, f);
      const done = new Map((await tx.query('select student_id, decision, signed_name, at from consent_responses where form_id = $1', [id])).rows.map((r) => [r.student_id as string, r]));
      return { title: f.title, total: kids.length, agreed: [...done.values()].filter((r) => r.decision === 'agree').length, declined: [...done.values()].filter((r) => r.decision === 'decline').length,
        outstanding: kids.filter((k) => !done.has(k.id)).map((k) => ({ studentId: k.id, name: `${k.first_name} ${k.last_name}`, admissionNo: k.admission_no })) };
    });
  }
  @Post(':id/remind')
  remind(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const f = await this.form(tx, a, id); needs(a, 'consents.manage');
      if (f.status !== 'active') throw new ConflictException({ error: 'form_closed' });
      const done = new Set((await tx.query('select student_id from consent_responses where form_id = $1', [id])).rows.map((r) => r.student_id));
      let n = 0;
      for (const k of (await targets(tx, f)).filter((x) => !done.has(x.id))) { await notify(tx, a.tenantId, await guardianUserIds(tx, k.id), 'consent.reminder', 'Reminder: consent needed', `${f.title} — response still needed for ${k.first_name}.`); n++; }
      return { reminded: n };
    });
  }
  @Post(':id/close')
  close(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => { await this.form(tx, a, id); needs(a, 'consents.manage'); await tx.query(`update consent_forms set status = 'closed' where id = $1`, [id]); return { closed: true }; });
  }

  /** Forms awaiting a response from the signed-in guardian, per child. */
  @Get('mine')
  mine(@Auth() a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => {
      const forms = (await tx.query(`select * from consent_forms where status = 'active' order by created_at desc`)).rows;
      const kids = (await tx.query(`select s.id, s.first_name, s.last_name from students s join student_guardians sg on sg.student_id = s.id join guardians g on g.id = sg.guardian_id where g.user_id = $1`, [a.userId])).rows;
      const out: any[] = [];
      for (const f of forms) {
        const ts = new Set((await targets(tx, f)).map((t) => t.id));
        for (const k of kids.filter((x) => ts.has(x.id))) {
          const r = (await tx.query('select decision, signed_name, at from consent_responses where form_id = $1 and student_id = $2', [f.id, k.id])).rows[0];
          out.push({ formId: f.id, title: f.title, body: f.body, dueOn: f.due_on, studentId: k.id, student: `${k.first_name} ${k.last_name}`, response: r ?? null });
        }
      }
      return out;
    });
  }
  @Post(':id/respond')
  respond(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown, @Req() req: any) {
    pid(id); const b = parse(respondS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [f] } = await tx.query('select * from consent_forms where id = $1', [id]);
      if (!f || !(await isGuardianOf(tx, a.userId, b.studentId))) throw new NotFoundException({ error: 'not_found' });
      if (f.status !== 'active') throw new ConflictException({ error: 'form_closed' });
      if (!(await targets(tx, f)).some((t) => t.id === b.studentId)) throw new NotFoundException({ error: 'not_found' });
      const r = await tx.query('insert into consent_responses(tenant_id, form_id, student_id, guardian_user_id, decision, signed_name, ip) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing returning at', [a.tenantId, id, b.studentId, a.userId, b.decision, b.signedName, req.ip]);
      if (!r.rowCount) throw new ConflictException({ error: 'already_responded' });
      await audit(tx, a, a.tenantId, 'consent.respond', 'consent_form', id, null, { studentId: b.studentId, decision: b.decision });
      return { recorded: true, decision: b.decision };
    });
  }
  private async form(tx: Tx, a: AuthContext, id: string) {
    const { rows: [f] } = await tx.query('select * from consent_forms where id = $1', [id]);
    if (!f || !(can(a, 'consents.manage') || can(a, 'activities.manage') || f.created_by === a.userId)) throw new NotFoundException({ error: 'not_found' });
    return f;
  }
}
