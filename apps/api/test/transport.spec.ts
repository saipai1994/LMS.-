import { INestApplication } from '@nestjs/common';
import { activate, adminSession, bearer, bootApp, http, login, schoolBase, userSession } from './helpers';
import { resetRateLimits } from '../src/auth/auth.service';

let app: INestApplication;
beforeAll(async () => { app = await bootApp(); });
afterAll(async () => { await app.close(); });
beforeEach(() => resetRateLimits());

describe('transport', () => {
  let A: Awaited<ReturnType<typeof adminSession>>; let base: Awaited<ReturnType<typeof schoolBase>>;
  let tm: any, teacher: any; let v: any, route: any, stops: any[]; let s1: any, s2: any, s3: any; let p1: string, p2: string;
  const f = (tok: string) => ({ get: (u: string) => http(app).get(u).set(bearer(tok)), post: (u: string, b?: any) => http(app).post(u).set(bearer(tok)).send(b ?? {}) });
  const soon = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  let trip: any;

  beforeAll(async () => {
    A = await adminSession(app, 'busco');
    tm = await userSession(app, 'busco', A.token, 'tm@busco.test', 'transport');
    teacher = await userSession(app, 'busco', A.token, 'tch@busco.test', 'teacher');
    base = await schoolBase(app, A.token, A.campusId);
    s1 = await base.admit('day_scholar', 'b1@example.test', 'Ana'); s2 = await base.admit('day_scholar', 'b2@example.test', 'Bob'); s3 = await base.admit('day_scholar', 'b3@example.test', 'Cy');
    await activate(app, 'busco', s1.parentInviteToken); p1 = await login(app, 'busco', 'b1@example.test');
    await activate(app, 'busco', s2.parentInviteToken); p2 = await login(app, 'busco', 'b2@example.test');
    v = (await f(tm.token).post('/transport/vehicles', { campusId: A.campusId, regNo: 'KA01AB1234', capacity: 2, insuranceExpiry: soon(10), permitExpiry: soon(200), fitnessExpiry: soon(-3) }).expect(201)).body;
    const d = (await f(tm.token).post('/transport/drivers', { campusId: A.campusId, fullName: 'Ramesh K', licenceNo: 'DL-001', licenceExpiry: soon(15), phone: '+91-90000-11111' }).expect(201)).body;
    route = (await f(tm.token).post('/transport/routes', { campusId: A.campusId, name: 'Route 1', vehicleId: v.id, driverId: d.id, attendantName: 'Sita', stops: [{ name: 'Lake View', pickupTime: '07:00' }, { name: 'Market', pickupTime: '07:20' }] }).expect(201)).body;
    stops = (await f(tm.token).get('/transport/routes').expect(200)).body[0].stops;
  });

  it('enforces permissions, capacity and effective-dated route changes', async () => {
    await f(teacher.token).post('/transport/assignments', { studentId: s1.studentId, routeId: route.id, stopId: stops[0].id, effectiveFrom: '2026-04-01' }).expect(404);
    await f(tm.token).post('/transport/assignments', { studentId: s1.studentId, routeId: route.id, stopId: '00000000-0000-4000-8000-000000000000', effectiveFrom: '2026-04-01' }).expect(422);
    await f(tm.token).post('/transport/assignments', { studentId: s1.studentId, routeId: route.id, stopId: stops[0].id, effectiveFrom: '2026-04-01' }).expect(201);
    await f(tm.token).post('/transport/assignments', { studentId: s2.studentId, routeId: route.id, stopId: stops[1].id, effectiveFrom: '2026-04-01' }).expect(201);
    await f(tm.token).post('/transport/assignments', { studentId: s3.studentId, routeId: route.id, stopId: stops[1].id, effectiveFrom: '2026-04-01' }).expect(409).expect((r: any) => expect(r.body.error).toBe('vehicle_full'));
    await f(tm.token).post('/transport/assignments', { studentId: s1.studentId, routeId: route.id, stopId: stops[1].id, effectiveFrom: '2026-06-01' }).expect(201);   // stop change keeps history
    const r = (await f(tm.token).get('/transport/routes').expect(200)).body[0];
    expect([r.riders, r.utilizationPercent]).toEqual([2, 100]);
    const mine = (await f(p1).get(`/transport/students/${s1.studentId}`).expect(200)).body;
    expect(mine.assignment).toMatchObject({ route: 'Route 1', stop: 'Market', driver: 'Ramesh K', reg_no: 'KA01AB1234' });
    await f(p1).get(`/transport/students/${s2.studentId}`).expect(404);
  });

  it('trip: manifest, boarding/drop-off confirmation, duplicate and sequence rules, parent notifications', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await f(teacher.token).post('/transport/trips', { routeId: route.id, date: today, shift: 'pm' }).expect(404);
    trip = (await f(tm.token).post('/transport/trips', { routeId: route.id, date: today, shift: 'pm' }).expect(201)).body;
    await f(tm.token).post('/transport/trips', { routeId: route.id, date: today, shift: 'pm' }).expect(409);
    const m = (await f(tm.token).get(`/transport/trips/${trip.id}`).expect(200)).body;
    expect(m.riders.map((r: any) => r.first_name).sort()).toEqual(['Ana1', 'Bob2']);
    const ev = (sid: string, event: string) => f(tm.token).post(`/transport/trips/${trip.id}/events`, { studentId: sid, event });
    await ev(s1.studentId, 'dropped').expect(422);                         // cannot drop before boarding
    await ev(s3.studentId, 'boarded').expect(422);                         // not on this route
    await ev(s1.studentId, 'boarded').expect(201); await ev(s1.studentId, 'boarded').expect(409);
    await ev(s2.studentId, 'boarded').expect(201);
    await f(tm.token).post(`/transport/trips/${trip.id}/complete`).expect(409).expect((r: any) => expect(r.body.error).toBe('students_not_dropped'));
    await ev(s1.studentId, 'dropped').expect(201);
    await ev(s2.studentId, 'dropped').expect(201);
    expect((await f(p1).get('/notifications').expect(200)).body.map((n: any) => n.kind)).toEqual(expect.arrayContaining(['transport.boarded', 'transport.dropped']));
    expect((await f(p2).get('/notifications').expect(200)).body.every((n: any) => !n.body.includes('Ana'))).toBe(true);
    const status = (await f(p1).get(`/transport/students/${s1.studentId}`)).body.today;
    expect(status[0].events).toEqual(['boarded', 'dropped']);
    await f(tm.token).post(`/transport/trips/${trip.id}/complete`).expect(201);
    await ev(s1.studentId, 'boarded').expect(409);
    const loc = (await f(tm.token).get(`/transport/trips/${trip.id}/location`).expect(200)).body;
    expect(loc.simulated).toBe(true); expect(loc.notice).toMatch(/DEMO/);
  });

  it('flags expiring/expired vehicle and driver documents; records maintenance; isolates tenants', async () => {
    const al = (await f(tm.token).get('/transport/alerts?days=30').expect(200)).body;
    expect(al.map((x: any) => `${x.subject}:${x.doc}:${x.expired}`)).toEqual(expect.arrayContaining(['KA01AB1234:fitness:true', 'KA01AB1234:insurance:false', 'Ramesh K:licence:false']));
    expect(al.some((x: any) => x.doc === 'permit')).toBe(false);
    await f(tm.token).post(`/transport/vehicles/${v.id}/maintenance`, { kind: 'service', doneOn: '2026-09-01', costMinor: 450000, nextDue: '2027-03-01' }).expect(201);
    await f(teacher.token).post(`/transport/vehicles/${v.id}/maintenance`, { kind: 'service', doneOn: '2026-09-01' }).expect(404);
    const B = await adminSession(app, 'busco-other');
    expect((await f(B.token).get('/transport/routes').expect(200)).body).toEqual([]);
    await f(B.token).get(`/transport/trips/${trip.id}`).expect(404);
    await f(B.token).post('/transport/assignments', { studentId: s1.studentId, routeId: route.id, stopId: stops[0].id, effectiveFrom: '2026-12-01' }).expect(404);
  });
});
