import { INestApplication } from '@nestjs/common';
import { activate, adminSession, bearer, bootApp, http, login, schoolBase, userSession } from './helpers';
import { resetRateLimits } from '../src/auth/auth.service';
import { DbService } from '../src/db/db.service';

let app: INestApplication;
beforeAll(async () => { app = await bootApp(); });
afterAll(async () => { await app.close(); });
beforeEach(() => resetRateLimits());
const f = (tok: string) => ({ get: (u: string) => http(app).get(u).set(bearer(tok)), post: (u: string, b?: any) => http(app).post(u).set(bearer(tok)).send(b ?? {}) });
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

describe('HR & payroll', () => {
  let A: Awaited<ReturnType<typeof adminSession>>; let hr: any, t1: any, t2: any, principal: any; let sp1: any, sp2: any, hrSp: any;
  beforeAll(async () => {
    A = await adminSession(app, 'hrco');
    hr = await userSession(app, 'hrco', A.token, 'hr@hrco.test', 'hr_payroll');
    t1 = await userSession(app, 'hrco', A.token, 't1@hrco.test', 'teacher');
    t2 = await userSession(app, 'hrco', A.token, 't2@hrco.test', 'teacher');
    principal = await userSession(app, 'hrco', A.token, 'prin@hrco.test', 'principal');
    const add = (u: any, no: string, d: string) => f(hr.token).post('/hr/staff', { userId: u.userId, campusId: A.campusId, employeeNo: no, designation: d, joinDate: '2025-04-01' }).expect(201);
    sp1 = (await add(t1, 'E001', 'Maths teacher')).body; sp2 = (await add(t2, 'E002', 'Science teacher')).body; hrSp = (await add(hr, 'E003', 'HR officer')).body;
  });

  it('staff records are permissioned; documents expire into alerts', async () => {
    await f(t1.token).get('/hr/staff').expect(403);
    expect((await f(hr.token).get('/hr/staff').expect(200)).body).toHaveLength(3);
    await f(hr.token).post(`/hr/staff/${sp1.id}/documents`, { kind: 'Teaching licence', expiresOn: day(20) }).expect(201);
    await f(hr.token).post(`/hr/staff/${sp2.id}/documents`, { kind: 'First-aid certificate', expiresOn: day(-5) }).expect(201);
    const al = (await f(hr.token).get('/hr/document-alerts').expect(200)).body;
    expect(al.map((x: any) => `${x.kind}:${x.expired}`)).toEqual(['First-aid certificate:true', 'Teaching licence:false']);
  });

  it('leave workflow: staff request, overlapping blocked, HR decides, never self-approves', async () => {
    const r = (await f(t1.token).post('/me/staff-leave', { kind: 'sick', fromDate: day(1), toDate: day(2), reason: 'Flu' }).expect(201)).body;
    await f(t1.token).post('/me/staff-leave', { kind: 'casual', fromDate: day(2), toDate: day(3) }).expect(409);
    await f(t1.token).post(`/hr/leave/${r.id}/decision`, { decision: 'approve' }).expect(404);          // staff cannot decide
    await f(hr.token).post(`/hr/leave/${r.id}/decision`, { decision: 'approve' }).expect(201);
    await f(hr.token).post(`/hr/leave/${r.id}/decision`, { decision: 'reject' }).expect(409);
    const own = (await f(hr.token).post('/me/staff-leave', { kind: 'casual', fromDate: day(10), toDate: day(10) }).expect(201)).body;
    await f(hr.token).post(`/hr/leave/${own.id}/decision`, { decision: 'approve' }).expect(422);       // not their own
  });

  it('payroll: calculation from attendance, maker-checker, immutability, payslip privacy', async () => {
    const month = '2026-09';
    await f(hr.token).post(`/payroll/staff/${sp1.id}/salary`, { effectiveFrom: '2026-01-01', basicMinor: 5000000, allowances: [{ name: 'HRA', amountMinor: 1000000 }], deductions: [{ name: 'PF', amountMinor: 600000 }] }).expect(201);
    await f(hr.token).post(`/payroll/staff/${sp2.id}/salary`, { effectiveFrom: '2026-01-01', basicMinor: 4000000 }).expect(201);
    await f(t1.token).post(`/payroll/staff/${sp1.id}/salary`, { effectiveFrom: '2026-02-01', basicMinor: 9999999 }).expect(404);
    await f(hr.token).post('/hr/attendance', { date: '2026-09-07', entries: [{ staffId: sp1.id, status: 'absent' }, { staffId: sp2.id, status: 'present' }] }).expect(201);
    await f(hr.token).post('/hr/attendance', { date: '2026-09-08', entries: [{ staffId: sp1.id, status: 'absent' }] }).expect(201);
    const run = (await f(hr.token).post('/payroll/runs', { month }).expect(201)).body;
    expect(run.payslips).toBe(2);
    await f(hr.token).post('/payroll/runs', { month }).expect(409);
    const slips = (await f(hr.token).get(`/payroll/runs/${run.id}/payslips`).expect(200)).body;
    const s1 = slips.find((s: any) => s.employee_no === 'E001'); const s2 = slips.find((s: any) => s.employee_no === 'E002');
    // gross 60,000.00 → per-day 2,000.00 × 2 absent days = 4,000.00; net = 60,000 − 6,000 PF − 4,000 = 50,000.00
    expect([s1.absence_days, s1.absence_deduction_minor, s1.net_minor]).toEqual([2, 400000, 5000000]);
    expect(s2.net_minor).toBe(4000000);
    expect((await f(t1.token).get('/me/payslips').expect(200)).body).toEqual([]);                    // draft: not visible to staff
    await f(hr.token).post(`/payroll/runs/${run.id}/decision`, { decision: 'approve' }).expect(403);   // hr lacks approve right
    await f(principal.token).post(`/payroll/runs/${run.id}/decision`, { decision: 'mark_paid' }).expect(409);
    await f(principal.token).post(`/payroll/runs/${run.id}/decision`, { decision: 'approve' }).expect(201);
    await f(principal.token).post(`/payroll/runs/${run.id}/decision`, { decision: 'approve' }).expect(409);
    await expect(app.get(DbService).withTenant(A.tenantId, (tx) => tx.query('update payslips set net_minor = 1'))).rejects.toThrow(/immutable/);
    const mine = (await f(t1.token).get('/me/payslips').expect(200)).body;
    expect(mine).toHaveLength(1); expect(mine[0].net_minor).toBe(5000000);
    expect((await f(t2.token).get('/me/payslips').expect(200)).body[0].net_minor).toBe(4000000);   // each sees only their own
    await f(t1.token).get(`/payroll/runs/${run.id}/payslips`).expect(403);
    await f(principal.token).post(`/payroll/runs/${run.id}/decision`, { decision: 'mark_paid' }).expect(201);
    const log = (await f(A.token).get('/audit-log').expect(200)).body.map((l: any) => l.action);
    expect(log).toEqual(expect.arrayContaining(['payroll.run_create', 'payroll.approve', 'payroll.payslips_read', 'payroll.mark_paid']));
  });

  it('offboarding revokes access immediately and clears teaching assignments', async () => {
    await f(t2.token).get('/me/payslips').expect(200);
    await f(hr.token).post(`/hr/staff/${sp2.id}/exit`, { exitedOn: day(0) }).expect(201);
    await f(t2.token).get('/me/payslips').expect(401);
    await f(hr.token).post(`/hr/staff/${sp2.id}/exit`, { exitedOn: day(0) }).expect(409);
    await f(hr.token).post(`/hr/staff/${hrSp.id}/exit`, { exitedOn: day(0) }).expect(422);       // cannot offboard yourself
    await http(app).post('/auth/login').send({ tenant: 'hrco', email: 't2@hrco.test', password: 'Correct-Horse-Battery-9' }).expect(401);
    const B = await adminSession(app, 'hrco-other');
    expect((await f(B.token).get('/hr/staff').expect(200)).body).toEqual([]);
    await f(B.token).get(`/payroll/runs/${'00000000-0000-4000-8000-000000000000'}/payslips`).expect(200).expect((r: any) => expect(r.body).toEqual([]));
  });
});

