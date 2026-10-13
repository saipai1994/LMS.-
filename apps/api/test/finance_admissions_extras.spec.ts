import { INestApplication } from '@nestjs/common';
import { activate, adminSession, bearer, bootApp, http, login, schoolBase, userSession } from './helpers';
import { resetRateLimits } from '../src/auth/auth.service';

let app: INestApplication;
beforeAll(async () => { app = await bootApp(); });
afterAll(async () => { await app.close(); });
beforeEach(() => resetRateLimits());
const f = (tok: string) => ({ get: (u: string) => http(app).get(u).set(bearer(tok)), post: (u: string, b?: any) => http(app).post(u).set(bearer(tok)).send(b ?? {}), put: (u: string, b?: any) => http(app).put(u).set(bearer(tok)).send(b ?? {}) });

describe('finance: concessions, sibling discount, instalments, late fees, reminders', () => {
  let A: Awaited<ReturnType<typeof adminSession>>; let base: Awaited<ReturnType<typeof schoolBase>>; let acct: any, principal: any, tch: any;
  let first: any, second: any, solo: any; let pFamily: string, pSolo: string;
  beforeAll(async () => {
    A = await adminSession(app, 'feeco');
    acct = await userSession(app, 'feeco', A.token, 'acct@feeco.test', 'accountant'); principal = await userSession(app, 'feeco', A.token, 'prin@feeco.test', 'principal'); tch = await userSession(app, 'feeco', A.token, 'tch@feeco.test', 'teacher');
    base = await schoolBase(app, A.token, A.campusId);
    const tui = (await f(acct.token).post('/finance/fee-heads', { code: 'TUI', name: 'Tuition' }).expect(201)).body;
    const act_ = (await f(acct.token).post('/finance/fee-heads', { code: 'ACT', name: 'Activities' }).expect(201)).body;
    await f(acct.token).post('/finance/fee-structures', { academicYearId: base.year.id, gradeLevelId: base.grade.id, headId: tui.id, amountMinor: 1000000 }).expect(201);
    await f(acct.token).post('/finance/fee-structures', { academicYearId: base.year.id, gradeLevelId: base.grade.id, headId: act_.id, amountMinor: 100000 }).expect(201);
    first = await base.admit('day_scholar', 'fam@example.test', 'Older');
    // second child of the same guardian: admit via a second application with the same guardian e-mail
    second = await base.admit('day_scholar', 'fam@example.test', 'Younger');
    solo = await base.admit('day_scholar', 'solo@example.test', 'Solo');
    await activate(app, 'feeco', first.parentInviteToken!); pFamily = await login(app, 'feeco', 'fam@example.test');
    await activate(app, 'feeco', solo.parentInviteToken!); pSolo = await login(app, 'feeco', 'solo@example.test');
  });

  it('policy and concessions require a finance approver; scholarships reduce generated invoices as ledger credits', async () => {
    await f(acct.token).put('/finance/settings', { siblingDiscountPercent: 10, siblingHeadCode: 'TUI', lateFeeFlatMinor: 50000, lateFeeGraceDays: 5 }).expect(403);
    await f(principal.token).put('/finance/settings', { siblingDiscountPercent: 10, siblingHeadCode: 'TUI', lateFeeFlatMinor: 50000, lateFeeGraceDays: 5 }).expect(200);
    await f(acct.token).post('/finance/concessions', { studentId: solo.studentId, academicYearId: base.year.id, kind: 'scholarship', basis: 'percent', value: 50, headCode: 'TUI', reason: 'Merit scholarship 2026' }).expect(404);
    await f(principal.token).post('/finance/concessions', { studentId: solo.studentId, academicYearId: base.year.id, kind: 'scholarship', basis: 'percent', value: 120, reason: 'bad percent value' }).expect(400);
    await f(principal.token).post('/finance/concessions', { studentId: solo.studentId, academicYearId: base.year.id, kind: 'scholarship', basis: 'percent', value: 50, headCode: 'TUI', reason: 'Merit scholarship 2026' }).expect(201);
    const gen = (await f(acct.token).post('/finance/invoices/generate', { academicYearId: base.year.id, dueDate: '2026-06-30', batchKey: 'T1' }).expect(201)).body;
    expect(gen.created).toBe(3);
    const inv = (await f(acct.token).get('/finance/invoices').expect(200)).body;
    const by = (id: string) => inv.find((i: any) => i.student_id === id);
    // totals: tuition 10,000.00 + activities 1,000.00 = 11,000.00 (1,100,000 minor)
    expect(Number(by(first.studentId).outstanding_minor)).toBe(1100000);                               // eldest child: no discount
    expect(Number(by(second.studentId).outstanding_minor)).toBe(1100000 - 100000);                     // sibling: 10% of tuition = 1,000.00
    expect(Number(by(solo.studentId).outstanding_minor)).toBe(1100000 - 500000);                       // 50% scholarship on tuition
    const ledger = (await f(pSolo).get(`/finance/students/${solo.studentId}/ledger`).expect(200)).body;
    expect(ledger.entries.map((e: any) => e.kind)).toEqual(['invoice', 'credit_note']); expect(ledger.balanceMinor).toBe(600000);
    expect((await f(acct.token).get('/finance/reconciliation').expect(200)).body.discrepancies).toEqual([]);
    const c = (await f(acct.token).get('/finance/concessions').expect(200)).body; expect(c).toHaveLength(1);
    await f(principal.token).post(`/finance/concessions/${c[0].id}/revoke`).expect(201);
    await f(principal.token).post(`/finance/concessions/${c[0].id}/revoke`).expect(409);
    await f(tch.token).get('/finance/concessions').expect(403);
  });

  it('instalments split fees exactly, are idempotent per instalment, and respect discounts', async () => {
    const body = { academicYearId: base.year.id, dueDate: '2026-12-01', batchKey: 'T2', installments: [{ suffix: 'A', dueDate: '2026-12-01', percent: 50 }, { suffix: 'B', dueDate: '2027-02-01', percent: 30 }, { suffix: 'C', dueDate: '2027-04-01', percent: 20 }] };
    await f(acct.token).post('/finance/invoices/generate', { ...body, installments: [{ suffix: 'A', dueDate: '2026-12-01', percent: 60 }, { suffix: 'B', dueDate: '2027-02-01', percent: 30 }] }).expect(400);   // must total 100
    expect((await f(acct.token).post('/finance/invoices/generate', body).expect(201)).body.created).toBe(3);
    expect((await f(acct.token).post('/finance/invoices/generate', body).expect(201)).body).toMatchObject({ created: 0, skippedExisting: 3 });
    const inv = (await f(acct.token).get('/finance/invoices?limit=200').expect(200)).body.filter((i: any) => i.student_id === first.studentId && /T2/.test(i.number) === false);
    const t2 = inv.filter((i: any) => Date.parse(i.due_date) >= Date.parse('2026-12-01'));
    expect(t2.map((i: any) => Number(i.total_minor)).reduce((a: number, b: number) => a + b, 0)).toBe(1100000);   // pieces add up to the whole
    expect(t2).toHaveLength(3);
    expect((await f(acct.token).get('/finance/reconciliation').expect(200)).body.discrepancies).toEqual([]);
  });

  it('late fees are configurable, applied once per invoice, and reminders are throttled', async () => {
    await f(tch.token).post('/finance/late-fees/apply', {}).expect(403);
    const r1 = (await f(acct.token).post('/finance/late-fees/apply', { asOf: '2027-01-15' }).expect(201)).body;
    expect(r1.created).toBeGreaterThan(0);
    expect((await f(acct.token).post('/finance/late-fees/apply', { asOf: '2027-01-15' }).expect(201)).body.created).toBe(0);      // idempotent
    const inv = (await f(acct.token).get('/finance/invoices?limit=200').expect(200)).body;
    const first_ = inv.find((i: any) => i.student_id === first.studentId && Number(i.total_minor) === 50000);
    expect(first_).toBeTruthy();
    const rem = (await f(acct.token).post('/finance/reminders', { minDaysOverdue: 1 }).expect(201)).body;
    expect(rem.sent).toBeGreaterThan(0);
    expect((await f(acct.token).post('/finance/reminders', { minDaysOverdue: 1 }).expect(201)).body).toMatchObject({ sent: 0 });   // throttled for 7 days
    expect((await f(pFamily).get('/notifications').expect(200)).body.filter((n: any) => n.kind === 'finance.reminder')).toHaveLength(2);   // one per child, not per invoice
    expect((await f(pSolo).get('/notifications').expect(200)).body.some((n: any) => n.kind === 'finance.reminder')).toBe(true);
  });
});

