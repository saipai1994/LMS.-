import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Put, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, can, needs, parse, pid } from '../common/http';
import { audit } from '../common/audit';
import { notify, studentAccess } from '../sis/access';

const reqS = z.object({ kind: z.enum(['access', 'correction', 'erasure']), studentId: z.string().uuid(), details: z.string().min(5).max(2000) });
const decideS = z.object({ status: z.enum(['in_review', 'completed', 'rejected']), outcome: z.string().min(3).max(2000).optional() });

/** Data-subject requests, retention settings, student data export and retention-gated anonymisation. */
@Controller('privacy')
export class PrivacyController {
  constructor(private db: DbService) {}

  @Post('requests')
  create(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(reqS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select id, campus_id, user_id from students where id = $1', [b.studentId]);
      if (!s) throw new NotFoundException({ error: 'not_found' });
      const via = await studentAccess(tx, a, s);
      if (!(via === 'guardian' || via === 'self' || can(a, 'privacy.manage', s.campus_id))) throw new NotFoundException({ error: 'not_found' });
      const r = (await tx.query('insert into privacy_requests(tenant_id, kind, student_id, requested_by, details) values ($1,$2,$3,$4,$5) returning *', [a.tenantId, b.kind, b.studentId, a.userId, b.details])).rows[0];
      await audit(tx, a, a.tenantId, 'privacy.request', 'privacy_request', r.id, s.campus_id, { kind: b.kind });
      return r;
    });
  }

  @Get('requests')
  list(@Auth() a: AuthContext) {
    const all = can(a, 'privacy.manage');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select p.*, s.first_name, s.last_name, s.admission_no, (p.status in ('open','in_review') and p.due_at < now()) as overdue
       from privacy_requests p join students s on s.id = p.student_id where ($1::boolean or p.requested_by = $2) order by p.created_at desc`, [all, a.userId])).rows);
  }

  @Post('requests/:id/decide')
  decide(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); needs(a, 'privacy.manage'); const b = parse(decideS, body);
    if (b.status !== 'in_review' && !b.outcome) throw new UnprocessableEntityException({ error: 'outcome_required' });
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [p] } = await tx.query('select * from privacy_requests where id = $1 for update', [id]);
      if (!p) throw new NotFoundException({ error: 'not_found' });
      if (['completed', 'rejected'].includes(p.status)) throw new ConflictException({ error: 'already_decided' });
      const done = b.status !== 'in_review';
      const r = (await tx.query('update privacy_requests set status=$2, outcome=$3, handled_by=$4, completed_at = case when $5 then now() end where id=$1 returning *', [id, b.status, b.outcome ?? null, a.userId, done])).rows[0];
      await audit(tx, a, a.tenantId, 'privacy.decide', 'privacy_request', id, null, { status: b.status });
      await notify(tx, a.tenantId, [p.requested_by], 'privacy', 'Privacy request update', `Your ${p.kind} request is now ${b.status.replace('_', ' ')}.`);
      return r;
    });
  }

  @Get('retention')
  retention(@Auth() a: AuthContext) {
    needs(a, 'privacy.manage');
    return this.db.withTenant(a.tenantId, async (tx) => ({ studentRecordYears: (await tx.query('select student_record_years n from retention_settings')).rows[0]?.n ?? 7 }));
  }
  @Put('retention')
  setRetention(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'privacy.manage'); const b = parse(z.object({ studentRecordYears: z.number().int().min(1).max(50) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      await tx.query('insert into retention_settings(tenant_id, student_record_years, configured_by) values ($1,$2,$3) on conflict (tenant_id) do update set student_record_years=$2, configured_by=$3', [a.tenantId, b.studentRecordYears, a.userId]);
      await audit(tx, a, a.tenantId, 'privacy.retention', 'tenant', a.tenantId, null, b);
      return b;
    });
  }

  /** Everything held about one student, as a downloadable JSON bundle (access request fulfilment). */
  @Get('students/:id/export')
  export(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id); needs(a, 'privacy.manage');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      if (!s || !can(a, 'privacy.manage', s.campus_id)) throw new NotFoundException({ error: 'not_found' });
      const q = async (sql: string) => (await tx.query(sql, [id])).rows;
      const out = {
        generatedAt: new Date().toISOString(),
        student: { id: s.id, admissionNo: s.admission_no, firstName: s.first_name, lastName: s.last_name, dateOfBirth: s.date_of_birth, gender: s.gender, status: s.status },
        guardians: await q('select g.full_name, g.phone, sg.relationship from student_guardians sg join guardians g on g.id = sg.guardian_id where sg.student_id = $1'),
        enrollments: await q('select effective_from, effective_to, end_reason from enrollments where student_id = $1'),
        invoices: await q('select number, issue_date, due_date, status, total_minor from invoices where student_id = $1'),
        medicalAlerts: await q('select alert, severity from student_medical_alerts where student_id = $1'),
      };
      await audit(tx, a, a.tenantId, 'privacy.export', 'student', id, s.campus_id);
      return out;
    });
  }

  /** Irreversibly removes identifying fields. Allowed only after the retention period, with no dues, for students who have left. */
  @Post('students/:id/anonymise')
  anonymise(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); needs(a, 'privacy.manage'); parse(z.object({ confirm: z.literal('ANONYMISE') }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1 for update', [id]);
      if (!s || !can(a, 'privacy.manage', s.campus_id)) throw new NotFoundException({ error: 'not_found' });
      if (s.anonymised_at) throw new ConflictException({ error: 'already_anonymised' });
      if (s.status === 'active') throw new ConflictException({ error: 'student_still_active' });
      const years = (await tx.query('select student_record_years n from retention_settings')).rows[0]?.n ?? 7;
      const { rows: [left] } = await tx.query(`select max(effective_date) d from withdrawal_requests where student_id = $1 and status = 'completed'`, [id]);
      if (!left?.d) throw new ConflictException({ error: 'no_departure_record' });
      const { rows: [ok] } = await tx.query(`select ($1::date + ($2 || ' years')::interval) <= current_date as passed`, [left.d, String(years)]);
      if (!ok.passed) throw new ConflictException({ error: 'retention_period_not_elapsed', retentionYears: years });
      const dues = Number((await tx.query(`select coalesce(sum(i.total_minor - coalesce((select sum(amount_minor) from invoice_adjustments where invoice_id = i.id),0) - coalesce((select sum(amount_minor) from payment_allocations where invoice_id = i.id),0)),0)::bigint n from invoices i where i.student_id = $1 and i.status <> 'void'`, [id])).rows[0].n);
      if (dues > 0) throw new ConflictException({ error: 'outstanding_dues' });
      await tx.query(`update students set first_name='Anonymised', last_name='Student', gender=null, date_of_birth = make_date(extract(year from date_of_birth)::int, 1, 1), user_id=null, anonymised_at=now() where id=$1`, [id]);
      await audit(tx, a, a.tenantId, 'privacy.anonymise', 'student', id, s.campus_id, { admissionNo: s.admission_no });
      return { id, anonymised: true };
    });
  }
}
