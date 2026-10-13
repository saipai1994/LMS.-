import { INestApplication } from '@nestjs/common';
import { activate, adminSession, bearer, bootApp, http, login, PASSWORD, PLATFORM_TOKEN, schoolBase, userSession } from './helpers';
import { resetRateLimits } from '../src/auth/auth.service';

let app: INestApplication;
beforeAll(async () => { process.env.DEMO_MODE = ''; app = await bootApp(); });
afterAll(async () => { await app.close(); });
beforeEach(() => resetRateLimits());
const f = (tok: string) => ({ get: (u: string) => http(app).get(u).set(bearer(tok)), post: (u: string, b?: any) => http(app).post(u).set(bearer(tok)).send(b ?? {}) });
const plat = (m: 'get' | 'patch' | 'post', u: string, b?: any) => (http(app) as any)[m](u).set('x-platform-token', PLATFORM_TOKEN).send(b);

describe('reports & exports', () => {
  let A: Awaited<ReturnType<typeof adminSession>>; let base: Awaited<ReturnType<typeof schoolBase>>; let reg: any, tch: any, acct: any;
  beforeAll(async () => {
    A = await adminSession(app, 'repco');
    reg = await userSession(app, 'repco', A.token, 'reg@repco.test', 'registrar'); tch = await userSession(app, 'repco', A.token, 'tch@repco.test', 'teacher'); acct = await userSession(app, 'repco', A.token, 'acct@repco.test', 'accountant');
    base = await schoolBase(app, A.token, A.campusId);
    await base.admit('boarder', 'r1@example.test', '=HYPERLINK("http://evil.test","x")');                                   // malicious name
    await base.admit('day_scholar', 'r2@example.test', 'Normal');
  });

  it('CSV export is permissioned, audited and neutralises formula injection', async () => {
    await f(tch.token).get('/reports/students.csv').expect(403);
    const r = await f(reg.token).get('/reports/students.csv').expect(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/); expect(r.headers['content-disposition']).toMatch(/students\.csv/);
    const lines = r.text.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('"admission_no","first_name","last_name","date_of_birth","gender","status","grade","section","residence_type"');
    expect(r.text).toContain(`"'=HYPERLINK(""http://evil.test"",""x"")1"`);        // leading quote disarms the formula
    expect(lines.some((l) => /^"?=/.test(l.split(',')[1] ?? ''))).toBe(false);
    await f(acct.token).get('/reports/students.csv').expect(200);
    expect((await f(A.token).get('/audit-log').expect(200)).body.filter((l: any) => l.action === 'report.export')).toHaveLength(2);
    await f(acct.token).get('/reports/attendance.csv?from=2026-01-01&to=2026-12-31').expect(403);                     // accountant has no attendance access
    await f(reg.token).get('/reports/attendance.csv?from=nonsense&to=2026-12-31').expect(400);
  });

  it('analytics endpoints are derived from stored data and campus-scoped', async () => {
    const e = (await f(reg.token).get('/reports/enrollment').expect(200)).body;
    expect(e[0]).toMatchObject({ grade: 'Grade 8', enrolled: 2, boarders: 1, day_scholars: 1 });
    const fun = (await f(reg.token).get('/reports/admission-funnel').expect(200)).body;
    expect(fun).toMatchObject({ total: 2, conversionPercent: 100 });
    await f(tch.token).get('/reports/enrollment').expect(403);
    const B = await adminSession(app, 'repco-other');
    expect((await f(B.token).get('/reports/enrollment').expect(200)).body).toEqual([]);
    expect((await f(B.token).get('/reports/students.csv').expect(200)).text.split('\r\n')).toHaveLength(1);       // header only: nothing leaks across tenants
  });
});

describe('password reset', () => {
  let A: Awaited<ReturnType<typeof adminSession>>; let u: any;
  beforeAll(async () => { A = await adminSession(app, 'resetco'); u = await userSession(app, 'resetco', A.token, 'staff@resetco.test', 'teacher'); });

  it('forgot-password never reveals accounts or tokens outside demo mode', async () => {
    const known = (await http(app).post('/auth/forgot').send({ tenant: 'resetco', email: 'staff@resetco.test' }).expect(202)).body;
    const unknown = (await http(app).post('/auth/forgot').send({ tenant: 'resetco', email: 'nobody@resetco.test' }).expect(202)).body;
    expect(known).toEqual(unknown); expect(JSON.stringify(known)).not.toMatch(/token/i);
  });
  it('admin-issued reset: single use, expires, revokes sessions, unlocks the account', async () => {
    const me = (await f(u.token).get('/auth/me')).status; expect(me).toBe(200);
    await f(u.token).post(`/users/${u.userId}/reset-password`).expect(403);                                            // only user managers
    const { resetToken } = (await f(A.token).post(`/users/${u.userId}/reset-password`).expect(201)).body;
    await http(app).post('/auth/reset').send({ tenant: 'resetco', token: resetToken, password: 'short' }).expect(400);
    await http(app).post('/auth/reset').send({ tenant: 'resetco', token: resetToken, password: 'A-brand-new-Passphrase-1' }).expect(200);
    await http(app).post('/auth/reset').send({ tenant: 'resetco', token: resetToken, password: 'Another-Passphrase-22' }).expect(400);   // single use
    await f(u.token).get('/auth/me').expect(401);                                                                      // old session revoked
    await http(app).post('/auth/login').send({ tenant: 'resetco', email: 'staff@resetco.test', password: PASSWORD }).expect(401);
    await http(app).post('/auth/login').send({ tenant: 'resetco', email: 'staff@resetco.test', password: 'A-brand-new-Passphrase-1' }).expect(200);
    const t2 = (await f(A.token).post(`/users/${u.userId}/reset-password`).expect(201)).body.resetToken;
    const { DbService } = await import('../src/db/db.service');
    await app.get(DbService).withTenant(A.tenantId, (tx) => tx.query(`update password_resets set expires_at = now() - interval '1 minute' where used_at is null`));
    await http(app).post('/auth/reset').send({ tenant: 'resetco', token: t2, password: 'Yet-Another-Passphrase-3' }).expect(400);      // expired
  });
  it('demo mode exposes the token only when explicitly enabled', async () => {
    process.env.DEMO_MODE = 'true';
    const r = (await http(app).post('/auth/forgot').send({ tenant: 'resetco', email: 'staff@resetco.test' }).expect(202)).body;
    expect(r.demoResetToken).toBeTruthy();
    process.env.DEMO_MODE = '';
  });
});

describe('SaaS: plans, entitlements, usage, export, suspension', () => {
  let A: Awaited<ReturnType<typeof adminSession>>;
  beforeAll(async () => { A = await adminSession(app, 'saasco'); });

  it('platform endpoints need the platform token', async () => {
    await http(app).get('/platform/tenants').expect(403);
    expect((await plat('get', '/platform/tenants').expect(200)).body.map((t: any) => t.slug)).toContain('saasco');
  });
  it('plan entitlements gate modules and feature overrides win', async () => {
    await f(A.token).get('/transport/routes').expect(200);
    await plat('patch', `/platform/tenants/${A.tenantId}/plan`, { plan: 'basic' }).expect(200);
    await f(A.token).get('/transport/routes').expect(403).expect((r: any) => expect(r.body).toMatchObject({ error: 'feature_not_in_plan', feature: 'transport' }));
    await f(A.token).get('/library/books').expect(403);
    await f(A.token).get('/students').expect(200);                                                                      // core stays available
    await plat('patch', `/platform/tenants/${A.tenantId}/plan`, { plan: 'basic', features: { library: true } }).expect(200);
    await f(A.token).get('/library/books').expect(200);
    await f(A.token).get('/transport/routes').expect(403);
    await plat('patch', `/platform/tenants/${A.tenantId}/plan`, { plan: 'bogus' }).expect(400);
    await plat('patch', `/platform/tenants/${A.tenantId}/plan`, { plan: 'standard' }).expect(200);
    await f(A.token).get('/transport/routes').expect(200);
  });
  it('usage metrics, full export without secrets, suspension and reactivation', async () => {
    const base = await schoolBase(app, A.token, A.campusId); await base.admit('day_scholar', 's1@example.test', 'Sam');
    const usage = (await plat('get', `/platform/tenants/${A.tenantId}/usage`).expect(200)).body;
    expect(usage).toMatchObject({ students: 1, campuses: 1 }); expect(usage.activeUsers).toBeGreaterThanOrEqual(1);
    const exp = (await plat('get', `/platform/tenants/${A.tenantId}/export`).expect(200)).body;
    expect(exp.tables.students).toHaveLength(1); expect(exp.tables.users.length).toBeGreaterThan(0);
    const text = JSON.stringify(exp);
    expect(text).not.toMatch(/password_hash|mfa_secret|token_hash/); expect(text).not.toContain('scrypt$');
    const other = await adminSession(app, 'saasco-other');
    expect(JSON.stringify((await plat('get', `/platform/tenants/${other.tenantId}/export`).expect(200)).body)).not.toContain(exp.tables.students[0].id);   // no cross-tenant rows
    await plat('patch', `/platform/tenants/${A.tenantId}/status`, { status: 'suspended' }).expect(200);
    await f(A.token).get('/students').expect(401);
    await http(app).post('/auth/login').send({ tenant: 'saasco', email: 'admin@saasco.test', password: PASSWORD, mfaCode: '000000' }).expect(401);
    await plat('patch', `/platform/tenants/${A.tenantId}/status`, { status: 'active' }).expect(200);
  });
});
