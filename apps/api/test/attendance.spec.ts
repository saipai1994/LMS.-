import { INestApplication } from '@nestjs/common';
import { activate, adminSession, bearer, bootApp, http, login, schoolBase, userSession } from './helpers';
import { resetRateLimits } from '../src/auth/auth.service';
import { DbService } from '../src/db/db.service';

let app: INestApplication;
beforeAll(async () => { app = await bootApp(); });
afterAll(async () => { await app.close(); });
beforeEach(() => resetRateLimits());
const today = new Date().toISOString().slice(0, 10);

describe('attendance, notifications and day-scholar dismissal', () => {
  let A: Awaited<ReturnType<typeof adminSession>>;
  let base: Awaited<ReturnType<typeof schoolBase>>;
  let classTeacher: any, otherTeacher: any, registrar: any, gate: any;
  let s1: any, s2: any, boarder: any; let parent1: string; let parent2: string;

  beforeAll(async () => {
    A = await adminSession(app, 'attco');
    classTeacher = await userSession(app, 'attco', A.token, 'ct@attco.test', 'teacher');
    otherTeacher = await userSession(app, 'attco', A.token, 'ot@attco.test', 'teacher');
    registrar = await userSession(app, 'attco', A.token, 'reg@attco.test', 'registrar');
    gate = await userSession(app, 'attco', A.token, 'gate@attco.test', 'security_staff');
    base = await schoolBase(app, A.token, A.campusId);
    await http(app).get('/sections').set(bearer(A.token));
    // make classTeacher the class teacher of the section (new section 'B' with the teacher assigned)
    const sec = await base.post('/sections', { campusId: A.campusId, academicYearId: base.year.id, gradeLevelId: base.grade.id, name: 'B', capacity: 30, classTeacherUserId: classTeacher.userId });
    base.section.id = sec.id;
    s1 = await base.admit('day_scholar', 'a1@example.test', 'Ann');
    s2 = await base.admit('day_scholar', 'a2@example.test', 'Ben');
    boarder = await base.admit('boarder', 'a3@example.test', 'Bo');
    await activate(app, 'attco', s1.parentInviteToken); parent1 = await login(app, 'attco', 'a1@example.test');
    await activate(app, 'attco', s2.parentInviteToken); parent2 = await login(app, 'attco', 'a2@example.test');
  });

  it('class teacher marks attendance; others cannot; validation applies', async () => {
    const mark = (tok: string, body: any) => http(app).post(`/sections/${base.section.id}/attendance`).set(bearer(tok)).send({ date: today, ...body });
    const entries = [{ studentId: s1.studentId, status: 'absent', reason: 'Fever' }, { studentId: s2.studentId, status: 'present' }, { studentId: boarder.studentId, status: 'late' }];
    await mark(otherTeacher.token, { entries }).expect(404);
    await mark(classTeacher.token, { entries, date: '2999-01-01' }).expect(422);
    await mark(classTeacher.token, { entries: [{ studentId: '00000000-0000-4000-8000-000000000000', status: 'present' }] }).expect(422);
    await mark(classTeacher.token, { entries: [{ studentId: s1.studentId, status: 'sick' }] }).expect(400);
    const r = (await mark(classTeacher.token, { entries }).expect(201)).body;
    expect(r).toEqual({ saved: 3, absences: 1 });
    // idempotent re-submission: no duplicate records, no duplicate notification
    await mark(classTeacher.token, { entries }).expect(201);
    const day = (await http(app).get(`/sections/${base.section.id}/attendance?date=${today}`).set(bearer(classTeacher.token)).expect(200)).body;
    expect(day).toHaveLength(3);
    expect(day.find((d: any) => d.student_id === s1.studentId).status).toBe('absent');
  });

  it('notifies only the absent child’s guardians, in-app', async () => {
    const n1 = (await http(app).get('/notifications').set(bearer(parent1)).expect(200)).body;
    expect(n1).toHaveLength(1);
    expect(n1[0]).toMatchObject({ kind: 'attendance.absent', channel: 'in_app' });
    expect((await http(app).get('/notifications').set(bearer(parent2)).expect(200)).body).toHaveLength(0);
    await http(app).post(`/notifications/${n1[0].id}/read`).set(bearer(parent2)).expect(200).expect((r: any) => expect(r.body.updated).toBe(0));
    await http(app).post(`/notifications/${n1[0].id}/read`).set(bearer(parent1)).expect(200).expect((r: any) => expect(r.body.updated).toBe(1));
  });

  it('parents see only their child’s attendance with percentages', async () => {
    const own = (await http(app).get(`/students/${s1.studentId}/attendance`).set(bearer(parent1)).expect(200)).body;
    expect(own.summary).toEqual({ days: 1, attended: 0, percentage: 0 });
    await http(app).get(`/students/${s1.studentId}/attendance`).set(bearer(parent2)).expect(404);
  });

  it('old records need an approved correction request (maker-checker)', async () => {
    const db = app.get(DbService);
    const rec = (await http(app).get(`/students/${s1.studentId}/attendance`).set(bearer(parent1))).body.records[0];
    await db.withTenant(A.tenantId, (tx) => tx.query(`update attendance_records set created_at = now() - interval '3 days' where id = $1`, [rec.id]));
    await http(app).post(`/sections/${base.section.id}/attendance`).set(bearer(classTeacher.token)).send({ date: today, entries: [{ studentId: s1.studentId, status: 'excused' }] })
      .expect(409).expect((r: any) => expect(r.body.error).toBe('requires_correction_request'));
    const c = (await http(app).post(`/attendance/${rec.id}/corrections`).set(bearer(classTeacher.token)).send({ newStatus: 'excused', reason: 'Medical certificate received' }).expect(201)).body;
    await http(app).post(`/attendance/corrections/${c.id}/decision`).set(bearer(classTeacher.token)).send({ decision: 'approve' }).expect(403);
    await http(app).post(`/attendance/corrections/${c.id}/decision`).set(bearer(registrar.token)).send({ decision: 'approve' }).expect(201);
    await http(app).post(`/attendance/corrections/${c.id}/decision`).set(bearer(registrar.token)).send({ decision: 'reject' }).expect(409);
    const after = (await http(app).get(`/students/${s1.studentId}/attendance`).set(bearer(parent1))).body.records[0];
    expect(after.status).toBe('excused');
  });

  it('Scenario C: authorized pickup, identity verification, handover, duplicate prevention', async () => {
    const guardianId = (await http(app).get(`/students/${s2.studentId}/pickup-list`).set(bearer(gate.token)).expect(200)).body.guardians[0].id;
    await http(app).post(`/students/${s2.studentId}/authorized-pickups`).set(bearer(parent1)).send({ fullName: 'Intruder', relationship: 'friend' }).expect(404); // not their child
    const uncle = (await http(app).post(`/students/${s2.studentId}/authorized-pickups`).set(bearer(parent2)).send({ fullName: 'Uncle Raj', relationship: 'uncle', idHint: '4821' }).expect(201)).body;
    const expired = (await http(app).post(`/students/${s2.studentId}/authorized-pickups`).set(bearer(parent2)).send({ fullName: 'Old Driver', relationship: 'driver', validUntil: '2020-01-01' }).expect(201)).body;
    const h = (body: any, tok = gate.token) => http(app).post('/dismissal/handover').set(bearer(tok)).send({ studentId: s2.studentId, idVerified: true, ...body });
    await h({ authorizedPickupId: uncle.id }, parent2).expect(404);               // parents cannot record handovers
    await h({ authorizedPickupId: expired.id }).expect(403);                       // expired authorization
    await h({ authorizedPickupId: uncle.id, idVerified: false }).expect(422);      // identity check required
    await h({ guardianId, authorizedPickupId: uncle.id }).expect(400);
    await http(app).post('/dismissal/handover').set(bearer(gate.token)).send({ studentId: boarder.studentId, guardianId, idVerified: true }).expect(422); // boarders use leave
    const ok = (await h({ authorizedPickupId: uncle.id }).expect(201)).body;
    expect(ok.collectedBy).toBe('Uncle Raj');
    await h({ guardianId }).expect(409);                                           // duplicate scan
    const today_ = (await http(app).get('/dismissal/today').set(bearer(gate.token)).expect(200)).body;
    expect(today_.collected).toBe(1); expect(today_.pending).toBe(1);
    const note = (await http(app).get('/notifications').set(bearer(parent2)).expect(200)).body;
    expect(note.some((n: any) => n.kind === 'dismissal.handover' && n.body.includes('Uncle Raj'))).toBe(true);
    // revoke
    await http(app).post(`/authorized-pickups/${uncle.id}/revoke`).set(bearer(parent1)).expect(404);
    await http(app).post(`/authorized-pickups/${uncle.id}/revoke`).set(bearer(parent2)).expect(201);
    const logs = (await http(app).get('/audit-log').set(bearer(A.token)).expect(200)).body.map((l: any) => l.action);
    expect(logs).toEqual(expect.arrayContaining(['dismissal.unauthorized_attempt', 'dismissal.handover', 'pickup.authorize', 'pickup.revoke', 'attendance.correction_approve']));
  });
});
