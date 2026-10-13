import { INestApplication } from '@nestjs/common';
import { activate, adminSession, bearer, bootApp, http, login, schoolBase, userSession } from './helpers';
import { resetRateLimits } from '../src/auth/auth.service';
import { DbService } from '../src/db/db.service';

let app: INestApplication;
beforeAll(async () => { app = await bootApp(); });
afterAll(async () => { await app.close(); });
beforeEach(() => resetRateLimits());
const f = (tok: string) => ({ get: (u: string) => http(app).get(u).set(bearer(tok)), post: (u: string, b?: any) => http(app).post(u).set(bearer(tok)).send(b ?? {}) });

describe('library', () => {
  let A: Awaited<ReturnType<typeof adminSession>>; let base: Awaited<ReturnType<typeof schoolBase>>;
  let lib: any, teacher: any; let s1: any, s2: any; let p1: string, p2: string; let book: any;

  beforeAll(async () => {
    A = await adminSession(app, 'libco');
    lib = await userSession(app, 'libco', A.token, 'lib@libco.test', 'librarian');
    teacher = await userSession(app, 'libco', A.token, 'tch@libco.test', 'teacher');
    base = await schoolBase(app, A.token, A.campusId);
    s1 = await base.admit('day_scholar', 'r1@example.test', 'Rea'); s2 = await base.admit('day_scholar', 'r2@example.test', 'Raj');
    await activate(app, 'libco', s1.parentInviteToken); p1 = await login(app, 'libco', 'r1@example.test');
    await activate(app, 'libco', s2.parentInviteToken); p2 = await login(app, 'libco', 'r2@example.test');
    book = (await f(lib.token).post('/library/books', { campusId: A.campusId, title: 'Wings of Fire', author: 'A. P. J. Abdul Kalam', isbn: '9788173711466', barcodes: ['BK-0001'] }).expect(201)).body;
  });

  it('catalogue, validation and permissions', async () => {
    await f(teacher.token).post('/library/books', { campusId: A.campusId, title: 'X', author: 'Y', barcodes: ['Z-1'] }).expect(403);
    await f(lib.token).post('/library/books', { campusId: A.campusId, title: 'No barcode', author: 'Y' }).expect(422);
    await f(lib.token).post('/library/books', { campusId: A.campusId, title: 'Ebook', author: 'Y', kind: 'digital', url: 'https://example.test/ebook' }).expect(201);
    const found = (await f(p1).get('/library/books?q=wings').expect(200)).body;     // any signed-in member can search
    expect(found).toHaveLength(1); expect(found[0]).toMatchObject({ available: 1, copies: 1 });
  });

  it('issue → reserve → return with fine → reservation hold → collect', async () => {
    const db = app.get(DbService);
    await f(teacher.token).post('/library/issue', { barcode: 'BK-0001', studentId: s1.studentId }).expect(404);
    const loan = (await f(lib.token).post('/library/issue', { barcode: 'BK-0001', studentId: s1.studentId }).expect(201)).body;
    await f(lib.token).post('/library/issue', { barcode: 'BK-0001', studentId: s2.studentId }).expect(409);           // already issued
    await f(p2).post('/library/reservations', { bookId: book.id, studentId: s2.studentId }).expect(201);
    await f(p2).post('/library/reservations', { bookId: book.id, studentId: s2.studentId }).expect(409);
    await f(p1).post('/library/reservations', { bookId: book.id, studentId: s2.studentId }).expect(404);             // not their child
    await f(lib.token).post(`/library/loans/${loan.loanId}/renew`).expect(409);                                      // reserved by another reader
    // make the loan 5 days overdue
    await db.withTenant(A.tenantId, (tx) => tx.query(`update loans set due_on = current_date - 5, issued_on = current_date - 19 where id = $1`, [loan.loanId]));
    const od = (await f(lib.token).get('/library/overdue').expect(200)).body;
    expect(od[0]).toMatchObject({ title: 'Wings of Fire', days_overdue: 5 });
    await f(lib.token).post(`/library/loans/${loan.loanId}/renew`).expect(422);                                       // overdue cannot renew
    const ret = (await f(lib.token).post('/library/return', { barcode: 'BK-0001' }).expect(201)).body;
    expect(ret).toMatchObject({ lateDays: 5, fineMinor: 1000, heldForReservation: true });
    expect((await f(p2).get('/notifications').expect(200)).body.some((n: any) => n.kind === 'library.reservation_ready')).toBe(true);
    await f(lib.token).post('/library/issue', { barcode: 'BK-0001', studentId: s1.studentId }).expect(409);        // held for s2
    // fines block new loans until settled
    await f(lib.token).post('/library/books', { campusId: A.campusId, title: 'Other', author: 'Z', barcodes: ['BK-0002'] }).expect(201);
    await f(lib.token).post('/library/issue', { barcode: 'BK-0002', studentId: s1.studentId }).expect(422).expect((r: any) => expect(r.body.error).toBe('unpaid_fines'));
    await f(lib.token).post(`/library/loans/${loan.loanId}/settle-fine`).expect(201);
    await f(lib.token).post(`/library/loans/${loan.loanId}/settle-fine`).expect(409);
    await f(lib.token).post('/library/issue', { barcode: 'BK-0002', studentId: s1.studentId }).expect(201);
    await f(lib.token).post('/library/issue', { barcode: 'BK-0001', studentId: s2.studentId }).expect(201);         // reserved reader collects
    const view = (await f(p1).get(`/library/students/${s1.studentId}`).expect(200)).body;
    expect(view.loans.map((l: any) => l.title).sort()).toEqual(['Other', 'Wings of Fire']);
    await f(p2).get(`/library/students/${s1.studentId}`).expect(404);
  });

  it('renewal limits and lost-book handling; tenant isolation', async () => {
    const loan = (await f(lib.token).get(`/library/students/x`)).status; void loan;
    const [open] = (await f(p1).get(`/library/students/${s1.studentId}`)).body.loans.filter((l: any) => !l.returned_on);
    await f(lib.token).post(`/library/loans/${open.id}/renew`).expect(201);
    await f(lib.token).post(`/library/loans/${open.id}/renew`).expect(201);
    await f(lib.token).post(`/library/loans/${open.id}/renew`).expect(422).expect((r: any) => expect(r.body.error).toBe('renewal_limit_reached'));
    await f(lib.token).post('/library/return', { barcode: 'BK-0002', condition: 'lost' }).expect(201);
    expect((await f(lib.token).get('/library/books?q=other').expect(200)).body[0].available).toBe(0);
    const B = await adminSession(app, 'libco-other');
    await f(B.token).post('/library/issue', { barcode: 'BK-0002', studentId: s1.studentId }).expect(404);
    expect((await f(B.token).get('/library/books').expect(200)).body).toEqual([]);
  });
});

