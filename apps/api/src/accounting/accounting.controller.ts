import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Put, Query, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { CASH_BY_METHOD, DEFAULT_CHART, ensureChart, INCOME_BY_HEAD, postJournal, reverseJournal } from '../common/gl';

const dateS = z.string().date();
const journalS = z.object({
  date: dateS.optional(), memo: z.string().min(3).max(300),
  lines: z.array(z.object({ account: z.string().min(2).max(20), debit: z.number().int().min(0).default(0), credit: z.number().int().min(0).default(0), costCentre: z.string().max(30).optional(), memo: z.string().max(200).optional() })).min(2).max(60),
});
const billS = z.object({ supplierId: uuid, poId: uuid.optional(), number: z.string().min(1).max(40), billDate: dateS, dueDate: dateS, lines: z.array(z.object({ account: z.string().min(2).max(20), amountMinor: z.number().int().positive(), costCentre: z.string().max(30).optional(), memo: z.string().max(200).optional() })).min(1).max(30) });
const stmtS = z.object({ lines: z.array(z.object({ date: dateS, description: z.string().min(1).max(200), amountMinor: z.number().int().refine((n) => n !== 0), reference: z.string().max(100).optional() })).min(1).max(1000) });

const BAL = `coalesce(sum(l.debit_minor),0)::bigint as debit, coalesce(sum(l.credit_minor),0)::bigint as credit`;
const num = (r: any) => ({ ...r, debit: Number(r.debit), credit: Number(r.credit) });

@Controller('accounting')
export class AccountingController {
  constructor(private db: DbService) {}

  // ---------- chart of accounts & cost centres ----------
  @Get('accounts')
  accounts(@Auth() a: AuthContext) {
    needs(a, 'accounting.read');
    return this.db.withTenant(a.tenantId, async (tx) => { await ensureChart(tx, a.tenantId); return (await tx.query('select code, name, type, is_bank, is_active from accounts order by code')).rows; });
  }
  @Post('accounts')
  addAccount(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'accounting.manage'); const b = parse(z.object({ code: z.string().regex(/^\d{4,6}$/), name: z.string().min(2).max(100), type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']), isBank: z.boolean().default(false) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => { await ensureChart(tx, a.tenantId); return (await tx.query('insert into accounts(tenant_id, code, name, type, is_bank) values ($1,$2,$3,$4,$5) returning code, name, type', [a.tenantId, b.code, b.name, b.type, b.isBank])).rows[0]; });
  }
  @Post('cost-centres')
  addCostCentre(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'accounting.manage'); const b = parse(z.object({ code: z.string().regex(/^[A-Z0-9-]{2,20}$/), name: z.string().min(2).max(100) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('insert into cost_centres(tenant_id, code, name) values ($1,$2,$3) returning code, name', [a.tenantId, b.code, b.name])).rows[0]);
  }
  @Get('cost-centres')
  costCentres(@Auth() a: AuthContext) { needs(a, 'accounting.read'); return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('select code, name from cost_centres order by code')).rows); }