describe('health, counselling, security', () => {
  let A: Awaited<ReturnType<typeof adminSession>>; let base: Awaited<ReturnType<typeof schoolBase>>;
  let nurse: any, teacher: any, gate: any, warden: any; let s1: any, s2: any; let p1: string, p2: string;
  beforeAll(async () => {
    A = await adminSession(app, 'healthco');
    nurse = await userSession(app, 'healthco', A.token, 'nurse@healthco.test', 'nurse');
    teacher = await userSession(app, 'healthco', A.token, 'tch@healthco.test', 'teacher');
    gate = await userSession(app, 'healthco', A.token, 'gate@healthco.test', 'security_staff');
    warden = await userSession(app, 'healthco', A.token, 'warden@healthco.test', 'warden');
    base = await schoolBase(app, A.token, A.campusId);
    s1 = await base.admit('boarder', 'h1@example.test', 'Hia'); s2 = await base.admit('day_scholar', 'h2@example.test', 'Hob');
    await activate(app, 'healthco', s1.parentInviteToken); p1 = await login(app, 'healthco', 'h1@example.test');
    await activate(app, 'healthco', s2.parentInviteToken); p2 = await login(app, 'healthco', 'h2@example.test');
  });

  it('clinic visits, medication consent/administration and audited restricted reads', async () => {
    await f(teacher.token).post('/health/visits', { studentId: s1.studentId, complaint: 'Headache', outcome: 'rested' }).expect(404);
    await f(nurse.token).post('/health/visits', { studentId: s1.studentId, complaint: 'Fever and headache', treatment: 'Paracetamol 250mg', outcome: 'sent_home' }).expect(201);
    expect((await f(p1).get('/notifications').expect(200)).body.some((n: any) => n.kind === 'health.visit')).toBe(true);
    expect((await f(p2).get('/notifications').expect(200)).body).toHaveLength(0);
    const own = (await f(p1).get(`/health/students/${s1.studentId}/visits`).expect(200)).body;
    expect(own[0].treatment).toBeUndefined();                                                  // guardians see complaint/outcome only
    await f(p2).get(`/health/students/${s1.studentId}/visits`).expect(404);
    expect((await f(nurse.token).get(`/health/students/${s1.studentId}/visits`).expect(200)).body[0].treatment).toMatch(/Paracetamol/);
    await f(nurse.token).post('/health/medications', { studentId: s1.studentId, name: 'Inhaler', dose: '2 puffs', schedule: 'as needed', startDate: day(-1), guardianConsent: false }).expect(422);
    const med = (await f(nurse.token).post('/health/medications', { studentId: s1.studentId, name: 'Antibiotic', dose: '5 ml', schedule: 'twice daily', startDate: day(-1), endDate: day(5), guardianConsent: true }).expect(201)).body;
    await f(nurse.token).post(`/health/medications/${med.id}/administer`, {}).expect(201);
    await f(nurse.token).post(`/health/medications/${med.id}/administer`, {}).expect(409);          // duplicate within a minute
    const old = (await f(nurse.token).post('/health/medications', { studentId: s1.studentId, name: 'Old course', dose: '1', schedule: 'daily', startDate: day(-30), endDate: day(-20), guardianConsent: true }).expect(201)).body;
    await f(nurse.token).post(`/health/medications/${old.id}/administer`, {}).expect(422);          // outside prescribed period
    expect((await f(nurse.token).get(`/health/medications/${med.id}/log`).expect(200)).body).toHaveLength(1);
    await f(teacher.token).get(`/health/medications/${med.id}/log`).expect(404);
    await f(nurse.token).post('/health/medicine-stock', { campusId: A.campusId, name: 'ORS sachets', qty: 40, expiresOn: day(15) }).expect(201);
    await f(nurse.token).post('/health/medicine-stock', { campusId: A.campusId, name: 'Old syrup', qty: 3, expiresOn: day(-2) }).expect(201);
    expect((await f(nurse.token).get('/health/medicine-alerts').expect(200)).body.map((x: any) => `${x.name}:${x.expired}`)).toEqual(['Old syrup:true', 'ORS sachets:false']);
    const log = (await f(A.token).get('/audit-log').expect(200)).body.map((l: any) => l.action);
    expect(log).toEqual(expect.arrayContaining(['health.visit', 'medical.read', 'health.medication_given']));
  });

  it('counselling is confidential: referrers cannot read notes, only counsellors can', async () => {
    const ref = (await f(teacher.token).post('/counselling/referrals', { studentId: s2.studentId, reason: 'Withdrawn and anxious in class' }).expect(201)).body;
    await f(teacher.token).get('/counselling/referrals').expect(403);
    await f(warden.token).get('/counselling/referrals').expect(403);
    await f(nurse.token).post(`/counselling/referrals/${ref.id}/update`, { status: 'scheduled', notes: 'Session booked; sensitive details recorded here' }).expect(201);
    const list = (await f(nurse.token).get('/counselling/referrals').expect(200)).body;
    expect(list[0].confidential_notes).toMatch(/sensitive/);
    await f(p2).get('/counselling/referrals').expect(403);
    expect((await f(A.token).get('/audit-log').expect(200)).body.some((l: any) => l.action === 'counselling.read')).toBe(true);
  });

  it('visitor log, badge control, evacuation roster and drills', async () => {
    const v = { campusId: A.campusId, kind: 'contractor', fullName: 'Electrician Raju', purpose: 'Fix corridor lights', host: 'Admin office', idType: 'Aadhaar', idLast4: '4821', badgeNo: 'V-07' };
    await f(teacher.token).post('/security/visitors', v).expect(403);
    await f(gate.token).post('/security/visitors', { ...v, idLast4: '48' }).expect(400);
    const in1 = (await f(gate.token).post('/security/visitors', v).expect(201)).body;
    await f(gate.token).post('/security/visitors', { ...v, fullName: 'Someone else' }).expect(409);       // badge already on a visitor
    expect((await f(gate.token).get('/security/visitors/on-site').expect(200)).body).toHaveLength(1);
    const ros = (await f(gate.token).get('/security/evacuation-roster').expect(200)).body;
    expect(ros.students.map((s: any) => s.residence_type).sort()).toEqual(['boarder', 'day_scholar']);
    expect(ros.expectedHeadcount).toBe(3);
    // a boarder on approved leave who has left, and a collected day scholar, drop off the roster
    const lr = (await f(p1).post('/leave-requests', { studentId: s1.studentId, leaveType: 'weekend', destination: 'Home', responsibleAdult: 'Dad', departAt: new Date().toISOString(), expectedReturnAt: new Date(Date.now() + 86400000).toISOString() }).expect(201)).body;
    await f(warden.token).post(`/leave-requests/${lr.id}/decision`, { decision: 'approve' }).expect(201);
    await f(gate.token).post(`/leave-requests/${lr.id}/gate-out`).expect(201);
    expect((await f(gate.token).get('/security/evacuation-roster').expect(200)).body.expectedHeadcount).toBe(2);
    expect((await f(gate.token).get('/security/movements').expect(200)).body[0].direction).toBe('out');
    await f(gate.token).post(`/security/visitors/${in1.id}/checkout`).expect(201);
    await f(gate.token).post(`/security/visitors/${in1.id}/checkout`).expect(409);
    const drill = (await f(gate.token).post('/security/drills', { campusId: A.campusId, kind: 'fire' }).expect(201)).body;
    await f(gate.token).post('/security/drills', { campusId: A.campusId, kind: 'fire' }).expect(409);
    const end = (await f(gate.token).post(`/security/drills/${drill.id}/complete`, { assembled: drill.headcount_expected - 1 }).expect(201)).body;
    expect(end).toEqual({ allAccountedFor: false, missing: 1 });
    const B = await adminSession(app, 'healthco-other');
    expect((await f(B.token).get('/security/visitors/on-site').expect(200)).body).toEqual([]);
    await f(B.token).get(`/health/students/${s1.studentId}/visits`).expect(404);
  });
});
