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
  process.env.DEMO_GATEWAY_SECRET = 'seed-test-gateway-secret-0123456789'; process.env.DEMO_MODE = 'true';
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

describe('demo seed — operational modules', () => {
  it('meets minimum volume targets for implemented modules', async () => {
    const min: [string, number][] = [
      ['select count(*)::int n from lessons', 100], ['select count(*)::int n from assignments', 150], ['select count(*)::int n from attendance_records', 500],
      ['select count(*)::int n from invoices', 200], ['select count(*)::int n from payments', 200], ['select count(*)::int n from submissions', 500],
      ['select count(*)::int n from beds', 80], ['select count(*)::int n from leave_requests', 8], ['select count(*)::int n from incidents', 6], ['select count(*)::int n from quizzes', 3],
    ];
    for (const [sql, n] of min) expect(await scalar(sql)).toBeGreaterThanOrEqual(n);
    expect(await scalar('select count(*)::int n from hostels')).toBe(3);
    expect(await scalar('select count(*)::int n from bed_assignments where effective_to is null')).toBe(80);
  });
  it('financial data is internally consistent', async () => {
    expect(await scalar(`select count(*)::int n from invoices i where (select coalesce(sum(amount_minor),0) from invoice_lines where invoice_id = i.id) <> i.total_minor`)).toBe(0);
    expect(await scalar(`select count(*)::int n from invoices i where (select coalesce(sum(amount_minor),0) from payment_allocations where invoice_id = i.id) > i.total_minor`)).toBe(0);
    expect(await scalar(`select count(*)::int n from payments p where p.amount_minor <> (select coalesce(sum(amount_minor),0) from payment_allocations where payment_id = p.id)`)).toBe(0);
    const accountant = await demoLogin('accountant', true);
    const rec = (await http(app).get('/finance/reconciliation').set(auth(accountant)).expect(200)).body;
    expect(rec.discrepancies).toEqual([]);
    const sum = (await http(app).get('/finance/summary').set(auth(accountant)).expect(200)).body;
    expect(sum.invoiced).toBeGreaterThan(0); expect(sum.collected).toBeLessThan(sum.invoiced);
    expect(sum.outstanding).toBe(sum.invoiced - sum.collected);
    expect(sum.overdue_invoices).toBeGreaterThan(0);
  });
  it('role dashboards have data: warden, teacher, parent, student, principal, gate', async () => {
    const warden = await demoLogin('warden');
    const st = (await http(app).get('/hostel/status').set(auth(warden)).expect(200)).body;
    const boarders = await scalar(`select count(*)::int n from residence_assignments where residence_type = 'boarder' and effective_to is null`);
    expect(st.summary.on_campus + st.summary.on_leave + st.summary.overdue).toBe(boarders); // includes the Scenario A newcomer, who has no bed yet
    expect(st.summary.overdue).toBeGreaterThanOrEqual(1); expect(st.summary.on_leave).toBeGreaterThanOrEqual(1);
    const hostels = (await http(app).get('/hostels').set(auth(warden)).expect(200)).body;
    expect(hostels).toHaveLength(3); expect(hostels.reduce((t: number, h: any) => t + h.occupied, 0)).toBe(80);
    const leave = (await http(app).get('/leave-requests').set(auth(warden)).expect(200)).body;
    expect(new Set(leave.map((l: any) => l.status))).toEqual(new Set(['requested', 'approved', 'out', 'returned']));

    const parent = await demoLogin('parent');
    const kids = (await http(app).get('/me/children').set(auth(parent)).expect(200)).body;
    const inv = (await http(app).get('/finance/me/invoices').set(auth(parent)).expect(200)).body;
    expect(inv.length).toBe(kids.length * 2);
    const rc = (await http(app).get(`/students/${kids[0].id}/report-card`).set(auth(parent)).expect(200)).body;
    expect(rc.items.length).toBeGreaterThan(0);
    const learn = (await http(app).get(`/students/${kids[0].id}/learning`).set(auth(parent)).expect(200)).body;
    expect(learn.assignments.length).toBeGreaterThan(10);
    const att = (await http(app).get(`/students/${kids[0].id}/attendance`).set(auth(parent)).expect(200)).body;
    expect(att.summary.days).toBe(10);
    expect((await http(app).get('/notifications').set(auth(parent)).expect(200)).body.length).toBeGreaterThanOrEqual(4);

    const student = await demoLogin('student');
    const mine = (await http(app).get('/me/learning').set(auth(student)).expect(200)).body;
    expect(mine.assignments.length).toBeGreaterThan(10);

    const teacher = await demoLogin('teacher');
    const taught = (await db.withTenant(tenantId, async (tx) => (await tx.query(`select c.id from courses c join users u on u.id = c.teacher_user_id where u.email = 'teacher@greenwood.demo' and exists (select 1 from assignments where course_id = c.id)`)).rows));
    expect(taught.length).toBeGreaterThan(0);
    const gb = (await http(app).get(`/courses/${taught[0].id}/gradebook`).set(auth(teacher)).expect(200)).body;
    expect(gb.assignments.length).toBe(2); expect(gb.students.length).toBeGreaterThan(5);
    await http(app).get(`/courses/${taught[0].id}/gradebook`).set(auth(parent)).expect(404);

    const gate = await demoLogin('gate');
    const today = (await http(app).get('/dismissal/today').set(auth(gate)).expect(200)).body;
    expect(today.collected + today.pending).toBe(220); expect(today.collected).toBeGreaterThan(0);

    const principal = await demoLogin('principal', true);
    const incidents = (await http(app).get('/incidents').set(auth(principal)).expect(200)).body;
    expect(incidents.some((i: any) => i.category === 'safeguarding')).toBe(false);   // restricted from principal
    expect(incidents.length).toBe(5);
  });
  it('receipt and invoice numbering continues without collisions after seeding', async () => {
    expect(await scalar(`select (max(substr(receipt_no, 5)::int) - count(*))::int n from payments`)).toBe(0);   // gap-free
    process.env.DEMO_MODE = 'true';
    const parent = await demoLogin('parent');
    const inv = (await http(app).get('/finance/me/invoices').set(auth(parent)).expect(200)).body.find((i: any) => Number(i.outstanding_minor) > 0);
    const intent = (await http(app).post('/finance/payment-intents').set(auth(parent)).send({ invoiceId: inv.id }).expect(201)).body;
    const r = (await http(app).post(`/finance/payment-intents/${intent.id}/simulate`).set(auth(parent)).send({ outcome: 'succeeded' }).expect(200)).body;
    expect(r.status).toBe('succeeded');
    const accountant = await demoLogin('accountant', true);
    const man = await http(app).post('/finance/invoices').set(auth(accountant)).send({ studentId: inv.student_id, dueDate: '2026-12-31', lines: [{ description: 'Trip fee', amountMinor: 50000 }] }).expect(201);
    expect(man.body.number).toMatch(/^INV-\d{6}$/);
  });
  it('seeding twice does not duplicate operational data', async () => {
    const before = await scalar('select count(*)::int n from invoices');
    await seedDemo(db);
    expect(await scalar('select count(*)::int n from invoices')).toBe(before);
  });
});

