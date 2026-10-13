import { INestApplication } from '@nestjs/common';
import { bootApp, http } from './helpers';
import { DbService } from '../src/db/db.service';
import { DEMO_MFA_SECRET, DEMO_PASSWORD, DEMO_SLUG, seedDemo } from '../src/demo/seed';
import { totp } from '../src/common/crypto';
import { resetRateLimits } from '../src/auth/auth.service';

let app: INestApplication; let db: DbService; let tenantId: string;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
async function demoLogin(local: string, mfa = false) {
  resetRateLimits();
  const r = await http(app).post('/auth/login').send({ tenant: DEMO_SLUG, email: `${local}@greenwood.demo`, password: DEMO_PASSWORD, ...(mfa ? { mfaCode: totp(DEMO_MFA_SECRET) } : {}) }).expect(200);
  return r.body.token as string;
}

beforeAll(async () => {
  app = await bootApp(); db = app.get(DbService);
  await seedDemo(db);
  [{ id: tenantId }] = await db.raw('select id from tenants where slug = $1', [DEMO_SLUG]);
}, 120_000);
afterAll(async () => { await app.close(); });

const scalar = (sql: string) => db.withTenant(tenantId, async (tx) => (await tx.query(sql)).rows[0].n as number);

describe('demo seed', () => {
  it('meets targets and is idempotent', async () => {
    expect(await scalar('select count(*)::int n from students')).toBe(300);
    expect(await scalar(`select count(*)::int n from residence_assignments where residence_type = 'boarder' and effective_to is null`)).toBe(80);
    expect(await scalar(`select count(*)::int n from residence_assignments where residence_type = 'day_scholar' and effective_to is null`)).toBe(220);
    expect(await scalar('select count(*)::int n from guardians')).toBe(250);
    expect(await scalar(`select count(distinct ur.user_id)::int n from user_roles ur join roles r on r.id = ur.role_id where r.key not in ('parent','student')`)).toBe(60);
    expect(await scalar('select count(*)::int n from courses')).toBeGreaterThanOrEqual(30);
    const again = await seedDemo(db);
    expect(again.created).toBe(false);
    expect(await scalar('select count(*)::int n from students')).toBe(300);
  });
  it('has consistent relationships', async () => {
    expect(await scalar('select count(*)::int n from students s where not exists (select 1 from enrollments e where e.student_id = s.id and e.effective_to is null)')).toBe(0);
    expect(await scalar('select count(*)::int n from students s where not exists (select 1 from student_guardians g where g.student_id = s.id)')).toBe(0);
    expect(await scalar(`select count(*)::int n from students s where (select count(*) from course_enrollments ce where ce.student_id = s.id) <> 8`)).toBe(0);
    expect(await scalar('select count(*)::int n from sections where capacity < (select count(*) from enrollments e where e.section_id = sections.id)')).toBe(0);
    expect(await scalar('select count(*)::int n from (select guardian_id from student_guardians group by guardian_id having count(*) > 1) x')).toBe(50);
  });
  it('is deterministic', async () => {
    const [r] = await db.withTenant(tenantId, async (tx) => (await tx.query(`select first_name, last_name, date_of_birth from students where admission_no = 'GIA-00001'`)).rows);
        expect(`${r.first_name} ${r.last_name} ${r.date_of_birth}`).toMatchSnapshot();
  });
  it('demo info is available only in demo mode', async () => {
    delete process.env.DEMO_MODE;
    await http(app).get('/demo/info').expect(404);
    process.env.DEMO_MODE = 'true';
    const r = await http(app).get('/demo/info').expect(200);
    expect(r.body.accounts).toContain('teacher@greenwood.demo');
    delete process.env.DEMO_MODE;
  });
  it('demo accounts see role-appropriate data', async () => {
    const parent = await demoLogin('parent');
    const kids = (await http(app).get('/me/children').set(auth(parent)).expect(200)).body;
    expect(kids).toHaveLength(2);
    await http(app).get('/students').set(auth(parent)).expect(403);
    const teacher = await demoLogin('teacher');
    const sections = (await http(app).get('/sections').set(auth(teacher)).expect(200)).body;
    expect(sections.length).toBe(24);
    const student = await demoLogin('student');
    await http(app).get('/me/children').set(auth(student)).expect(200).expect((r: any) => expect(r.body).toEqual([]));
    const nurse = await demoLogin('nurse', true);
    const list = (await http(app).get('/students?q=GIA-00008').set(auth(nurse)).expect(200)).body;
    const ov = (await http(app).get(`/students/${list[0].id}/overview`).set(auth(nurse)).expect(200)).body;
    expect(ov.medicalAlerts[0].severity).toBe('critical');
    const principal = await demoLogin('principal', true);
    expect((await http(app).get(`/students/${list[0].id}/overview`).set(auth(principal)).expect(200)).body.medicalAlerts).toBeUndefined();
  });
  it('Scenario A: accepted applicant is enrolled with class, parent, LMS and boarding', async () => {
    const officer = await demoLogin('admissions', true);
    const apps = (await http(app).get('/admissions?status=accepted').set(auth(officer)).expect(200)).body;
    expect(apps).toHaveLength(1);
    const sec = (await http(app).get('/sections').set(auth(officer)).expect(200)).body.find((s: any) => s.grade_name === 'Grade 7' && s.name === 'A');
    const e = (await http(app).post(`/admissions/${apps[0].id}/enroll`).set(auth(officer)).send({ sectionId: sec.id }).expect(201)).body;
    expect(e.admissionNo).toBe('GIA-00301');
    const ov = (await http(app).get(`/students/${e.studentId}/overview`).set(auth(officer)).expect(200)).body;
    expect(ov.courses).toHaveLength(8);
    expect(ov.residence[0].residence_type).toBe('boarder');
  });
});
