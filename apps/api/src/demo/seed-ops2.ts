/** Third seed phase: transport, library, inventory, HR/payroll, health, security, meals, activities, comms, timetable, exams. Deterministic (hashtext of stable keys). */
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';

const H = (expr: string, mod = 100) => `(abs(hashtext(${expr})) % ${mod})`;
const TITLES = ['The Jungle Book', 'Wings of Fire', 'Malgudi Days', 'Panchatantra Tales', 'A Brief History of Time', 'Gulliver’s Travels', 'Swami and Friends', 'The Story of My Experiments with Truth', 'Harry Potter and the Philosopher’s Stone', 'Charlie and the Chocolate Factory', 'The Diary of a Young Girl', 'Treasure Island', 'Alice in Wonderland', 'Tinkle Digest Anthology', 'Atlas of the World', 'Oxford Student Dictionary', 'Fun with Numbers', 'The Elements Explained', 'Indian Folk Tales', 'Journey to the Centre of the Earth'];
const AUTHORS = ['R. Kipling', 'A. P. J. Abdul Kalam', 'R. K. Narayan', 'Vishnu Sharma', 'S. Hawking', 'J. Swift', 'M. K. Gandhi', 'J. K. Rowling', 'R. Dahl', 'A. Frank', 'R. L. Stevenson', 'L. Carroll', 'A. Pai', 'National Geographic', 'Oxford Press', 'P. Verma', 'S. Rao', 'Folk collection', 'J. Verne'];
const ITEMS: [string, string, number][] = [['Whiteboard markers (box)', 'stationery', 40], ['A4 paper ream', 'stationery', 60], ['Notebooks 180pg', 'stationery', 200], ['Chalk (box)', 'stationery', 30], ['Staplers', 'stationery', 10], ['Football', 'sports', 8], ['Cricket bat', 'sports', 6], ['Badminton racket', 'sports', 10], ['Yoga mats', 'sports', 15], ['School uniform shirt M', 'uniform', 50], ['School uniform shirt L', 'uniform', 50], ['School tie', 'uniform', 80], ['Blazer S', 'uniform', 20], ['Textbook – Maths G6', 'textbook', 40], ['Textbook – Science G6', 'textbook', 40], ['Textbook – English G6', 'textbook', 40], ['Lab beakers 250ml', 'lab', 30], ['Microscope slides (box)', 'lab', 20], ['Bunsen burners', 'lab', 8], ['Safety goggles', 'lab', 40], ['Bed linen set', 'hostel', 90], ['Pillows', 'hostel', 90], ['Mosquito nets', 'hostel', 60], ['Cleaning phenyl 5L', 'housekeeping', 25], ['Hand sanitiser 500ml', 'housekeeping', 60], ['Rice 25kg', 'kitchen', 20], ['Cooking oil 15L', 'kitchen', 10], ['Dal 10kg', 'kitchen', 20], ['LED tube lights', 'maintenance', 40], ['Projector lamp', 'maintenance', 4]];
const ACTIVITIES: [string, string, number][] = [['Football', 'sport', 30], ['Cricket', 'sport', 30], ['Basketball', 'sport', 24], ['Athletics', 'sport', 40], ['Swimming', 'sport', 20], ['Chess club', 'club', 20], ['Robotics club', 'club', 18], ['Debate society', 'club', 25], ['Music & choir', 'club', 30], ['Art studio', 'club', 25], ['Science fair', 'event', 60], ['Annual day rehearsal', 'event', 80], ['Hill-station excursion', 'trip', 40]];