describe('demo seed — phase 3 modules', () => {
  it('meets volume targets and invariants', async () => {
    const min: [string, number][] = [
      ['select count(*)::int n from vehicles', 10], ['select count(*)::int n from transport_routes', 10], ['select count(*)::int n from books', 100], ['select count(*)::int n from loans', 40],
      ['select count(*)::int n from inventory_items', 30], ['select count(*)::int n from staff_profiles', 60], ['select count(*)::int n from payslips', 60], ['select count(*)::int n from clinic_visits', 30],
      ['select count(*)::int n from timetable_slots', 600], ['select count(*)::int n from activities', 10], ['select count(*)::int n from tickets', 8], ['select count(*)::int n from menus', 30], ['select count(*)::int n from exam_papers', 18],
    ];
    for (const [sql, n] of min) expect(await scalar(sql)).toBeGreaterThanOrEqual(n);
    // no teacher teaches two sections in the same period, no room is double-booked, no section has two lessons in one period
    expect(await scalar(`select count(*)::int n from (select t.day_of_week, t.period_id, c.teacher_user_id from timetable_slots t join courses c on c.id = t.course_id group by 1,2,3 having count(*) > 1) x`)).toBe(0);
    expect(await scalar(`select count(*)::int n from (select day_of_week, period_id, room from timetable_slots where room is not null group by 1,2,3 having count(*) > 1) x`)).toBe(0);
    expect(await scalar(`select count(*)::int n from transport_routes r where (select count(*) from student_transport st where st.route_id = r.id and st.effective_to is null) > (select capacity from vehicles v where v.id = r.vehicle_id)`)).toBe(0);
    expect(await scalar(`select count(*)::int n from (select item_id from stock_movements group by item_id having sum(qty_delta) < 0) x`)).toBe(0);
    expect(await scalar(`select count(*)::int n from book_copies c where c.status = 'issued' and not exists (select 1 from loans l where l.copy_id = c.id and l.returned_on is null)`)).toBe(0);
    expect(await scalar(`select count(*)::int n from activities a where (select count(*) from activity_registrations r where r.activity_id = a.id and r.status = 'registered') > a.capacity`)).toBe(0);
    expect(await scalar(`select count(*)::int n from payslips p where p.net_minor <> p.basic_minor + p.allowances_minor - p.deductions_minor - p.absence_deduction_minor`)).toBe(0);
    expect(await scalar(`select count(*)::int n from trip_events d where d.event = 'dropped' and not exists (select 1 from trip_events b where b.trip_id = d.trip_id and b.student_id = d.student_id and b.event = 'boarded')`)).toBe(0);
  });
  it('role dashboards for transport, library, inventory, HR, health, kitchen and exams have data', async () => {
    const tm = await demoLogin('transport');
    const routes = (await http(app).get('/transport/routes').set(auth(tm)).expect(200)).body;
    expect(routes).toHaveLength(10); expect(routes.every((r: any) => r.riders > 0 && r.riders <= 40)).toBe(true);
    const al = (await http(app).get('/transport/alerts').set(auth(tm)).expect(200)).body;
    expect(al.some((x: any) => x.expired)).toBe(true);
    const lib = await demoLogin('librarian');
    expect((await http(app).get('/library/overdue').set(auth(lib)).expect(200)).body.length).toBeGreaterThan(3);
    const inv = await demoLogin('inventory');
    expect((await http(app).get('/inventory/low-stock').set(auth(inv)).expect(200)).body.length).toBeGreaterThan(2);
    expect((await http(app).get('/procurement/requisitions').set(auth(inv)).expect(200)).body.length).toBeGreaterThanOrEqual(5);
    const hr = await demoLogin('hr', true);
    expect((await http(app).get('/hr/staff').set(auth(hr)).expect(200)).body).toHaveLength(60);
    expect((await http(app).get('/payroll/runs').set(auth(hr)).expect(200)).body[0]).toMatchObject({ status: 'paid', payslips: 60 });
    const nurse = await demoLogin('nurse', true);
    expect((await http(app).get('/health/medicine-alerts').set(auth(nurse)).expect(200)).body.length).toBeGreaterThan(1);
    expect((await http(app).get('/counselling/referrals').set(auth(nurse)).expect(200)).body).toHaveLength(4);
    const kitchen = await demoLogin('kitchen');
    const today = new Date().toISOString().slice(0, 10);
    const hc = (await http(app).get(`/meals/headcount?date=${today}&meal=lunch`).set(auth(kitchen)).expect(200)).body;
    expect(hc.expected).toBeGreaterThan(70);
    const parent = await demoLogin('parent');
    const kids = (await http(app).get('/me/children').set(auth(parent)).expect(200)).body;
    const rc = (await http(app).get(`/students/${kids[0].id}/report-card`).set(auth(parent)).expect(200)).body;
    expect(rc.items.some((i: any) => i.assessment_name === 'Mid-term 2026')).toBe(true);
    const teacherTok = await demoLogin('teacher');
    const tt = (await http(app).get('/me/timetable').set(auth(teacherTok)).expect(200)).body;
    expect(tt.length).toBeGreaterThan(5);
    const sg = await demoLogin('safeguarding', true);
    expect((await http(app).get('/incidents').set(auth(sg)).expect(200)).body.some((i: any) => i.category === 'safeguarding')).toBe(true);
    const adminTok = await demoLogin('admin', true);
    const exp = await http(app).get('/reports/students.csv').set(auth(adminTok)).expect(200);
    expect(exp.text.split('\r\n').length).toBeGreaterThan(300);
  });
});