  // ---------- journals ----------
  @Post('journals')
  journal(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'accounting.manage'); const b = parse(journalS, body);
    const d = b.lines.reduce((t, l) => t + l.debit, 0), c = b.lines.reduce((t, l) => t + l.credit, 0);
    if (d !== c) throw new UnprocessableEntityException({ error: 'unbalanced', debit: d, credit: c });
    if (b.lines.some((l) => (l.debit > 0) === (l.credit > 0))) throw new UnprocessableEntityException({ error: 'each_line_needs_exactly_one_of_debit_or_credit' });
    return this.db.withTenant(a.tenantId, async (tx) => {
      await ensureChart(tx, a.tenantId);
      const known = new Set((await tx.query('select code from accounts where is_active')).rows.map((r) => r.code));
      const bad = b.lines.filter((l) => !known.has(l.account)).map((l) => l.account);
      if (bad.length) throw new UnprocessableEntityException({ error: 'unknown_or_inactive_account', accounts: bad });
      const id = await postJournal(tx, a.tenantId, { date: b.date, memo: b.memo, source: 'manual', postedBy: a.userId, lines: b.lines.map((l) => ({ account: l.account, debit: l.debit, credit: l.credit, costCentre: l.costCentre, memo: l.memo })) });
      await audit(tx, a, a.tenantId, 'accounting.journal', 'journal', id ?? undefined, null, { amountMinor: d });
      return { id };
    });
  }
  /** A reversal must be made by someone other than the original poster. */
  @Post('journals/:id/reverse')
  reverse(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); needs(a, 'accounting.approve'); const { reason } = parse(z.object({ reason: z.string().min(5).max(300) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [e] } = await tx.query('select * from journal_entries where id = $1', [id]);
      if (!e) throw new NotFoundException({ error: 'not_found' });
      if (e.source === 'reversal') throw new ConflictException({ error: 'cannot_reverse_a_reversal' });
      if (e.posted_by === a.userId) throw new UnprocessableEntityException({ error: 'reverser_must_differ_from_poster' });
      if ((await tx.query('select 1 from journal_entries where reversal_of = $1', [id])).rowCount) throw new ConflictException({ error: 'already_reversed' });
      const rev = await reverseJournal(tx, a.tenantId, id, a.userId, `Reversal of JE-${e.entry_no}: ${reason}`, `reverse:${id}`);
      await audit(tx, a, a.tenantId, 'accounting.reverse', 'journal', id, null, { reason });
      return { reversalId: rev };
    });
  }
  @Get('journals')
  list(@Auth() a: AuthContext, @Query('limit') limit = '50', @Query('source') source?: string) {
    needs(a, 'accounting.read'); const lim = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(`select e.id, e.entry_no, e.entry_date, e.memo, e.source, e.reversal_of, (select sum(debit_minor) from journal_lines where entry_id = e.id)::bigint as amount from journal_entries e where ($1::text is null or e.source = $1) order by e.entry_no desc limit $2`, [source ?? null, lim])).rows.map((r) => ({ ...r, amount: Number(r.amount) })));
  }
  @Get('journals/:id')
  one(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id); needs(a, 'accounting.read');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [e] } = await tx.query('select * from journal_entries where id = $1', [id]);
      if (!e) throw new NotFoundException({ error: 'not_found' });
      const lines = (await tx.query('select a.code, a.name, l.debit_minor, l.credit_minor, l.cost_centre, l.memo from journal_lines l join accounts a on a.id = l.account_id where l.entry_id = $1 order by l.line_no', [id])).rows.map((l) => ({ ...l, debit_minor: Number(l.debit_minor), credit_minor: Number(l.credit_minor) }));
      return { ...e, lines };
    });
  }

  // ---------- reports ----------
  @Get('trial-balance')
  trial(@Auth() a: AuthContext, @Query('asOf') asOf?: string) {
    needs(a, 'accounting.read'); const d = asOf ? parse(dateS, asOf) : '2999-12-31';
    return this.db.withTenant(a.tenantId, async (tx) => {
      await ensureChart(tx, a.tenantId);
      const rows = (await tx.query(`select a.code, a.name, a.type, ${BAL} from accounts a left join journal_lines l on l.account_id = a.id left join journal_entries e on e.id = l.entry_id and e.entry_date <= $1 where (l.entry_id is null or e.id is not null) group by a.id order by a.code`, [d])).rows.map(num);
      const accounts = rows.map((r) => { const net = r.debit - r.credit; return { ...r, balanceDebit: net > 0 ? net : 0, balanceCredit: net < 0 ? -net : 0 }; });
      const td = accounts.reduce((t, r) => t + r.balanceDebit, 0), tc = accounts.reduce((t, r) => t + r.balanceCredit, 0);
      return { asOf: asOf ?? null, accounts: accounts.filter((r) => r.debit || r.credit), totalDebit: td, totalCredit: tc, balanced: td === tc };
    });
  }
  @Get('reports/income-statement')
  income(@Auth() a: AuthContext, @Query('from') from: string, @Query('to') to: string) {
    needs(a, 'accounting.read'); const f = parse(dateS, from), t = parse(dateS, to);
    return this.db.withTenant(a.tenantId, async (tx) => {
      await ensureChart(tx, a.tenantId);
      const rows = (await tx.query(`select a.code, a.name, a.type, ${BAL} from accounts a join journal_lines l on l.account_id = a.id join journal_entries e on e.id = l.entry_id where a.type in ('income','expense') and e.entry_date between $1 and $2 group by a.id order by a.code`, [f, t])).rows.map(num);
      const inc = rows.filter((r) => r.type === 'income').map((r) => ({ code: r.code, name: r.name, amount: r.credit - r.debit }));
      const exp = rows.filter((r) => r.type === 'expense').map((r) => ({ code: r.code, name: r.name, amount: r.debit - r.credit }));
      const ti = inc.reduce((s, r) => s + r.amount, 0), te = exp.reduce((s, r) => s + r.amount, 0);
      return { from: f, to: t, income: inc, expenses: exp, totalIncome: ti, totalExpenses: te, surplus: ti - te };
    });
  }
  @Get('reports/balance-sheet')
  balanceSheet(@Auth() a: AuthContext, @Query('asOf') asOf: string) {
    needs(a, 'accounting.read'); const d = parse(dateS, asOf);
    return this.db.withTenant(a.tenantId, async (tx) => {
      await ensureChart(tx, a.tenantId);
      const rows = (await tx.query(`select a.code, a.name, a.type, ${BAL} from accounts a join journal_lines l on l.account_id = a.id join journal_entries e on e.id = l.entry_id where e.entry_date <= $1 group by a.id order by a.code`, [d])).rows.map(num);
      const side = (type: string, sign: 1 | -1) => rows.filter((r) => r.type === type).map((r) => ({ code: r.code, name: r.name, amount: sign * (r.debit - r.credit) })).filter((r) => r.amount !== 0);
      const assets = side('asset', 1), liabilities = side('liability', -1), equity = side('equity', -1);
      const surplus = rows.filter((r) => r.type === 'income').reduce((t, r) => t + (r.credit - r.debit), 0) - rows.filter((r) => r.type === 'expense').reduce((t, r) => t + (r.debit - r.credit), 0);
      const sum = (x: { amount: number }[]) => x.reduce((t, r) => t + r.amount, 0);
      return { asOf: d, assets, liabilities, equity, currentSurplus: surplus, totalAssets: sum(assets), totalLiabilitiesAndEquity: sum(liabilities) + sum(equity) + surplus, balanced: sum(assets) === sum(liabilities) + sum(equity) + surplus };
    });
  }
  @Get('ledger/:code')
  ledger(@Auth() a: AuthContext, @Param('code') code: string, @Query('from') from?: string, @Query('to') to?: string) {
    needs(a, 'accounting.read'); const f = from ? parse(dateS, from) : '1900-01-01', t = to ? parse(dateS, to) : '2999-12-31';
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [acc] } = await tx.query('select id, code, name, type from accounts where code = $1', [code]);
      if (!acc) throw new NotFoundException({ error: 'not_found' });
      const opening = (await tx.query('select coalesce(sum(l.debit_minor - l.credit_minor),0)::bigint n from journal_lines l join journal_entries e on e.id = l.entry_id where l.account_id = $1 and e.entry_date < $2', [acc.id, f])).rows[0].n;
      const lines = (await tx.query('select e.entry_no, e.entry_date, e.memo, l.debit_minor, l.credit_minor, l.cost_centre from journal_lines l join journal_entries e on e.id = l.entry_id where l.account_id = $1 and e.entry_date between $2 and $3 order by e.entry_date, e.entry_no, l.line_no', [acc.id, f, t])).rows;
      let bal = Number(opening);
      return { account: acc, opening: Number(opening), lines: lines.map((l) => ({ ...l, debit_minor: Number(l.debit_minor), credit_minor: Number(l.credit_minor), balance: (bal += Number(l.debit_minor) - Number(l.credit_minor)) })), closing: bal };
    });
  }

  // ---------- budgets ----------
  @Put('budgets')
  budget(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'accounting.manage'); const b = parse(z.object({ academicYearId: uuid, costCentre: z.string(), account: z.string(), amountMinor: z.number().int().min(0) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      await ensureChart(tx, a.tenantId);
      const acc = (await tx.query('select id from accounts where code = $1', [b.account])).rows[0];
      if (!acc) throw new UnprocessableEntityException({ error: 'unknown_account' });
      await tx.query(`insert into budgets(tenant_id, academic_year_id, cost_centre, account_id, amount_minor) values ($1,$2,$3,$4,$5) on conflict (academic_year_id, cost_centre, account_id) do update set amount_minor = excluded.amount_minor`, [a.tenantId, b.academicYearId, b.costCentre, acc.id, b.amountMinor]);
      await audit(tx, a, a.tenantId, 'accounting.budget', 'academic_year', b.academicYearId, null, { costCentre: b.costCentre, account: b.account, amountMinor: b.amountMinor });
      return b;
    });
  }
  @Get('budget-vs-actual')
  bva(@Auth() a: AuthContext, @Query('academicYearId') yid: string) {
    needs(a, 'accounting.read'); const y = parse(uuid, yid);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const rows = (await tx.query(
        `select b.cost_centre, c.name as cost_centre_name, a.code, a.name, a.type, b.amount_minor as budget,
           coalesce((select sum(case when a.type = 'expense' then l.debit_minor - l.credit_minor else l.credit_minor - l.debit_minor end) from journal_lines l join journal_entries e on e.id = l.entry_id join academic_years ay on ay.id = b.academic_year_id
              where l.account_id = b.account_id and l.cost_centre = b.cost_centre and e.entry_date between ay.starts_on and ay.ends_on), 0)::bigint as actual
         from budgets b join accounts a on a.id = b.account_id join cost_centres c on c.code = b.cost_centre where b.academic_year_id = $1 order by b.cost_centre, a.code`, [y])).rows;
      return rows.map((r) => ({ ...r, budget: Number(r.budget), actual: Number(r.actual), variance: Number(r.budget) - Number(r.actual), usedPercent: Number(r.budget) > 0 ? Math.round((Number(r.actual) / Number(r.budget)) * 1000) / 10 : null, overBudget: Number(r.actual) > Number(r.budget) }));
    });
  }

  // ---------- accounts payable ----------
  @Post('bills')
  bill(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'accounting.manage'); const b = parse(billS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      await ensureChart(tx, a.tenantId);
      if (!(await tx.query('select 1 from suppliers where id = $1', [b.supplierId])).rowCount) throw new UnprocessableEntityException({ error: 'unknown_supplier' });
      const known = new Set((await tx.query(`select code from accounts where is_active and type in ('expense','asset')`)).rows.map((r) => r.code));
      const bad = b.lines.filter((l) => !known.has(l.account)).map((l) => l.account);
      if (bad.length) throw new UnprocessableEntityException({ error: 'bill_lines_must_post_to_expense_or_asset_accounts', accounts: bad });
      const total = b.lines.reduce((t, l) => t + l.amountMinor, 0);
      const bill = (await tx.query('insert into vendor_bills(tenant_id, number, supplier_id, po_id, bill_date, due_date, total_minor, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id', [a.tenantId, b.number, b.supplierId, b.poId ?? null, b.billDate, b.dueDate, total, a.userId])).rows[0];
      await postJournal(tx, a.tenantId, { date: b.billDate, memo: `Vendor bill ${b.number}`, source: 'vendor_bill', sourceRef: bill.id, postedBy: a.userId, lines: [...b.lines.map((l) => ({ account: l.account, debit: l.amountMinor, costCentre: l.costCentre, memo: l.memo })), { account: '2000', credit: total }] });
      await audit(tx, a, a.tenantId, 'accounting.bill', 'vendor_bill', bill.id, null, { totalMinor: total });
      return { id: bill.id, totalMinor: total };
    });
  }
  @Post('bills/:id/pay')
  payBill(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(z.object({ date: dateS.optional(), method: z.enum(['bank', 'cash']).default('bank') }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [bill] } = await tx.query('select * from vendor_bills where id = $1 for update', [id]);
      if (!bill) throw new NotFoundException({ error: 'not_found' });
      if (bill.status === 'paid') throw new ConflictException({ error: 'already_paid' });
      // Segregation of duties: whoever booked the bill cannot release payment unless they also hold approval rights.
      if (bill.created_by === a.userId) needs(a, 'accounting.approve'); else if (!(a.grants.some((g) => g.permission === 'accounting.manage' || g.permission === 'accounting.approve'))) needs(a, 'accounting.manage');
      await tx.query(`update vendor_bills set status = 'paid', paid_on = coalesce($2::date, current_date) where id = $1`, [id, b.date ?? null]);
      await postJournal(tx, a.tenantId, { date: b.date, memo: `Payment of bill ${bill.number}`, source: 'bill_payment', sourceRef: id, postedBy: a.userId, lines: [{ account: '2000', debit: Number(bill.total_minor) }, { account: b.method === 'cash' ? '1000' : '1010', credit: Number(bill.total_minor) }] });
      return { paid: true };
    });
  }
  @Get('payables')
  payables(@Auth() a: AuthContext) {
    needs(a, 'accounting.read');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const rows = (await tx.query(`select b.id, b.number, s.name as supplier, b.bill_date, b.due_date, b.total_minor, (current_date - b.due_date) as days_overdue from vendor_bills b join suppliers s on s.id = b.supplier_id where b.status = 'open' order by b.due_date`)).rows.map((r) => ({ ...r, total_minor: Number(r.total_minor) }));
      const bucket = (lo: number, hi: number) => rows.filter((r) => r.days_overdue > lo && r.days_overdue <= hi).reduce((t, r) => t + r.total_minor, 0);
      return { bills: rows, total: rows.reduce((t, r) => t + r.total_minor, 0), ageing: { current: rows.filter((r) => r.days_overdue <= 0).reduce((t, r) => t + r.total_minor, 0), d1_30: bucket(0, 30), d31_60: bucket(30, 60), d60_plus: bucket(60, 100000) } };
    });
  }

  // ---------- bank reconciliation ----------
  @Post('bank-statement')
  statement(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'accounting.manage'); const b = parse(stmtS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      let added = 0, duplicates = 0;
      for (const l of b.lines) {
        const r = await tx.query(`insert into bank_statement_lines(tenant_id, stmt_date, description, amount_minor, reference) values ($1,$2,$3,$4,$5) on conflict do nothing returning id`, [a.tenantId, l.date, l.description, l.amountMinor, l.reference ?? null]);
        r.rowCount ? added++ : duplicates++;
      }
      return { added, duplicates };
    });
  }
  /** Matches inflows to bank-routed receipts by exact amount, a reference containing the receipt number or demo reference, and date within 5 days. Ambiguity is left for a human. */
  @Post('bank-reconciliation/auto-match')
  autoMatch(@Auth() a: AuthContext) {
    needs(a, 'accounting.manage');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const lines = (await tx.query(`select * from bank_statement_lines where matched_payment_id is null and amount_minor > 0 order by stmt_date`)).rows;
      let matched = 0, ambiguous = 0;
      for (const l of lines) {
        const c = (await tx.query(`select p.id from payments p where p.method <> 'cash' and p.amount_minor = $1 and abs(p.received_at::date - $2::date) <= 5 and not exists (select 1 from bank_statement_lines x where x.matched_payment_id = p.id)
          and ($3::text is null or p.receipt_no = $3 or p.reference = $3 or position(p.receipt_no in $4) > 0)`, [l.amount_minor, l.stmt_date, l.reference, l.description])).rows;
        if (c.length === 1) { await tx.query('update bank_statement_lines set matched_payment_id = $2, matched_at = now() where id = $1', [l.id, c[0].id]); matched++; }
        else if (c.length > 1) ambiguous++;
      }
      await audit(tx, a, a.tenantId, 'accounting.bank_match', 'bank', undefined, null, { matched, ambiguous });
      return { matched, ambiguous, unmatched: lines.length - matched - ambiguous };
    });
  }
  @Get('bank-reconciliation')
  recon(@Auth() a: AuthContext) {
    needs(a, 'accounting.read');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const unmatchedStatement = (await tx.query(`select id, stmt_date, description, amount_minor, reference from bank_statement_lines where matched_payment_id is null order by stmt_date`)).rows.map((r) => ({ ...r, amount_minor: Number(r.amount_minor) }));
      const unmatchedPayments = (await tx.query(`select p.id, p.receipt_no, p.method, p.amount_minor, p.received_at from payments p where p.method <> 'cash' and not exists (select 1 from bank_statement_lines x where x.matched_payment_id = p.id) order by p.received_at`)).rows.map((r) => ({ ...r, amount_minor: Number(r.amount_minor) }));
      const bank = (await tx.query(`select coalesce(sum(l.debit_minor - l.credit_minor),0)::bigint n from journal_lines l join accounts a on a.id = l.account_id where a.code = '1010'`)).rows[0].n;
      const stmt = (await tx.query('select coalesce(sum(amount_minor),0)::bigint n from bank_statement_lines')).rows[0].n;
      return { bookBalance: Number(bank), statementTotal: Number(stmt), unmatchedStatement, unmatchedPayments };
    });
  }

  // ---------- backfill: brings pre-ledger records into the general ledger ----------
  /** Idempotently posts journals for invoices, adjustments, payments, refunds and payroll that predate the GL (or were imported). */
  @Post('backfill')
  backfill(@Auth() a: AuthContext) {
    needs(a, 'accounting.approve');
    return this.db.withTenant(a.tenantId, async (tx) => ({ ...(await backfillGl(tx, a.tenantId, a.userId)) }));
  }
}

