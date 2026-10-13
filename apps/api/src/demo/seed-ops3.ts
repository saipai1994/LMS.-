/** Fourth seed phase: lifecycle, finance policy, admissions pipeline, consents, advanced learning, hostel upkeep, accounting. Deterministic. */
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';
import { postJournal } from '../common/gl';
import { backfillGl } from '../accounting/accounting.controller';
import { hashPassword } from '../common/crypto';
import { DEMO_PASSWORD } from './constants';

const H = (expr: string, mod = 100) => `(abs(hashtext(${expr})) % ${mod})`;

export async function seedOperations3(db: DbService, tenantId: string): Promise<void> {
  await db.withTenant(tenantId, async (tx) => {
    const q = async (sql: string, p: unknown[] = []) => { try { return (await tx.query(sql, p)).rows; } catch (e) { console.error(`seed-ops3 failed: ${(e as Error).message}\n  SQL: ${sql.replace(/\s+/g, ' ').slice(0, 220)}`); throw e; } };
    const T = [tenantId];
    const [campus] = await q('select id from campuses limit 1');
    const [year] = await q('select id from academic_years where is_current');
    const uid = async (email: string) => (await q('select id from users where email = $1', [email]))[0]?.id as string;
    const byRole = async (role: string) => (await q(`select u.id from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where r.key = $1 order by u.email`, [role])).map((r) => r.id as string);
    const admin = await uid('admin@greenwood.demo'), principal = await uid('principal@greenwood.demo'), registrar = await uid('registrar@greenwood.demo'), warden = await uid('warden@greenwood.demo'), accountant = await uid('accountant@greenwood.demo');
    const teachers = await byRole('teacher');
    const kids = await q(`select s.id, s.admission_no from students s where s.status = 'active' order by s.admission_no`);

    // ---------- student logins for Grade 6 (so the student portal and discussions have real users) ----------
    const pw = await hashPassword(DEMO_PASSWORD);
    const studentRole = (await q(`select id from roles where key = 'student'`))[0].id;
    for (const st of await q(`select s.id, s.admission_no, s.first_name, s.last_name from students s join enrollments e on e.student_id = s.id and e.effective_to is null join sections sec on sec.id = e.section_id join grade_levels g on g.id = sec.grade_level_id where g.ordinal = 6 and s.user_id is null order by s.admission_no`)) {
      const [u] = await q(`insert into users(tenant_id, email, full_name, status, password_hash) values ($1,$2,$3,'active',$4) returning id`, [tenantId, `${st.admission_no.toLowerCase()}@students.greenwood.demo`, `${st.first_name} ${st.last_name}`, pw]);
      await q('insert into user_roles(tenant_id, user_id, role_id) values ($1,$2,$3)', [tenantId, u.id, studentRole]);
      await q('update students set user_id = $2 where id = $1', [st.id, u.id]);
    }

    // ---------- finance policy & concessions ----------
    await q(`insert into fee_settings(tenant_id, sibling_discount_percent, sibling_head_code, late_fee_flat_minor, late_fee_grace_days, configured_by) values ($1,10,'TUI',50000,7,$2)`, [tenantId, principal]);
    for (let i = 0; i < 10; i++) await q(`insert into student_concessions(tenant_id, student_id, academic_year_id, kind, basis, value, head_code, reason, approved_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenantId, kids[i * 29 + 4].id, year.id, ['scholarship', 'concession', 'staff_ward'][i % 3], i % 2 ? 'fixed' : 'percent', i % 2 ? 5000 : 25 + (i % 3) * 25, i % 2 ? null : 'TUI', ['Merit scholarship', 'Financial assistance (means-tested)', 'Staff ward concession'][i % 3] + ' — demo', principal]);

    // ---------- admissions pipeline ----------
    const g = await q(`select id, ordinal from grade_levels`);
    const gid = (n: number) => g.find((x) => x.ordinal === n).id as string;
    for (let i = 0; i < 15; i++) await q(`insert into enquiries(tenant_id, campus_id, contact_name, email, phone, child_name, interest_grade_level_id, source, status, notes, assigned_to, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() - ($12 || ' days')::interval)`,
      [tenantId, campus.id, ['Anil Rao', 'Pooja Menon', 'Salim Khan', 'Divya Nair', 'Vikas Gupta', 'Rekha Iyer', 'Tarun Bose', 'Neha Kapoor', 'Mohan Das', 'Sunita Reddy', 'Ajay Sethi', 'Lata Pillai', 'Karan Gill', 'Maya Joshi', 'Imran Ali'][i], i % 3 ? `enq${i}@example.test` : null, `+91-98${String(10000000 + i * 137).slice(0, 8)}`, ['Aditya', 'Kiara', 'Zain', 'Anvi', 'Rudra', 'Siya', 'Ishan', 'Mahi', 'Vedant', 'Tanya', 'Arnav', 'Diya', 'Krish', 'Navya', 'Rayan'][i], gid(1 + (i % 10)), ['walk_in', 'website', 'referral', 'phone', 'event'][i % 5], ['new', 'contacted', 'visit_scheduled', 'lost', 'contacted'][i % 5], 'Demo enquiry', registrar, i * 2 + 1]);
    const pending = await q(`select id, applicant_first_name, status from admission_applications order by applicant_first_name`);
    for (const ap of pending) {
      await q(`insert into admission_assessments(tenant_id, application_id, kind, scheduled_at, score, max_score, panel, recorded_by) values ($1,$2,'entrance_test', now() - interval '3 days', $3, 100, 'Panel A', $4)`, [tenantId, ap.id, 55 + (ap.applicant_first_name.length * 7) % 40, registrar]);
      if (['accepted', 'offered'].includes(ap.status)) await q(`insert into admission_assessments(tenant_id, application_id, kind, scheduled_at, score, max_score, panel, recorded_by) values ($1,$2,'interview', now() - interval '2 days', $3, 20, 'Principal + Counsellor', $4)`, [tenantId, ap.id, 14 + (ap.applicant_first_name.length % 6), registrar]);
      await q(`insert into admission_documents(tenant_id, application_id, kind, created_by, verified_by, verified_at) values ($1,$2,'Birth certificate',$3, case when $4 then $5::uuid end, case when $4 then now() end)`, [tenantId, ap.id, registrar, ap.status !== 'submitted', admin]);
    }
    const offered = pending.find((p) => p.status === 'offered');
    if (offered) await q(`insert into admission_offers(tenant_id, application_id, token_hash, terms, expires_on, created_by) values ($1,$2,$3,'Annual fees as per the attached schedule; school rules apply. (Demo)', current_date + 10, $4)`, [tenantId, offered.id, 'demo-offer-token-hash-not-usable-' + offered.id, registrar]);

    // ---------- student records: documents, previous schools, promotion rules, withdrawal ----------
    for (let i = 0; i < 60; i++) {
      const exp = i % 9 === 0 ? -20 : i % 7 === 0 ? 25 : i % 5 === 0 ? 400 : null;
      await q(`insert into student_documents(tenant_id, student_id, kind, reference, issued_on, expires_on, verified_by, verified_at, created_by) values ($1,$2,$3,$4,current_date - 900, case when $5::int is null then null else current_date + $5::int end, case when $6 then $7::uuid end, case when $6 then now() - interval '30 days' end, $8)`,
        [tenantId, kids[i * 5].id, exp === null ? 'Birth certificate' : i % 2 ? 'Passport' : 'Medical fitness certificate', `DOC-${1000 + i}`, exp, i % 4 !== 0, admin, registrar]);
    }
    for (let i = 0; i < 40; i++) await q(`insert into previous_schools(tenant_id, student_id, school_name, last_grade, from_year, to_year, summary) values ($1,$2,$3,$4,'2021','2025','Transferred for relocation (demo)')`, [tenantId, kids[100 + i * 4].id, ['Sunrise Public School', 'Little Flower School', 'Delhi Public School (demo)', 'St. Mary’s Academy', 'Vidya Mandir'][i % 5], `Grade ${3 + (i % 8)}`]);
    await q(`insert into promotion_rules(tenant_id, academic_year_id, min_overall_percent, min_subject_percent, max_failed_subjects, min_attendance_percent) values ($1,$2,40,33,2,75)`, [tenantId, year.id]);
    const dayScholar = (await q(`select s.id from students s join residence_assignments ra on ra.student_id = s.id and ra.effective_to is null and ra.residence_type = 'day_scholar' order by s.admission_no offset 150 limit 1`))[0];
    await q(`insert into withdrawal_requests(tenant_id, student_id, kind, reason, destination_school, effective_date, requested_by) values ($1,$2,'transfer_out','Family relocating to another city (demo)','Greenfield School, Pune', current_date + 14, $3)`, [tenantId, dayScholar.id, registrar]);

    // ---------- day scholars & hostel ----------
    const ds = await q(`select s.id, s.campus_id from students s join residence_assignments ra on ra.student_id = s.id and ra.effective_to is null and ra.residence_type = 'day_scholar' order by s.admission_no limit 6`);
    for (let i = 0; i < ds.length; i++) await q(`insert into early_dismissal_requests(tenant_id, student_id, requested_by, for_date, pickup_time, reason, status, decided_by, decided_at) select $1, $2, g.user_id, current_date + $3::int, '13:00', $4, $5, case when $5 = 'approved' then $6::uuid end, case when $5 = 'approved' then now() end from student_guardians sg join guardians g on g.id = sg.guardian_id where sg.student_id = $2 limit 1`,
      [tenantId, ds[i].id, i % 2, ['Dental appointment', 'Family function', 'Medical check-up', 'Travel', 'Sibling’s event', 'Religious ceremony'][i], i % 3 === 0 ? 'requested' : 'approved', teachers[0]]);
    const hostels = await q(`select id from hostels order by name`);
    const rooms = await q(`select r.id, r.hostel_id from rooms r order by r.hostel_id, r.number`);
    const issues = ['Leaking tap in bathroom', 'Window latch broken', 'Fan making noise', 'Light flickering', 'Door lock jammed', 'Mattress needs replacement', 'Wi-Fi socket not working', 'Wardrobe hinge loose'];
    for (let i = 0; i < issues.length; i++) await q(`insert into maintenance_requests(tenant_id, hostel_id, room_id, description, priority, status, reported_by, assigned_to, done_note, done_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9, case when $6 = 'done' then now() - interval '2 days' end)`,
      [tenantId, rooms[i * 3].hostel_id, rooms[i * 3].id, issues[i], ['low', 'normal', 'urgent'][i % 3], ['open', 'assigned', 'done', 'open'][i % 4], warden, i % 4 === 1 ? 'Maintenance team' : i % 4 === 2 ? 'Electrician Raju' : null, i % 4 === 2 ? 'Fixed (demo)' : null]);
    for (let i = 0; i < 18; i++) await q(`insert into room_inspections(tenant_id, room_id, inspected_by, inspected_on, score, issues) values ($1,$2,$3, current_date - $4::int, $5, $6)`, [tenantId, rooms[i].id, warden, i % 12, 3 + (i % 3), i % 5 === 0 ? 'Minor untidiness (demo)' : null]);
    const boarders = await q(`select s.id from students s join residence_assignments ra on ra.student_id = s.id and ra.effective_to is null and ra.residence_type = 'boarder' order by s.admission_no limit 30`);
    for (let i = 0; i < boarders.length; i++) await q(`insert into vacation_plans(tenant_id, student_id, from_date, to_date, arrangement, contact, recorded_by) values ($1,$2, current_date + 60, current_date + 90, $3, $4, $5)`,
      [tenantId, boarders[i].id, i % 6 === 0 ? 'school_stay' : i % 4 === 0 ? 'guardian' : 'home', i % 6 === 0 ? 'Warden on duty' : `+91-97000-${String(10000 + i)}`, warden]);
    void hostels;

    // ---------- consents ----------
    const grade6 = gid(6);
    const forms: [string, string, string, string | null][] = [
      ['Photo & media consent', 'I consent to my child’s photograph being used in school publications and the website, as described in the privacy notice. (Demo)', 'all', null],
      ['Excursion consent — hill station trip', 'I give permission for my child to join the Grade 6 excursion, understand the itinerary, and have shared medical information with the trip nurse. (Demo)', 'grade', grade6],
      ['Sports participation & medical fitness', 'My child is medically fit to take part in inter-house sports. (Demo)', 'all', null],
    ];
    for (const [title, body, aud, ref] of forms) {
      const [f] = await q(`insert into consent_forms(tenant_id, title, body, audience_type, audience_ref, due_on, created_by) values ($1,$2,$3,$4,$5, current_date + 12, $6) returning id`, [tenantId, title, body, aud, ref, registrar]);
      await q(`insert into consent_responses(tenant_id, form_id, student_id, guardian_user_id, decision, signed_name, ip)
               select $1, $2, s.id, g.user_id, case when ${H("s.admission_no || $3", 100)} < 8 then 'decline' else 'agree' end, g.full_name, '203.0.113.7'
               from students s join student_guardians sg on sg.student_id = s.id join guardians g on g.id = sg.guardian_id
               where s.status = 'active' and ${H("s.admission_no || $3", 100)} < 62 and g.user_id <> (select id from users where email = 'parent@greenwood.demo')
                 and ($4::uuid is null or exists (select 1 from enrollments e join sections sec on sec.id = e.section_id where e.student_id = s.id and e.effective_to is null and sec.grade_level_id = $4))`, [tenantId, f.id, title, ref]);
    }

    // ---------- advanced learning ----------
    const courses = await q(`select c.id, c.teacher_user_id, c.subject_id, c.title from courses c join sections s on s.id = c.section_id join grade_levels g on g.id = s.grade_level_id where g.ordinal between 1 and 6 order by g.ordinal, s.name, c.title limit 60`);
    const g6courses = await q(`select c.id, c.teacher_user_id from courses c join sections s on s.id = c.section_id join grade_levels g on g.id = s.grade_level_id where g.ordinal = 6 order by s.name, c.title`);
    for (let i = 0; i < 6; i++) {
      const [th] = await q(`insert into discussion_threads(tenant_id, course_id, title, moderated, created_by) values ($1,$2,$3,true,$4) returning id`, [tenantId, g6courses[i * 2].id, ['Questions on Homework 1', 'Share your project ideas', 'Weekly reading discussion', 'Help with problem 5', 'Exam revision tips', 'Class etiquette'][i], g6courses[i * 2].teacher_user_id]);
      await q(`insert into discussion_posts(tenant_id, thread_id, author_user_id, body, status, moderated_by) values ($1,$2,$3,'Welcome! Ask your questions here and be respectful. (Demo)','approved',null)`, [tenantId, th.id, g6courses[i * 2].teacher_user_id]);
      const enrolled = await q(`select s.user_id from course_enrollments ce join students s on s.id = ce.student_id where ce.course_id = $1 and s.user_id is not null limit 2`, [g6courses[i * 2].id]);
      for (const e of enrolled) await q(`insert into discussion_posts(tenant_id, thread_id, author_user_id, body, status) values ($1,$2,$3,'Can someone explain step 3? (demo)','pending')`, [tenantId, th.id, e.user_id]);
    }
    const subjects = await q(`select id, code from subjects`);
    const comps: string[] = [];
    for (const s of subjects.filter((x) => ['MATH', 'ENG', 'SCI'].includes(x.code))) for (let k = 1; k <= 4; k++)
      comps.push((await q(`insert into competencies(tenant_id, subject_id, code, description) values ($1,$2,$3,$4) returning id`, [tenantId, s.id, `${s.code}.${k}`, `${s.code} competency ${k}: demonstrates the expected skill for the stage (demo)`]))[0].id);
    const compCourses = courses.filter((c) => subjects.find((s) => s.id === c.subject_id && ['MATH', 'ENG', 'SCI'].includes(s.code))).slice(0, 12);
    for (const c of compCourses) {
      const cs = await q(`select k.id from competencies k where k.subject_id = $1`, [c.subject_id]);
      const st = await q(`select ce.student_id, s.admission_no from course_enrollments ce join students s on s.id = ce.student_id where ce.course_id = $1 and ce.status = 'active' limit 6`, [c.id]);
      for (const s_ of st) for (const k of cs) await q(`insert into competency_assessments(tenant_id, student_id, competency_id, level, evidence, assessed_by) values ($1,$2,$3,$4,'Observed in class work (demo)',$5)`, [tenantId, s_.student_id, k.id, 1 + (Math.abs(hashCode(s_.admission_no + k.id)) % 4), c.teacher_user_id]);
    }
    for (let i = 0; i < 8; i++) {
      const c = courses[i * 5 + 1];
      const [st] = await q(`select student_id from course_enrollments where course_id = $1 and status = 'active' order by student_id limit 1 offset $2`, [c.id, i % 3]);
      if (st) await q(`insert into learning_plans(tenant_id, student_id, course_id, kind, goal, starts_on, ends_on, status, created_by) values ($1,$2,$3,$4,$5, current_date - 7, current_date + 21, 'active', $6)`, [tenantId, st.student_id, c.id, i % 3 === 0 ? 'enrichment' : 'remedial', i % 3 === 0 ? 'Extension problems and a mini-project (demo)' : 'Short daily practice to close gaps in fractions (demo)', c.teacher_user_id]);
    }
    const stud = await uid('student@greenwood.demo');
    if (stud) {
      const [me] = await q('select id from students where user_id = $1', [stud]);
      for (const [t, r] of [['My science fair model', 'I built a working water-cycle model and learned about evaporation and condensation.'], ['Reading journal — term 1', 'I finished three books and wrote short summaries of each.']])
        await q(`insert into portfolio_entries(tenant_id, student_id, title, reflection, teacher_comment, commented_by) values ($1,$2,$3,$4,'Excellent effort — keep it up! (demo)',$5)`, [tenantId, me.id, t, r, teachers[0]]);
    }
    await q(`insert into report_remarks(tenant_id, student_id, academic_year_id, remark, author_user_id) select $1, s.id, $2, 'Hard-working and cooperative; a pleasure to teach. (Demo remark)', sec.class_teacher_user_id from students s join enrollments e on e.student_id = s.id and e.effective_to is null join sections sec on sec.id = e.section_id join grade_levels g on g.id = sec.grade_level_id where g.ordinal <= 3 and sec.class_teacher_user_id is not null`, [tenantId, year.id]);

    // ---------- accounting: cost centres, backfill, bills, budgets, bank statement ----------
    for (const [code, name] of [['ACAD', 'Academics'], ['ADMIN', 'Administration'], ['HOSTEL', 'Hostel & mess'], ['TRANS', 'Transport'], ['SPORT', 'Sports & activities']]) await q('insert into cost_centres(tenant_id, code, name) values ($1,$2,$3)', [tenantId, code, name]);
    await backfillGl(tx, tenantId, accountant ?? admin);
    const sups = await q('select id, name from suppliers order by name');
    const billPlan: [number, string, string, number, number][] = [[0, '5100', 'ACAD', 6500000, 20], [1, '5100', 'SPORT', 3200000, 35], [2, '5100', 'ADMIN', 1850000, 12], [3, '5100', 'ACAD', 4200000, 50], [4, '5100', 'HOSTEL', 7800000, 8], [5, '5200', 'ADMIN', 2400000, 70]];
    for (let i = 0; i < billPlan.length; i++) {
      const [si, acct, cc, amt, ago] = billPlan[i]; const paid = i % 2 === 1;
      const [b] = await q(`insert into vendor_bills(tenant_id, number, supplier_id, bill_date, due_date, total_minor, status, paid_on, created_by) values ($1,$2,$3, current_date - $4::int, current_date - $4::int + 30, $5, $6, case when $7 then current_date - $4::int + 20 end, $8) returning id`, [tenantId, `VB-${2026}-${String(i + 1).padStart(3, '0')}`, sups[si].id, ago, amt, paid ? 'paid' : 'open', paid, accountant ?? admin]);
      await postJournal(tx, tenantId, { memo: `Vendor bill VB-${i + 1}`, source: 'vendor_bill', sourceRef: b.id, postedBy: accountant ?? admin, lines: [{ account: acct, debit: amt, costCentre: cc }, { account: '2000', credit: amt }] });
      if (paid) await postJournal(tx, tenantId, { memo: `Payment of bill VB-${i + 1}`, source: 'bill_payment', sourceRef: b.id, postedBy: principal, lines: [{ account: '2000', debit: amt }, { account: '1010', credit: amt }] });
    }
    for (const [cc, acct, amt] of [['ACAD', '5100', 9000000], ['ADMIN', '5100', 3000000], ['HOSTEL', '5100', 6000000], ['SPORT', '5100', 4000000], ['ADMIN', '5200', 2000000]])
      await q(`insert into budgets(tenant_id, academic_year_id, cost_centre, account_id, amount_minor) select $1,$2,$3,id,$5 from accounts where code = $4`, [tenantId, year.id, cc, acct, amt]);
    await q(`insert into bank_statement_lines(tenant_id, stmt_date, description, amount_minor, reference) select $1, p.received_at::date, 'Credit ' || p.method, p.amount_minor, p.receipt_no from payments p where p.method <> 'cash' and ${H('p.receipt_no', 100)} < 75`, T);
    for (const [d, desc, amt] of [[3, 'Cash deposit — unreferenced', 1250000], [6, 'Cheque deposit — payer unknown', 840000], [9, 'Interest credit', 31200]] as [number, string, number][])
      await q(`insert into bank_statement_lines(tenant_id, stmt_date, description, amount_minor) values ($1, current_date - $2::int, $3, $4)`, [tenantId, d, desc, amt]);
    await audit(tx, null, tenantId, 'demo.seed.ops3', 'tenant', tenantId);
  });
}
function hashCode(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
