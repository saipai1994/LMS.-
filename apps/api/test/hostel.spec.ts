import { INestApplication } from '@nestjs/common';
import { activate, adminSession, bearer, bootApp, http, login, schoolBase, userSession } from './helpers';
import { resetRateLimits } from '../src/auth/auth.service';

let app: INestApplication;
beforeAll(async () => { app = await bootApp(); });
afterAll(async () => { await app.close(); });
beforeEach(() => resetRateLimits());

describe('hostel, leave/gate, roll call, incidents', () => {
  let A: Awaited<ReturnType<typeof adminSession>>;
  let warden: { userId: string; token: string }; let gate: { userId: string; token: string }; let teacher: { userId: string; token: string };
  let safeguard: { userId: string; token: string };
  let base: Awaited<ReturnType<typeof schoolBase>>;
  let s1: any, s2: any, s3: any; let parent1: string; let parent2: string;
  let hostelId: string; let beds: any[];

  beforeAll(async () => {
    A = await adminSession(app, 'hostelco');
    warden = await userSession(app, 'hostelco', A.token, 'warden@hostelco.test', 'warden');
    gate = await userSession(app, 'hostelco', A.token, 'gate@hostelco.test', 'security_staff');
    teacher = await userSession(app, 'hostelco', A.token, 'teacher@hostelco.test', 'teacher');
    safeguard = await userSession(app, 'hostelco', A.token, 'safe@hostelco.test', 'safeguarding_officer');
    base = await schoolBase(app, A.token, A.campusId);
    s1 = await base.admit('boarder', 'p1@example.test');
    s2 = await base.admit('boarder', 'p2@example.test');
    s3 = await base.admit('day_scholar', 'p3@example.test');
    await activate(app, 'hostelco', s1.parentInviteToken); parent1 = await login(app, 'hostelco', 'p1@example.test');
    await activate(app, 'hostelco', s2.parentInviteToken); parent2 = await login(app, 'hostelco', 'p2@example.test');
    hostelId = (await base.post('/hostels', { campusId: A.campusId, name: 'Himalaya House' })).id;
    await base.post(`/hostels/${hostelId}/rooms`, { floor: 1, number: '101', beds: 2 });
    await base.post(`/hostels/${hostelId}/rooms`, { floor: 1, number: '102', beds: 1 });
    beds = (await http(app).get(`/hostels/${hostelId}/rooms`).set(bearer(warden.token)).expect(200)).body;
  });

  it('Scenario F: allocation, occupancy, transfer, vacancy', async () => {
    const post = (tok: string, body: any) => http(app).post('/hostel/allocations').set(bearer(tok)).send(body);
    await post(warden.token, { studentId: s3.studentId, bedId: beds[0].bed_id, effectiveFrom: '2026-04-01' }).expect(422); // day scholar
    await post(teacher.token, { studentId: s1.studentId, bedId: beds[0].bed_id, effectiveFrom: '2026-04-01' }).expect(404);
    await post(warden.token, { studentId: s1.studentId, bedId: beds[0].bed_id, effectiveFrom: '2026-04-01' }).expect(201);
    await post(warden.token, { studentId: s2.studentId, bedId: beds[0].bed_id, effectiveFrom: '2026-04-01' }).expect(409); // occupied
    await post(warden.token, { studentId: s2.studentId, bedId: beds[1].bed_id, effectiveFrom: '2026-04-01' }).expect(201);
    let h = (await http(app).get('/hostels').set(bearer(warden.token)).expect(200)).body[0];
    expect([h.capacity, h.occupied, h.vacant]).toEqual([3, 2, 1]);
    // transfer s1 to the free bed in room 102
    await post(warden.token, { studentId: s1.studentId, bedId: beds[2].bed_id, effectiveFrom: '2026-06-01' }).expect(201);
    const rooms = (await http(app).get(`/hostels/${hostelId}/rooms`).set(bearer(warden.token)).expect(200)).body;
    expect(rooms.find((r: any) => r.bed_id === beds[0].bed_id).student_id).toBeNull();
    expect(rooms.find((r: any) => r.bed_id === beds[2].bed_id).student_id).toBe(s1.studentId);
    h = (await http(app).get('/hostels').set(bearer(warden.token)).expect(200)).body[0];
    expect(h.vacant).toBe(1);
    await post(warden.token, { studentId: s2.studentId, bedId: beds[0].bed_id, effectiveFrom: '2026-07-01' }).expect(201); // freed bed reusable
  });

  it('Scenario B: leave request → approval → gate-out → overdue → gate-in', async () => {
    const lr = (tok: string, studentId: string, extra = {}) => http(app).post('/leave-requests').set(bearer(tok)).send({
      studentId, leaveType: 'weekend', destination: 'Home, Pune', responsibleAdult: 'Mr Guardian',
      departAt: new Date(Date.now() - 3 * 3600_000).toISOString(), expectedReturnAt: new Date(Date.now() - 3600_000).toISOString(), ...extra });
    await lr(parent2, s1.studentId).expect(404);                      // not their child
    await lr(parent1, s3.studentId).expect(404);
    await lr(parent1, s1.studentId, { expectedReturnAt: new Date(Date.now() - 5 * 3600_000).toISOString() }).expect(422);
    const req = (await lr(parent1, s1.studentId).expect(201)).body;
    await lr(parent1, s1.studentId).expect(409);                      // one open request at a time
    await http(app).post(`/leave-requests/${req.id}/gate-out`).set(bearer(gate.token)).expect(409); // not approved
    await http(app).post(`/leave-requests/${req.id}/decision`).set(bearer(parent1)).send({ decision: 'approve' }).expect(403);
    await http(app).post(`/leave-requests/${req.id}/decision`).set(bearer(warden.token)).send({ decision: 'approve', note: 'OK' }).expect(201);
    await http(app).post(`/leave-requests/${req.id}/decision`).set(bearer(warden.token)).send({ decision: 'reject' }).expect(409);
    await http(app).post(`/leave-requests/${req.id}/gate-out`).set(bearer(teacher.token)).expect(403);
    await http(app).post(`/leave-requests/${req.id}/gate-out`).set(bearer(gate.token)).expect(201);
    await http(app).post(`/leave-requests/${req.id}/gate-out`).set(bearer(gate.token)).expect(409); // duplicate scan
    const st = (await http(app).get('/hostel/status').set(bearer(warden.token)).expect(200)).body;
    expect(st.summary).toEqual({ on_campus: 1, on_leave: 0, overdue: 1 });
    expect(st.students.find((s: any) => s.id === s1.studentId).presence).toBe('overdue');
    // parents only see their own requests
    expect((await http(app).get('/leave-requests').set(bearer(parent2)).expect(200)).body).toHaveLength(0);
    expect((await http(app).get('/leave-requests').set(bearer(parent1)).expect(200)).body).toHaveLength(1);
    await http(app).post(`/leave-requests/${req.id}/gate-in`).set(bearer(gate.token)).expect(201);
    const st2 = (await http(app).get('/hostel/status').set(bearer(warden.token)).expect(200)).body;
    expect(st2.summary).toEqual({ on_campus: 2, on_leave: 0, overdue: 0 });
    const log = (await http(app).get('/audit-log').set(bearer(A.token)).expect(200)).body.map((l: any) => l.action);
    expect(log).toEqual(expect.arrayContaining(['leave.request', 'leave.approved', 'gate.out', 'gate.in']));
  });

  it('roll call reconciles against hostel residents and gate status; absentees raise incidents', async () => {
    const rc = (tok: string, entries: any[], session = 'bedtime') => http(app).post(`/hostels/${hostelId}/roll-calls`).set(bearer(tok)).send({ session, date: '2026-10-13', entries });
    await rc(warden.token, [{ studentId: s1.studentId, status: 'present' }]).expect(422); // missing resident
    await rc(teacher.token, [{ studentId: s1.studentId, status: 'present' }, { studentId: s2.studentId, status: 'present' }]).expect(403);
    const r = (await rc(warden.token, [{ studentId: s1.studentId, status: 'present' }, { studentId: s2.studentId, status: 'absent' }]).expect(201)).body;
    expect(r.unaccounted).toEqual([s2.studentId]);
    await rc(warden.token, [{ studentId: s1.studentId, status: 'present' }, { studentId: s2.studentId, status: 'present' }]).expect(409); // same session twice
    const inc = (await http(app).get('/incidents').set(bearer(warden.token)).expect(200)).body;
    expect(inc.map((i: any) => i.category)).toContain('missing_student');
  });

  it('Scenario G: incident reporting, assignment, escalation, closure; safeguarding is restricted', async () => {
    const mk = (tok: string, body: any) => http(app).post('/incidents').set(bearer(tok)).send({ campusId: A.campusId, severity: 'high', title: 'Fall in corridor', description: 'Student slipped', ...body });
    const created = (await mk(teacher.token, { category: 'safety', studentId: s1.studentId }).expect(201)).body;
    await http(app).get(`/incidents/${created.id}`).set(bearer(teacher.token)).expect(200); // reporter can see
    await http(app).post(`/incidents/${created.id}/close`).set(bearer(teacher.token)).send({ note: 'done' }).expect(404); // reporter cannot manage
    await http(app).post(`/incidents/${created.id}/assign`).set(bearer(warden.token)).send({ assignTo: teacher.userId }).expect(422); // assignee lacks permission
    await http(app).post(`/incidents/${created.id}/assign`).set(bearer(warden.token)).send({ assignTo: warden.userId }).expect(201);
    await http(app).post(`/incidents/${created.id}/escalate`).set(bearer(warden.token)).send({ note: 'Needs principal review' }).expect(201);
    await http(app).post(`/incidents/${created.id}/close`).set(bearer(warden.token)).send({ note: 'Treated at clinic, parents informed' }).expect(201);
    await http(app).post(`/incidents/${created.id}/close`).set(bearer(warden.token)).send({ note: 'again' }).expect(409);
    const detail = (await http(app).get(`/incidents/${created.id}`).set(bearer(warden.token)).expect(200)).body;
    expect(detail.events.map((e: any) => e.action)).toEqual(['created', 'assigned', 'escalated', 'closed']);
    // safeguarding: warden (incident.manage) cannot see; officer can
    const sg = (await mk(teacher.token, { category: 'safeguarding', title: 'Concern raised', studentId: s2.studentId }).expect(201)).body;
    await http(app).get(`/incidents/${sg.id}`).set(bearer(warden.token)).expect(404);
    expect((await http(app).get('/incidents').set(bearer(warden.token)).expect(200)).body.some((i: any) => i.id === sg.id)).toBe(false);
    await http(app).get(`/incidents/${sg.id}`).set(bearer(safeguard.token)).expect(200);
    await http(app).post(`/incidents/${sg.id}/assign`).set(bearer(safeguard.token)).send({ assignTo: warden.userId }).expect(422);
    await http(app).post(`/incidents/${sg.id}/close`).set(bearer(safeguard.token)).send({ note: 'Resolved with counsellor' }).expect(201);
    const audit = (await http(app).get('/audit-log').set(bearer(A.token)).expect(200)).body.map((l: any) => l.action);
    expect(audit).toEqual(expect.arrayContaining(['incident.create', 'incident.assign', 'incident.escalate', 'incident.close', 'incident.read']));
  });

  it('isolates hostel data between tenants', async () => {
    const B = await adminSession(app, 'otherco');
    expect((await http(app).get('/hostels').set(bearer(B.token)).expect(200)).body).toEqual([]);
    await http(app).get(`/hostels/${hostelId}/rooms`).set(bearer(B.token)).expect(404);
    await http(app).post('/hostel/allocations').set(bearer(B.token)).send({ studentId: s1.studentId, bedId: beds[0].bed_id, effectiveFrom: '2026-09-01' }).expect(404);
    expect((await http(app).get('/incidents').set(bearer(B.token)).expect(200)).body).toEqual([]);
  });
});