export async function backfillGl(tx: Tx, tenantId: string, by: string | null) {
  await ensureChart(tx, tenantId);
  const heads = new Map((await tx.query('select id, code from fee_heads')).rows.map((r) => [r.id as string, r.code as string]));
  let invoices = 0, adjustments = 0, payments = 0, refunds = 0, payroll = 0;
  for (const i of (await tx.query(`select i.id, i.number, i.issue_date, i.total_minor from invoices i where i.status <> 'void' and not exists (select 1 from journal_entries e where e.source = 'invoice' and e.source_ref = i.id::text) order by i.number`)).rows) {
    const lines = (await tx.query('select head_id, amount_minor from invoice_lines where invoice_id = $1', [i.id])).rows;
    const inc = new Map<string, number>();
    for (const l of lines) { const acct = (l.head_id && INCOME_BY_HEAD[heads.get(l.head_id) ?? '']) || '4020'; inc.set(acct, (inc.get(acct) ?? 0) + Number(l.amount_minor)); }
    await postJournal(tx, tenantId, { date: i.issue_date, memo: `Invoice ${i.number}`, source: 'invoice', sourceRef: i.id, postedBy: by, lines: [{ account: '1100', debit: Number(i.total_minor) }, ...[...inc].map(([account, credit]) => ({ account, credit }))] });
    invoices++;
  }
  for (const d of (await tx.query(`select a.id, a.amount_minor, a.reason, a.source, a.created_at::date as d from invoice_adjustments a join invoices i on i.id = a.invoice_id where i.status <> 'void' and not exists (select 1 from journal_entries e where e.source = 'adjustment' and e.source_ref = a.id::text) order by a.created_at`)).rows) {
    await postJournal(tx, tenantId, { date: d.d, memo: d.reason, source: 'adjustment', sourceRef: d.id, postedBy: by, lines: [{ account: d.source === 'write_off' ? '5900' : '4900', debit: Number(d.amount_minor) }, { account: '1100', credit: Number(d.amount_minor) }] });
    adjustments++;
  }
  for (const p of (await tx.query(`select p.id, p.receipt_no, p.method, p.amount_minor, p.received_at::date as d from payments p where not exists (select 1 from journal_entries e where e.source = 'payment' and e.source_ref = p.id::text) order by p.receipt_no`)).rows) {
    await postJournal(tx, tenantId, { date: p.d, memo: `Receipt ${p.receipt_no} (${p.method})`, source: 'payment', sourceRef: p.id, postedBy: by, lines: [{ account: CASH_BY_METHOD[p.method] ?? '1010', debit: Number(p.amount_minor) }, { account: '1100', credit: Number(p.amount_minor) }] });
    payments++;
  }
  for (const r of (await tx.query(`select r.id, r.amount_minor, r.reason, r.decided_at::date as d, p.method from refunds r join payments p on p.id = r.payment_id where r.status = 'approved' and not exists (select 1 from journal_entries e where e.source = 'refund' and e.source_ref = r.id::text)`)).rows) {
    await postJournal(tx, tenantId, { date: r.d, memo: `Refund: ${r.reason}`, source: 'refund', sourceRef: r.id, postedBy: by, lines: [{ account: '1100', debit: Number(r.amount_minor) }, { account: CASH_BY_METHOD[r.method] ?? '1010', credit: Number(r.amount_minor) }] });
    refunds++;
  }
  for (const run of (await tx.query(`select r.id, r.month, r.status from payroll_runs r where r.status in ('approved','paid')`)).rows) {
    const t = (await tx.query('select coalesce(sum(basic_minor + allowances_minor - absence_deduction_minor),0)::bigint gross, coalesce(sum(deductions_minor),0)::bigint ded, coalesce(sum(net_minor),0)::bigint net from payslips where run_id = $1', [run.id])).rows[0];
    const before = (await postJournal(tx, tenantId, { memo: `Payroll ${run.month}`, source: 'payroll', sourceRef: run.id, postedBy: by, lines: [{ account: '5000', debit: Number(t.gross) }, { account: '2100', credit: Number(t.net) }, { account: '2150', credit: Number(t.ded) }] }));
    if (run.status === 'paid') await postJournal(tx, tenantId, { memo: `Salary payment ${run.month}`, source: 'payroll_payment', sourceRef: run.id, postedBy: by, lines: [{ account: '2100', debit: Number(t.net) }, { account: '1010', credit: Number(t.net) }] });
    void before; payroll++;
  }
  return { invoices, adjustments, payments, refunds, payroll, accountsInChart: DEFAULT_CHART.length };
}
