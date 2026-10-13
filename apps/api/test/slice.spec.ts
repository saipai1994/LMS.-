import { INestApplication } from '@nestjs/common';
import { activate, adminSession, bootApp, enrolMfa, http, login, PLATFORM_TOKEN } from './helpers';
import { DbService } from '../src/db/db.service';
import { resetRateLimits } from '../src/auth/auth.service';

let app: INestApplication;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => { app = await bootApp(); });
afterAll(async () => { await app.close(); });
beforeEach(() => resetRateLimits());
afterEach(() => resetRateLimits());

describe('auth & tenant onboarding', () => {
  it('rejects platform calls without the platform token', async () => {
    await http(app).post('/platform/tenants').send({}).expect(403);
    await http(app).post('/platform/tenants').set('x-platform-token', 'wrong').send({}).expect(403);
  });
  it('requires authentication on protected routes', async () => {
    await http(app).get('/students').expect(401);
    await http(app).get('/students').set('Authorization', 'Bearer not-a-token').expect(401);
  });
  it('blocks privileged users until MFA is enrolled, then requires a code to log in', async () => {
    const t = await (await import('./helpers')).createTenant(app, 'mfa-school');
    await activate(app, 'mfa-school', t.adminInviteToken);
    const tok = await login(app, 'mfa-school', 'admin@mfa-school.test');
    await http(app).get('/students').set(auth(tok)).expect(403).expect((r: any) => expect(r.body.error).toBe('mfa_setup_required'));
    const secret = await enrolMfa(app, tok);
    await http(app).post('/auth/login').send({ tenant: 'mfa-school', email: 'admin@mfa-school.test', password: (await import('./helpers')).PASSWORD })
      .expect(401).expect((r: any) => expect(r.body.error).toBe('mfa_required'));
    const ok = await login(app, 'mfa-school', 'admin@mfa-school.test', secret);
    await http(app).get('/students').set(auth(ok)).expect(200);
  });
  it('locks the account after repeated failures and audits it', async () => {
    const t = await (await import('./helpers')).createTenant(app, 'lock-school');
    await activate(app, 'lock-school', t.adminInviteToken);
    for (let i = 0; i < 5; i++) await http(app).post('/auth/login').send({ tenant: 'lock-school', email: 'admin@lock-school.test', password: 'wrong-password-1' }).expect(401);
    await http(app).post('/auth/login').send({ tenant: 'lock-school', email: 'admin@lock-school.test', password: (await import('./helpers')).PASSWORD }).expect(423);
    const rows = await app.get(DbService).withTenant(t.tenantId, async (tx) => (await tx.query(`select action from audit_log where action in ('auth.account_locked','auth.login_failed')`)).rows);
    expect(rows.map((r: any) => r.action)).toContain('auth.account_locked');
    expect(rows.length).toBe(5);
  });
  it('rate limits login by IP', async () => {
    for (let i = 0; i < 100; i++) await http(app).post('/auth/login').send({ tenant: 'nope', email: 'a@b.co', password: 'x' });
    await http(app).post('/auth/login').send({ tenant: 'nope', email: 'a@b.co', password: 'x' }).expect(429);
  });
});