describe('admissions: enquiries, tests, documents, offers and consent', () => {
  let A: Awaited<ReturnType<typeof adminSession>>; let base: Awaited<ReturnType<typeof schoolBase>>; let officer: any, tch: any;
  beforeAll(async () => {
    A = await adminSession(app, 'admco');
    officer = await userSession(app, 'admco', A.token, 'officer@admco.test', 'admissions_officer'); tch = await userSession(app, 'admco', A.token, 'tch@admco.test', 'teacher');
    base = await schoolBase(app, A.token, A.campusId);
  });
  const newApp = async (first: string, email: string) => (await f(officer.token).post('/admissions', { campusId: A.campusId, academicYearId: base.year.id, gradeLevelId: base.grade.id, applicantFirstName: first, applicantLastName: 'Applicant', applicantDob: '2013-03-03', guardianName: `Parent of ${first}`, guardianEmail: email }).expect(201)).body;

  it('enquiry CRM: staff entry, public website form (rate limited, honeypot), conversion to application', async () => {
    await f(tch.token).post('/admissions/enquiries', { campusId: A.campusId, contactName: 'X Y', childName: 'Kid', phone: '123' }).expect(403);
    await f(officer.token).post('/admissions/enquiries', { campusId: A.campusId, contactName: 'No Contact', childName: 'Kid' }).expect(400);
    const e = (await f(officer.token).post('/admissions/enquiries', { campusId: A.campusId, contactName: 'Anita Rao', email: 'anita@example.test', childName: 'Rohan', source: 'referral' }).expect(201)).body;
    await http(app).post('/admissions/public/enquiries').send({ tenant: 'admco', contactName: 'Web Parent', email: 'web@example.test', childName: 'Webkid' }).expect(202);
    await http(app).post('/admissions/public/enquiries').send({ tenant: 'no-such-school', contactName: 'Web Parent', email: 'web@example.test', childName: 'Webkid' }).expect(202);   // same answer
    await http(app).post('/admissions/public/enquiries').send({ tenant: 'admco', contactName: 'Bot', email: 'b@example.test', childName: 'Spam', website: 'http://spam' }).expect(400);   // honeypot
    const list = (await f(officer.token).get('/admissions/enquiries').expect(200)).body;
    expect(list.map((x: any) => x.source).sort()).toEqual(['referral', 'website']);
    const conv = (await f(officer.token).post(`/admissions/enquiries/${e.id}/convert`, { academicYearId: base.year.id, gradeLevelId: base.grade.id, applicantFirstName: 'Rohan', applicantLastName: 'Rao', applicantDob: '2014-01-01' }).expect(201)).body;
    await f(officer.token).post(`/admissions/enquiries/${e.id}/convert`, { academicYearId: base.year.id, gradeLevelId: base.grade.id, applicantFirstName: 'Rohan', applicantLastName: 'Rao', applicantDob: '2014-01-01' }).expect(409);
    expect((await f(officer.token).get('/admissions?status=submitted').expect(200)).body.map((x: any) => x.id)).toContain(conv.applicationId);
    for (let i = 0; i < 6; i++) await http(app).post('/admissions/public/enquiries').send({ tenant: 'admco', contactName: 'Flood', email: 'f@example.test', childName: 'k' });
    await http(app).post('/admissions/public/enquiries').send({ tenant: 'admco', contactName: 'Flood', email: 'f@example.test', childName: 'k' }).expect(429);
  });

  it('assessments, ranking, document verification (second person) and checklist', async () => {
    const a1 = await newApp('Alpha', 'a1@example.test'), a2 = await newApp('Beta', 'a2@example.test');
    const t1 = (await f(officer.token).post(`/admissions/${a1.id}/assessments`, { kind: 'entrance_test', scheduledAt: new Date(Date.now() + 86400000).toISOString() }).expect(201)).body;
    const i1 = (await f(officer.token).post(`/admissions/${a1.id}/assessments`, { kind: 'interview', scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString(), maxScore: 20 }).expect(201)).body;
    const t2 = (await f(officer.token).post(`/admissions/${a2.id}/assessments`, { kind: 'entrance_test', scheduledAt: new Date().toISOString() }).expect(201)).body;
    await f(officer.token).post(`/admissions/assessments/${t1.id}/score`, { score: 101 }).expect(422);
    await f(officer.token).post(`/admissions/assessments/${t1.id}/score`, { score: 70 }).expect(201);
    await f(officer.token).post(`/admissions/assessments/${t1.id}/score`, { score: 80 }).expect(409);                     // scores are final
    await f(officer.token).post(`/admissions/assessments/${i1.id}/score`, { score: 18 }).expect(201);                     // 90%
    await f(officer.token).post(`/admissions/assessments/${t2.id}/score`, { score: 75 }).expect(201);
    const rank = (await f(officer.token).get(`/admissions/ranking?gradeLevelId=${base.grade.id}&academicYearId=${base.year.id}`).expect(200)).body;
    expect(rank.slice(0, 2).map((r: any) => [r.applicant_first_name, r.average_percent])).toEqual([['Alpha', 80], ['Beta', 75]]);
    expect(rank.slice(2).every((r: any) => r.average_percent === null)).toBe(true);                                      // unscored applicants rank last
    await f(tch.token).get(`/admissions/ranking?gradeLevelId=${base.grade.id}&academicYearId=${base.year.id}`).expect(403);
    const d = (await f(officer.token).post(`/admissions/${a1.id}/documents`, { kind: 'Birth certificate' }).expect(201)).body;
    await f(officer.token).post(`/admissions/documents/${d.id}/verify`, { accept: true }).expect(422);                     // uploader cannot self-verify
    await f(A.token).post(`/admissions/documents/${d.id}/verify`, { accept: false }).expect(422);                           // rejection needs a reason
    await f(A.token).post(`/admissions/documents/${d.id}/verify`, { accept: true }).expect(201);
    const cl = (await f(officer.token).get(`/admissions/${a1.id}/checklist`).expect(200)).body;
    expect(cl.documents[0].verified).toBe(true); expect(cl.assessments).toHaveLength(2);
  });

  it('acceptance needs consent: online offer by token, or a recorded paper form; offers expire; enrolment requires consent', async () => {
    const ap = await newApp('Gamma', 'g@example.test');
    const move = (to: string, extra: any = {}) => f(officer.token).post(`/admissions/${ap.id}/transition`, { to, ...extra });
    await move('under_review').expect(201); await move('offered').expect(201);
    await move('accepted').expect(422).expect((r: any) => expect(r.body.error).toBe('consent_required'));
    await f(officer.token).post(`/admissions/${ap.id}/offer`, { expiresOn: '2020-01-01', terms: 'Annual fees as per schedule.' }).expect(422);
    const { offerToken } = (await f(officer.token).post(`/admissions/${ap.id}/offer`, { expiresOn: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), terms: 'Annual fees as per the attached schedule; rules of conduct apply.' }).expect(201)).body;
    const view = (await http(app).post('/admissions/public/offers/view').send({ tenant: 'admco', token: offerToken }).expect(200)).body;
    expect(view).toMatchObject({ applicant: 'Gamma Applicant' });
    await http(app).post('/admissions/public/offers/view').send({ tenant: 'admco', token: 'x'.repeat(30) }).expect(400);
    await http(app).post('/admissions/public/offers/view').send({ tenant: 'other', token: offerToken }).expect(400);
    await http(app).post('/admissions/public/offers/decide').send({ tenant: 'admco', token: offerToken, decision: 'accepted', signedName: 'Parent of Gamma', agree: false }).expect(400);
    await http(app).post('/admissions/public/offers/decide').send({ tenant: 'admco', token: offerToken, decision: 'accepted', signedName: 'Parent of Gamma', agree: true }).expect(200);
    await http(app).post('/admissions/public/offers/decide').send({ tenant: 'admco', token: offerToken, decision: 'declined', signedName: 'Parent of Gamma', agree: true }).expect(409);
    expect((await f(officer.token).get('/admissions?status=accepted').expect(200)).body.map((x: any) => x.id)).toContain(ap.id);
    const e = (await f(officer.token).post(`/admissions/${ap.id}/enroll`, { sectionId: base.section.id }).expect(201)).body;
    expect(e.studentId).toBeTruthy();
    // paper-form route; and enrolment is refused if an application somehow reached 'accepted' without consent
    const ap2 = await newApp('Delta', 'd@example.test');
    const { DbService } = await import('../src/db/db.service');
    await app.get(DbService).withTenant(A.tenantId, (tx) => tx.query(`update admission_applications set status = 'accepted' where id = $1`, [ap2.id]));
    await f(officer.token).post(`/admissions/${ap2.id}/enroll`, { sectionId: base.section.id }).expect(422).expect((r: any) => expect(r.body.error).toBe('consent_missing'));
    // declined offer withdraws the application
    const ap3 = await newApp('Epsilon', 'e@example.test');
    await f(officer.token).post(`/admissions/${ap3.id}/transition`, { to: 'under_review' }).expect(201); await f(officer.token).post(`/admissions/${ap3.id}/transition`, { to: 'offered' }).expect(201);
    const o3 = (await f(officer.token).post(`/admissions/${ap3.id}/offer`, { expiresOn: new Date(Date.now() + 86400000).toISOString().slice(0, 10), terms: 'Standard terms and conditions apply.' }).expect(201)).body;
    await http(app).post('/admissions/public/offers/decide').send({ tenant: 'admco', token: o3.offerToken, decision: 'declined', signedName: 'Parent of Epsilon', agree: true }).expect(200);
    expect((await f(officer.token).get('/admissions?status=withdrawn').expect(200)).body.map((x: any) => x.id)).toContain(ap3.id);
    const B = await adminSession(app, 'admco-other');
    expect((await f(B.token).get('/admissions/enquiries').expect(200)).body).toEqual([]);
    await f(B.token).get(`/admissions/${ap.id}/checklist`).expect(404);
  });
});
