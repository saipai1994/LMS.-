import { INestApplication } from '@nestjs/common';
import { activate, adminSession, bearer, bootApp, http, login, schoolBase, userSession } from './helpers';
import { resetRateLimits } from '../src/auth/auth.service';
import { DbService } from '../src/db/db.service';

let app: INestApplication;
beforeAll(async () => { app = await bootApp(); });
afterAll(async () => { await app.close(); });
beforeEach(() => resetRateLimits());
const f = (tok: string) => ({ get: (u: string) => http(app).get(u).set(bearer(tok)), post: (u: string, b?: any) => http(app).post(u).set(bearer(tok)).send(b ?? {}), put: (u: string, b?: any) => http(app).put(u).set(bearer(tok)).send(b ?? {}) });

describe('accounting', () => {
  let A: Awaited<ReturnType<typeof adminSession>>; let base: Awaited<ReturnType<typeof schoolBase>>;
  let acct: any, principal: any, tch: any, hr: any; let s1: any, s2: any; let invs: any[] = [];
  const tb = async () => (await f(acct.token).get('/accounting/trial-balance').expect(200)).body;
  const bal = (t: any, code: string) => { const r = t.accounts.find((x: any) => x.code === code); return r ? r.balanceDebit - r.balanceCredit : 0; };

  beforeAll(async () => {
    A = await adminSession(app, 'glco');
    acct = await userSession(app, 'glco', A.token, 'acct@glco.test', 'accountant'); principal = await userSession(app, 'glco', A.token, 'prin@glco.test', 'principal'); tch = await userSession(app, 'glco', A.token, 'tch@glco.test', 'teacher'); hr = await userSession(app, 'glco', A.token, 'hr@glco.test', 'hr_payroll');
    base = await schoolBase(app, A.token, A.campusId);
    s1 = await base.admit('boarder', 'g1@example.test', 'Gia'); s2 = await base.admit('day_scholar', 'g2@example.test', 'Gus');
    const tui = (await f(acct.token).post('/finance/fee-heads', { code: 'TUI', name: 'Tuition' }).expect(201)).body; const brd = (await f(acct.token).post('/finance/fee-heads', { code: 'BRD', name: 'Boarding' }).expect(201)).body;
    await f(acct.token).post('/finance/fee-structures', { academicYearId: base.year.id, gradeLevelId: base.grade.id, headId: tui.id, amountMinor: 1000000 }).expect(201);
    await f(acct.token).post('/finance/fee-structures', { academicYearId: base.year.id, gradeLevelId: base.grade.id, residenceType: 'boarder', headId: brd.id, amountMinor: 400000 }).expect(201);
    await f(acct.token).post('/finance/invoices/generate', { academicYearId: base.year.id, dueDate: '2026-12-01', batchKey: 'T1' }).expect(201);
    invs = (await f(acct.token).get('/finance/invoices').expect(200)).body;
  });

  it('finance events post balanced journals; receivable control account equals invoice outstanding', async () => {
    await f(tch.token).get('/accounting/accounts').expect(403);
    expect((await f(acct.token).get('/accounting/accounts').expect(200)).body.length).toBeGreaterThan(10);
    let t = await tb();
    expect(t.balanced).toBe(true);
    expect(bal(t, '1100')).toBe(1400000 + 1000000);                                                        // both invoices
    expect([bal(t, '4000'), bal(t, '4010')]).toEqual([-2000000, -400000]);                                // credit balances: tuition 2 × 10,000 and boarding 4,000
    const inv1 = invs.find((i: any) => i.student_id === s1.studentId), inv2 = invs.find((i: any) => i.student_id === s2.studentId);
    await f(acct.token).post('/finance/payments', { studentId: s1.studentId, invoiceId: inv1.id, method: 'cash', amountMinor: 500000, idempotencyKey: 'gl-pay-0001' }).expect(201);
    const p2 = (await f(acct.token).post('/finance/payments', { studentId: s2.studentId, invoiceId: inv2.id, method: 'bank_transfer', amountMinor: 1000000, idempotencyKey: 'gl-pay-0002', reference: 'NEFT123' }).expect(201)).body;
    await f(principal.token).post(`/finance/invoices/${inv1.id}/credit-notes`, { amountMinor: 100000, reason: 'Hardship waiver' }).expect(201);
    const refund = (await f(acct.token).post(`/finance/payments/${p2.id}/refunds`, { amountMinor: 200000, reason: 'Duplicate transfer' }).expect(201)).body;
    await f(principal.token).post(`/finance/refunds/${refund.id}/decision`, { decision: 'approve' }).expect(201);
    t = await tb();
    expect(t.balanced).toBe(true);
    expect([bal(t, '1000'), bal(t, '1010')]).toEqual([500000, 1000000 - 200000]);                          // cash and bank
    expect(bal(t, '4900')).toBe(100000);
    const outstanding = (await f(acct.token).get('/finance/summary').expect(200)).body.outstanding;
    expect(bal(t, '1100')).toBe(outstanding);                                                              // GL agrees with the sub-ledger
    expect(bal(t, '1100')).toBe(1400000 + 1000000 - 500000 - 1000000 - 100000 + 200000);
    expect((await f(acct.token).get('/finance/reconciliation').expect(200)).body.discrepancies).toEqual([]);
    // income statement
    const is = (await f(acct.token).get('/accounting/reports/income-statement?from=2020-01-01&to=2099-12-31').expect(200)).body;
    expect(is.totalIncome).toBe(2000000 + 400000 - 100000); expect(is.surplus).toBe(2300000);
    const bs = (await f(principal.token).get('/accounting/reports/balance-sheet?asOf=2099-12-31').expect(200)).body;
    expect(bs.balanced).toBe(true);
    const led = (await f(acct.token).get('/accounting/ledger/1100').expect(200)).body;
    expect(led.closing).toBe(bal(t, '1100'));
  });

  it('manual journals must balance; reversal needs a different approver; entries are immutable', async () => {
    const j = (lines: any[]) => f(acct.token).post('/accounting/journals', { memo: 'Donation received', lines });
    await j([{ account: '1010', debit: 500000 }, { account: '3000', credit: 400000 }]).expect(422).expect((r: any) => expect(r.body.error).toBe('unbalanced'));
    await j([{ account: '1010', debit: 500000, credit: 500000 }, { account: '3000', credit: 0 }]).expect(422);
    await j([{ account: '9999', debit: 500000 }, { account: '3000', credit: 500000 }]).expect(422);
    await f(tch.token).post('/accounting/journals', { memo: 'x y z', lines: [{ account: '1010', debit: 1 }, { account: '3000', credit: 1 }] }).expect(403);
    const je = (await j([{ account: '1010', debit: 500000 }, { account: '3000', credit: 500000 }]).expect(201)).body;
    await f(acct.token).post(`/accounting/journals/${je.id}/reverse`, { reason: 'Posted twice by mistake' }).expect(403);   // accountant lacks approve
    await f(principal.token).post(`/accounting/journals/${je.id}/reverse`, { reason: 'Posted twice by mistake' }).expect(201);
    await f(principal.token).post(`/accounting/journals/${je.id}/reverse`, { reason: 'Posted twice again?' }).expect(409);
    const t = await tb(); expect(t.balanced).toBe(true); expect(bal(t, '3000')).toBe(0);
    await expect(app.get(DbService).withTenant(A.tenantId, (tx) => tx.query('update journal_lines set debit_minor = 1'))).rejects.toThrow(/append-only/);
    await expect(app.get(DbService).withTenant(A.tenantId, (tx) => tx.query('delete from journal_entries'))).rejects.toThrow(/append-only/);
    // the database itself refuses an unbalanced entry even if the API were bypassed
    await expect(app.get(DbService).withTenant(A.tenantId, async (tx) => {
      const acc = (await tx.query(`select id from accounts where code = '1000'`)).rows[0].id;
      const e = (await tx.query(`insert into journal_entries(tenant_id, entry_no, entry_date, memo, source) values ($1, 9999, current_date, 'bad', 'manual') returning id`, [A.tenantId])).rows[0];
      await tx.query(`insert into journal_lines(tenant_id, entry_id, line_no, account_id, debit_minor) values ($1,$2,1,$3,100)`, [A.tenantId, e.id, acc]);
    })).rejects.toThrow(/unbalanced/);
  });

  it('payroll posts to the ledger; vendor bills flow through payables; budgets show variance', async () => {
    const e1 = await f(hr.token).post('/hr/staff', { userId: tch.userId, campusId: A.campusId, employeeNo: 'T1', designation: 'Teacher', joinDate: '2025-01-01' }).expect(201);
    await f(hr.token).post(`/payroll/staff/${e1.body.id}/salary`, { effectiveFrom: '2026-01-01', basicMinor: 4000000, allowances: [{ name: 'HRA', amountMinor: 1000000 }], deductions: [{ name: 'PF', amountMinor: 500000 }] }).expect(201);
    const run = (await f(hr.token).post('/payroll/runs', { month: '2026-09' }).expect(201)).body;
    await f(principal.token).post(`/payroll/runs/${run.id}/decision`, { decision: 'approve' }).expect(201);
    let t = await tb();
    expect([bal(t, '5000'), bal(t, '2100'), bal(t, '2150')]).toEqual([5000000, -4500000, -500000]);
    await f(principal.token).post(`/payroll/runs/${run.id}/decision`, { decision: 'mark_paid' }).expect(201);
    t = await tb(); expect(bal(t, '2100')).toBe(0); expect(t.balanced).toBe(true);
    // vendor bill
    const sup = (await f(A.token).post('/procurement/suppliers', { name: 'Paper & Co' }).expect(201)).body;
    await f(acct.token).post('/accounting/cost-centres', { code: 'ADMIN', name: 'Administration' }).expect(201);
    await f(acct.token).post('/accounting/bills', { supplierId: sup.id, number: 'PC-77', billDate: '2026-09-01', dueDate: '2026-09-30', lines: [{ account: '3000', amountMinor: 1 }] }).expect(422);
    const bill = (await f(acct.token).post('/accounting/bills', { supplierId: sup.id, number: 'PC-77', billDate: '2026-09-01', dueDate: '2026-09-30', lines: [{ account: '5100', amountMinor: 250000, costCentre: 'ADMIN' }] }).expect(201)).body;
    await f(acct.token).post('/accounting/bills', { supplierId: sup.id, number: 'PC-77', billDate: '2026-09-01', dueDate: '2026-09-30', lines: [{ account: '5100', amountMinor: 250000 }] }).expect(409);   // same supplier invoice twice
    const ap = (await f(acct.token).get('/accounting/payables').expect(200)).body;
    expect(ap.total).toBe(250000); expect(ap.ageing.d1_30 + ap.ageing.d31_60 + ap.ageing.d60_plus).toBe(250000);
    await f(acct.token).post(`/accounting/bills/${bill.id}/pay`, {}).expect(403);                              // booker cannot also release payment without approval right
    await f(principal.token).post(`/accounting/bills/${bill.id}/pay`, {}).expect(201);
    await f(principal.token).post(`/accounting/bills/${bill.id}/pay`, {}).expect(409);
    t = await tb(); expect(bal(t, '2000')).toBe(0); expect(bal(t, '5100')).toBe(250000);
    // budget vs actual
    await f(acct.token).put('/accounting/budgets', { academicYearId: base.year.id, costCentre: 'ADMIN', account: '5100', amountMinor: 200000 }).expect(200);
    const bva = (await f(acct.token).get(`/accounting/budget-vs-actual?academicYearId=${base.year.id}`).expect(200)).body;
    expect(bva[0]).toMatchObject({ budget: 200000, actual: 250000, variance: -50000, overBudget: true, usedPercent: 125 });
  });

  it('bank reconciliation matches receipts, flags ambiguity, and backfill is idempotent', async () => {
    await f(acct.token).post('/accounting/bank-statement', { lines: [
      { date: new Date().toISOString().slice(0, 10), description: 'NEFT credit', amountMinor: 1000000, reference: 'NEFT123' },
      { date: new Date().toISOString().slice(0, 10), description: 'Unknown deposit', amountMinor: 777700 },
    ] }).expect(201).expect((r: any) => expect(r.body.added).toBe(2));
    await f(acct.token).post('/accounting/bank-statement', { lines: [{ date: new Date().toISOString().slice(0, 10), description: 'NEFT credit', amountMinor: 1000000, reference: 'NEFT123' }] }).expect(201).expect((r: any) => expect(r.body).toEqual({ added: 0, duplicates: 1 }));
    expect((await f(acct.token).post('/accounting/bank-reconciliation/auto-match').expect(201)).body).toMatchObject({ matched: 1, unmatched: 1 });
    const rc = (await f(acct.token).get('/accounting/bank-reconciliation').expect(200)).body;
    expect(rc.unmatchedStatement.map((x: any) => x.amount_minor)).toEqual([777700]); expect(rc.unmatchedPayments).toEqual([]);
    await f(tch.token).get('/accounting/bank-reconciliation').expect(403);
    // backfill: an invoice inserted outside the application (e.g. a data import) gets journals exactly once
    await app.get(DbService).withTenant(A.tenantId, async (tx) => {
      const inv = (await tx.query(`insert into invoices(tenant_id, student_id, number, due_date, total_minor, created_by) values ($1,$2,'IMPORT-1',current_date,123400,$3) returning id`, [A.tenantId, s2.studentId, acct.userId])).rows[0];
      await tx.query(`insert into invoice_lines(tenant_id, invoice_id, line_no, description, amount_minor) values ($1,$2,1,'Imported fee',123400)`, [A.tenantId, inv.id]);
    });
    const before = bal(await tb(), '1100');
    await f(acct.token).post('/accounting/backfill').expect(403);
    expect((await f(principal.token).post('/accounting/backfill').expect(201)).body.invoices).toBe(1);
    expect((await f(principal.token).post('/accounting/backfill').expect(201)).body.invoices).toBe(0);
    expect(bal(await tb(), '1100')).toBe(before + 123400);
    const B = await adminSession(app, 'glco-other');
    expect((await f(B.token).get('/accounting/trial-balance').expect(200)).body.accounts).toEqual([]);
    await f(B.token).get(`/accounting/journals/${'00000000-0000-4000-8000-000000000000'}`).expect(404);
  });
});
