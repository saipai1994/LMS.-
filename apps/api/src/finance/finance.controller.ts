import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Headers, HttpCode, NotFoundException, Param, Post, Query, Req, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, campusScope, can, needs, parse, pid, Public, uuid } from '../common/http';
import { audit } from '../common/audit';
import { guardianUserIds, isGuardianOf, notify, studentAccess } from '../sis/access';

const money = z.number().int().positive().max(1_000_000_000_00); // minor units
const headS = z.object({ code: z.string().min(1).max(30), name: z.string().min(1).max(100) });
const structS = z.object({ academicYearId: uuid, gradeLevelId: uuid, residenceType: z.enum(['boarder', 'day_scholar']).nullable().default(null), headId: uuid, amountMinor: money });
const genS = z.object({ academicYearId: uuid, dueDate: z.string().date(), batchKey: z.string().min(1).max(50), studentIds: z.array(uuid).max(1000).optional() });
const manualS = z.object({ studentId: uuid, dueDate: z.string().date(), lines: z.array(z.object({ description: z.string().min(1).max(200), amountMinor: money })).min(1).max(30) });
const payS = z.object({ studentId: uuid, invoiceId: uuid.optional(), amountMinor: money, method: z.enum(['cash', 'cheque', 'bank_transfer']), reference: z.string().max(100).optional(), idempotencyKey: z.string().min(8).max(100) });
const adjS = z.object({ amountMinor: money, reason: z.string().min(3).max(300) });
const refundS = z.object({ amountMinor: money, reason: z.string().min(3).max(300) });

/** Invoice with derived amounts. Outstanding = total - credit notes - allocations. */
const INVOICE_SQL = `select i.id, i.student_id, i.number, i.issue_date, i.due_date, i.status, i.total_minor,
  coalesce(adj.n, 0)::bigint as adjusted_minor, coalesce(al.n, 0)::bigint as paid_minor,
  case when i.status = 'void' then 0 else (i.total_minor - coalesce(adj.n, 0) - coalesce(al.n, 0))::bigint end as outstanding_minor,
  case when i.status = 'void' then 'void'
       when i.total_minor - coalesce(adj.n, 0) - coalesce(al.n, 0) <= 0 then 'paid'
       when i.due_date < current_date then 'overdue'
       when coalesce(al.n, 0) > 0 then 'partially_paid' else 'issued' end as display_status
  from invoices i
  left join lateral (select sum(amount_minor) n from invoice_adjustments where invoice_id = i.id) adj on true
  left join lateral (select sum(amount_minor) n from payment_allocations where invoice_id = i.id) al on true`;