describe('admission → enrollment → LMS → parent visibility (vertical slice)', () => {
  let A: Awaited<ReturnType<typeof adminSession>>;
  let B: Awaited<ReturnType<typeof adminSession>>;
  let ids: any = {};
  let parentToken: string; let otherParentToken: string;

  beforeAll(async () => {
    A = await adminSession(app, 'alpha');
    B = await adminSession(app, 'beta');
    const post = async (tok: string, url: string, body: any) => (await http(app).post(url).set(auth(tok)).send(body).expect(201)).body;
    ids.year = (await post(A.token, '/academic-years', { name: '2026-27', startsOn: '2026-04-01', endsOn: '2027-03-31', isCurrent: true })).id;
    ids.grade = (await post(A.token, '/grade-levels', { name: 'Grade 5', ordinal: 5 })).id;
    ids.sub = (await post(A.token, '/subjects', { code: 'MATH', name: 'Mathematics' })).id;
    ids.secA = (await post(A.token, '/sections', { campusId: A.campusId, academicYearId: ids.year, gradeLevelId: ids.grade, name: 'A', capacity: 1 })).id;
    ids.secB = (await post(A.token, '/sections', { campusId: A.campusId, academicYearId: ids.year, gradeLevelId: ids.grade, name: 'B', capacity: 30 })).id;
    const officer = await post(A.token, '/users', { email: 'officer@alpha.test', fullName: 'Officer', roleKey: 'admissions_officer' });
    const teacher = await post(A.token, '/users', { email: 'teacher@alpha.test', fullName: 'Teacher', roleKey: 'teacher' });
    const nurse = await post(A.token, '/users', { email: 'nurse@alpha.test', fullName: 'Nurse', roleKey: 'nurse' });
    await activate(app, 'alpha', teacher.inviteToken);
    ids.teacherId = teacher.userId;
    ids.teacherTok = await login(app, 'alpha', 'teacher@alpha.test');
    await activate(app, 'alpha', officer.inviteToken);
    ids.officerSecret = await enrolMfa(app, await login(app, 'alpha', 'officer@alpha.test'));
    ids.officerTok = await login(app, 'alpha', 'officer@alpha.test', ids.officerSecret);
    await activate(app, 'alpha', nurse.inviteToken);
    ids.nurseSecret = await enrolMfa(app, await login(app, 'alpha', 'nurse@alpha.test'));
    ids.nurseTok = await login(app, 'alpha', 'nurse@alpha.test', ids.nurseSecret);
    ids.course = (await post(A.token, '/courses', { sectionId: ids.secA, subjectId: ids.sub, teacherUserId: ids.teacherId, title: 'Grade 5A Maths' })).id;
  });

  const app_ = () => ({
    campusId: A.campusId, academicYearId: ids.year, gradeLevelId: ids.grade,
    applicantFirstName: 'Asha', applicantLastName: 'Verma', applicantDob: '2015-06-01',
    guardianName: 'Ravi Verma', guardianEmail: 'ravi@example.test', residencePreference: 'boarder',
  });

  it('validates input and rejects cross-references to another tenant', async () => {
    await http(app).post('/admissions').set(auth(ids.officerTok)).send({ ...app_(), applicantDob: 'nonsense' }).expect(400);
    // B's admin referencing A's campus/year/grade: RLS hides them, so the FK check fails (400) and nothing leaks.
    await http(app).post('/admissions').set(auth(B.token)).send(app_()).expect(400);
    expect((await http(app).get('/admissions').set(auth(B.token)).expect(200)).body).toEqual([]);
  });

  it('runs the full workflow and enforces the state machine', async () => {
    const created = (await http(app).post('/admissions').set(auth(ids.officerTok)).send(app_()).expect(201)).body;
    ids.app = created.id;
    await http(app).post(`/admissions/${ids.app}/enroll`).set(auth(ids.officerTok)).send({ sectionId: ids.secA }).expect(409); // not accepted
    for (const to of ['under_review', 'offered', 'accepted'])
      await http(app).post(`/admissions/${ids.app}/transition`).set(auth(ids.officerTok)).send({ to, ...(to === 'accepted' ? { consentRef: 'paper form' } : {}) }).expect(201);
    await http(app).post(`/admissions/${ids.app}/transition`).set(auth(ids.officerTok)).send({ to: 'under_review' }).expect(409);
    await http(app).post(`/admissions/${ids.app}/enroll`).set(auth(ids.teacherTok)).send({ sectionId: ids.secA }).expect(403);
    const e = (await http(app).post(`/admissions/${ids.app}/enroll`).set(auth(ids.officerTok)).send({ sectionId: ids.secA, effectiveFrom: '2026-04-01' }).expect(201)).body;
    expect(e.admissionNo).toBe('ADM-00001');
    expect(e.parentInviteToken).toBeTruthy();
    ids.student = e.studentId; ids.invite = e.parentInviteToken;
    // exactly-once: re-enrolling is rejected, no duplicate student
    await http(app).post(`/admissions/${ids.app}/enroll`).set(auth(ids.officerTok)).send({ sectionId: ids.secA }).expect(409);
    const list = (await http(app).get('/students').set(auth(ids.officerTok)).expect(200)).body;
    expect(list).toHaveLength(1);
  });

  it('enforces section capacity', async () => {
    const c2 = (await http(app).post('/admissions').set(auth(ids.officerTok)).send({ ...app_(), applicantFirstName: 'Second', guardianEmail: 'second@example.test' }).expect(201)).body;
    for (const to of ['under_review', 'offered', 'accepted']) await http(app).post(`/admissions/${c2.id}/transition`).set(auth(ids.officerTok)).send({ to, ...(to === 'accepted' ? { consentRef: 'paper form' } : {}) }).expect(201);
    await http(app).post(`/admissions/${c2.id}/enroll`).set(auth(ids.officerTok)).send({ sectionId: ids.secA }).expect(409).expect((r: any) => expect(r.body.error).toBe('section_full'));
  });

  it('gives the parent LMS-linked visibility of only their own child', async () => {
    await activate(app, 'alpha', ids.invite);
    parentToken = await login(app, 'alpha', 'ravi@example.test');
    const kids = (await http(app).get('/me/children').set(auth(parentToken)).expect(200)).body;
    expect(kids.map((k: any) => k.id)).toEqual([ids.student]);
    const ov = (await http(app).get(`/students/${ids.student}/overview`).set(auth(parentToken)).expect(200)).body;
    expect(ov.enrollments[0].section).toBe('A');
    expect(ov.courses.map((c: any) => c.title)).toEqual(['Grade 5A Maths']);
    expect(ov.residence[0].residence_type).toBe('boarder');
    expect(ov.medicalAlerts).toBeUndefined();
    await http(app).get('/students').set(auth(parentToken)).expect(403); // no staff list access
    // an unrelated parent cannot see the child
    const other = (await http(app).post('/admissions').set(auth(ids.officerTok)).send({ ...app_(), applicantFirstName: 'Other', guardianEmail: 'other@example.test' }).expect(201)).body;
    for (const to of ['under_review', 'offered', 'accepted']) await http(app).post(`/admissions/${other.id}/transition`).set(auth(ids.officerTok)).send({ to, ...(to === 'accepted' ? { consentRef: 'paper form' } : {}) }).expect(201);
    const oe = (await http(app).post(`/admissions/${other.id}/enroll`).set(auth(ids.officerTok)).send({ sectionId: ids.secB }).expect(201)).body;
    await activate(app, 'alpha', oe.parentInviteToken);
    otherParentToken = await login(app, 'alpha', 'other@example.test');
    await http(app).get(`/students/${ids.student}/overview`).set(auth(otherParentToken)).expect(404);
  });

  it("teacher sees only students in their courses, without family details; roster is teacher/permission scoped", async () => {
    const ov = (await http(app).get(`/students/${ids.student}/overview`).set(auth(ids.teacherTok)).expect(200)).body;
    expect(ov.guardians).toEqual([]);
    const other = (await http(app).get('/students').set(auth(ids.officerTok))).body.find((s: any) => s.first_name === 'Other');
    await http(app).get(`/students/${other.id}/overview`).set(auth(ids.teacherTok)).expect(404);
    await http(app).get(`/courses/${ids.course}/roster`).set(auth(ids.teacherTok)).expect(200).expect((r: any) => expect(r.body).toHaveLength(1));
    await http(app).get(`/courses/${ids.course}/roster`).set(auth(parentToken)).expect(403);
  });

  it('restricts medical data to medical permissions and audits reads', async () => {
    await http(app).post(`/students/${ids.student}/medical-alerts`).set(auth(ids.officerTok)).send({ alert: 'Peanut allergy', severity: 'critical' }).expect(404);
    await http(app).post(`/students/${ids.student}/medical-alerts`).set(auth(ids.nurseTok)).send({ alert: 'Peanut allergy', severity: 'critical' }).expect(201);
    const ovNurse = (await http(app).get(`/students/${ids.student}/overview`).set(auth(ids.nurseTok)).expect(200)).body;
    expect(ovNurse.medicalAlerts[0].alert).toBe('Peanut allergy');
    for (const t of [ids.officerTok, ids.teacherTok, parentToken]) {
      const o = (await http(app).get(`/students/${ids.student}/overview`).set(auth(t)).expect(200)).body;
      expect(o.medicalAlerts).toBeUndefined();
    }
    const log = (await http(app).get('/audit-log').set(auth(A.token)).expect(200)).body;
    expect(log.some((l: any) => l.action === 'medical.read' && l.entity_id === ids.student)).toBe(true);
  });

  it('keeps boarder/day-scholar and section history on one student identity', async () => {
    await http(app).post(`/students/${ids.student}/residence`).set(auth(A.token)).send({ residenceType: 'day_scholar', effectiveFrom: '2026-09-01' }).expect(201);
    await http(app).post(`/students/${ids.student}/residence`).set(auth(A.token)).send({ residenceType: 'day_scholar', effectiveFrom: '2026-10-01' }).expect(409);
    await http(app).post(`/students/${ids.student}/residence`).set(auth(A.token)).send({ residenceType: 'boarder', effectiveFrom: '2020-01-01' }).expect(422);
    await http(app).post(`/students/${ids.student}/section-transfer`).set(auth(A.token)).send({ sectionId: ids.secB, effectiveFrom: '2026-09-15' }).expect(201);
    const ov = (await http(app).get(`/students/${ids.student}/overview`).set(auth(parentToken)).expect(200)).body;
    expect(ov.residence.map((r: any) => r.residence_type)).toEqual(['day_scholar', 'boarder']);
    expect(ov.enrollments).toHaveLength(2);
    expect(ov.enrollments[1].effective_to).toBe('2026-09-14');
    expect(ov.courses).toHaveLength(0); // dropped from 5A course; 5B has none yet
    const students = (await http(app).get('/students').set(auth(A.token)).expect(200)).body;
    expect(students.filter((s: any) => s.admission_no === 'ADM-00001')).toHaveLength(1);
  });

  it('isolates tenants through URLs, ids, bodies and lists', async () => {
    await http(app).get(`/students/${ids.student}/overview`).set(auth(B.token)).expect(404);
    expect((await http(app).get('/students').set(auth(B.token)).expect(200)).body).toEqual([]);
    expect((await http(app).get('/admissions').set(auth(B.token)).expect(200)).body).toEqual([]);
    await http(app).post(`/students/${ids.student}/residence`).set(auth(B.token)).send({ residenceType: 'boarder', effectiveFrom: '2026-12-01' }).expect(404);
    await http(app).post(`/admissions/${ids.app}/transition`).set(auth(B.token)).send({ to: 'withdrawn' }).expect(404);
    // B cannot build a section out of A's year/grade (FK + RLS)
    await http(app).post('/sections').set(auth(B.token)).send({ campusId: B.campusId, academicYearId: ids.year, gradeLevelId: ids.grade, name: 'X', capacity: 5 }).expect(400);
    await http(app).get(`/courses/${ids.course}/roster`).set(auth(B.token)).expect(404);
    expect((await http(app).get('/sections').set(auth(B.token)).expect(200)).body).toEqual([]);
    // A token cannot be replayed under B's tenant prefix
    const forged = `${B.tenantId}.${A.token.split('.')[1]}`;
    await http(app).get('/students').set(auth(forged)).expect(401);
    const logB = (await http(app).get('/audit-log').set(auth(B.token)).expect(200)).body;
    expect(JSON.stringify(logB)).not.toContain(ids.student);
  });

  it('database RLS blocks queries without tenant context and audit log is append-only', async () => {
    const db = app.get(DbService);
    expect(await db.raw('select * from students')).toEqual([]);
    await expect(db.withTenant(A.tenantId, (tx) => tx.query('update audit_log set action = $1', ['x']))).rejects.toThrow(/append-only/);
    await expect(db.withTenant(B.tenantId, (tx) => tx.query(`insert into students(tenant_id, campus_id, admission_no, first_name, last_name, date_of_birth) values ($1,$2,'X','a','b','2010-01-01')`, [A.tenantId, A.campusId]))).rejects.toThrow();
  });

  it('disabled users lose access immediately', async () => {
    const u = (await http(app).post('/users').set(auth(A.token)).send({ email: 'temp@alpha.test', fullName: 'Temp', roleKey: 'teacher' }).expect(201)).body;
    await activate(app, 'alpha', u.inviteToken);
    const tok = await login(app, 'alpha', 'temp@alpha.test');
    await http(app).get('/academic-years').set(auth(tok)).expect(200);
    await http(app).post(`/users/${u.userId}/disable`).set(auth(A.token)).expect(201);
    await http(app).get('/academic-years').set(auth(tok)).expect(401);
  });
});