describe('inventory & procurement', () => {
  let A: Awaited<ReturnType<typeof adminSession>>;
  let inv: any, teacher: any, principal: any; let item: any, supplier: any;

  beforeAll(async () => {
    A = await adminSession(app, 'invco');
    inv = await userSession(app, 'invco', A.token, 'inv@invco.test', 'inventory_manager');
    teacher = await userSession(app, 'invco', A.token, 'tch@invco.test', 'teacher');
    principal = await userSession(app, 'invco', A.token, 'prin@invco.test', 'principal');
    item = (await f(inv.token).post('/inventory/items', { campusId: A.campusId, sku: 'MRK-01', name: 'Whiteboard markers', category: 'stationery', reorderLevel: 20 }).expect(201)).body;
    supplier = (await f(inv.token).post('/procurement/suppliers', { name: 'Paper & Co' }).expect(201)).body;
  });

  it('requisition → approval (maker-checker) → PO → goods receipt → stock → issue', async () => {
    await f(teacher.token).post('/inventory/items', { campusId: A.campusId, sku: 'XX1', name: 'Nope', category: 'misc' }).expect(403);
    const req = (await f(teacher.token).post('/procurement/requisitions', { campusId: A.campusId, justification: 'Classroom supplies for term 2', lines: [{ itemId: item.id, qty: 100, estUnitCostMinor: 2500 }] }).expect(201)).body;
    expect(req.number).toBe('PR-00001');
    await f(inv.token).post(`/procurement/requisitions/${req.id}/order`, { supplierId: supplier.id }).expect(409);       // not yet approved
    await f(teacher.token).post(`/procurement/requisitions/${req.id}/decision`, { decision: 'approve' }).expect(404);       // requesters cannot approve
    await f(inv.token).post(`/procurement/requisitions/${req.id}/decision`, { decision: 'approve' }).expect(404);            // inventory manager lacks approval right
    await f(principal.token).post(`/procurement/requisitions/${req.id}/decision`, { decision: 'approve' }).expect(201);
    await f(principal.token).post(`/procurement/requisitions/${req.id}/decision`, { decision: 'reject' }).expect(409);
    const po = (await f(inv.token).post(`/procurement/requisitions/${req.id}/order`, { supplierId: supplier.id }).expect(201)).body;
    expect(po).toMatchObject({ number: 'PO-00001', total_minor: 250000 });
    await f(inv.token).post(`/procurement/requisitions/${req.id}/order`, { supplierId: supplier.id }).expect(409);
    await f(inv.token).post(`/procurement/orders/${po.id}/receive`, { lines: [{ itemId: item.id, qty: 150 }] }).expect(422).expect((r: any) => expect(r.body.error).toBe('over_receipt'));
    expect((await f(inv.token).post(`/procurement/orders/${po.id}/receive`, { lines: [{ itemId: item.id, qty: 60 }] }).expect(201)).body.status).toBe('partially_received');
    expect((await f(inv.token).get('/inventory/items').expect(200)).body[0].on_hand).toBe(60);
    expect((await f(inv.token).post(`/procurement/orders/${po.id}/receive`, { lines: [{ itemId: item.id, qty: 40 }] }).expect(201)).body.status).toBe('received');
    await f(inv.token).post(`/procurement/orders/${po.id}/receive`, { lines: [{ itemId: item.id, qty: 1 }] }).expect(409);
    // issue stock; cannot go negative; low-stock alert
    await f(inv.token).post('/inventory/issue', { itemId: item.id, qty: 200, issuedTo: 'Science dept' }).expect(409);
    const r = (await f(inv.token).post('/inventory/issue', { itemId: item.id, qty: 85, issuedTo: 'Science dept' }).expect(201)).body;
    expect(r).toEqual({ onHand: 15, belowReorderLevel: true });
    expect((await f(inv.token).get('/inventory/low-stock').expect(200)).body.map((x: any) => x.sku)).toEqual(['MRK-01']);
    await f(inv.token).post(`/inventory/items/${item.id}/adjust`, { qtyDelta: -2, reason: 'Count correction' }).expect(404);      // approvers only
    expect((await f(principal.token).post(`/inventory/items/${item.id}/adjust`, { qtyDelta: -2, reason: 'Count correction' }).expect(201)).body.onHand).toBe(13);   // approvers may adjust
    await f(principal.token).post(`/inventory/items/${item.id}/adjust`, { qtyDelta: -50, reason: 'Too many' }).expect(409);
  });

  it('concurrent issues never oversell stock; assets and warranty alerts; tenant isolation', async () => {
    const it2 = (await f(inv.token).post('/inventory/items', { campusId: A.campusId, sku: 'LAP-1', name: 'Laptop', category: 'equipment' }).expect(201)).body;
    const PO = (await f(A.token).post('/procurement/requisitions', { campusId: A.campusId, justification: 'Computer lab refresh', lines: [{ itemId: it2.id, qty: 5, estUnitCostMinor: 4000000 }] }).expect(201)).body;
    await f(principal.token).post(`/procurement/requisitions/${PO.id}/decision`, { decision: 'approve' }).expect(201);
    const po = (await f(inv.token).post(`/procurement/requisitions/${PO.id}/order`, { supplierId: supplier.id, unitCosts: { [it2.id]: 3900000 } }).expect(201)).body;
    expect(po.total_minor).toBe(19500000);
    await f(inv.token).post(`/procurement/orders/${po.id}/receive`, { lines: [{ itemId: it2.id, qty: 5 }] }).expect(201);
    const res = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => f(inv.token).post('/inventory/issue', { itemId: it2.id, qty: 1, issuedTo: `Room ${n}` })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(5);
    expect(res.filter((r) => r.status === 409)).toHaveLength(1);
    const d = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    await f(inv.token).post('/assets', { campusId: A.campusId, tag: 'AST-001', name: 'Projector', warrantyExpiry: d, purchaseCostMinor: 5000000 }).expect(201);
    expect((await f(inv.token).get('/assets/warranty-alerts').expect(200)).body.map((x: any) => x.tag)).toEqual(['AST-001']);
    const B = await adminSession(app, 'invco-other');
    expect((await f(B.token).get('/inventory/items').expect(200)).body).toEqual([]);
    await f(B.token).post(`/procurement/requisitions/${PO.id}/decision`, { decision: 'reject' }).expect(404);
  });
});