export function signWebhook(secret: string, raw: string | Buffer) {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

@Controller('finance')
export class FinanceController {
  constructor(private db: DbService) {}

  // ---------- configuration ----------
  @Post('fee-heads')
  createHead(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'finance.manage');
    const b = parse(headS, body);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('insert into fee_heads(tenant_id, code, name) values ($1,$2,$3) returning *', [a.tenantId, b.code, b.name])).rows[0]);
  }
  @Post('fee-structures')
  createStructure(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'finance.manage');
    const b = parse(structS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const r = (await tx.query('insert into fee_structures(tenant_id, academic_year_id, grade_level_id, residence_type, head_id, amount_minor) values ($1,$2,$3,$4,$5,$6) returning *', [a.tenantId, b.academicYearId, b.gradeLevelId, b.residenceType, b.headId, b.amountMinor])).rows[0];
      await audit(tx, a, a.tenantId, 'finance.fee_structure', 'fee_structure', r.id);
      return r;
    });
  }
  @Get('fee-structures')
  listStructures(@Auth() a: AuthContext) {
    needs(a, 'finance.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select fs.*, h.name as head_name, g.name as grade_name from fee_structures fs join fee_heads h on h.id = fs.head_id join grade_levels g on g.id = fs.grade_level_id order by g.ordinal, h.name`)).rows);
  }

  // ---------- invoices ----------
  /** Idempotent bulk generation: one invoice per student per batchKey. */
  @Post('invoices/generate')
  generate(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'finance.manage');
    const b = parse(genS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const students = (await tx.query(
        `select s.id, s.campus_id, e.section_id, sec.grade_level_id, ra.residence_type from students s
         join enrollments e on e.student_id = s.id and e.effective_to is null join sections sec on sec.id = e.section_id and sec.academic_year_id = $1
         join residence_assignments ra on ra.student_id = s.id and ra.effective_to is null
         where s.status = 'active' and ($2::uuid[] is null or s.id = any($2)) order by s.admission_no`, [b.academicYearId, b.studentIds ?? null])).rows;
      let created = 0, skippedExisting = 0, skippedNoFees = 0;
      for (const s of students) {
        if (!can(a, 'finance.manage', s.campus_id)) continue;
        const lines = (await tx.query(
          `select fs.head_id, h.name, fs.amount_minor from fee_structures fs join fee_heads h on h.id = fs.head_id
           where fs.academic_year_id = $1 and fs.grade_level_id = $2 and (fs.residence_type is null or fs.residence_type = $3) order by h.code`, [b.academicYearId, s.grade_level_id, s.residence_type])).rows;
        if (!lines.length) { skippedNoFees++; continue; }
        const exists = await tx.query('select 1 from invoices where student_id = $1 and batch_key = $2', [s.id, b.batchKey]);
        if (exists.rowCount) { skippedExisting++; continue; }
        await this.createInvoice(tx, a, s.id, b.dueDate, lines.map((l) => ({ description: l.name, headId: l.head_id, amountMinor: Number(l.amount_minor) })), b.batchKey);
        created++;
      }
      await audit(tx, a, a.tenantId, 'finance.invoices_generated', 'academic_year', b.academicYearId, null, { batchKey: b.batchKey, created, skippedExisting, skippedNoFees });
      return { created, skippedExisting, skippedNoFees };
    });
  }

  @Post('invoices')
  manual(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(manualS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select id, campus_id from students where id = $1', [b.studentId]);
      if (!s || !can(a, 'finance.manage', s.campus_id)) throw new NotFoundException({ error: 'not_found' });
      return this.createInvoice(tx, a, s.id, b.dueDate, b.lines.map((l) => ({ ...l, headId: null })), null);
    });
  }

  @Get('invoices')
  list(@Auth() a: AuthContext, @Query('status') status?: string, @Query('studentId') studentId?: string, @Query('limit') limit = '100', @Query('offset') offset = '0') {
    needs(a, 'finance.read');
    const scope = campusScope(a, 'finance.read');
    const lim = Math.min(Math.max(parseInt(limit) || 100, 1), 500), off = Math.max(parseInt(offset) || 0, 0);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select x.*, s.first_name, s.last_name, s.admission_no from (${INVOICE_SQL}) x join students s on s.id = x.student_id
       where ($1::uuid[] is null or s.campus_id = any($1)) and ($2::text is null or x.display_status = $2) and ($3::uuid is null or x.student_id = $3)
       order by x.issue_date desc, x.number desc limit $4 offset $5`, [scope, status ?? null, studentId ?? null, lim, off])).rows);
  }

  /** Parent portal: invoices of linked children only. */
  @Get('me/invoices')
  mine(@Auth() a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select x.*, s.first_name from (${INVOICE_SQL}) x join students s on s.id = x.student_id
       where exists (select 1 from student_guardians sg join guardians g on g.id = sg.guardian_id where sg.student_id = x.student_id and g.user_id = $1) order by x.issue_date desc`, [a.userId])).rows);
  }

  @Get('invoices/:id')
  get(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const inv = await this.invoiceFor(tx, a, id, 'read');
      const lines = (await tx.query('select line_no, description, amount_minor from invoice_lines where invoice_id = $1 order by line_no', [id])).rows;
      const payments = (await tx.query('select p.id, p.receipt_no, p.method, p.received_at, pa.amount_minor from payment_allocations pa join payments p on p.id = pa.payment_id where pa.invoice_id = $1 order by pa.id', [id])).rows;
      return { ...inv, lines, payments };
    });
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  voidInvoice(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const inv = await this.invoiceFor(tx, a, id, 'approve', true);
      if (inv.status === 'void') throw new ConflictException({ error: 'already_void' });
      if (Number(inv.paid_minor) !== 0) throw new ConflictException({ error: 'has_payments' });
      await tx.query(`update invoices set status = 'void' where id = $1`, [id]);
      const remaining = Number(inv.total_minor) - Number(inv.adjusted_minor);
      if (remaining > 0) await tx.query(`insert into ledger_entries(tenant_id, student_id, kind, ref_id, credit_minor, description) values ($1,$2,'void',$3,$4,$5)`, [a.tenantId, inv.student_id, id, remaining, `Void ${inv.number}`]);
      await audit(tx, a, a.tenantId, 'finance.invoice_void', 'invoice', id);
      return { status: 'void' };
    });
  }

  @Post('invoices/:id/credit-notes')
  creditNote(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(adjS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const inv = await this.invoiceFor(tx, a, id, 'approve', true);
      if (inv.status === 'void') throw new ConflictException({ error: 'invoice_void' });
      if (b.amountMinor > Number(inv.outstanding_minor)) throw new UnprocessableEntityException({ error: 'exceeds_outstanding', outstandingMinor: Number(inv.outstanding_minor) });
      await tx.query('insert into invoice_adjustments(tenant_id, invoice_id, amount_minor, reason, approved_by) values ($1,$2,$3,$4,$5)', [a.tenantId, id, b.amountMinor, b.reason, a.userId]);
      await tx.query(`insert into ledger_entries(tenant_id, student_id, kind, ref_id, credit_minor, description) values ($1,$2,'credit_note',$3,$4,$5)`, [a.tenantId, inv.student_id, id, b.amountMinor, `Credit note on ${inv.number}: ${b.reason}`]);
      await audit(tx, a, a.tenantId, 'finance.credit_note', 'invoice', id, null, { amountMinor: b.amountMinor });
      return { credited: b.amountMinor };
    });
  }

  // ---------- offline payments (idempotent) ----------
  @Post('payments')
  record(@Auth() a: AuthContext, @Body() body: unknown, @Req() req: any) {
    const b = parse(payS, body);
    const hash = createHash('sha256').update(JSON.stringify([b.studentId, b.invoiceId ?? null, b.amountMinor, b.method, b.reference ?? null])).digest('hex');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select id, campus_id from students where id = $1', [b.studentId]);
      if (!s || !can(a, 'finance.manage', s.campus_id)) throw new NotFoundException({ error: 'not_found' });
      const prior = await tx.query('select id, receipt_no, request_hash, amount_minor from payments where idempotency_key = $1', [b.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== hash) throw new UnprocessableEntityException({ error: 'idempotency_key_reused_with_different_request' });
        req.res.status(200);
        return { id: prior.rows[0].id, receiptNo: prior.rows[0].receipt_no, amountMinor: Number(prior.rows[0].amount_minor), idempotentReplay: true };
      }
      return this.applyPayment(tx, a, { studentId: s.id, invoiceId: b.invoiceId, amountMinor: b.amountMinor, method: b.method, reference: b.reference, key: b.idempotencyKey, hash, receivedBy: a.userId });
    });
  }

  @Get('payments/:id/receipt')
  receipt(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [p] } = await tx.query(`select p.*, s.first_name, s.last_name, s.admission_no, s.campus_id, s.user_id from payments p join students s on s.id = p.student_id where p.id = $1`, [id]);
      if (!p || !(can(a, 'finance.read', p.campus_id) || (await isGuardianOf(tx, a.userId, p.student_id)))) throw new NotFoundException({ error: 'not_found' });
      const allocations = (await tx.query('select i.number, pa.amount_minor from payment_allocations pa join invoices i on i.id = pa.invoice_id where pa.payment_id = $1 order by pa.id', [id])).rows;
      const refunded = (await tx.query(`select coalesce(sum(amount_minor),0)::bigint n from refunds where payment_id = $1 and status = 'approved'`, [id])).rows[0].n;
      return {
        receiptNo: p.receipt_no, date: p.received_at, student: `${p.first_name} ${p.last_name}`, admissionNo: p.admission_no,
        method: p.method, reference: p.reference, amountMinor: Number(p.amount_minor), refundedMinor: Number(refunded), allocations,
        simulated: p.method === 'online_demo', notice: p.method === 'online_demo' ? 'DEMO / SIMULATED payment — no real money moved' : undefined,
      };
    });
  }

  // ---------- refunds (maker-checker) ----------
  @Post('payments/:id/refunds')
  requestRefund(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(refundS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [p] } = await tx.query('select p.*, s.campus_id from payments p join students s on s.id = p.student_id where p.id = $1 for update of p', [id]);
      if (!p || !can(a, 'finance.manage', p.campus_id)) throw new NotFoundException({ error: 'not_found' });
      const used = (await tx.query(`select coalesce(sum(amount_minor),0)::bigint n from refunds where payment_id = $1 and status in ('pending','approved')`, [id])).rows[0].n;
      if (b.amountMinor > Number(p.amount_minor) - Number(used)) throw new UnprocessableEntityException({ error: 'exceeds_refundable', refundableMinor: Number(p.amount_minor) - Number(used) });
      const r = (await tx.query('insert into refunds(tenant_id, payment_id, amount_minor, reason, requested_by) values ($1,$2,$3,$4,$5) returning *', [a.tenantId, id, b.amountMinor, b.reason, a.userId])).rows[0];
      await audit(tx, a, a.tenantId, 'finance.refund_request', 'refund', r.id, p.campus_id, { amountMinor: b.amountMinor });
      return r;
    });
  }

  @Post('refunds/:id/decision')
  decideRefund(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const { decision } = parse(z.object({ decision: z.enum(['approve', 'reject']) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [r] } = await tx.query('select r.*, p.student_id, s.campus_id from refunds r join payments p on p.id = r.payment_id join students s on s.id = p.student_id where r.id = $1 for update of r', [id]);
      if (!r) throw new NotFoundException({ error: 'not_found' });
      needs(a, 'finance.approve', r.campus_id);
      if (r.status !== 'pending') throw new ConflictException({ error: 'already_decided' });
      if (r.requested_by === a.userId) throw new UnprocessableEntityException({ error: 'cannot_approve_own_request' });
      await tx.query('update refunds set status = $2, decided_by = $3, decided_at = now() where id = $1', [id, decision === 'approve' ? 'approved' : 'rejected', a.userId]);
      if (decision === 'approve') {
        // reverse allocations newest-first so invoices become payable again
        let left = Number(r.amount_minor);
        const allocs = (await tx.query('select invoice_id, sum(amount_minor)::bigint as n from payment_allocations where payment_id = $1 group by invoice_id having sum(amount_minor) > 0 order by max(id) desc', [r.payment_id])).rows;
        for (const al of allocs) {
          if (left <= 0) break;
          const take = Math.min(left, Number(al.n));
          await tx.query('insert into payment_allocations(tenant_id, payment_id, invoice_id, amount_minor) values ($1,$2,$3,$4)', [a.tenantId, r.payment_id, al.invoice_id, -take]);
          left -= take;
        }
        await tx.query(`insert into ledger_entries(tenant_id, student_id, kind, ref_id, debit_minor, description) values ($1,$2,'refund',$3,$4,$5)`, [a.tenantId, r.student_id, id, r.amount_minor, `Refund: ${r.reason}`]);
      }
      await audit(tx, a, a.tenantId, `finance.refund_${decision}`, 'refund', id, r.campus_id);
      return { decision };
    });
  }

  // ---------- ledger, reconciliation, dashboard ----------
  @Get('students/:id/ledger')
  ledger(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      if (!s || !(can(a, 'finance.read', s.campus_id) || (await isGuardianOf(tx, a.userId, id)))) throw new NotFoundException({ error: 'not_found' });
      const entries = (await tx.query('select id, entry_date, kind, description, debit_minor, credit_minor from ledger_entries where student_id = $1 order by id', [id])).rows;
      let bal = 0;
      const withBalance = entries.map((e) => ({ ...e, debit_minor: Number(e.debit_minor), credit_minor: Number(e.credit_minor), balance_minor: (bal += Number(e.debit_minor) - Number(e.credit_minor)) }));
      return { balanceMinor: bal, entries: withBalance };
    });
  }

  /** Day-end totals per method plus integrity checks (ledger vs invoices/payments). Empty `discrepancies` = reconciled. */
  @Get('reconciliation')
  reconciliation(@Auth() a: AuthContext, @Query('date') date?: string) {
    needs(a, 'finance.read');
    const d = date ? parse(z.string().date(), date) : new Date().toISOString().slice(0, 10);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const byMethod = (await tx.query(`select method, count(*)::int as count, sum(amount_minor)::bigint as total_minor from payments where received_at::date = $1 group by method order by method`, [d])).rows
        .map((r) => ({ ...r, total_minor: Number(r.total_minor) }));
      const discrepancies = (await tx.query(
        `select s.id as student_id, s.admission_no,
           coalesce(l.bal, 0)::bigint as ledger_balance, coalesce(inv.outstanding, 0)::bigint as invoice_outstanding
         from students s
         left join lateral (select sum(debit_minor - credit_minor) bal from ledger_entries where student_id = s.id) l on true
         left join lateral (select sum(outstanding_minor) outstanding from (${INVOICE_SQL}) q where q.student_id = s.id) inv on true
         where coalesce(l.bal, 0) <> coalesce(inv.outstanding, 0)`)).rows;
      return { date: d, byMethod, discrepancies: discrepancies.map((r) => ({ ...r, ledger_balance: Number(r.ledger_balance), invoice_outstanding: Number(r.invoice_outstanding) })) };
    });
  }

  @Get('summary')
  summary(@Auth() a: AuthContext) {
    needs(a, 'finance.read');
    const scope = campusScope(a, 'finance.read');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const r = (await tx.query(
        `select coalesce(sum(x.total_minor - x.adjusted_minor) filter (where x.status <> 'void'), 0)::bigint as invoiced,
           coalesce(sum(x.paid_minor), 0)::bigint as collected, coalesce(sum(x.outstanding_minor), 0)::bigint as outstanding,
           coalesce(sum(x.outstanding_minor) filter (where x.display_status = 'overdue' and current_date - x.due_date <= 30), 0)::bigint as overdue_0_30,
           coalesce(sum(x.outstanding_minor) filter (where x.display_status = 'overdue' and current_date - x.due_date > 30 and current_date - x.due_date <= 60), 0)::bigint as overdue_31_60,
           coalesce(sum(x.outstanding_minor) filter (where x.display_status = 'overdue' and current_date - x.due_date > 60), 0)::bigint as overdue_60_plus,
           count(*) filter (where x.display_status = 'overdue')::int as overdue_invoices
         from (${INVOICE_SQL}) x join students s on s.id = x.student_id where ($1::uuid[] is null or s.campus_id = any($1))`, [scope])).rows[0];
      return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
    });
  }

  // ---------- online payments via the DEMO gateway (no real provider) ----------
  @Post('payment-intents')
  createIntent(@Auth() a: AuthContext, @Body() body: unknown) {
    const { invoiceId } = parse(z.object({ invoiceId: uuid }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const inv = await this.invoiceFor(tx, a, invoiceId, 'pay');
      if (Number(inv.outstanding_minor) <= 0) throw new ConflictException({ error: 'nothing_due' });
      const r = (await tx.query('insert into payment_intents(tenant_id, invoice_id, student_id, amount_minor, created_by) values ($1,$2,$3,$4,$5) returning id, amount_minor, status, provider',
        [a.tenantId, invoiceId, inv.student_id, inv.outstanding_minor, a.userId])).rows[0];
      return { ...r, amount_minor: Number(r.amount_minor), simulated: true, notice: 'DEMO / SIMULATED gateway — no real payment will be taken' };
    });
  }

  /** Demo convenience: plays the gateway's role by sending a correctly signed webhook to the real handler. Demo mode only. */
  @Post('payment-intents/:id/simulate')
  @HttpCode(200)
  async simulate(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    if (process.env.DEMO_MODE !== 'true' || process.env.NODE_ENV === 'production') throw new NotFoundException();
    const { outcome } = parse(z.object({ outcome: z.enum(['succeeded', 'failed']) }), body);
    const secret = this.gatewaySecret();
    const intent = await this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [i] } = await tx.query('select * from payment_intents where id = $1', [id]);
      if (!i || (i.created_by !== a.userId && !can(a, 'finance.manage'))) throw new NotFoundException({ error: 'not_found' });
      return i;
    });
    const payload = { eventId: `evt_${id}_${outcome}`, tenantId: a.tenantId, intentId: id, status: outcome, amountMinor: Number(intent.amount_minor) };
    return this.processWebhook(secret, JSON.stringify(payload), signWebhook(secret, JSON.stringify(payload)));
  }

  /** Gateway callback. Authenticity = HMAC over the raw body; replayed event ids are ignored; amounts are checked server-side. */
  @Public()
  @Post('webhooks/demo-gateway')
  @HttpCode(200)
  webhook(@Req() req: any, @Headers('x-signature') sig: string) {
    return this.processWebhook(this.gatewaySecret(), (req.rawBody as Buffer)?.toString('utf8') ?? '', sig);
  }

  private gatewaySecret(): string {
    const s = process.env.DEMO_GATEWAY_SECRET;
    if (!s || s.length < 16) throw new ServiceUnavailableException({ error: 'gateway_not_configured' });
    return s;
  }

  private async processWebhook(secret: string, raw: string, sig?: string) {
    const expected = signWebhook(secret, raw);
    if (!sig || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new ForbiddenException({ error: 'bad_signature' });
    const ev = parse(z.object({ eventId: z.string().min(5).max(200), tenantId: uuid, intentId: uuid, status: z.enum(['succeeded', 'failed']), amountMinor: z.number().int().positive() }), JSON.parse(raw || '{}'));
    return this.db.withTenant(ev.tenantId, async (tx) => {
      const seen = await tx.query('insert into webhook_events(tenant_id, event_id, provider) values ($1,$2,$3) on conflict do nothing returning event_id', [ev.tenantId, ev.eventId, 'demo']);
      if (!seen.rowCount) return { duplicate: true };
      const { rows: [i] } = await tx.query('select * from payment_intents where id = $1 for update', [ev.intentId]);
      if (!i) throw new NotFoundException({ error: 'unknown_intent' });
      if (i.status !== 'pending') return { ignored: true, status: i.status };
      if (ev.status === 'failed') { await tx.query(`update payment_intents set status = 'failed' where id = $1`, [i.id]); return { status: 'failed' }; }
      if (Number(i.amount_minor) !== ev.amountMinor) {
        await tx.query(`update payment_intents set status = 'needs_review' where id = $1`, [i.id]);
        await audit(tx, null, ev.tenantId, 'finance.webhook_amount_mismatch', 'payment_intent', i.id);
        throw Object.assign(new UnprocessableEntityException({ error: 'amount_mismatch' }), { commit: true });
      }
      const inv = (await tx.query(`select * from (${INVOICE_SQL}) q where id = $1`, [i.invoice_id])).rows[0];
      if (Number(inv.outstanding_minor) < Number(i.amount_minor)) {
        await tx.query(`update payment_intents set status = 'needs_review' where id = $1`, [i.id]);
        await audit(tx, null, ev.tenantId, 'finance.webhook_overpayment', 'payment_intent', i.id);
        return { status: 'needs_review' };
      }
      const hash = createHash('sha256').update(`intent:${i.id}`).digest('hex');
      const pay = await this.applyPayment(tx, { tenantId: ev.tenantId, userId: i.created_by }, { studentId: i.student_id, invoiceId: i.invoice_id, amountMinor: Number(i.amount_minor), method: 'online_demo', reference: `demo:${i.id}`, key: `intent:${i.id}`, hash, receivedBy: null });
      await tx.query(`update payment_intents set status = 'succeeded' where id = $1`, [i.id]);
      return { status: 'succeeded', paymentId: pay.id, receiptNo: pay.receiptNo };
    });
  }

  // ---------- helpers ----------
  private async createInvoice(tx: Tx, a: { tenantId: string; userId: string }, studentId: string, dueDate: string, lines: { description: string; headId: string | null; amountMinor: number }[], batchKey: string | null) {
    const total = lines.reduce((t, l) => t + l.amountMinor, 0);
    const { rows: [seq] } = await tx.query(`insert into document_sequences(tenant_id, key, prefix, next_value) values ($1,'invoice','INV-',2) on conflict (tenant_id, key) do update set next_value = document_sequences.next_value + 1 returning prefix, next_value - 1 as v`, [a.tenantId]);
    const number = `${seq.prefix}${String(seq.v).padStart(6, '0')}`;
    const { rows: [inv] } = await tx.query('insert into invoices(tenant_id, student_id, number, batch_key, due_date, total_minor, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id, number, total_minor', [a.tenantId, studentId, number, batchKey, dueDate, total, a.userId]);
    let n = 1;
    for (const l of lines) await tx.query('insert into invoice_lines(tenant_id, invoice_id, line_no, description, head_id, amount_minor) values ($1,$2,$3,$4,$5,$6)', [a.tenantId, inv.id, n++, l.description, l.headId, l.amountMinor]);
    await tx.query(`insert into ledger_entries(tenant_id, student_id, kind, ref_id, debit_minor, description) values ($1,$2,'invoice',$3,$4,$5)`, [a.tenantId, studentId, inv.id, total, `Invoice ${number}`]);
    await audit(tx, a as AuthContext, a.tenantId, 'finance.invoice_create', 'invoice', inv.id, null, { number, totalMinor: total });
    return { id: inv.id, number, totalMinor: Number(inv.total_minor) };
  }

  private async applyPayment(tx: Tx, a: { tenantId: string; userId: string }, p: { studentId: string; invoiceId?: string | null; amountMinor: number; method: string; reference?: string | null; key: string; hash: string; receivedBy: string | null }) {
    // Lock the student's open invoices to serialize concurrent payments.
    const open = (await tx.query(
      `select q.* from (${INVOICE_SQL}) q where q.student_id = $1 and q.status <> 'void' and q.outstanding_minor > 0 and ($2::uuid is null or q.id = $2) order by q.due_date, q.number`, [p.studentId, p.invoiceId ?? null])).rows;
    if (p.invoiceId && !open.length) throw new UnprocessableEntityException({ error: 'invoice_not_payable' });
    await tx.query('select id from invoices where id = any($1) for update', [open.map((o) => o.id)]);
    const fresh = (await tx.query(`select q.id, q.outstanding_minor from (${INVOICE_SQL}) q where q.id = any($1) order by q.due_date, q.number`, [open.map((o) => o.id)])).rows;
    const due = fresh.reduce((t, r) => t + Number(r.outstanding_minor), 0);
    if (p.amountMinor > due) throw new UnprocessableEntityException({ error: 'exceeds_outstanding', outstandingMinor: due });
    const { rows: [seq] } = await tx.query(`insert into document_sequences(tenant_id, key, prefix, next_value) values ($1,'receipt','RCT-',2) on conflict (tenant_id, key) do update set next_value = document_sequences.next_value + 1 returning prefix, next_value - 1 as v`, [a.tenantId]);
    const receiptNo = `${seq.prefix}${String(seq.v).padStart(6, '0')}`;
    const { rows: [pay] } = await tx.query('insert into payments(tenant_id, student_id, receipt_no, method, amount_minor, reference, idempotency_key, request_hash, received_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',
      [a.tenantId, p.studentId, receiptNo, p.method, p.amountMinor, p.reference ?? null, p.key, p.hash, p.receivedBy]);
    let left = p.amountMinor;
    for (const inv of fresh) {
      if (left <= 0) break;
      const take = Math.min(left, Number(inv.outstanding_minor));
      await tx.query('insert into payment_allocations(tenant_id, payment_id, invoice_id, amount_minor) values ($1,$2,$3,$4)', [a.tenantId, pay.id, inv.id, take]);
      left -= take;
    }
    await tx.query(`insert into ledger_entries(tenant_id, student_id, kind, ref_id, credit_minor, description) values ($1,$2,'payment',$3,$4,$5)`, [a.tenantId, p.studentId, pay.id, p.amountMinor, `Payment ${receiptNo} (${p.method})`]);
    await audit(tx, a as AuthContext, a.tenantId, 'finance.payment', 'payment', pay.id, null, { receiptNo, amountMinor: p.amountMinor, method: p.method });
    await notify(tx, a.tenantId, await guardianUserIds(tx, p.studentId), 'finance.receipt', 'Payment received', `Receipt ${receiptNo} issued${p.method === 'online_demo' ? ' (DEMO / simulated payment)' : ''}.`);
    return { id: pay.id as string, receiptNo, amountMinor: p.amountMinor };
  }

  private async invoiceFor(tx: Tx, a: AuthContext, id: string, mode: 'read' | 'approve' | 'pay', lock = false) {
    if (lock) await tx.query('select id from invoices where id = $1 for update', [id]);
    const { rows: [inv] } = await tx.query(`select q.*, s.campus_id from (${INVOICE_SQL}) q join students s on s.id = q.student_id where q.id = $1`, [id]);
    if (!inv) throw new NotFoundException({ error: 'not_found' });
    const guardian = mode !== 'approve' && (await isGuardianOf(tx, a.userId, inv.student_id));
    const ok = mode === 'approve' ? can(a, 'finance.approve', inv.campus_id) : mode === 'pay' ? (guardian || can(a, 'finance.manage', inv.campus_id)) : (guardian || can(a, 'finance.read', inv.campus_id));
    if (!ok) throw new NotFoundException({ error: 'not_found' });
    return inv;
  }
}
void BadRequestException; void studentAccess;
