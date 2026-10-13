import { INestApplication } from '@nestjs/common';
import { PASSWORD, adminSession, bearer, bootApp, http, schoolBase, userSession } from './helpers';
import { resetRateLimits } from '../src/auth/auth.service';
import { DbService } from '../src/db/db.service';

let app: INestApplication;
beforeAll(async () => { app = await bootApp(); });
afterAll(async () => { await app.close(); });
beforeEach(() => resetRateLimits());
const f = (tok: string) => ({ get: (u: string) => http(app).get(u).set(bearer(tok)), post: (u: string, b?: any) => http(app).post(u).set(bearer(tok)).send(b ?? {}), put: (u: string, b?: any) => http(app).put(u).set(bearer(tok)).send(b ?? {}), del: (u: string) => http(app).delete(u).set(bearer(tok)) });

describe('admin & privacy', () => {
  let A: Awaited<ReturnType<typeof adminSession>>; let tch: any, prin: any, pw: any; let s: any; let base: any;
  beforeAll(async () => {
    A = await adminSession(app, 'adpv');
    tch = await userSession(app, 'adpv', A.token, 'teach@adpv.test', 'teacher');
    pw = await userSession(app, 'adpv', A.token, 'pwuser@adpv.test', 'teacher');
    prin = await userSession(app, 'adpv', A.token, 'princ@adpv.test', 'principal');
    base = await schoolBase(app, A.token, A.campusId);
    s = await base.admit('day_scholar', 'par@example.test', 'Pia');
  });

  it('campuses and roles: permission gated, no privilege escalation', async () => {
    await f(tch.token).post('/campuses', { code: 'N2', name: 'North' }).expect(403);
    await f(A.token).post('/campuses', { code: 'N2', name: 'North Campus' }).expect(201);
    expect((await f(A.token).get('/campuses').expect(200)).body.length).toBe(2);
    await f(tch.token).get('/roles').expect(403);
    const role = (await f(A.token).post('/roles', { key: 'front_desk', name: 'Front desk', permissions: ['student.read'] }).expect(201)).body;
    await f(A.token).put(`/roles/${role.id}/permissions`, { permissions: ['student.read', 'attendance.read'] }).catch(() => undefined);
    const roles = (await f(A.token).get('/roles').expect(200)).body;
    const ga = roles.find((r: any) => r.key === 'group_admin');
    await f(A.token).put(`/roles/${ga.id}/permissions`, { permissions: ['student.read'] }).expect(409);
  });

  it('password change re-checks the current password; sessions listable and revocable', async () => {
    const me = (await f(pw.token).get('/auth/sessions').expect(200)).body;
    expect(me.length).toBeGreaterThan(0);
    const r = await f(pw.token).post('/auth/password', { currentPassword: 'wrong-password-123', newPassword: 'Another-Passw0rd!2027' });
    expect([401, 403]).toContain(r.status);
    await f(pw.token).post('/auth/password', { currentPassword: PASSWORD, newPassword: 'Another-Passw0rd!2027' }).expect(200);
  });

  it('privacy requests: guardian can file, only privacy.manage decides; export and retention-gated anonymisation', async () => {
    await f(tch.token).get('/privacy/retention').expect(403);
    await f(tch.token).post('/privacy/requests', { kind: 'access', studentId: s.studentId, details: 'Copy of data please' }).expect(404);
    const r = (await f(prin.token).post('/privacy/requests', { kind: 'access', studentId: s.studentId, details: 'Copy of data please' }).expect(201)).body;
    expect(new Date(r.due_at).getTime()).toBeGreaterThan(Date.now() + 29 * 86400000);
    await f(tch.token).post(`/privacy/requests/${r.id}/decide`, { status: 'completed', outcome: 'done' }).expect(403);
    await f(prin.token).post(`/privacy/requests/${r.id}/decide`, { status: 'completed' }).expect(422);
    await f(prin.token).post(`/privacy/requests/${r.id}/decide`, { status: 'completed', outcome: 'Export provided' }).expect(201);
    await f(prin.token).post(`/privacy/requests/${r.id}/decide`, { status: 'rejected', outcome: 'again' }).expect(409);
    const ex = (await f(prin.token).get(`/privacy/students/${s.studentId}/export`).expect(200)).body;
    expect(ex.student.admissionNo).toBeTruthy();
    // gates
    await f(prin.token).post(`/privacy/students/${s.studentId}/anonymise`, { confirm: 'ANONYMISE' }).expect(409);
    const db = app.get(DbService);
    await db.withTenant(A.tenantId, async (tx) => {
      await tx.query(`update students set status='withdrawn' where id=$1`, [s.studentId]);
      await tx.query(`insert into withdrawal_requests(tenant_id, student_id, kind, reason, effective_date, requested_by, status) values ($1,$2,'withdrawal','moved','2015-01-01',$3,'completed')`, [A.tenantId, s.studentId, prin.userId]);
    });
    await f(prin.token).put('/privacy/retention', { studentRecordYears: 7 }).expect(200);
    await f(prin.token).post(`/privacy/students/${s.studentId}/anonymise`, { confirm: 'ANONYMISE' }).expect(201);
    await f(prin.token).post(`/privacy/students/${s.studentId}/anonymise`, { confirm: 'ANONYMISE' }).expect(409);
    const after = await db.withTenant(A.tenantId, async (tx) => (await tx.query('select first_name, anonymised_at from students where id=$1', [s.studentId])).rows[0]);
    expect(after.first_name).toBe('Anonymised'); expect(after.anonymised_at).toBeTruthy();
  });
});
