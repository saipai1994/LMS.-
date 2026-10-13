import { INestApplication } from '@nestjs/common';
import { activate, adminSession, bearer, bootApp, http, login, schoolBase, userSession } from './helpers';
import { resetRateLimits } from '../src/auth/auth.service';
import { signWebhook } from '../src/finance/finance.controller';

const SECRET = 'test-gateway-secret-0123456789';
let app: INestApplication;
beforeAll(async () => { process.env.DEMO_GATEWAY_SECRET = SECRET; process.env.DEMO_MODE = 'true'; app = await bootApp(); });
afterAll(async () => { delete process.env.DEMO_MODE; await app.close(); });
beforeEach(() => resetRateLimits());

describe('finance: invoices, payments, ledger, refunds, demo gateway', () => {
  let A: Awaited<ReturnType<typeof adminSession>>; let base: Awaited<ReturnType<typeof schoolBase>>;
  let acct: any, principal: any; let boarder: any, day: any; let pBoard: string, pDay: string;
  const f = (tok: string) => ({
    get: (u: string) => http(app).get(u).set(bearer(tok)),
    post: (u: string, b?: any) => http(app).post(u).set(bearer(tok)).send(b ?? {}),
  });
  let invBoard: any, invDay: any;

  beforeAll(async () => {
    A = await adminSession(app, 'fincorp');
    acct = await userSession(app, 'fincorp', A.token, 'acct@fincorp.test', 'accountant');
    principal = await userSession(app, 'fincorp', A.token, 'prin@fincorp.test', 'principal');
    base = await schoolBase(app, A.token, A.campusId);
    boarder = await base.admit('boarder', 'fb@example.test', 'Bo');
    day = await base.admit('day_scholar', 'fd@example.test', 'Dee');
    await activate(app, 'fincorp', boarder.parentInviteToken); pBoard = await login(app, 'fincorp', 'fb@example.test');
    await activate(app, 'fincorp', day.parentInviteToken); pDay = await login(app, 'fincorp', 'fd@example.test');
    const tuition = (await f(acct.token).post('/finance/fee-heads', { code: 'TUI', name: 'Tuition' }).expect(201)).body;
    const boarding = (await f(acct.token).post('/finance/fee-heads', { code: 'BRD', name: 'Boarding' }).expect(201)).body;
    await f(acct.token).post('/finance/fee-structures', { academicYearId: base.year.id, gradeLevelId: base.grade.id, headId: tuition.id, amountMinor: 100000 }).expect(201);
    await f(acct.token).post('/finance/fee-structures', { academicYearId: base.year.id, gradeLevelId: base.grade.id, residenceType: 'boarder', headId: boarding.id, amountMinor: 50000 }).expect(201);
    await f(acct.token).post('/finance/fee-structures', { academicYearId: base.year.id, gradeLevelId: base.grade.id, residenceType: 'boarder', headId: boarding.id, amountMinor: 1 }).expect(409); // duplicate rule
  });

  it('generates invoices from fee structures, idempotently per batch', async () => {
    const gen = () => f(acct.token).post('/finance/invoices/generate', { academicYearId: base.year.id, dueDate: '2026-12-31', batchKey: 'TERM1' });
    expect((await gen().expect(201)).body).toEqual({ created: 2, skippedExisting: 0, skippedNoFees: 0 });
    expect((await gen().expect(201)).body).toEqual({ created: 0, skippedExisting: 2, skippedNoFees: 0 });
    const list = (await f(acct.token).get('/finance/invoices').expect(200)).body;
    expect(list.map((i: any) => Number(i.total_minor)).sort()).toEqual([100000, 150000]);
    invBoard = list.find((i: any) => i.student_id === boarder.studentId); invDay = list.find((i: any) => i.student_id === day.studentId);
    expect(invBoard.number).toBe('INV-000001');
    await f(principal.token).post('/finance/invoices/generate', { academicYearId: base.year.id, dueDate: '2026-12-31', batchKey: 'X' }).expect(403); // read-only
  });

  it('parents see only their own invoices and ledger', async () => {
    const mine = (await f(pBoard).get('/finance/me/invoices').expect(200)).body;
    expect(mine.map((i: any) => i.id)).toEqual([invBoard.id]);
    await f(pBoard).get(`/finance/invoices/${invDay.id}`).expect(404);
    await f(pBoard).get(`/finance/students/${day.studentId}/ledger`).expect(404);
    await f(pBoard).get('/finance/invoices').expect(403);
    expect((await f(pBoard).get(`/finance/students/${boarder.studentId}/ledger`).expect(200)).body.balanceMinor).toBe(150000);
  });

  it('records offline payments idempotently with receipts and correct balances', async () => {
    const pay = (body: any) => f(acct.token).post('/finance/payments', { studentId: boarder.studentId, invoiceId: invBoard.id, method: 'cash', amountMinor: 40000, idempotencyKey: 'key-0001-aaaa', ...body });
    const first = (await pay({}).expect(201)).body;
    expect(first.receiptNo).toBe('RCT-000001');
    const replay = (await pay({}).expect(200)).body;
    expect(replay).toMatchObject({ id: first.id, idempotentReplay: true });
    await pay({ amountMinor: 50000 }).expect(422);                                        // same key, different request
    await pay({ idempotencyKey: 'key-0002-bbbb', amountMinor: 999999 }).expect(422);      // exceeds outstanding
    await f(pDay).post('/finance/payments', { studentId: day.studentId, method: 'cash', amountMinor: 10, idempotencyKey: 'key-parent-1' }).expect(404); // parents cannot record cash
    const inv = (await f(acct.token).get(`/finance/invoices/${invBoard.id}`).expect(200)).body;
    expect([Number(inv.paid_minor), Number(inv.outstanding_minor), inv.display_status]).toEqual([40000, 110000, 'partially_paid']);
    expect((await f(pBoard).get(`/finance/students/${boarder.studentId}/ledger`)).body.balanceMinor).toBe(110000);
    const rc = (await f(pBoard).get(`/finance/payments/${first.id}/receipt`).expect(200)).body;
    expect(rc).toMatchObject({ receiptNo: 'RCT-000001', amountMinor: 40000, simulated: false });
    await f(pDay).get(`/finance/payments/${first.id}/receipt`).expect(404);
  });

  it('Scenario E: online demo payment is server-verified, signed, and replay-safe', async () => {
    const intent = (await f(pDay).post('/finance/payment-intents', { invoiceId: invDay.id }).expect(201)).body;
    expect(intent).toMatchObject({ amount_minor: 100000, simulated: true });
    await f(pBoard).post('/finance/payment-intents', { invoiceId: invDay.id }).expect(404);
    const payload = JSON.stringify({ eventId: `evt_forged_1`, tenantId: A.tenantId, intentId: intent.id, status: 'succeeded', amountMinor: 100000 });
    const send = (raw: string, sig: string) => http(app).post('/finance/webhooks/demo-gateway').set('content-type', 'application/json').set('x-signature', sig).send(raw);
    await send(payload, 'deadbeef').expect(403);                                                // forged
    await send(payload, signWebhook('wrong-secret-0123456789', payload)).expect(403);
    // client-side "success" claim changes nothing
    expect(Number((await f(acct.token).get(`/finance/invoices/${invDay.id}`)).body.outstanding_minor)).toBe(100000);
    // valid signature but wrong amount → needs review, no payment
    const bad = JSON.stringify({ eventId: 'evt_bad_amount', tenantId: A.tenantId, intentId: intent.id, status: 'succeeded', amountMinor: 1 });
    await send(bad, signWebhook(SECRET, bad)).expect(422);
    expect(Number((await f(acct.token).get(`/finance/invoices/${invDay.id}`)).body.outstanding_minor)).toBe(100000);
    // new intent, simulated success twice
    const i2 = (await f(pDay).post('/finance/payment-intents', { invoiceId: invDay.id }).expect(201)).body;
    const ok = (await f(pDay).post(`/finance/payment-intents/${i2.id}/simulate`, { outcome: 'succeeded' }).expect(200)).body;
    expect(ok.status).toBe('succeeded');
    expect((await f(pDay).post(`/finance/payment-intents/${i2.id}/simulate`, { outcome: 'succeeded' }).expect(200)).body).toEqual({ duplicate: true });
    const inv = (await f(pDay).get(`/finance/invoices/${invDay.id}`).expect(200)).body;
    expect([inv.display_status, Number(inv.outstanding_minor), inv.payments.length]).toEqual(['paid', 0, 1]);
    const rc = (await f(pDay).get(`/finance/payments/${ok.paymentId}/receipt`).expect(200)).body;
    expect(rc.simulated).toBe(true); expect(rc.notice).toMatch(/DEMO/);
    await f(pDay).post('/finance/payment-intents', { invoiceId: invDay.id }).expect(409);        // nothing due
    expect((await f(pDay).get(`/finance/students/${day.studentId}/ledger`)).body.balanceMinor).toBe(0);
    const n = (await f(pDay).get('/notifications').expect(200)).body;
    expect(n.some((x: any) => x.kind === 'finance.receipt' && /simulated/.test(x.body))).toBe(true);
  });

  it('serializes concurrent payments: exactly one full payment succeeds', async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) =>
      f(acct.token).post('/finance/payments', { studentId: boarder.studentId, invoiceId: invBoard.id, method: 'bank_transfer', amountMinor: 110000, idempotencyKey: `race-key-000${n}` })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 422)).toHaveLength(4);
    const inv = (await f(acct.token).get(`/finance/invoices/${invBoard.id}`)).body;
    expect([Number(inv.outstanding_minor), inv.display_status]).toEqual([0, 'paid']);
  });

  it('refunds need a second approver and restore the balance', async () => {
    const pays = (await f(acct.token).get(`/finance/invoices/${invBoard.id}`)).body.payments;
    const big = pays.find((p: any) => Number(p.amount_minor) === 110000);
    await f(acct.token).post(`/finance/payments/${big.id}/refunds`, { amountMinor: 200000, reason: 'too much' }).expect(422);
    const r = (await f(acct.token).post(`/finance/payments/${big.id}/refunds`, { amountMinor: 30000, reason: 'Duplicate bank transfer' }).expect(201)).body;
    await f(acct.token).post(`/finance/refunds/${r.id}/decision`, { decision: 'approve' }).expect(403);   // maker cannot approve
    await f(principal.token).post(`/finance/refunds/${r.id}/decision`, { decision: 'approve' }).expect(201);
    await f(principal.token).post(`/finance/refunds/${r.id}/decision`, { decision: 'approve' }).expect(409);
    const inv = (await f(acct.token).get(`/finance/invoices/${invBoard.id}`)).body;
    expect(Number(inv.outstanding_minor)).toBe(30000);
    expect((await f(pBoard).get(`/finance/students/${boarder.studentId}/ledger`)).body.balanceMinor).toBe(30000);
    // self-approval by an approver who is also the requester
    const r2 = (await f(principal.token).post(`/finance/payments/${big.id}/refunds`, { amountMinor: 1000, reason: 'self' })).status;
    expect(r2).toBe(404); // principal lacks finance.manage, cannot even request
  });

  it('credit notes and voids are approver-only and keep the ledger consistent', async () => {
    await f(acct.token).post(`/finance/invoices/${invBoard.id}/credit-notes`, { amountMinor: 5000, reason: 'Sibling discount' }).expect(404);
    await f(principal.token).post(`/finance/invoices/${invBoard.id}/credit-notes`, { amountMinor: 99999999, reason: 'x y z' }).expect(422);
    await f(principal.token).post(`/finance/invoices/${invBoard.id}/credit-notes`, { amountMinor: 5000, reason: 'Sibling discount' }).expect(201);
    await f(principal.token).post(`/finance/invoices/${invBoard.id}/void`).expect(409); // has payments
    const man = (await f(acct.token).post('/finance/invoices', { studentId: day.studentId, dueDate: '2020-01-01', lines: [{ description: 'Lab kit', amountMinor: 20000 }] }).expect(201)).body;
    const od = (await f(acct.token).get('/finance/invoices?status=overdue').expect(200)).body;
    expect(od.map((i: any) => i.id)).toContain(man.id);
    await f(principal.token).post(`/finance/invoices/${man.id}/void`).expect(200);
    const rec = (await f(acct.token).get('/finance/reconciliation').expect(200)).body;
    expect(rec.discrepancies).toEqual([]);
    expect(rec.byMethod.map((m: any) => m.method)).toEqual(expect.arrayContaining(['cash', 'bank_transfer', 'online_demo']));
    const sum = (await f(principal.token).get('/finance/summary').expect(200)).body;
    expect(sum.outstanding).toBe(25000);
    expect(sum.collected).toBe(40000 + 110000 + 100000 - 30000);
  });

  it('isolates finance data and protects the ledger from edits', async () => {
    const B = await adminSession(app, 'fin-other');
    expect((await http(app).get('/finance/invoices').set(bearer(B.token)).expect(200)).body).toEqual([]);
    await http(app).get(`/finance/invoices/${invBoard.id}`).set(bearer(B.token)).expect(404);
    await http(app).post('/finance/payments').set(bearer(B.token)).send({ studentId: boarder.studentId, method: 'cash', amountMinor: 1000, idempotencyKey: 'cross-tenant-1' }).expect(404);
    const { DbService } = await import('../src/db/db.service');
    await expect(app.get(DbService).withTenant(A.tenantId, (tx) => tx.query('delete from ledger_entries'))).rejects.toThrow(/append-only/);
  });
});
