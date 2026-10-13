/**
 * Deterministic, idempotent demo seed: "Greenwood International Academy" (fictional).
 * All names, emails (@greenwood.demo / example.test) and phone numbers are synthetic.
 * Covers modules implemented so far; other modules are listed in docs/KNOWN_LIMITATIONS.md.
 */
import { DbService } from '../db/db.service';
import { hashPassword, sha256 } from '../common/crypto';
import { SYSTEM_ROLES } from '../common/permissions';
import { audit } from '../common/audit';

export const DEMO_SLUG = 'greenwood';
export const DEMO_PASSWORD = 'Demo-Passw0rd!2026';
/** Demo-only TOTP secret shared by privileged demo accounts (generate codes with `npm run demo:code`). */
export const DEMO_MFA_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function rng(seed: number) { // mulberry32
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const FIRST_M = ['Aarav', 'Vihaan', 'Arjun', 'Kabir', 'Ishaan', 'Reyansh', 'Rohan', 'Dev', 'Kian', 'Neil', 'Samar', 'Yash', 'Veer', 'Ayaan', 'Nikhil'];
const FIRST_F = ['Anaya', 'Diya', 'Meera', 'Saanvi', 'Isha', 'Tara', 'Kavya', 'Riya', 'Zoya', 'Nisha', 'Aditi', 'Pooja', 'Leela', 'Myra', 'Sana'];
const LAST = ['Sharma', 'Iyer', 'Nair', 'Khan', 'Mehta', 'Reddy', 'Das', 'Kapoor', 'Menon', 'Bose', 'Pillai', 'Joshi', 'Rao', 'Sethi', 'Gill', 'Banerjee', 'Chopra', 'Naidu', 'Verma', 'Thomas'];
const SUBJECTS: [string, string][] = [['ENG', 'English'], ['MATH', 'Mathematics'], ['SCI', 'Science'], ['SST', 'Social Studies'], ['HIN', 'Hindi'], ['CS', 'Computer Science'], ['ART', 'Art'], ['PE', 'Physical Education']];

export interface SeedResult { created: boolean; students: number; guardians: number; staff: number; sections: number; courses: number }

export async function seedDemo(db: DbService): Promise<SeedResult> {
  const [existing] = await db.raw('select id from tenants where slug = $1', [DEMO_SLUG]);
  if (existing) {
    const c = await counts(db, existing.id);
    return { created: false, ...c };
  }
  const pwHash = await hashPassword(DEMO_PASSWORD);
  const R = rng(20260401);
  const [t] = await db.raw("insert into tenants(slug, name, branding) values ($1,'Greenwood International Academy (DEMO)', $2) returning id",
    [DEMO_SLUG, JSON.stringify({ demo: true, primaryColor: '#1b5e20' })]);
  await db.withTenant(t.id, async (tx) => {
    const q = async (sql: string, p: unknown[] = []) => (await tx.query(sql, p)).rows;
    const { 0: campus } = await q("insert into campuses(tenant_id, code, name, is_boarding) values ($1,'GIA-MAIN','Greenwood Main Campus',true) returning id", [t.id]);
    const roleId: Record<string, string> = {};
    for (const r of SYSTEM_ROLES) {
      const [row] = await q('insert into roles(tenant_id, key, name, is_system) values ($1,$2,$3,true) returning id', [t.id, r.key, r.name]);
      roleId[r.key] = row.id;
      for (const p of r.permissions) await q('insert into role_permissions(tenant_id, role_id, permission) values ($1,$2,$3)', [t.id, row.id, p]);
    }
    await q(`insert into document_sequences(tenant_id, key, prefix, next_value) values ($1,'student_admission_no','GIA-',1)`, [t.id]);

    const PRIV = new Set(['group_admin', 'campus_admin', 'principal', 'admissions_officer', 'nurse', 'accountant']);
    const addUser = async (email: string, name: string, role: string, withCampus: boolean) => {
      const [u] = await q(`insert into users(tenant_id, email, full_name, status, password_hash, mfa_secret, mfa_enabled) values ($1,$2,$3,'active',$4,$5,$6) returning id`,
        [t.id, email, name, pwHash, PRIV.has(role) ? DEMO_MFA_SECRET : null, PRIV.has(role)]);
      await q('insert into user_roles(tenant_id, user_id, role_id, campus_id) values ($1,$2,$3,$4)', [t.id, u.id, roleId[role], role === 'group_admin' ? null : (withCampus ? campus.id : null)]);
      return u.id as string;
    };

    // --- Staff: 60 accounts. First entries are the documented demo logins.
    const named: [string, string, string][] = [
      ['admin', 'Meenakshi Raghavan (Group Admin)', 'group_admin'], ['principal', 'Dr. Suresh Nambiar', 'principal'],
      ['admissions', 'Farah Siddiqui', 'admissions_officer'], ['accountant', 'Harish Pandey', 'accountant'],
      ['teacher', 'Lakshmi Krishnan', 'teacher'], ['warden', 'Rakesh Thakur', 'warden'], ['transport', 'Imran Qureshi', 'transport'],
      ['nurse', 'Sister Grace Mathew', 'nurse'], ['librarian', 'Anita Deshpande', 'librarian'], ['inventory', 'Pradeep Kulkarni', 'inventory_manager'],
      ['registrar', 'Neha Bhatia', 'registrar'], ['campusadmin', 'Vikram Oberoi', 'campus_admin'],
    ];
    const teachers: string[] = [];
    let staffCount = 0;
    for (const [local, name, role] of named) {
      const id = await addUser(`${local}@greenwood.demo`, name, role, true);
      staffCount++;
      if (role === 'teacher') teachers.push(id);
    }
    const extraRoles = ['teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'teacher', 'warden', 'warden', 'nurse', 'security_staff', 'security_staff', 'kitchen_manager', 'hr_payroll', 'exam_coordinator', 'lms_admin', 'safeguarding_officer', 'auditor', 'transport', 'transport', 'transport', 'accountant', 'librarian', 'inventory_manager']; // 52 -> 64? trimmed below
    let n = 0;
    for (const role of extraRoles) {
      if (staffCount >= 60) break;
      n++;
      const name = `${FIRST_M[n % 15]} ${LAST[(n * 7) % 20]}`;
      const id = await addUser(`staff${String(n).padStart(2, '0')}@greenwood.demo`, name, role, true);
      staffCount++;
      if (role === 'teacher') teachers.push(id);
    }

    // --- Calendar, grades, sections, subjects, courses
    const [year] = await q("insert into academic_years(tenant_id, name, starts_on, ends_on, is_current) values ($1,'2026-27','2026-04-01','2027-03-31',true) returning id", [t.id]);
    const grades: { id: string; n: number }[] = [];
    for (let g = 1; g <= 12; g++) grades.push({ id: (await q('insert into grade_levels(tenant_id, name, ordinal) values ($1,$2,$3) returning id', [t.id, `Grade ${g}`, g]))[0].id, n: g });
    const subjectIds: string[] = [];
    for (const [code, name] of SUBJECTS) subjectIds.push((await q('insert into subjects(tenant_id, code, name) values ($1,$2,$3) returning id', [t.id, code, name]))[0].id);
    const sections: { id: string; grade: number; name: string; count: number }[] = [];
    let ti = 0, courses = 0;
    for (const g of grades) for (const s of ['A', 'B']) {
      const ct = teachers[ti++ % teachers.length];
      const [sec] = await q('insert into sections(tenant_id, campus_id, academic_year_id, grade_level_id, name, capacity, class_teacher_user_id) values ($1,$2,$3,$4,$5,30,$6) returning id', [t.id, campus.id, year.id, g.id, s, ct]);
      sections.push({ id: sec.id, grade: g.n, name: s, count: 0 });
      for (let k = 0; k < subjectIds.length; k++) {
        await q('insert into courses(tenant_id, section_id, subject_id, teacher_user_id, title) values ($1,$2,$3,$4,$5)',
          [t.id, sec.id, subjectIds[k], teachers[(ti + k) % teachers.length], `${SUBJECTS[k][1]} — Grade ${g.n}${s}`]);
        courses++;
      }
    }

    // --- Students (300) and families (250 guardian accounts; first 50 families have two children)
    const perGrade = [25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25]; // 300 total
    let boarders = 0, sIdx = 0, famIdx = 0;
    const gradeStudents: { grade: number; section: typeof sections[number]; idx: number }[] = [];
    for (const g of grades) for (let i = 0; i < perGrade[g.n - 1]; i++) gradeStudents.push({ grade: g.n, section: sections.find((x) => x.grade === g.n && x.name === (i % 2 ? 'B' : 'A'))!, idx: sIdx++ });
    let guardianCount = 0;
    const familyOf: string[] = [];
    // families: assign students consecutively; pair students (2k, 2k+1) for the first 50 families, rest singles
    let cursor = 0;
    const pendingGuardian = async (surname: string, idx: number) => {
      const email = `parent${String(idx + 1).padStart(3, '0')}@example.test`;
      const isDemoParent = idx === 0;
      const [u] = await q(`insert into users(tenant_id, email, full_name, status, password_hash) values ($1,$2,$3,'active',$4) returning id`, [t.id, isDemoParent ? 'parent@greenwood.demo' : email, `${FIRST_M[(idx * 3) % 15]} ${surname}`, pwHash]);
      await q(`insert into user_roles(tenant_id, user_id, role_id) values ($1,$2,$3)`, [t.id, u.id, roleId['parent']]);
      const [g] = await q('insert into guardians(tenant_id, user_id, full_name, phone, email) values ($1,$2,$3,$4,$5) returning id',
        [t.id, u.id, `${FIRST_M[(idx * 3) % 15]} ${surname}`, `+91-90000-${String(10000 + idx).slice(-5)}`, isDemoParent ? 'parent@greenwood.demo' : email]);
      guardianCount++;
      return g.id as string;
    };
    let demoStudentUser: string | null = null;
    while (cursor < gradeStudents.length) {
      const sibling = famIdx < 50 && cursor + 1 < gradeStudents.length;
      const kids = gradeStudents.slice(cursor, cursor + (sibling ? 2 : 1));
      const surname = LAST[Math.floor(R() * 20)];
      const gid = await pendingGuardian(surname, famIdx);
      for (const k of kids) {
        const female = R() < 0.5;
        const first = (female ? FIRST_F : FIRST_M)[Math.floor(R() * 15)];
        const dob = `${2026 - (5 + k.grade) - (R() < 0.5 ? 0 : 1)}-${String(1 + Math.floor(R() * 12)).padStart(2, '0')}-${String(1 + Math.floor(R() * 28)).padStart(2, '0')}`;
        const wantsBoarding = k.grade >= 6 && k.idx % 2 === 0 && boarders < 80;
        if (wantsBoarding) boarders++;
        const admNo = `GIA-${String(k.idx + 1).padStart(5, '0')}`;
        const [st] = await q(`insert into students(tenant_id, campus_id, admission_no, first_name, last_name, date_of_birth, gender) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
          [t.id, campus.id, admNo, first, surname, dob, female ? 'F' : 'M']);
        await q('insert into student_guardians(tenant_id, student_id, guardian_id, relationship, is_primary, can_pickup) values ($1,$2,$3,$4,true,true)', [t.id, st.id, gid, female ? 'father' : 'mother']);
        await q('insert into enrollments(tenant_id, student_id, section_id, academic_year_id, effective_from) values ($1,$2,$3,$4,$5)', [t.id, st.id, k.section.id, year.id, '2026-04-01']);
        await q('insert into residence_assignments(tenant_id, student_id, residence_type, effective_from) values ($1,$2,$3,$4)', [t.id, st.id, wantsBoarding ? 'boarder' : 'day_scholar', '2026-04-01']);
        await q('insert into course_enrollments(tenant_id, course_id, student_id) select $1::uuid, id, $2::uuid from courses where section_id = $3', [t.id, st.id, k.section.id]);
        k.section.count++;
        if (k.idx === 130 && !demoStudentUser) { // Grade 6 student with her own login
          const [u] = await q(`insert into users(tenant_id, email, full_name, status, password_hash) values ($1,'student@greenwood.demo',$2,'active',$3) returning id`, [t.id, `${first} ${surname}`, pwHash]);
          await q('insert into user_roles(tenant_id, user_id, role_id) values ($1,$2,$3)', [t.id, u.id, roleId['student']]);
          await q('update students set user_id = $2 where id = $1', [st.id, u.id]);
          demoStudentUser = u.id;
        }
        if (k.idx === 7) await q(`insert into student_medical_alerts(tenant_id, student_id, alert, severity) values ($1,$2,'Severe peanut allergy (epinephrine auto-injector in clinic)','critical')`, [t.id, st.id]);
      }
      cursor += kids.length; famIdx++;
      void familyOf;
    }
    await q(`update document_sequences set next_value = $2 where tenant_id = $1 and key = 'student_admission_no'`, [t.id, sIdx + 1]);

    // --- Admission pipeline (Scenario A): one accepted applicant ready to enrol, others at earlier stages
    const g7 = grades.find((g) => g.n === 7)!;
    const apps: [string, string, string, string, string][] = [
      ['Advait', 'Kulkarni', 'accepted', 'boarder', 'advait.parent@example.test'], ['Mira', 'Fernandes', 'offered', 'day_scholar', 'mira.parent@example.test'],
      ['Zayan', 'Ahmed', 'under_review', 'day_scholar', 'zayan.parent@example.test'], ['Tanvi', 'Shetty', 'submitted', 'boarder', 'tanvi.parent@example.test'],
      ['Kunal', 'Arora', 'waitlisted', 'day_scholar', 'kunal.parent@example.test'],
    ];
    for (const [f, l, status, res, em] of apps)
      await q(`insert into admission_applications(tenant_id, campus_id, academic_year_id, grade_level_id, applicant_first_name, applicant_last_name, applicant_dob, guardian_name, guardian_email, guardian_phone, residence_preference, status)
               values ($1,$2,$3,$4,$5,$6,'2014-08-15',$7,$8,'+91-98000-00000',$9,$10)`, [t.id, campus.id, year.id, g7.id, f, l, `Parent of ${f} ${l}`, em, res, status]);
    await audit(tx, null, t.id, 'demo.seed', 'tenant', t.id, null, { students: sIdx, guardians: guardianCount });
  });
  return { created: true, ...(await counts(db, t.id)) };
}

async function counts(db: DbService, tenantId: string) {
  return db.withTenant(tenantId, async (tx) => {
    const n = async (sql: string) => (await tx.query(sql)).rows[0].n as number;
    return {
      students: await n('select count(*)::int n from students'), guardians: await n('select count(*)::int n from guardians'),
      staff: await n(`select count(distinct ur.user_id)::int n from user_roles ur join roles r on r.id = ur.role_id where r.key not in ('parent','student')`),
      sections: await n('select count(*)::int n from sections'), courses: await n('select count(*)::int n from courses'),
    };
  });
}