export async function seedOperations2(db: DbService, tenantId: string): Promise<void> {
  await db.withTenant(tenantId, async (tx) => {
    const q = async (sql: string, p: unknown[] = []) => { try { return (await tx.query(sql, p)).rows; } catch (e) { console.error(`seed-ops2 failed: ${(e as Error).message}\n  SQL: ${sql.replace(/\s+/g, ' ').slice(0, 220)}`); throw e; } };
    const T = [tenantId];
    const [campus] = await q('select id from campuses limit 1');
    const [year] = await q('select id from academic_years where is_current');
    const uid = async (email: string) => (await q('select id from users where email = $1', [email]))[0]?.id as string;
    const byRole = async (role: string) => (await q(`select u.id from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where r.key = $1 order by u.email`, [role])).map((r) => r.id as string);
    const admin = await uid('admin@greenwood.demo'), principal = await uid('principal@greenwood.demo'), transportUser = await uid('transport@greenwood.demo'), nurse = await uid('nurse@greenwood.demo');
    const librarian = await uid('librarian@greenwood.demo'), invMgr = await uid('inventory@greenwood.demo'), gate = await uid('gate@greenwood.demo'), warden = await uid('warden@greenwood.demo');
    const hr = (await byRole('hr_payroll'))[0], kitchen = (await byRole('kitchen_manager'))[0], registrar = await uid('registrar@greenwood.demo');
    const coordinators = await byRole('exam_coordinator');

    // ---------- transport ----------
    const vehicles: string[] = [], routes: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const [v] = await q(`insert into vehicles(tenant_id, campus_id, reg_no, capacity, insurance_expiry, permit_expiry, fitness_expiry) values ($1,$2,$3,40, current_date + $4::int, current_date + $5::int, current_date + $6::int) returning id`,
        [tenantId, campus.id, `KA01GW${String(1000 + i)}`, i === 3 ? 12 : 200 + i * 10, i === 6 ? -4 : 180 + i * 7, i === 9 ? 25 : 300]);
      vehicles.push(v.id);
      const [d] = await q(`insert into drivers(tenant_id, campus_id, full_name, phone, licence_no, licence_expiry) values ($1,$2,$3,$4,$5, current_date + $6::int) returning id`,
        [tenantId, campus.id, ['Ramesh Naik', 'Suresh Gowda', 'Manjunath Rao', 'Irfan Pasha', 'Dinesh Kumar', 'Raju Shetty', 'Anand Murthy', 'Basavaraj H', 'Kiran Patil', 'Sanjay Bhat'][i - 1], `+91-98450-${String(10000 + i)}`, `DL-KA-${2020 + i}-0${i}`, i === 4 ? 18 : 400 + i * 11]);
      const [r] = await q(`insert into transport_routes(tenant_id, campus_id, name, vehicle_id, driver_id, attendant_name) values ($1,$2,$3,$4,$5,$6) returning id`, [tenantId, campus.id, `Route ${i} — ${['Lakeview', 'Hillcrest', 'Market Road', 'Green Park', 'Station Road', 'Orchid Layout', 'Temple Street', 'Riverside', 'Airport Road', 'Tech Park'][i - 1]}`, v.id, d.id, ['Sita', 'Gita', 'Lakshmi', 'Meena', 'Radha', 'Uma', 'Kavitha', 'Padma', 'Sarala', 'Vimala'][i - 1]]);
      routes.push(r.id);
      for (let s = 1; s <= 4; s++) await q(`insert into route_stops(tenant_id, route_id, seq, name, pickup_time, drop_time) values ($1,$2,$3,$4,$5,$6)`, [tenantId, r.id, s, `Stop ${i}.${s}`, `0${6 + Math.floor(s / 2)}:${s % 2 ? '10' : '40'}`, `1${5 + Math.floor(s / 3)}:${s * 10}`]);
      await q(`insert into vehicle_maintenance(tenant_id, vehicle_id, kind, done_on, cost_minor, notes, next_due, recorded_by) values ($1,$2,'service', current_date - $3::int, $4, 'Routine service (demo)', current_date + $5::int, $6)`, [tenantId, v.id, 30 + i * 4, 450000 + i * 12000, 60 - i * 3, transportUser]);
    }
    await q(`create temp table _ds on commit drop as select s.id, row_number() over (order by s.admission_no) as rn from students s join residence_assignments ra on ra.student_id = s.id and ra.effective_to is null and ra.residence_type = 'day_scholar' where ${H('s.admission_no')} < 70`);
    await q(`insert into student_transport(tenant_id, student_id, route_id, stop_id, effective_from)
             select $1, d.id, r.id, (select id from route_stops where route_id = r.id and seq = 1 + (d.rn % 4)), '2026-04-01'
             from _ds d join (select id, row_number() over (order by name) - 1 as k from transport_routes) r on r.k = d.rn % 10`, T);
    await q('drop table _ds');
    await q(`create temp table _sd on commit drop as select d::date as d from generate_series(current_date - 8, current_date - 1, '1 day') d where extract(isodow from d) < 6`);
    for (const shift of ['am', 'pm']) {
      await q(`insert into trips(tenant_id, route_id, trip_date, shift, status, started_by, started_at, completed_at) select $1, r.id, _sd.d, $2, 'completed', $3, _sd.d + time '07:00', _sd.d + time '08:30' from transport_routes r cross join _sd`, [tenantId, shift, transportUser]);
      await q(`insert into trip_events(tenant_id, trip_id, student_id, event, recorded_by, at)
               select $1, t.id, st.student_id, 'boarded', $3, t.trip_date + time '07:30' from trips t join student_transport st on st.route_id = t.route_id and st.effective_to is null join students s on s.id = st.student_id where t.shift = $2 and ${H("s.admission_no || t.trip_date::text")} < 95`, [tenantId, shift, transportUser]);
      await q(`insert into trip_events(tenant_id, trip_id, student_id, event, recorded_by, at) select tenant_id, trip_id, student_id, 'dropped', recorded_by, at + interval '40 minutes' from trip_events te where te.event = 'boarded' and te.trip_id in (select id from trips where shift = $1)`, [shift]);
    }
    await q('drop table _sd');

    // ---------- library ----------
    for (let i = 0; i < 120; i++) {
      const title = i < TITLES.length * 6 ? `${TITLES[i % TITLES.length]}${i >= TITLES.length ? ` (vol. ${Math.floor(i / TITLES.length) + 1})` : ''}` : `Reference ${i}`;
      const digital = i % 17 === 0;
      const [b] = await q(`insert into books(tenant_id, campus_id, isbn, title, author, category, kind, url) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`, [tenantId, campus.id, `978-81-${String(70000 + i)}-${i % 10}`, title, AUTHORS[i % AUTHORS.length], ['Fiction', 'Science', 'History', 'Biography', 'Reference', 'Comics'][i % 6], digital ? 'digital' : 'physical', digital ? `https://library.example.test/ebooks/${i}` : null]);
      if (!digital) for (let c = 0; c < 1 + (i % 3); c++) await q(`insert into book_copies(tenant_id, book_id, barcode) values ($1,$2,$3)`, [tenantId, b.id, `GW-${String(i).padStart(4, '0')}-${c + 1}`]);
    }
    const loanCopies = await q(`select c.id from book_copies c order by c.barcode limit 45 offset 3`);
    const readers = await q(`select s.id from students s where ${H('s.admission_no || \'lib\'')} < 20 order by s.admission_no limit 45`);
    for (let i = 0; i < loanCopies.length; i++) {
      const state = i % 5; // 0,1 open on time; 2 overdue; 3 returned on time; 4 returned late with fine
      const issued = state === 2 ? 30 : state === 4 ? 40 : state === 3 ? 25 : 6;
      const due = state === 2 ? 16 : state === 4 ? 26 : state === 3 ? 11 : -8;
      const returned = state === 3 ? 12 : state === 4 ? 20 : null;
      const lateDays = state === 4 ? 6 : 0;
      await q(`insert into loans(tenant_id, copy_id, student_id, issued_on, due_on, returned_on, fine_minor, fine_settled, issued_by) values ($1,$2,$3, current_date - $4::int, current_date - $5::int, case when $6::int is null then null else current_date - $6::int end, $7, $8, $9)`,
        [tenantId, loanCopies[i].id, readers[i].id, issued, due, returned, lateDays * 200, state === 4 && i % 2 === 0, librarian]);
      if (!returned) await q(`update book_copies set status = 'issued' where id = $1`, [loanCopies[i].id]);
    }

    // ---------- inventory & procurement ----------
    const suppliers: string[] = [];
    for (const n of ['Sri Lakshmi Stationers', 'Bharat Sports Goods', 'Uniform Hub', 'City Book Depot', 'Fresh Farm Provisions', 'LabEquip India']) suppliers.push((await q('insert into suppliers(tenant_id, name, contact) values ($1,$2,$3) returning id', [tenantId, n, 'orders@supplier.example.test']))[0].id);
    const items: string[] = [];
    for (let i = 0; i < ITEMS.length; i++) {
      const [it] = await q(`insert into inventory_items(tenant_id, campus_id, sku, name, category, reorder_level, location) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [tenantId, campus.id, `SKU-${String(i + 1).padStart(3, '0')}`, ITEMS[i][0], ITEMS[i][1], ITEMS[i][2], ['Store A', 'Store B', 'Kitchen store', 'Hostel store'][i % 4]]);
      items.push(it.id);
      const stock = i % 7 === 0 ? Math.floor(ITEMS[i][2] / 2) : ITEMS[i][2] * 2 + (i % 5) * 7;   // every 7th item is below its reorder level
      await q(`insert into stock_movements(tenant_id, item_id, qty_delta, kind, ref, by_user, at) values ($1,$2,$3,'receipt','Opening stock (demo)',$4, now() - interval '60 days')`, [tenantId, items[i], stock + 20, invMgr]);
      await q(`insert into stock_movements(tenant_id, item_id, qty_delta, kind, ref, by_user, at) values ($1,$2,-20,'issue','Issued to departments (demo)',$3, now() - interval '30 days')`, [tenantId, items[i], invMgr]);
    }
    const teacher1 = await uid('teacher@greenwood.demo');
    const reqStates = ['submitted', 'submitted', 'approved', 'ordered', 'rejected'];
    for (let i = 0; i < reqStates.length; i++) {
      const [r] = await q(`insert into purchase_requisitions(tenant_id, campus_id, number, requested_by, justification, status, decided_by, decided_at) values ($1,$2,$3,$4,$5,$6, case when $6 in ('approved','ordered','rejected') then $7::uuid end, case when $6 in ('approved','ordered','rejected') then now() - interval '5 days' end) returning id`,
        [tenantId, campus.id, `PR-${String(i + 1).padStart(5, '0')}`, teacher1, ['Lab consumables for term 2', 'Sports kit for inter-house meet', 'Hostel linen replacement', 'Textbooks for new admissions', 'Premium art supplies (not needed)'][i], reqStates[i], principal]);
      for (const k of [i * 3, i * 3 + 1]) await q(`insert into requisition_lines(tenant_id, requisition_id, item_id, qty, est_unit_cost_minor) values ($1,$2,$3,$4,$5)`, [tenantId, r.id, items[k], 10 + k, 15000 + k * 1000]);
      if (reqStates[i] === 'ordered') {
        const [po] = await q(`insert into purchase_orders(tenant_id, number, requisition_id, supplier_id, total_minor, status, created_by) values ($1,'PO-00001',$2,$3,(select sum(qty * est_unit_cost_minor) from requisition_lines where requisition_id = $2),'partially_received',$4) returning id`, [tenantId, r.id, suppliers[0], invMgr]);
        await q(`insert into po_lines(tenant_id, po_id, item_id, qty, unit_cost_minor, received_qty) select $1, $2, item_id, qty, est_unit_cost_minor, qty / 2 from requisition_lines where requisition_id = $3`, [tenantId, po.id, r.id]);
        await q(`insert into stock_movements(tenant_id, item_id, qty_delta, kind, ref, by_user) select $1, item_id, qty / 2, 'receipt', 'PO-00001', $3 from requisition_lines where requisition_id = $2 and qty / 2 > 0`, [tenantId, r.id, invMgr]);
      }
    }
    await q(`insert into document_sequences(tenant_id, key, prefix, next_value) values ($1,'requisition','PR-',6), ($1,'purchase_order','PO-',2) on conflict (tenant_id, key) do update set next_value = excluded.next_value`, T);
    for (let i = 1; i <= 20; i++) await q(`insert into assets(tenant_id, campus_id, tag, name, assigned_to, purchase_cost_minor, warranty_expiry, status) values ($1,$2,$3,$4,$5,$6, current_date + $7::int, $8)`,
      [tenantId, campus.id, `AST-${String(i).padStart(3, '0')}`, ['Projector', 'Laptop', 'Smart board', 'Desktop PC', 'Printer', 'CCTV camera', 'Generator', 'Water purifier'][i % 8], ['Science lab', 'Staff room', 'Library', 'Admin office', 'Hostel office'][i % 5], 2500000 + i * 150000, i % 6 === 0 ? 20 : i % 9 === 0 ? -30 : 300 + i * 10, 'in_use']);

    // ---------- HR & payroll ----------
    const staffUsers = await q(`select distinct u.id, u.full_name from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where r.key not in ('parent','student') order by u.id`);
    const named = await q(`select u.id, u.email from users u where u.email like '%@greenwood.demo' order by u.email`);
    void named;
    let eno = 0;
    const staffIds: string[] = [];
    for (const u of staffUsers) {
      eno++;
      const [sp] = await q(`insert into staff_profiles(tenant_id, user_id, campus_id, employee_no, designation, department, join_date, contract_end, qualifications)
        values ($1,$2,$3,$4,(select r.name from roles r join user_roles ur on ur.role_id = r.id where ur.user_id = $2 limit 1), $5, $6, $7, $8) returning id`,
        [tenantId, u.id, campus.id, `GW-E${String(eno).padStart(3, '0')}`, ['Academics', 'Administration', 'Hostel', 'Operations'][eno % 4], `20${15 + (eno % 10)}-0${1 + (eno % 9)}-15`, eno % 11 === 0 ? 'now'.length ? new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10) : null : null, 'B.Ed / M.A. (demo)']);
      staffIds.push(sp.id);
      await q(`insert into salary_structures(tenant_id, staff_id, effective_from, basic_minor, allowances, deductions, created_by) values ($1,$2,'2026-04-01',$3,$4,$5,$6)`,
        [tenantId, sp.id, (30000 + (eno % 12) * 2500) * 100, JSON.stringify([{ name: 'HRA', amountMinor: 800000 }, { name: 'Transport allowance', amountMinor: 200000 }]), JSON.stringify([{ name: 'Provident fund', amountMinor: 360000 }]), hr ?? admin]);
      if (eno % 5 === 0) await q(`insert into staff_documents(tenant_id, staff_id, kind, reference, expires_on) values ($1,$2,'First-aid certificate','FA-2024',current_date + $3::int)`, [tenantId, sp.id, eno % 10 === 0 ? 25 : -10]);
    }
    await q(`create temp table _wd on commit drop as select d::date as d from generate_series(date_trunc('month', current_date - interval '1 month')::date, current_date - 1, '1 day') d where extract(isodow from d) < 6`);
    await q(`insert into staff_attendance(tenant_id, staff_id, att_date, status, marked_by) select $1, sp.id, _wd.d, case when ${H("sp.employee_no || _wd.d::text")} < 4 then 'absent' when ${H("sp.employee_no || _wd.d::text")} < 8 then 'late' else 'present' end, $2 from staff_profiles sp cross join _wd`, [tenantId, hr ?? admin]);
    await q('drop table _wd');
    for (let i = 0; i < 6; i++) await q(`insert into staff_leave_requests(tenant_id, staff_id, kind, from_date, to_date, reason, status, decided_by, decided_at) values ($1,$2,$3, current_date + $4::int, current_date + $5::int, $6, $7, case when $7 = 'requested' then null::uuid else $8::uuid end, case when $7 = 'requested' then null::timestamptz else now() end)`,
      [tenantId, staffIds[i + 3], ['casual', 'sick', 'earned', 'casual', 'unpaid', 'sick'][i], i + 2, i + 3, 'Personal (demo)', i < 3 ? 'requested' : 'approved', admin]);
    const prevMonth = (await q(`select to_char(date_trunc('month', current_date - interval '1 month'), 'YYYY-MM') m`))[0].m;
    const [run] = await q(`insert into payroll_runs(tenant_id, month, status, created_by, approved_by, approved_at, paid_at) values ($1,$2,'paid',$3,$4, now() - interval '10 days', now() - interval '8 days') returning id`, [tenantId, prevMonth, hr ?? admin, principal]);
    await q(`insert into payslips(tenant_id, run_id, staff_id, basic_minor, allowances_minor, deductions_minor, absence_days, absence_deduction_minor, net_minor, detail)
      select $1, $2, sp.id, s.basic_minor, 1000000, 360000, a.n, round((s.basic_minor + 1000000) / 30.0 * a.n), s.basic_minor + 1000000 - 360000 - round((s.basic_minor + 1000000) / 30.0 * a.n), '{"note":"demo"}'::jsonb
      from staff_profiles sp join salary_structures s on s.staff_id = sp.id join lateral (select count(*)::int n from staff_attendance x where x.staff_id = sp.id and x.status = 'absent' and to_char(x.att_date, 'YYYY-MM') = $3) a on true`, [tenantId, run.id, prevMonth]);

    // ---------- health ----------
    const kids = await q(`select s.id from students s order by s.admission_no`);
    const complaints = ['Headache', 'Stomach ache', 'Minor cut on knee', 'Fever', 'Sprained ankle', 'Nausea', 'Sore throat', 'Asthma episode'];
    const outcomes = ['returned_to_class', 'rested', 'rested', 'sent_home', 'referred', 'returned_to_class', 'returned_to_class', 'sent_home'];
    for (let i = 0; i < 30; i++) await q(`insert into clinic_visits(tenant_id, student_id, visited_at, complaint, treatment, outcome, recorded_by) values ($1,$2, now() - ($3 || ' days')::interval - ($4 || ' hours')::interval, $5, 'Assessed and treated per protocol (demo)', $6, $7)`,
      [tenantId, kids[(i * 9) % kids.length].id, i % 12, i % 7, complaints[i % 8], outcomes[i % 8], nurse]);
    for (let i = 0; i < 5; i++) {
      const [m] = await q(`insert into medications(tenant_id, student_id, name, dose, schedule, start_date, end_date, guardian_consent, prescribed_by) values ($1,$2,$3,$4,$5, current_date - 5, current_date + 10, true, 'Dr. Mehra (demo)') returning id`, [tenantId, kids[i * 41 + 5].id, ['Salbutamol inhaler', 'Cetirizine', 'Amoxicillin', 'Iron supplement', 'Insulin (supervised)'][i], ['2 puffs', '10 mg', '500 mg', '1 tablet', 'as per chart'][i], ['as needed', 'nightly', 'three times daily', 'daily', 'before meals'][i]]);
      for (let d = 1; d <= 3; d++) await q(`insert into medication_log(tenant_id, medication_id, given_at, given_by, note) values ($1,$2, now() - ($3 || ' days')::interval, $4, 'Given (demo)')`, [tenantId, m.id, d, nurse]);
    }
    for (const [n, qty, exp] of [['Paracetamol 500mg', 200, 300], ['ORS sachets', 80, 20], ['Antiseptic solution', 15, 120], ['Bandages (roll)', 60, 400], ['Cough syrup', 12, -5], ['Antacid tablets', 90, 45], ['Burn cream', 10, 200], ['Thermometer strips', 100, 365]] as [string, number, number][])
      await q(`insert into medicine_stock(tenant_id, campus_id, name, qty, expires_on) values ($1,$2,$3,$4, current_date + $5::int)`, [tenantId, campus.id, n, qty, exp]);
    for (let i = 0; i < 4; i++) await q(`insert into counselling_referrals(tenant_id, student_id, referred_by, reason, status, confidential_notes) values ($1,$2,$3,$4,$5,$6)`, [tenantId, kids[i * 53 + 11].id, teacher1, ['Difficulty adjusting after joining', 'Exam anxiety', 'Friendship conflict', 'Homesickness (boarder)'][i], ['open', 'scheduled', 'closed', 'open'][i], i === 0 ? null : 'Session notes recorded by counsellor (demo, confidential).']);
    for (let i = 0; i < 25; i++) await q(`insert into dietary_flags(tenant_id, student_id, tag, added_by) values ($1,$2,$3,$4) on conflict do nothing`, [tenantId, kids[i * 11 + 2].id, ['peanut', 'dairy', 'gluten', 'vegetarian', 'egg', 'halal', 'vegan', 'shellfish'][i % 8], nurse]);

    // ---------- security ----------
    for (let i = 1; i <= 12; i++) await q(`insert into visitors(tenant_id, campus_id, kind, full_name, phone, purpose, host, id_type, id_last4, badge_no, checked_in_at, checked_out_at, checked_in_by) values ($1,$2,$3,$4,'+91-90000-00000',$5,$6,$7,$8,$9, now() - ($10 || ' hours')::interval, case when $11 then null else now() - ($10 || ' hours')::interval + interval '45 minutes' end, $12)`,
      [tenantId, campus.id, ['visitor', 'contractor', 'vendor', 'guardian'][i % 4], ['Rahul Bansal', 'Priya Nambiar', 'Electrician Raju', 'Courier – BlueDart', 'Mr. Kapoor', 'Plumber Sunil', 'Vendor – Uniform Hub', 'Auditor visit', 'Mrs. D’Souza', 'Photographer', 'Pest control', 'Guest speaker'][i - 1], ['Meeting', 'Repairs', 'Delivery', 'Parent visit', 'Audit', 'Workshop'][i % 6], ['Principal', 'Admin office', 'Store', 'Warden'][i % 4], ['Aadhaar', 'Driving licence', 'Voter ID'][i % 3], String(1000 + i * 37).slice(-4), `V-${String(i).padStart(2, '0')}`, i * 2, i > 9, gate]);
    for (const [kind, ago] of [['fire', 45], ['evacuation', 120]] as [string, number][]) await q(`insert into drills(tenant_id, campus_id, kind, started_at, completed_at, headcount_expected, headcount_assembled, notes, started_by) values ($1,$2,$3, now() - ($4 || ' days')::interval, now() - ($4 || ' days')::interval + interval '9 minutes', 380, 380, 'All accounted for in 9 minutes (demo).', $5)`, [tenantId, campus.id, kind, ago, gate]);

    // ---------- meals ----------
    const menuPlan = [['breakfast', 'Idli, sambar, chutney; milk', ['dairy', 'soy']], ['lunch', 'Rice, dal, mixed vegetable curry, curd, roti', ['gluten', 'dairy']], ['snack', 'Fruit chaat and biscuits', ['gluten']], ['dinner', 'Chapati, paneer butter masala, jeera rice', ['gluten', 'dairy']]] as [string, string, string[]][];
    for (let d = -2; d <= 6; d++) for (const [ml, items_, tags] of menuPlan)
      await q(`insert into menus(tenant_id, campus_id, menu_date, meal, items, allergen_tags, nutrition_note) values ($1,$2,current_date + $3::int,$4,$5,$6,'Approx. 550 kcal (demo)')`, [tenantId, campus.id, d, ml, d % 3 === 0 && ml === 'lunch' ? 'Chicken biryani, raita, salad' : items_, d % 3 === 0 && ml === 'lunch' ? ['meat', 'dairy'] : tags]);
    await q(`insert into meal_attendance(tenant_id, student_id, meal_date, meal, recorded_by) select $1, s.id, current_date - 1, m.meal, $2 from students s join residence_assignments ra on ra.student_id = s.id and ra.effective_to is null and ra.residence_type = 'boarder' cross join (values ('breakfast'),('lunch'),('dinner')) m(meal) where ${H("s.admission_no || m.meal")} < 92`, [tenantId, kitchen ?? warden]);

    // ---------- activities ----------
    const coachPool = (await byRole('teacher')).slice(0, 13);
    const actIds: string[] = [];
    for (let i = 0; i < ACTIVITIES.length; i++) actIds.push((await q(`insert into activities(tenant_id, campus_id, name, kind, capacity, coach_user_id, requires_consent, starts_on) values ($1,$2,$3,$4,$5,$6,true,current_date - 30) returning id`, [tenantId, campus.id, ACTIVITIES[i][0], ACTIVITIES[i][1], ACTIVITIES[i][2], coachPool[i % coachPool.length]]))[0].id);
    await q(`insert into activity_registrations(tenant_id, activity_id, student_id, status, consent_by, consent_at)
             select $1, a.id, s.id, 'registered', (select g.user_id from student_guardians sg join guardians g on g.id = sg.guardian_id where sg.student_id = s.id limit 1), now() - interval '20 days'
             from students s join (select id, row_number() over (order by name) - 1 as k from activities) a on ${H("s.admission_no || a.id::text")} < 11 where s.status = 'active'`, T);
    await q(`update activity_registrations r set status = 'waitlisted' from (select x.id, x.rn, a.capacity from (select id, activity_id, row_number() over (partition by activity_id order by created_at, id) rn from activity_registrations) x join activities a on a.id = x.activity_id) y where y.id = r.id and y.rn > y.capacity`);
    await q(`insert into activity_attendance(tenant_id, activity_id, student_id, session_date, present) select $1, r.activity_id, r.student_id, d.d::date, ${H("r.student_id::text || d.d::text")} < 85 from activity_registrations r cross join generate_series(current_date - 21, current_date - 1, '7 days') d(d) where r.status = 'registered'`, T);
    for (let i = 0; i < 12; i++) await q(`insert into awards(tenant_id, student_id, activity_id, title, awarded_on, awarded_by) values ($1,$2,$3,$4, current_date - $5::int, $6)`, [tenantId, kids[i * 23 + 7].id, actIds[i % actIds.length], ['Inter-house football winners', 'Best debater', 'Science fair gold', 'Chess runner-up', 'Athletics 100m champion', 'Choir lead', 'Art exhibition selection', 'Robotics innovation award', 'Sportsmanship award', 'Swimming relay gold', 'Cricket player of the match', 'Volunteer of the term'][i], 10 + i * 6, coachPool[i % coachPool.length]]);

    // ---------- calendar, PTM ----------
    for (const [title, kind, s, e] of [['Diwali break', 'vacation', 20, 26], ['Mid-term examinations', 'exam', -10, -4], ['Parent-teacher meeting', 'ptm', 6, 6], ['Annual sports day', 'event', 30, 30], ['Founders’ Day', 'holiday', 14, 14], ['Science fair', 'event', 40, 41], ['Hill-station excursion', 'trip', 50, 52], ['Term 2 fee deadline', 'deadline', 9, 9], ['Winter vacation', 'vacation', 75, 90], ['Children’s Day celebrations', 'event', 33, 33]] as [string, string, number, number][])
      await q(`insert into calendar_events(tenant_id, campus_id, title, kind, starts_on, ends_on, created_by) values ($1,$2,$3,$4,current_date + $5::int,current_date + $6::int,$7)`, [tenantId, campus.id, title, kind, s, e, admin]);
    const tchrs = await byRole('teacher');
    for (let i = 0; i < 20; i++) await q(`insert into ptm_slots(tenant_id, teacher_user_id, starts_at, ends_at) values ($1,$2, date_trunc('day', now()) + interval '6 days 9 hours' + ($3 || ' minutes')::interval, date_trunc('day', now()) + interval '6 days 9 hours' + ($3::int + 15 || ' minutes')::interval)`, [tenantId, tchrs[Math.floor(i / 5)], (i % 5) * 15]);

    // ---------- communications & tickets ----------
    for (const [title, body, aud, pr, status] of [['Welcome back to Term 2', 'We look forward to a wonderful term. Please check the updated calendar. (Demo)', 'all', 'normal', 'sent'], ['Parent-teacher meeting this Saturday', 'Book your slot from the dashboard. (Demo)', 'parents', 'normal', 'sent'], ['Staff meeting Monday 8:00', 'Agenda circulated by email (not configured). (Demo)', 'staff', 'normal', 'sent'], ['Heavy rain advisory', 'Day scholars: school ends at noon today. (Demo drill)', 'parents', 'emergency', 'sent'], ['Annual day rehearsal schedule', 'Rehearsals begin next week. (Demo)', 'students', 'normal', 'scheduled']] as [string, string, string, string, string][])
      await q(`insert into announcements(tenant_id, title, body, audience_type, channels, priority, scheduled_for, status, created_by, sent_at, recipients) values ($1,$2,$3,$4,'{in_app}',$5, case when $6 = 'scheduled' then now() + interval '2 days' end, $6, $7, case when $6 = 'sent' then now() - interval '3 days' end, case when $6 = 'sent' then 200 end)`, [tenantId, title, body, aud, pr, status, admin]);
    for (const [key, ch, body] of [['fee_reminder', 'sms', 'Dear {{parent}}, fees of {{amount}} are due on {{date}}.'], ['absence_alert', 'in_app', '{{student}} was absent on {{date}}.'], ['leave_approved', 'in_app', 'Leave for {{student}} has been approved until {{date}}.'], ['welcome', 'email', 'Welcome to Greenwood, {{parent}}. Your login is {{email}}.']])
      await q(`insert into message_templates(tenant_id, key, channel, subject, body) values ($1,$2,$3,$4,$5)`, [tenantId, key, ch, key.replace('_', ' '), body]);
    const parentUser = await uid('parent@greenwood.demo');
    const tks: [string, string, string, string, number][] = [['fees', 'Query about late fee', 'Please explain the late fee on invoice INV-000012.', 'open', 30], ['transport', 'Bus pickup time change', 'Can the pickup move 10 minutes later?', 'in_progress', 20], ['complaint', 'Canteen food quality', 'The snack portions were small this week.', 'open', -5], ['academic', 'Request extra practice for fractions', 'My child is struggling with fractions.', 'resolved', 50], ['hostel', 'Laundry not returned', 'Two uniforms missing from the laundry batch.', 'open', 3], ['other', 'Update emergency contact', 'Please update the secondary contact number.', 'resolved', 60], ['request', 'Certificate request', 'Bonafide certificate required for passport.', 'in_progress', 40], ['complaint', 'Hostel noise at night', 'Noise after lights-out on 2nd floor.', 'open', -20]];
    for (const [cat, subj, body, status, slaHours] of tks) await q(`insert into tickets(tenant_id, requester_id, category, subject, body, status, assigned_to, sla_due_at, resolved_at, created_at) values ($1,$2,$3,$4,$5,$6, case when $6 <> 'open' then $7::uuid end, now() + ($8 || ' hours')::interval, case when $6 = 'resolved' then now() - interval '1 day' end, now() - interval '2 days')`, [tenantId, parentUser, cat, subj, body, status, registrar, slaHours]);

    // ---------- timetable (conflict-free greedy) ----------
    const periods: string[] = [];
    for (const [seq, name, st, en, br] of [[1, 'Period 1', '08:30', '09:15', false], [2, 'Period 2', '09:15', '10:00', false], [3, 'Short break', '10:00', '10:15', true], [4, 'Period 3', '10:15', '11:00', false], [5, 'Period 4', '11:00', '11:45', false], [6, 'Lunch', '11:45', '12:30', true], [7, 'Period 5', '12:30', '13:15', false], [8, 'Period 6', '13:15', '14:00', false]] as [number, string, string, string, boolean][])
      periods.push((await q(`insert into periods(tenant_id, seq, name, start_time, end_time, is_break) values ($1,$2,$3,$4,$5,$6) returning id`, [tenantId, seq, name, st, en, br]))[0].id);
    const teachingPeriods = periods.filter((_, i) => ![2, 5].includes(i));
    const secs = await q(`select s.id, g.name as grade, s.name from sections s join grade_levels g on g.id = s.grade_level_id order by g.ordinal, s.name`);
    const courseRows = await q(`select c.id, c.section_id, c.teacher_user_id from courses c join subjects sub on sub.id = c.subject_id order by c.section_id, sub.code`);
    const bySection = new Map<string, { id: string; teacher: string }[]>();
    for (const c of courseRows) { const a = bySection.get(c.section_id) ?? []; a.push({ id: c.id, teacher: c.teacher_user_id }); bySection.set(c.section_id, a); }
    const busy = new Set<string>(); const remaining = new Map<string, number>();
    for (const [, cs] of bySection) cs.forEach((c, i) => remaining.set(c.id, i < 6 ? 4 : 3));
    for (let day = 1; day <= 5; day++) for (let p = 0; p < teachingPeriods.length; p++) for (let si = 0; si < secs.length; si++) {
      const cs = bySection.get(secs[si].id)!;
      const pick = cs.filter((c) => (remaining.get(c.id) ?? 0) > 0 && !busy.has(`${day}:${p}:${c.teacher}`)).sort((x, y) => (remaining.get(y.id)! - remaining.get(x.id)!) || (x.id < y.id ? -1 : 1))[0];
      if (!pick) continue;
      busy.add(`${day}:${p}:${pick.teacher}`); remaining.set(pick.id, remaining.get(pick.id)! - 1);
      await q(`insert into timetable_slots(tenant_id, section_id, day_of_week, period_id, course_id, room) values ($1,$2,$3,$4,$5,$6)`, [tenantId, secs[si].id, day, teachingPeriods[p], pick.id, `Room ${secs[si].grade.replace('Grade ', '')}${secs[si].name}`]);
    }

    // ---------- examinations: Mid-term for grades 1-3 (English, Maths, Science), approved & published ----------
    const [ex] = await q(`insert into exams(tenant_id, academic_year_id, name, starts_on, ends_on) values ($1,$2,'Mid-term 2026', current_date - 12, current_date - 8) returning id`, [tenantId, year.id]);
    const examCourses = await q(`select c.id, c.section_id, c.teacher_user_id, sub.code, g.ordinal, s.name as sec from courses c join subjects sub on sub.id = c.subject_id join sections s on s.id = c.section_id join grade_levels g on g.id = s.grade_level_id where g.ordinal <= 3 and sub.code in ('ENG','MATH','SCI') order by g.ordinal, s.name, sub.code`);
    const approver = coordinators[0] ?? principal;
    for (const c of examCourses) {
      const dayOff = c.code === 'ENG' ? 12 : c.code === 'MATH' ? 11 : 10;
      const [p] = await q(`insert into exam_papers(tenant_id, exam_id, course_id, paper_date, start_time, duration_min, room, max_marks, status, submitted_by, decided_by) values ($1,$2,$3, current_date - $4::int, '09:00', 90, $5, 50, 'approved', $6, $7) returning id`, [tenantId, ex.id, c.id, dayOff, `Hall ${c.ordinal}${c.sec}`, c.teacher_user_id, approver]);
      await q(`insert into exam_marks(tenant_id, paper_id, student_id, marks, absent, entered_by) select $1, $2, ce.student_id, 20 + ${H("s.admission_no || $4", 31)}, false, $3 from course_enrollments ce join students s on s.id = ce.student_id where ce.course_id = $5 and ce.status = 'active'`, [tenantId, p.id, c.teacher_user_id, c.code, c.id]);
      await q(`insert into exam_seating(tenant_id, paper_id, student_id, seat_no) select $1, $2, m.student_id, row_number() over (order by s.admission_no) from exam_marks m join students s on s.id = m.student_id where m.paper_id = $2`, [tenantId, p.id]);
      const [pub] = await q(`insert into grade_publications(tenant_id, course_id, assessment_name, source_assignment_ids, status, submitted_by, decided_by, decided_at) values ($1,$2,'Mid-term 2026','{}','approved',$3,$4, now() - interval '6 days') returning id`, [tenantId, c.id, c.teacher_user_id, approver]);
      await q(`insert into publication_entries(tenant_id, publication_id, student_id, marks, max_marks) select $1, $2, student_id, marks, 50 from exam_marks where paper_id = $3`, [tenantId, pub.id, p.id]);
      await q(`insert into official_marks(tenant_id, student_id, course_id, academic_year_id, assessment_name, marks, max_marks, publication_id) select $1, student_id, $2, $3, 'Mid-term 2026', marks, 50, $4 from exam_marks where paper_id = $5`, [tenantId, c.id, year.id, pub.id, p.id]);
    }

    await audit(tx, null, tenantId, 'demo.seed.ops2', 'tenant', tenantId);
  });
}
