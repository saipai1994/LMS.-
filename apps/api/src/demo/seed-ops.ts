/**
 * Second seed phase: operational data (hostel, leave, attendance, finance, LMS, incidents).
 * Deterministic: all "random" choices derive from hashtext() of stable business keys (admission numbers, titles).
 * Time-relative records (leave status, today's pickups) are anchored to the moment of seeding.
 */
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';

const H = (expr: string, mod = 100) => `(abs(hashtext(${expr})) % ${mod})`;

export async function seedOperations(db: DbService, tenantId: string): Promise<void> {
  await db.withTenant(tenantId, async (tx) => {
    const q = async (sql: string, p: unknown[] = []) => (await tx.query(sql, p)).rows;
    const T = [tenantId];
    const [campus] = await q('select id from campuses limit 1');
    const [year] = await q('select id from academic_years where is_current');
    const uid = async (email: string) => (await q('select id from users where email = $1', [email]))[0]?.id as string;
    const warden = await uid('warden@greenwood.demo'), principal = await uid('principal@greenwood.demo'), coord = await uid('staff12@greenwood.demo') ?? principal;
    const examCoord = (await q(`select u.id from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where r.key = 'exam_coordinator' order by u.email limit 1`))[0]?.id ?? principal;
    void coord;

    // ---------- hostels, rooms, beds, allocations ----------
    const hostels: { id: string }[] = [];
    for (const name of ['Himalaya House', 'Nilgiri House', 'Aravalli House']) {
      const [h] = await q('insert into hostels(tenant_id, campus_id, name) values ($1,$2,$3) returning id', [tenantId, campus.id, name]);
      hostels.push(h);
      for (let floor = 1; floor <= 2; floor++) for (let r = 1; r <= 5; r++) {
        const [room] = await q('insert into rooms(tenant_id, hostel_id, floor, number) values ($1,$2,$3,$4) returning id', [tenantId, h.id, floor, String(floor * 100 + r)]);
        for (const label of ['A', 'B', 'C', 'D']) await q('insert into beds(tenant_id, room_id, label) values ($1,$2,$3)', [tenantId, room.id, label]);
      }
    }
    const bedsByHostel: string[][] = [];
    for (const h of hostels) bedsByHostel.push((await q('select b.id from beds b join rooms r on r.id = b.room_id where r.hostel_id = $1 order by r.number, b.label', [h.id])).map((x) => x.id));
    const boarders = await q(`select s.id, s.admission_no from students s join residence_assignments ra on ra.student_id = s.id and ra.effective_to is null and ra.residence_type = 'boarder' order by s.admission_no`);
    const cursor = [0, 0, 0];
    const residents: string[][] = [[], [], []];
    for (let i = 0; i < boarders.length; i++) {
      const h = i % 3;
      await q('insert into bed_assignments(tenant_id, student_id, bed_id, effective_from) values ($1,$2,$3,$4)', [tenantId, boarders[i].id, bedsByHostel[h][cursor[h]++], '2026-04-01']);
      residents[h].push(boarders[i].id);
    }

    // ---------- leave requests & gate movements (Scenario B states) ----------
    const guardianUser = async (sid: string) => (await q('select g.user_id from student_guardians sg join guardians g on g.id = sg.guardian_id where sg.student_id = $1 limit 1', [sid]))[0].user_id as string;
    const states = ['requested', 'requested', 'approved', 'out', 'out', 'out_overdue', 'returned', 'returned'];
    const dest = ['Home, Pune', 'Grandparents, Chennai', 'Family wedding, Jaipur', 'Home, Kochi', 'Medical appointment, Bengaluru', 'Home, Hyderabad', 'Home, Mumbai', 'Cousin visit, Delhi'];
    const outIds: string[] = [];
    for (let i = 0; i < states.length; i++) {
      const sid = boarders[i * 7].id;
      const st = states[i];
      const hoursAgo = st === 'out_overdue' ? 30 : st === 'out' ? 20 : st === 'returned' ? 120 : 0;
      const departOffset = st === 'requested' || st === 'approved' ? 48 : -hoursAgo;
      const returnOffset = st === 'out_overdue' ? -6 : st === 'out' ? 28 : st === 'returned' ? -72 : departOffset + 52;
      const status = st === 'out_overdue' ? 'out' : st;
      const [l] = await q(
        `insert into leave_requests(tenant_id, student_id, requested_by, leave_type, destination, responsible_adult, depart_at, expected_return_at, status, decided_by, decided_at, gate_out_at, gate_in_at)
         values ($1,$2,$3,$4,$5,'Parent / guardian', now() + ($6 || ' hours')::interval, now() + ($7 || ' hours')::interval, $8,
           case when $8 = 'requested' then null::uuid else $9::uuid end, case when $8 = 'requested' then null::timestamptz else now() - interval '3 days' end,
           case when $8 in ('out','returned') then now() + ($6 || ' hours')::interval end,
           case when $8 = 'returned' then now() + ($7 || ' hours')::interval end) returning id`,
        [tenantId, sid, await guardianUser(sid), i % 3 === 0 ? 'weekend' : i % 3 === 1 ? 'home_visit' : 'outing', dest[i], departOffset, returnOffset, status, warden]);
      if (status === 'out' || status === 'returned') await q(`insert into gate_movements(tenant_id, student_id, direction, leave_request_id, recorded_by, at) values ($1,$2,'out',$3,$4, now() + ($5 || ' hours')::interval)`, [tenantId, sid, l.id, warden, departOffset]);
      if (status === 'returned') await q(`insert into gate_movements(tenant_id, student_id, direction, leave_request_id, recorded_by, at) values ($1,$2,'in',$3,$4, now() + ($5 || ' hours')::interval)`, [tenantId, sid, l.id, warden, returnOffset]);
      if (status === 'out') outIds.push(sid);
    }

    // ---------- hostel roll calls: last 3 evenings and mornings ----------
    for (let h = 0; h < 3; h++) for (let d = 1; d <= 3; d++) for (const session of ['morning', 'bedtime']) {
      const [rc] = await q(`insert into roll_calls(tenant_id, hostel_id, session, roll_date, recorded_by) values ($1,$2,$3, current_date - $4::int, $5) returning id`, [tenantId, hostels[h].id, session, d, warden]);
      for (const sid of residents[h]) await q(`insert into roll_call_entries(tenant_id, roll_call_id, student_id, status) values ($1,$2,$3,'present')`, [tenantId, rc.id, sid]);
    }

    // ---------- attendance: 10 school days for every enrolled student ----------
    await q(`create temp table _days on commit drop as select d::date as d from generate_series('2026-09-14'::date, '2026-09-25'::date, '1 day') d where extract(isodow from d) < 6`);
    await q(
      `insert into attendance_records(tenant_id, student_id, section_id, att_date, period, status, marked_by)
       select $1, e.student_id, e.section_id, _days.d, 0,
         case when ${H("s.admission_no || _days.d::text")} < 5 then 'absent' when ${H("s.admission_no || _days.d::text")} < 8 then 'late' when ${H("s.admission_no || _days.d::text")} < 9 then 'excused' else 'present' end,
         sec.class_teacher_user_id
       from enrollments e join students s on s.id = e.student_id join sections sec on sec.id = e.section_id cross join _days where e.effective_to is null`, T);

    // ---------- finance ----------
    const heads: Record<string, string> = {};
    for (const [code, name] of [['TUI', 'Tuition'], ['BRD', 'Boarding & Mess'], ['ACT', 'Activities & Sports']])
      heads[code] = (await q('insert into fee_heads(tenant_id, code, name) values ($1,$2,$3) returning id', [tenantId, code, name]))[0].id;
    await q(`insert into fee_structures(tenant_id, academic_year_id, grade_level_id, residence_type, head_id, amount_minor) select $1, $2, g.id, null, $3, (30000 + g.ordinal * 2000) * 100 from grade_levels g`, [tenantId, year.id, heads.TUI]);
    await q(`insert into fee_structures(tenant_id, academic_year_id, grade_level_id, residence_type, head_id, amount_minor) select $1, $2, g.id, 'boarder', $3, 45000 * 100 from grade_levels g`, [tenantId, year.id, heads.BRD]);
    await q(`insert into fee_structures(tenant_id, academic_year_id, grade_level_id, residence_type, head_id, amount_minor) select $1, $2, g.id, null, $3, 5000 * 100 from grade_levels g`, [tenantId, year.id, heads.ACT]);
    const admin = await uid('admin@greenwood.demo');
    let invNo = 0;
    for (const [batch, issue, due] of [['TERM1-2026', '2026-04-05', '2026-08-31'], ['TERM2-2026', '2026-10-01', '2026-12-15']]) {
      await q(`create temp table _inv on commit drop as
        select s.id as student_id, row_number() over (order by s.admission_no) + $2::int as n, sum(fs.amount_minor)::bigint as total
        from students s join enrollments e on e.student_id = s.id and e.effective_to is null join sections sec on sec.id = e.section_id
        join residence_assignments ra on ra.student_id = s.id and ra.effective_to is null
        join fee_structures fs on fs.grade_level_id = sec.grade_level_id and fs.academic_year_id = $1 and (fs.residence_type is null or fs.residence_type = ra.residence_type)
        group by s.id, s.admission_no`, [year.id, invNo]);
      await q(`insert into invoices(tenant_id, student_id, number, batch_key, issue_date, due_date, total_minor, created_by)
               select $1, student_id, 'INV-' || lpad(n::text, 6, '0'), $2, $3::date, $4::date, total, $5 from _inv`, [tenantId, batch, issue, due, admin]);
      await q(`insert into invoice_lines(tenant_id, invoice_id, line_no, description, head_id, amount_minor)
               select $1, i.id, row_number() over (partition by i.id order by h.code), h.name, h.id, fs.amount_minor
               from invoices i join students s on s.id = i.student_id join enrollments e on e.student_id = s.id and e.effective_to is null join sections sec on sec.id = e.section_id
               join residence_assignments ra on ra.student_id = s.id and ra.effective_to is null
               join fee_structures fs on fs.grade_level_id = sec.grade_level_id and fs.academic_year_id = $2 and (fs.residence_type is null or fs.residence_type = ra.residence_type)
               join fee_heads h on h.id = fs.head_id where i.batch_key = $3`, [tenantId, year.id, batch]);
      await q(`insert into ledger_entries(tenant_id, student_id, entry_date, kind, ref_id, debit_minor, description) select $1, student_id, $2::date, 'invoice', id, total_minor, 'Invoice ' || number from invoices where batch_key = $3`, [tenantId, issue, batch]);
      invNo += (await q('select count(*)::int n from _inv'))[0].n;
      await q('drop table _inv');
    }
    await q(`insert into document_sequences(tenant_id, key, prefix, next_value) values ($1,'invoice','INV-',$2) on conflict (tenant_id, key) do update set next_value = excluded.next_value`, [tenantId, invNo + 1]);
    // payments: TERM1 ~70% paid in full, ~15% half; TERM2 ~20% paid early. One payment per invoice.
    await q(`create temp table _pay on commit drop as
      select i.id as invoice_id, i.student_id, i.number, i.issue_date, i.total_minor,
        (case when ${H("s.admission_no || i.batch_key")} < (case when i.batch_key = 'TERM1-2026' then 70 else 20 end) then i.total_minor
              when i.batch_key = 'TERM1-2026' and ${H("s.admission_no || i.batch_key")} < 85 then i.total_minor / 2 else 0 end)::bigint as amount,
        (array['cash','bank_transfer','online_demo','cheque'])[1 + ${H("i.number", 4)}] as method,
        row_number() over (order by i.number) as rn
      from invoices i join students s on s.id = i.student_id`);
    await q(`delete from _pay where amount <= 0`);
    await q(`insert into payments(tenant_id, student_id, receipt_no, method, amount_minor, reference, idempotency_key, request_hash, received_by, received_at)
             select $1, student_id, 'RCT-' || lpad(rn::text, 6, '0'), method, amount, case when method = 'online_demo' then 'demo:seed-' || number end, 'seed:' || number, 'seed', null, issue_date + 10 from _pay`, T);
    await q(`insert into payment_allocations(tenant_id, payment_id, invoice_id, amount_minor) select $1, p.id, _pay.invoice_id, _pay.amount from _pay join payments p on p.idempotency_key = 'seed:' || _pay.number`, T);
    await q(`insert into ledger_entries(tenant_id, student_id, entry_date, kind, ref_id, credit_minor, description) select $1, p.student_id, p.received_at::date, 'payment', p.id, p.amount_minor, 'Payment ' || p.receipt_no || ' (' || p.method || ')' from payments p`, T);
    await q(`insert into document_sequences(tenant_id, key, prefix, next_value) values ($1,'receipt','RCT-',$2) on conflict (tenant_id, key) do update set next_value = excluded.next_value`, [tenantId, (await q('select count(*)::int + 1 as n from payments'))[0].n]);
    await q('drop table _pay');

    // ---------- LMS content for grades 1-6 ----------
    const courses = await q(`select c.id, c.title, c.teacher_user_id, c.section_id from courses c join sections s on s.id = c.section_id join grade_levels g on g.id = s.grade_level_id where g.ordinal <= 6 order by g.ordinal, s.name, c.title`);
    for (const c of courses) {
      const [l1] = await q(`insert into lessons(tenant_id, course_id, unit, title, body, position, published, created_by) values ($1,$2,'Unit 1','Introduction','Welcome to the course. Read the overview, then try the practice questions. (Demo content)',1,true,$3) returning id`, [tenantId, c.id, c.teacher_user_id]);
      await q(`insert into lessons(tenant_id, course_id, unit, title, body, position, published, prerequisite_lesson_id, created_by) values ($1,$2,'Unit 1','Core concepts','Worked examples and key ideas. (Demo content)',2,true,$3,$4)`, [tenantId, c.id, l1.id, c.teacher_user_id]);
      for (const [title, due] of [['Homework 1', '2026-09-20T18:00:00Z'], ['Homework 2', '2026-11-05T18:00:00Z']])
        await q(`insert into assignments(tenant_id, course_id, title, instructions, due_at, max_marks, published, created_by) values ($1,$2,$3,'Complete the exercises and submit your answers. (Demo)',$4,20,true,$5)`, [tenantId, c.id, title, due, c.teacher_user_id]);
    }
    // submissions: past homework mostly submitted and graded; upcoming homework partly drafted/submitted
    await q(`insert into submissions(tenant_id, assignment_id, student_id, status, answer_text, version, submitted_at, is_late, marks, feedback, graded_by, graded_at)
      select $1, x.id, s.id,
        case when ${H("s.admission_no || x.title || c.title")} < 70 then 'graded' else 'submitted' end, 'Demo answer text.', 1,
        x.due_at - interval '6 hours' + (${H("s.admission_no || x.title", 12)} || ' hours')::interval, ${H("s.admission_no || x.title", 12)} > 6,
        case when ${H("s.admission_no || x.title || c.title")} < 70 then 8 + ${H("s.admission_no || x.title || 'm'", 13)} end,
        case when ${H("s.admission_no || x.title || c.title")} < 70 then 'Reviewed. (Demo feedback)' end,
        case when ${H("s.admission_no || x.title || c.title")} < 70 then c.teacher_user_id end, case when ${H("s.admission_no || x.title || c.title")} < 70 then x.due_at + interval '2 days' end
      from assignments x join courses c on c.id = x.course_id join course_enrollments ce on ce.course_id = c.id join students s on s.id = ce.student_id
      where x.title = 'Homework 1' and ${H("s.admission_no || x.title || c.title")} < 88`, T);
    await q(`insert into submissions(tenant_id, assignment_id, student_id, status, answer_text, version, submitted_at, is_late)
      select $1, x.id, s.id, case when ${H("s.admission_no || x.title")} < 10 then 'submitted' else 'draft' end, 'Work in progress. (Demo)', case when ${H("s.admission_no || x.title")} < 10 then 1 else 0 end,
        case when ${H("s.admission_no || x.title")} < 10 then now() end, false
      from assignments x join courses c on c.id = x.course_id join course_enrollments ce on ce.course_id = c.id join students s on s.id = ce.student_id
      where x.title = 'Homework 2' and ${H("s.admission_no || x.title")} < 30`, T);
    await q(`insert into submission_history(tenant_id, submission_id, event, version, answer_text, marks, feedback, actor_user_id, at)
             select $1, id, 'submitted', 1, answer_text, null, null, null, submitted_at from submissions where status in ('submitted','graded')`, T);
    await q(`insert into submission_history(tenant_id, submission_id, event, version, marks, feedback, actor_user_id, at) select $1, id, 'graded', 1, marks, feedback, graded_by, graded_at from submissions where status = 'graded'`, T);
    // lesson progress for a share of students
    await q(`insert into lesson_progress(tenant_id, lesson_id, student_id)
             select $1, l.id, ce.student_id from lessons l join course_enrollments ce on ce.course_id = l.course_id join students s on s.id = ce.student_id
             where l.position = 1 and ${H("s.admission_no || l.course_id::text")} < 60`, T);
    // quizzes in three courses
    for (const c of courses.slice(0, 3)) {
      const [qz] = await q(`insert into quizzes(tenant_id, course_id, title, opens_at, closes_at, time_limit_minutes, attempts_allowed, published, created_by) values ($1,$2,'Chapter 1 quiz', now() - interval '1 day', now() + interval '30 days', 20, 2, true, $3) returning id`, [tenantId, c.id, c.teacher_user_id]);
      await q(`insert into quiz_questions(tenant_id, quiz_id, position, kind, prompt, options, answer_key, points) values ($1,$2,1,'mcq','Which is a prime number?','["4","7","9","12"]','1',2), ($1,$2,2,'mcq','What is 6 × 7?','["36","42","48","54"]','1',2), ($1,$2,3,'short','Capital of India?',null,'["new delhi","delhi"]',1)`, [tenantId, qz.id]);
    }
    // approved official marks for Homework 1 in grades 1-3 (what report cards show)
    const pubCourses = await q(`select c.id, c.teacher_user_id, x.id as assignment_id from courses c join sections s on s.id = c.section_id join grade_levels g on g.id = s.grade_level_id join assignments x on x.course_id = c.id and x.title = 'Homework 1' where g.ordinal <= 3`);
    for (const c of pubCourses) {
      const [p] = await q(`insert into grade_publications(tenant_id, course_id, assessment_name, source_assignment_ids, status, submitted_by, decided_by, decided_at) values ($1,$2,'Unit Test 1',$3,'approved',$4,$5, now() - interval '2 days') returning id`, [tenantId, c.id, [c.assignment_id], c.teacher_user_id, examCoord]);
      await q(`insert into publication_entries(tenant_id, publication_id, student_id, marks, max_marks) select $1, $2, sub.student_id, sub.marks, 20 from submissions sub where sub.assignment_id = $3 and sub.status = 'graded'`, [tenantId, p.id, c.assignment_id]);
      await q(`insert into official_marks(tenant_id, student_id, course_id, academic_year_id, assessment_name, marks, max_marks, publication_id) select $1, student_id, $2, $3, 'Unit Test 1', marks, max_marks, $4 from publication_entries where publication_id = $4`, [tenantId, c.id, year.id, p.id]);
    }

    // ---------- dismissal: authorized pickups and today's handovers ----------
    await q(`insert into authorized_pickups(tenant_id, student_id, full_name, relationship, id_hint, added_by)
             select $1, s.id, 'Uncle ' || s.last_name, 'uncle', lpad((abs(hashtext(s.admission_no)) % 10000)::text, 4, '0'), g.user_id
             from students s join residence_assignments ra on ra.student_id = s.id and ra.effective_to is null and ra.residence_type = 'day_scholar'
             join student_guardians sg on sg.student_id = s.id join guardians g on g.id = sg.guardian_id where ${H('s.admission_no', 100)} < 20`, T);
    const gate = await uid('gate@greenwood.demo') ?? warden;
    await q(`insert into pickup_events(tenant_id, student_id, guardian_id, collected_by_name, id_verified, recorded_by)
             select $1, s.id, g.id, g.full_name, true, $2 from students s join residence_assignments ra on ra.student_id = s.id and ra.effective_to is null and ra.residence_type = 'day_scholar'
             join student_guardians sg on sg.student_id = s.id join guardians g on g.id = sg.guardian_id where ${H("s.admission_no || 'pickup'")} < 60`, [tenantId, gate]);

    // ---------- incidents (Scenario G) ----------
    const sample = await q(`select id from students order by admission_no limit 40`);
    const inc: [string, string, string, string, string, string][] = [
      ['safety', 'medium', 'Slip on wet corridor', 'Student slipped near the science block after rain; minor bruise, first aid given.', 'closed', 'Floor mats installed; student fine.'],
      ['maintenance', 'low', 'Broken window latch in Room 203', 'Latch on east window does not close.', 'open', ''],
      ['discipline', 'medium', 'Curfew breach — Nilgiri House', 'Two students found outside the hostel at 10:20 pm.', 'investigating', ''],
      ['medical', 'high', 'Asthma episode during PE', 'Inhaler administered; parent informed; clinic follow-up arranged.', 'escalated', ''],
      ['missing_student', 'critical', 'Student unaccounted for at bedtime roll call', 'Not found in room; later located at the library. (Demo drill)', 'closed', 'Student located; supervision reinforced.'],
      ['safeguarding', 'high', 'Welfare concern raised by staff', 'Confidential concern recorded for the safeguarding officer. (Demo, restricted)', 'investigating', ''],
    ];
    for (let i = 0; i < inc.length; i++) {
      const [cat, sev, title, desc, status, closure] = inc[i];
      const officer = (await q(`select u.id from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where r.key = 'safeguarding_officer' order by u.email limit 1`))[0]?.id as string;
      const assignee = cat === 'safeguarding' ? officer : warden;
      const reporter = cat === 'safeguarding' ? officer : warden;
      const [r] = await q(`insert into incidents(tenant_id, campus_id, category, severity, title, description, student_id, reported_by, assigned_to, status, closure_note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [tenantId, campus.id, cat, sev, title, desc, sample[i * 5].id, reporter, status === 'open' ? null : assignee ?? warden, status, closure || null]);
      const events: [string, string | null][] = [['created', null]];
      if (status !== 'open') events.push(['assigned', null]);
      if (status === 'escalated') events.push(['escalated', 'Principal informed']);
      if (status === 'closed') events.push(['closed', closure]);
      for (const [action, note] of events) await q('insert into incident_events(tenant_id, incident_id, actor_user_id, action, note) values ($1,$2,$3,$4,$5)', [tenantId, r.id, warden, action, note]);
    }

    // ---------- notifications for the demo parent ----------
    const parent = await uid('parent@greenwood.demo');
    for (const [kind, title, body] of [['attendance.absent', 'Absence recorded', 'Your child was marked absent on 2026-09-18.'], ['lms.assignment', 'New assignment', 'Homework 2 is due 2026-11-05.'], ['finance.receipt', 'Payment received', 'Receipt issued (DEMO / simulated data).'], ['results.published', 'Results published', 'Unit Test 1 results are available.']])
      await q('insert into notifications(tenant_id, user_id, kind, title, body) values ($1,$2,$3,$4,$5)', [tenantId, parent, kind, title, body]);

    await audit(tx, null, tenantId, 'demo.seed.ops', 'tenant', tenantId);
    void principal;
  });
}