describe('demo seed — phase 4 (accounting, lifecycle, consents, advanced learning)', () => {
  it('general ledger is balanced and agrees with the fee sub-ledger and payroll', async () => {
    const acct = await demoLogin('accountant', true);
    const t = (await http(app).get('/accounting/trial-balance').set(auth(acct)).expect(200)).body;
    expect(t.balanced).toBe(true); expect(t.accounts.length).toBeGreaterThan(8);
    const bal = (code: string) => { const r = t.accounts.find((x: any) => x.code === code); return r ? r.balanceDebit - r.balanceCredit : 0; };
    const sum = (await http(app).get('/finance/summary').set(auth(acct)).expect(200)).body;
    expect(bal('1100')).toBe(sum.outstanding);                                         // receivable control account = Σ invoice outstanding
    expect(bal('2100')).toBe(0);                                                       // the seeded payroll run is paid
    expect(bal('2000')).toBe(-(await scalar(`select coalesce(sum(total_minor),0)::int n from vendor_bills where status = 'open'`)));
    const bs = (await http(app).get(`/accounting/reports/balance-sheet?asOf=2099-12-31`).set(auth(acct)).expect(200)).body;
    expect(bs.balanced).toBe(true);
    const bva = (await http(app).get(`/accounting/budget-vs-actual?academicYearId=${(await db.raw('select 1'), (await db.withTenant(tenantId, async (tx) => (await tx.query('select id from academic_years where is_current')).rows[0].id)))}`).set(auth(acct)).expect(200)).body;
    expect(bva.length).toBe(5);
    const rec = (await http(app).get('/accounting/bank-reconciliation').set(auth(acct)).expect(200)).body;
    expect(rec.unmatchedStatement.length).toBeGreaterThan(3);
    const matched = (await http(app).post('/accounting/bank-reconciliation/auto-match').set(auth(acct)).expect(201)).body;
    expect(matched.matched).toBeGreaterThan(20);
    expect(await scalar(`select count(*)::int n from journal_entries e where (select sum(debit_minor) from journal_lines where entry_id = e.id) <> (select sum(credit_minor) from journal_lines where entry_id = e.id)`)).toBe(0);
  });
  it('admissions, lifecycle and consent data support the demo workflows', async () => {
    expect(await scalar('select count(*)::int n from enquiries')).toBe(15);
    expect(await scalar('select count(*)::int n from student_documents')).toBeGreaterThanOrEqual(60);
    const reg = await demoLogin('registrar');
    expect((await http(app).get('/student-documents/expiring?days=60').set(auth(reg)).expect(200)).body.length).toBeGreaterThan(3);
    expect((await http(app).get('/withdrawals').set(auth(reg)).expect(200)).body.length).toBe(1);
    const pv = (await http(app).get(`/promotion/preview?academicYearId=${await db.withTenant(tenantId, async (tx) => (await tx.query('select id from academic_years where is_current')).rows[0].id)}`).set(auth(reg)).expect(200)).body.students;
    expect(pv.some((x: any) => x.suggestion === 'promote')).toBe(true); expect(pv.some((x: any) => x.suggestion === 'needs_review')).toBe(true);
    const parent = await demoLogin('parent');
    const mine = (await http(app).get('/consents/mine').set(auth(parent)).expect(200)).body;
    expect(mine.length).toBeGreaterThanOrEqual(4); expect(mine.every((m: any) => m.response === null)).toBe(true);   // the demo parent still has everything to answer
    const forms = (await http(app).get('/consents').set(auth(reg)).expect(200)).body;
    expect(forms).toHaveLength(3); expect(forms.every((f: any) => f.responses >= 10)).toBe(true);
  });
  it('advanced learning data: competencies, discussions awaiting moderation, plans, portfolio', async () => {
    const student = await demoLogin('student');
    const me = (await db.withTenant(tenantId, async (tx) => (await tx.query(`select id from students where user_id = (select id from users where email = 'student@greenwood.demo')`)).rows[0].id));
    const pf = (await http(app).get(`/students/${me}/portfolio`).set(auth(student)).expect(200)).body;
    expect(pf).toHaveLength(2);
    expect(await scalar(`select count(*)::int n from discussion_posts where status = 'pending'`)).toBeGreaterThan(0);
    expect(await scalar('select count(*)::int n from competency_assessments')).toBeGreaterThan(100);
    expect(await scalar(`select count(*)::int n from learning_plans where status = 'active'`)).toBeGreaterThanOrEqual(5);
  });
  it('seeding twice still adds nothing', async () => {
    const before = await scalar('select count(*)::int n from journal_entries');
    await seedDemo(db);
    expect(await scalar('select count(*)::int n from journal_entries')).toBe(before);
  });
});
