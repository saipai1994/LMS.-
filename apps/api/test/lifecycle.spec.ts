import { INestApplication } from '@nestjs/common';
import { activate, adminSession, bearer, bootApp, http, login, schoolBase, userSession } from './helpers';
import { resetRateLimits } from '../src/auth/auth.service';
import { DbService } from '../src/db/db.service';

let app: INestApplication;
beforeAll(async () => { app = await bootApp(); });
afterAll(async () => { await app.close(); });
beforeEach(() => resetRateLimits());
const f = (tok: string) => ({ get: (u: string) => http(app).get(u).set(bearer(tok)), post: (u: string, b?: any) => http(app).post(u).set(bearer(tok)).send(b ?? {}), put: (u: string, b?: any) => http(app).put(u).set(bearer(tok)).send(b ?? {}) });

describe('student lifecycle', () => {
  let A: Awaited<ReturnType<typeof adminSession>>; let base: Awaited<ReturnType<typeof schoolBase>>;
  let reg: any, principal: any, acct: any, tch: any, librarian: any; let s: any[] = []; let parents: string[] = [];
  let year2: any, grade9: any, sec9: any, sec8b: any, course: any;
  const db = () => app.get(DbService);

  beforeAll(async () => {
    A = await adminSession(app, 'lifeco2');
    reg = await userSession(app, 'lifeco2', A.token, 'reg@lifeco2.test', 'registrar'); principal = await userSession(app, 'lifeco2', A.token, 'prin@lifeco2.test', 'principal');
    acct = await userSession(app, 'lifeco2', A.token, 'acct@lifeco2.test', 'accountant'); tch = await userSession(app, 'lifeco2', A.token, 'tch@lifeco2.test', 'teacher'); librarian = await userSession(app, 'lifeco2', A.token, 'lib@lifeco2.test', 'librarian');
    base = await schoolBase(app, A.token, A.campusId);
    year2 = await base.post('/academic-years', { name: '2027-28', startsOn: '2027-04-01', endsOn: '2028-03-31' });
    grade9 = await base.post('/grade-levels', { name: 'Grade 9', ordinal: 9 });
    sec9 = await base.post('/sections', { campusId: A.campusId, academicYearId: year2.id, gradeLevelId: grade9.id, name: 'A', capacity: 30 });
    sec8b = await base.post('/sections', { campusId: A.campusId, academicYearId: year2.id, gradeLevelId: base.grade.id, name: 'A', capacity: 30 });
    const maths = await base.post('/subjects', { code: 'MATH', name: 'Maths' }); const sci = await base.post('/subjects', { code: 'SCI', name: 'Science' });
    course = await base.post('/courses', { sectionId: base.section.id, subjectId: maths.id, teacherUserId: tch.userId, title: '8A Maths' });
    const course2 = await base.post('/courses', { sectionId: base.section.id, subjectId: sci.id, teacherUserId: tch.userId, title: '8A Science' });
    for (const [n, res, email] of [['Pass', 'day_scholar', 'a@example.test'], ['Fail', 'day_scholar', 'b@example.test'], ['Norez', 'day_scholar', 'c@example.test'], ['Leaver', 'boarder', 'd@example.test'], ['Dupe', 'day_scholar', 'e@example.test']] as const) {
      const adm = await base.admit(res, email, n); s.push(adm);
      await activate(app, 'lifeco2', adm.parentInviteToken!); parents.push(await login(app, 'lifeco2', email));
    }
    // approved results (setup through SQL: the grade pipeline itself is covered in lms.spec)
    await db().withTenant(A.tenantId, async (tx) => {
      const pub = (await tx.query(`insert into grade_publications(tenant_id, course_id, assessment_name, source_assignment_ids, status, submitted_by, decided_by, decided_at) values ($1,$2,'Final','{}','approved',$3,$4,now()) returning id`, [A.tenantId, course.id, tch.userId, principal.userId])).rows[0];
      const pub2 = (await tx.query(`insert into grade_publications(tenant_id, course_id, assessment_name, source_assignment_ids, status, submitted_by, decided_by, decided_at) values ($1,$2,'Final','{}','approved',$3,$4,now()) returning id`, [A.tenantId, course2.id, tch.userId, principal.userId])).rows[0];
      const put = async (st: string, cid: string, p: string, m: number) => tx.query(`insert into official_marks(tenant_id, student_id, course_id, academic_year_id, assessment_name, marks, max_marks, publication_id) values ($1,$2,$3,$4,'Final',$5,100,$6)`, [A.tenantId, st, cid, base.year.id, m, p]);
      await put(s[0].studentId, course.id, pub.id, 78); await put(s[0].studentId, course2.id, pub2.id, 66);
      await put(s[1].studentId, course.id, pub.id, 20); await put(s[1].studentId, course2.id, pub2.id, 25);
    });
  });

  it('documents: verification by a second person, expiry alerts and file access control', async () => {
    const file = (await f(reg.token).post('/files', { name: 'birth.pdf', mime: 'application/pdf', contentBase64: Buffer.from('%PDF-1.4 x').toString('base64') }).expect(201)).body;
    const soon = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    const d = (await f(reg.token).post(`/students/${s[0].studentId}/documents`, { kind: 'Passport', expiresOn: soon, fileId: file.id }).expect(201)).body;
    await f(reg.token).post(`/student-documents/${d.id}/verify`).expect(422);                    // uploader cannot self-verify
    await f(principal.token).post(`/student-documents/${d.id}/verify`).expect(404);               // principal lacks student.write
    await f(A.token).post(`/student-documents/${d.id}/verify`).expect(201);
    await f(A.token).post(`/student-documents/${d.id}/verify`).expect(409);
    expect((await f(reg.token).get('/student-documents/expiring?days=30').expect(200)).body.map((x: any) => x.kind)).toEqual(['Passport']);
    await f(parents[0]).get(`/students/${s[0].studentId}/documents`).expect(200);
    await f(parents[1]).get(`/students/${s[0].studentId}/documents`).expect(404);
    await f(parents[0]).get(`/files/${file.id}`).expect(200); await f(parents[1]).get(`/files/${file.id}`).expect(404);
    await f(tch.token).post(`/students/${s[0].studentId}/documents`, { kind: 'x1' }).expect(404);
    await f(reg.token).post(`/students/${s[0].studentId}/previous-schools`, { schoolName: 'Sunrise Public School', lastGrade: 'Grade 7', toYear: '2025' }).expect(201);
    expect((await f(reg.token).get(`/students/${s[0].studentId}/previous-schools`).expect(200)).body[0].school_name).toBe('Sunrise Public School');
  });

  it('identity corrections need a second approver and keep the old value; duplicates are flagged', async () => {
    const c = (await f(parents[0]).post(`/students/${s[0].studentId}/corrections`, { field: 'last_name', newValue: 'Testington', reason: 'Spelling error on application' }).expect(201)).body;
    await f(parents[0]).post(`/corrections/${c.id}/decision`, { decision: 'approve' }).expect(404);             // parent cannot approve
    await f(reg.token).post(`/corrections/${c.id}/decision`, { decision: 'approve' }).expect(201);
    await f(reg.token).post(`/corrections/${c.id}/decision`, { decision: 'approve' }).expect(409);
    const hist = (await f(reg.token).get(`/students/${s[0].studentId}/corrections`).expect(200)).body;
    expect(hist[0]).toMatchObject({ field: 'last_name', old_value: 'Test', new_value: 'Testington', status: 'approved' });
    const own = (await f(reg.token).post(`/students/${s[0].studentId}/corrections`, { field: 'first_name', newValue: 'Zed', reason: 'Per birth certificate' }).expect(201)).body;
    await f(reg.token).post(`/corrections/${own.id}/decision`, { decision: 'approve' }).expect(422);            // maker-checker
    await f(parents[1]).post(`/students/${s[0].studentId}/corrections`, { field: 'first_name', newValue: 'X', reason: 'not my child' }).expect(404);
    expect((await f(reg.token).get('/students/duplicates').expect(200)).body).toEqual([]);                         // distinct names: nothing flagged
    await base.admit('day_scholar', 'dup1@example.test', 'Twin'); await base.admit('day_scholar', 'dup2@example.test', 'Twin');   // 'Twin6 Test' / 'Twin7 Test', same date of birth
    const dup = (await f(reg.token).get('/students/duplicates').expect(200)).body;
    expect(dup).toHaveLength(1); expect([dup[0].a_name, dup[0].b_name].sort()).toEqual(['Twin6 Test', 'Twin7 Test']);
    expect((await f(A.token).get('/audit-log').expect(200)).body.some((l: any) => l.action === 'student.correction_approve')).toBe(true);
  });

  it('promotion: rule-based suggestions, no auto-promotion without results, history-preserving apply, alumni', async () => {
    await f(reg.token).put('/promotion/rules', { academicYearId: base.year.id, minOverallPercent: 40, minSubjectPercent: 33, maxFailedSubjects: 0 }).expect(200);
    await f(tch.token).get(`/promotion/preview?academicYearId=${base.year.id}`).expect(403);
    const pv = (await f(reg.token).get(`/promotion/preview?academicYearId=${base.year.id}`).expect(200)).body.students;
    const by = (n: string) => pv.find((x: any) => x.name.startsWith(n));
    expect(by('Pass1')).toMatchObject({ suggestion: 'promote', overallPercent: 72 });
    expect(by('Fail2')).toMatchObject({ suggestion: 'retain' }); expect(by('Fail2').reasons.join()).toMatch(/overall 22\.5%/);
    expect(by('Norez3')).toMatchObject({ suggestion: 'needs_review', overallPercent: null });
    // apply: promote Pass to grade 9, retain Fail in grade 8, graduate nobody yet
    const apply = (decisions: any[]) => f(reg.token).post('/promotion/apply', { fromAcademicYearId: base.year.id, toAcademicYearId: year2.id, effectiveFrom: '2027-04-01', decisions });
    await apply([{ studentId: s[0].studentId, action: 'promote', targetSectionId: sec8b.id }]).expect(422).expect((r: any) => expect(r.body.error).toBe('promotion_requires_higher_grade'));
    await apply([{ studentId: s[1].studentId, action: 'retain', targetSectionId: sec9.id }]).expect(422);
    await apply([{ studentId: s[0].studentId, action: 'promote' }]).expect(422);
    const ok = (await apply([{ studentId: s[0].studentId, action: 'promote', targetSectionId: sec9.id }, { studentId: s[1].studentId, action: 'retain', targetSectionId: sec8b.id }]).expect(201)).body;
    expect(ok).toEqual({ promoted: 1, retained: 1, graduated: 0 });
    const ov = (await f(parents[0]).get(`/students/${s[0].studentId}/overview`).expect(200)).body;
    expect(ov.enrollments.map((e: any) => `${e.grade}:${e.end_reason ?? 'current'}`)).toEqual(['Grade 9:current', 'Grade 8:promoted']);   // history preserved
    await f(parents[0]).post('/promotion/apply', {}).expect(403);
    // graduation → alumni, access disabled
    await db().withTenant(A.tenantId, (tx) => tx.query('select 1'));
    await apply([{ studentId: s[0].studentId, action: 'graduate' }]).expect(422);                                  // no enrolment in the *from* year any more
    expect((await f(reg.token).get('/alumni').expect(200)).body).toEqual([]);
    const g = await f(reg.token).post('/promotion/apply', { fromAcademicYearId: year2.id, toAcademicYearId: year2.id, effectiveFrom: '2028-04-01', decisions: [{ studentId: s[0].studentId, action: 'graduate' }] }).expect(201);
    expect(g.body.graduated).toBe(1);
    expect((await f(reg.token).get('/alumni').expect(200)).body.map((x: any) => x.status)).toEqual(['alumni']);
  });

  it('withdrawal workflow: approval, clearance blockers, write-off authority, history preserved, certificate escaped', async () => {
    const st = s[3]; // boarder
    await f(A.token).post(`/hostels`, { campusId: A.campusId, name: 'Block A' }).expect(201);
    const h = (await f(A.token).get('/hostels')).body[0]; await f(A.token).post(`/hostels/${h.id}/rooms`, { floor: 1, number: '101', beds: 1 }).expect(201);
    const bed = (await f(A.token).get(`/hostels/${h.id}/rooms`)).body[0].bed_id;
    await f(A.token).post('/hostel/allocations', { studentId: st.studentId, bedId: bed, effectiveFrom: '2026-04-01' }).expect(201);
    await f(A.token).post('/finance/invoices', { studentId: st.studentId, dueDate: '2026-12-01', lines: [{ description: 'Tuition', amountMinor: 100000 }] }).expect(201);
    const book = (await f(librarian.token).post('/library/books', { campusId: A.campusId, title: 'Atlas', author: 'X', barcodes: ['LC-1'] }).expect(201)).body; void book;
    await f(librarian.token).post('/library/issue', { barcode: 'LC-1', studentId: st.studentId }).expect(201);
    const today = new Date().toISOString().slice(0, 10);
    await f(parents[4]).post('/withdrawals', { studentId: st.studentId, kind: 'withdrawal', reason: 'Family relocating', effectiveDate: today }).expect(404);       // not their child
    const w = (await f(parents[3]).post('/withdrawals', { studentId: st.studentId, kind: 'transfer_out', reason: 'Family relocating abroad', destinationSchool: 'Dubai College', effectiveDate: today }).expect(201)).body;
    await f(parents[3]).post('/withdrawals', { studentId: st.studentId, kind: 'withdrawal', reason: 'duplicate request', effectiveDate: today }).expect(409);
    await f(parents[3]).post(`/withdrawals/${w.id}/decision`, { decision: 'approve' }).expect(403);
    await f(reg.token).post(`/withdrawals/${w.id}/complete`, {}).expect(409).expect((r: any) => expect(r.body.error).toBe('not_approved'));
    await f(principal.token).post(`/withdrawals/${w.id}/decision`, { decision: 'approve' }).expect(201);
    const cl = (await f(reg.token).get(`/withdrawals/${w.id}/clearance`).expect(200)).body;
    expect(cl).toMatchObject({ feesOutstandingMinor: 100000, openLibraryLoans: 1, hostelBedAssigned: true }); expect(cl.blockers).toEqual(['outstanding_fees', 'library_items_not_returned']);
    await f(reg.token).post(`/withdrawals/${w.id}/complete`, {}).expect(409).expect((r: any) => expect(r.body.blockers).toEqual(['outstanding_fees', 'library_items_not_returned']));
    await f(reg.token).post(`/withdrawals/${w.id}/complete`, { waiveOutstandingFees: true }).expect(403);       // registrar cannot write off fees
    await f(librarian.token).post('/library/return', { barcode: 'LC-1' }).expect(201);
    await f(A.token).post(`/withdrawals/${w.id}/complete`, { waiveOutstandingFees: true }).expect(201);
    const ov = (await f(A.token).get(`/students/${st.studentId}/overview`).expect(200)).body;
    expect(ov.student.status).toBe('transferred'); expect(ov.courses).toHaveLength(0);
    expect(ov.residence[0].effective_to).toBeTruthy(); expect(ov.enrollments[0].end_reason).toBe('transfer_out');
    expect((await f(A.token).get('/hostels')).body[0].occupied).toBe(0);                                          // bed released
    expect((await f(A.token).get(`/finance/students/${st.studentId}/ledger`)).body.balanceMinor).toBe(0);        // write-off recorded in the ledger
    // certificate is HTML-escaped
    await db().withTenant(A.tenantId, (tx) => tx.query(`update students set last_name = $2 where id = $1`, [st.studentId, '<script>alert(1)</script>']));
    const cert = await f(A.token).get(`/students/${st.studentId}/leaving-certificate`).expect(200);
    expect(cert.text).toContain('Dubai College'); expect(cert.text).not.toContain('<script>'); expect(cert.text).toContain('&lt;script&gt;');
    expect(cert.headers['content-security-policy']).toMatch(/default-src 'none'/);
    await f(parents[0]).get(`/students/${st.studentId}/leaving-certificate`).expect(404);
    const B = await adminSession(app, 'lifeco2-other');
    expect((await f(B.token).get('/withdrawals').expect(200)).body).toEqual([]);
    await f(B.token).get(`/withdrawals/${w.id}/clearance`).expect(404);
  });
});
