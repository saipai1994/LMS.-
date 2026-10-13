import { INestApplication } from '@nestjs/common';
import { activate, adminSession, bearer, bootApp, http, login, schoolBase, userSession } from './helpers';
import { resetRateLimits } from '../src/auth/auth.service';
import { DbService } from '../src/db/db.service';

let app: INestApplication;
beforeAll(async () => { app = await bootApp(); });
afterAll(async () => { await app.close(); });
beforeEach(() => resetRateLimits());
const f = (tok: string) => ({ get: (u: string) => http(app).get(u).set(bearer(tok)), post: (u: string, b?: any) => http(app).post(u).set(bearer(tok)).send(b ?? {}), put: (u: string, b?: any) => http(app).put(u).set(bearer(tok)).send(b ?? {}) });
const day = (o: number) => new Date(Date.now() + o * 86400000).toISOString().slice(0, 10);

describe('dismissal rules, hostel upkeep and consent forms', () => {
  let A: Awaited<ReturnType<typeof adminSession>>; let base: Awaited<ReturnType<typeof schoolBase>>;
  let gate: any, warden: any, reg: any, classTeacher: any, other: any; let s1: any, s2: any, b1: any; let p1: string, p2: string, pb: string;
  beforeAll(async () => {
    A = await adminSession(app, 'dismco');
    gate = await userSession(app, 'dismco', A.token, 'gate@dismco.test', 'security_staff'); warden = await userSession(app, 'dismco', A.token, 'warden@dismco.test', 'warden');
    reg = await userSession(app, 'dismco', A.token, 'reg@dismco.test', 'registrar'); classTeacher = await userSession(app, 'dismco', A.token, 'ct@dismco.test', 'teacher'); other = await userSession(app, 'dismco', A.token, 'other@dismco.test', 'teacher');
    base = await schoolBase(app, A.token, A.campusId);
    base.section.id = (await base.post('/sections', { campusId: A.campusId, academicYearId: base.year.id, gradeLevelId: base.grade.id, name: 'B', capacity: 30, classTeacherUserId: classTeacher.userId })).id;
    s1 = await base.admit('day_scholar', 'd1@example.test', 'Dee'); s2 = await base.admit('day_scholar', 'd2@example.test', 'Dan'); b1 = await base.admit('boarder', 'b1@example.test', 'Bo');
    for (const [x, set] of [[s1, (v: string) => (p1 = v)], [s2, (v: string) => (p2 = v)], [b1, (v: string) => (pb = v)]] as const) { await activate(app, 'dismco', x.parentInviteToken!); set(await login(app, 'dismco', x === s1 ? 'd1@example.test' : x === s2 ? 'd2@example.test' : 'b1@example.test')); }
  });

  it('dismissal time gates early release; class teacher approves; late pickups notify and escalate once', async () => {
    const guardianId = (await f(gate.token).get(`/students/${s1.studentId}/pickup-list`).expect(200)).body.guardians[0].id;
    const ho = () => f(gate.token).post('/dismissal/handover', { studentId: s1.studentId, guardianId, idVerified: true });
    await f(reg.token).put(`/campuses/${A.campusId}/settings`, { dismissalTime: '23:59' }).expect(403);                              // campus.manage needed
    await f(A.token).put(`/campuses/${A.campusId}/settings`, { dismissalTime: '23:59', lateGraceMinutes: 0, lateEscalateMinutes: 1, timezone: 'Asia/Kolkata' }).expect(200);
    await ho().expect(422).expect((r: any) => expect(r.body.error).toBe('early_dismissal_not_approved'));
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });   // the campus day, as the server sees it
    await f(p2).post('/dismissal/early-requests', { studentId: s1.studentId, forDate: today, pickupTime: '10:00', reason: 'Dentist' }).expect(404);          // not their child
    await f(pb).post('/dismissal/early-requests', { studentId: b1.studentId, forDate: today, pickupTime: '10:00', reason: 'Home' }).expect(422);            // boarders use leave
    const er = (await f(p1).post('/dismissal/early-requests', { studentId: s1.studentId, forDate: today, pickupTime: '10:00', reason: 'Dentist appointment' }).expect(201)).body;
    await f(p1).post('/dismissal/early-requests', { studentId: s1.studentId, forDate: today, pickupTime: '11:00', reason: 'again' }).expect(409);
    await f(p1).post(`/dismissal/early-requests/${er.id}/decision`, { decision: 'approve' }).expect(404);                                   // guardian cannot approve
    await f(other.token).post(`/dismissal/early-requests/${er.id}/decision`, { decision: 'approve' }).expect(404);                          // not the class teacher
    await f(classTeacher.token).post(`/dismissal/early-requests/${er.id}/decision`, { decision: 'approve' }).expect(201);
    expect((await f(p1).get('/notifications')).body.some((n: any) => n.kind === 'dismissal.early_decision')).toBe(true);
    await ho().expect(201);                                                                                                                 // released early with approval
    // late pickup: s2 never collected, dismissal 23:59 → only late once time passes; use a past time to trigger
    await f(A.token).put(`/campuses/${A.campusId}/settings`, { dismissalTime: '00:00' }).expect(200);
    const late = (await f(gate.token).get('/dismissal/late').expect(200)).body;
    expect(late.map((l: any) => l.name.split(' ')[0])).toEqual(['Dan2']);                                                                  // s1 was collected; boarder excluded
    const n1 = (await f(gate.token).post('/dismissal/late/notify').expect(201)).body;
    expect(n1).toMatchObject({ late: 1, notified: 1, escalated: 1 });
    expect((await f(gate.token).post('/dismissal/late/notify').expect(201)).body).toMatchObject({ notified: 0, escalated: 0 });            // once per day
    expect((await f(p2).get('/notifications')).body.some((n: any) => n.kind === 'dismissal.late')).toBe(true);
    expect((await f(warden.token).get('/incidents').expect(200)).body.some((i: any) => /Uncollected student/.test(i.title))).toBe(true);
  });

  it('hostel maintenance, inspections raise requests, vacation roster', async () => {
    const h = (await f(A.token).post('/hostels', { campusId: A.campusId, name: 'Block B' }).expect(201)).body;
    const room = (await f(A.token).post(`/hostels/${h.id}/rooms`, { floor: 1, number: '201', beds: 2 }).expect(201)).body;
    await f(gate.token).post('/hostel/maintenance', { hostelId: h.id, description: 'Leaking tap', priority: 'low' }).expect(403);
    const m = (await f(warden.token).post('/hostel/maintenance', { hostelId: h.id, roomId: room.id, description: 'Fan not working in room 201', priority: 'urgent' }).expect(201)).body;
    await f(warden.token).post(`/hostel/maintenance/${m.id}/update`, { status: 'assigned' }).expect(422);
    await f(warden.token).post(`/hostel/maintenance/${m.id}/update`, { status: 'assigned', assignedTo: 'Electrician Raju' }).expect(201);
    await f(warden.token).post(`/hostel/maintenance/${m.id}/update`, { status: 'done', note: 'Replaced capacitor' }).expect(201);
    await f(warden.token).post(`/hostel/maintenance/${m.id}/update`, { status: 'done' }).expect(409);
    expect((await f(warden.token).get('/hostel/inspections/overdue').expect(200)).body.map((r: any) => r.room)).toEqual(['201']);
    const insp = (await f(warden.token).post(`/hostels/rooms/${room.id}/inspections`, { score: 2, issues: 'Damp wall, untidy lockers' }).expect(201)).body;
    expect(insp.maintenanceRequestId).toBeTruthy();                                                                                          // poor score raises a request
    expect((await f(warden.token).post(`/hostels/rooms/${room.id}/inspections`, { score: 5 }).expect(201)).body.maintenanceRequestId).toBeNull();
    expect((await f(warden.token).get('/hostel/inspections/overdue').expect(200)).body).toEqual([]);
    const open = (await f(warden.token).get('/hostel/maintenance').expect(200)).body;
    expect(open.map((x: any) => x.status)).toEqual(['open', 'done']);                                                                        // open items first
    // vacation plans
    await f(pb).post('/hostel/vacation-plans', { studentId: b1.studentId, fromDate: day(10), toDate: day(30), arrangement: 'school_stay', contact: 'Warden on duty' }).expect(201);
    await f(pb).post('/hostel/vacation-plans', { studentId: b1.studentId, fromDate: day(20), toDate: day(40), arrangement: 'home', contact: 'Dad' }).expect(409);   // overlapping plans
    await f(p1).post('/hostel/vacation-plans', { studentId: s1.studentId, fromDate: day(10), toDate: day(30), arrangement: 'home', contact: 'x y z' }).expect(422);
    const roster = (await f(warden.token).get(`/hostel/vacation-roster?date=${day(15)}`).expect(200)).body;
    expect(roster.staying.map((s: any) => s.first_name)).toEqual(['Bo3']); expect(roster.noPlan).toEqual([]);
    expect((await f(warden.token).get(`/hostel/vacation-roster?date=${day(60)}`).expect(200)).body.noPlan.map((s: any) => s.first_name)).toEqual(['Bo3']);
  });

  it('consent forms: audience targeting, per-child evidence, no double response, reminders', async () => {
    await f(p1).post('/consents', { title: 'Trip consent', body: 'I consent to my child joining the trip.', audienceType: 'all' }).expect(404);
    const form = (await f(reg.token).post('/consents', { title: 'Museum trip consent', body: 'I allow my child to attend the museum trip on the stated date.', audienceType: 'section', audienceRef: base.section.id, dueOn: day(5) }).expect(201)).body;
    expect(form.students).toBe(3);                                                                                                           // all three students are in section B
    const mine = (await f(p1).get('/consents/mine').expect(200)).body;
    expect(mine).toHaveLength(1); expect(mine[0]).toMatchObject({ student: 'Dee1 Test', response: null });
    await f(p1).post(`/consents/${form.id}/respond`, { studentId: s2.studentId, decision: 'agree', signedName: 'Mr Someone', confirm: true }).expect(404);   // another family's child
    await f(p1).post(`/consents/${form.id}/respond`, { studentId: s1.studentId, decision: 'agree', signedName: 'Mr Dee', confirm: false }).expect(400);
    await f(p1).post(`/consents/${form.id}/respond`, { studentId: s1.studentId, decision: 'agree', signedName: 'Mr Dee', confirm: true }).expect(201);
    await f(p1).post(`/consents/${form.id}/respond`, { studentId: s1.studentId, decision: 'decline', signedName: 'Mr Dee', confirm: true }).expect(409);   // evidence cannot be changed
    await f(p2).post(`/consents/${form.id}/respond`, { studentId: s2.studentId, decision: 'decline', signedName: 'Mrs Dan', confirm: true }).expect(201);
    const st = (await f(reg.token).get(`/consents/status/${form.id}`).expect(200)).body;
    expect(st).toMatchObject({ total: 3, agreed: 1, declined: 1 }); expect(st.outstanding.map((o: any) => o.name)).toEqual(['Bo3 Test']);
    expect((await f(reg.token).post(`/consents/${form.id}/remind`).expect(201)).body.reminded).toBe(1);
    expect((await f(pb).get('/notifications')).body.some((n: any) => n.kind === 'consent.reminder')).toBe(true);
    expect((await f(p1).get('/notifications')).body.some((n: any) => n.kind === 'consent.reminder')).toBe(false);
    await f(p1).get(`/consents/status/${form.id}`).expect(404);
    await f(reg.token).post(`/consents/${form.id}/close`).expect(201);
    await f(pb).post(`/consents/${form.id}/respond`, { studentId: b1.studentId, decision: 'agree', signedName: 'Mr Bo', confirm: true }).expect(409);
    expect((await f(A.token).get('/audit-log').expect(200)).body.filter((l: any) => l.action === 'consent.respond')).toHaveLength(2);
    const B = await adminSession(app, 'dismco-other');
    expect((await f(B.token).get('/consents').expect(200)).body).toEqual([]);
  });
});

describe('advanced learning and report cards', () => {
  let A: Awaited<ReturnType<typeof adminSession>>; let base: Awaited<ReturnType<typeof schoolBase>>;
  let t1: any, t2: any, coord: any; let course: any, subj: any; let s: any[] = []; let st1: string, st2: string; let p: string[] = [];
  beforeAll(async () => {
    A = await adminSession(app, 'advco');
    t1 = await userSession(app, 'advco', A.token, 't1@advco.test', 'teacher'); t2 = await userSession(app, 'advco', A.token, 't2@advco.test', 'teacher'); coord = await userSession(app, 'advco', A.token, 'coord@advco.test', 'exam_coordinator');
    base = await schoolBase(app, A.token, A.campusId);
    subj = await base.post('/subjects', { code: 'MATH', name: 'Maths' });
    course = await base.post('/courses', { sectionId: base.section.id, subjectId: subj.id, teacherUserId: t1.userId, title: '8A Maths' });
    for (const [n, email] of [['Ace', 'ace@example.test'], ['Bob', 'bob@example.test'], ['Cat', 'cat@example.test']]) { const x = await base.admit('day_scholar', email, n); s.push(x); await activate(app, 'advco', x.parentInviteToken!); p.push(await login(app, 'advco', email)); }
    for (const [i, em] of [[0, 'ace.s@advco.test'], [1, 'bob.s@advco.test']] as const) { const acc = (await f(A.token).post(`/students/${s[i].studentId}/account`, { email: em }).expect(201)).body; await activate(app, 'advco', acc.inviteToken); const tok = await login(app, 'advco', em); if (i === 0) st1 = tok; else st2 = tok; }
  });

  it('moderated discussions: student posts wait for approval and are visible only to the author until then', async () => {
    const th = (await f(t1.token).post(`/courses/${course.id}/threads`, { title: 'Fractions help' }).expect(201)).body;
    await f(t2.token).post(`/courses/${course.id}/threads`, { title: 'Hijack' }).expect(404);
    await f(p[2]).get(`/courses/${course.id}/threads`).expect(404);
    expect((await f(st1).get(`/courses/${course.id}/threads`).expect(200)).body).toHaveLength(1);
    const post = (await f(st1).post(`/threads/${th.id}/posts`, { body: 'How do I add 1/2 and 1/3?' }).expect(201)).body;
    expect(post.status).toBe('pending');
    expect((await f(st1).get(`/threads/${th.id}`).expect(200)).body.posts).toHaveLength(1);                     // author sees their pending post
    expect((await f(st2).get(`/threads/${th.id}`).expect(200)).body.posts).toHaveLength(0);                     // classmates do not
    await f(st2).post(`/posts/${post.id}/moderate`, { action: 'approve' }).expect(404);
    await f(t1.token).post(`/posts/${post.id}/moderate`, { action: 'approve' }).expect(201);
    expect((await f(st2).get(`/threads/${th.id}`).expect(200)).body.posts[0].body).toMatch(/1\/2/);
    expect((await f(t1.token).post(`/threads/${th.id}/posts`, { body: 'Use a common denominator.' }).expect(201)).body.status).toBe('approved');
    const bad = (await f(st2).post(`/threads/${th.id}/posts`, { body: 'inappropriate content' }).expect(201)).body;
    await f(t1.token).post(`/posts/${bad.id}/moderate`, { action: 'remove' }).expect(201);
    expect((await f(st1).get(`/threads/${th.id}`)).body.posts).toHaveLength(2);
  });

  it('competencies keep history; plans and at-risk detection; portfolio; analytics', async () => {
    const k = (await f(A.token).post('/competencies', { subjectId: subj.id, code: 'MATH.FRAC.1', description: 'Adds fractions with unlike denominators' }).expect(201)).body;
    await f(t2.token).post('/competency-assessments', { studentId: s[0].studentId, competencyId: k.id, level: 2, evidence: 'Quiz 1' }).expect(404);          // not their teacher
    await f(t1.token).post('/competency-assessments', { studentId: s[0].studentId, competencyId: k.id, level: 2, evidence: 'Quiz 1: partial method' }).expect(201);
    await f(t1.token).post('/competency-assessments', { studentId: s[0].studentId, competencyId: k.id, level: 4, evidence: 'Project: full mastery' }).expect(201);
    const c = (await f(p[0]).get(`/students/${s[0].studentId}/competencies`).expect(200)).body;
    expect(c).toHaveLength(1); expect(c[0]).toMatchObject({ levelName: 'mastered', assessments: 2 });
    await f(p[1]).get(`/students/${s[0].studentId}/competencies`).expect(404);
    // assignments → at-risk
    const mk = (title: string, due: number) => f(t1.token).post(`/courses/${course.id}/assignments`, { title, instructions: 'x', dueAt: new Date(Date.now() + due * 86400000).toISOString(), maxMarks: 10, published: true }).expect(201);
    const a1 = (await mk('HW1', -3)).body, a2 = (await mk('HW2', -2)).body;
    await f(st1).put(`/assignments/${a1.id}/submission`, { answerText: 'ok', submit: true }).expect(200); await f(st1).put(`/assignments/${a2.id}/submission`, { answerText: 'ok', submit: true }).expect(200);
    for (const a_ of [a1, a2]) { const sub = (await f(t1.token).get(`/assignments/${a_.id}/submissions`)).body.find((x: any) => x.student_id === s[0].studentId); await f(t1.token).post(`/submissions/${sub.submission_id}/grade`, { marks: 9 }).expect(201); }
    const risk = (await f(t1.token).get(`/courses/${course.id}/at-risk`).expect(200)).body;
    expect(risk.map((r: any) => r.first_name).sort()).toEqual(['Bob2', 'Cat3']);                                  // missing two overdue assignments each; Ace is fine
    await f(t2.token).get(`/courses/${course.id}/at-risk`).expect(404);
    const plan = (await f(t1.token).post('/learning-plans', { studentId: s[1].studentId, courseId: course.id, kind: 'remedial', goal: 'Catch up on missing homework and fractions basics', startsOn: day(0), endsOn: day(21) }).expect(201)).body;
    await f(t2.token).post('/learning-plans', { studentId: s[1].studentId, courseId: course.id, kind: 'remedial', goal: 'Not my class at all', startsOn: day(0), endsOn: day(5) }).expect(404);
    expect((await f(p[1]).get('/notifications')).body.some((n: any) => n.kind === 'learning.plan')).toBe(true);
    expect((await f(p[1]).get(`/students/${s[1].studentId}/learning-plans`).expect(200)).body).toHaveLength(1);
    await f(p[0]).get(`/students/${s[1].studentId}/learning-plans`).expect(404);
    await f(t1.token).post(`/learning-plans/${plan.id}/close`, { status: 'completed', outcome: 'All homework up to date; quiz 70%' }).expect(201);
    await f(t1.token).post(`/learning-plans/${plan.id}/close`, { status: 'completed', outcome: 'again again' }).expect(409);
    // portfolio
    const e = (await f(st1).post('/me/portfolio', { title: 'Fraction poster', reflection: 'I learned to find common denominators by drawing.' }).expect(201)).body;
    await f(t1.token).post(`/portfolio/${e.id}/comment`, { comment: 'Great visual explanation!' }).expect(201);
    await f(t2.token).post(`/portfolio/${e.id}/comment`, { comment: 'I do not teach this child' }).expect(404);
    expect((await f(p[0]).get(`/students/${s[0].studentId}/portfolio`).expect(200)).body[0]).toMatchObject({ title: 'Fraction poster', teacher_comment: 'Great visual explanation!' });
    await f(p[1]).get(`/students/${s[0].studentId}/portfolio`).expect(404);
    // analytics
    const an = (await f(t1.token).get(`/courses/${course.id}/analytics`).expect(200)).body;
    expect(an).toMatchObject({ students: 3, assignments: 2, averageGradePercent: 90 });
    expect(an.submissionRatePercent).toBeCloseTo(33.3, 1);
    await f(t2.token).get(`/courses/${course.id}/analytics`).expect(404);
  });

  it('report card HTML, rank list, transcript, remarks and HTML escaping', async () => {
    const { DbService: Db } = await import('../src/db/db.service');
    await app.get(Db).withTenant(A.tenantId, async (tx) => {
      const pub = (await tx.query(`insert into grade_publications(tenant_id, course_id, assessment_name, source_assignment_ids, status, submitted_by, decided_by, decided_at) values ($1,$2,'Term <1>','{}','approved',$3,$4,now()) returning id`, [A.tenantId, course.id, t1.userId, coord.userId])).rows[0];
      for (const [i, m] of [[0, 90], [1, 60], [2, 90]] as const) await tx.query(`insert into official_marks(tenant_id, student_id, course_id, academic_year_id, assessment_name, marks, max_marks, publication_id) values ($1,$2,$3,$4,'Term <1>',$5,100,$6)`, [A.tenantId, s[i].studentId, course.id, base.year.id, m, pub.id]);
      await tx.query(`update students set first_name = $2 where id = $1`, [s[0].studentId, '<img src=x onerror=alert(1)>']);
    });
    await f(p[2]).get(`/students/${s[0].studentId}/report-card.html`).expect(404);
    await f(t2.token).post(`/students/${s[0].studentId}/remarks`, { academicYearId: base.year.id, remark: 'Not my student' }).expect(404);
    await f(t1.token).post(`/students/${s[0].studentId}/remarks`, { academicYearId: base.year.id, remark: 'Works consistently and helps classmates.' }).expect(201);
    const html = await f(p[0]).get(`/students/${s[0].studentId}/report-card.html`).expect(200);
    expect(html.headers['content-type']).toMatch(/text\/html/); expect(html.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(html.text).toContain('Term &lt;1&gt;'); expect(html.text).toContain('&lt;img src=x'); expect(html.text).not.toContain('<img src=x'); expect(html.text).toContain('Works consistently');
    expect(html.text).toContain('90%'); expect(html.text).toContain('grade A');
    await f(p[1]).get(`/students/${s[2].studentId}/report-card.html`).expect(404);
    const secId = (await f(A.token).get('/sections')).body[0].id;
    await f(p[0]).get(`/sections/${secId}/rank-list`).expect(404);
    const rank = (await f(coord.token).get(`/sections/${secId}/rank-list`).expect(200)).body;
    expect(rank.map((r: any) => [r.rank, r.percent])).toEqual([[1, 90], [1, 90], [3, 60]]);                           // ties share a rank
    const tr = (await f(p[1]).get(`/students/${s[1].studentId}/transcript`).expect(200)).body;
    expect(tr.years[0]).toMatchObject({ year: '2026-27', overallPercent: 60 });
    await f(t1.token).get(`/students/${s[1].studentId}/transcript`).expect(404);                                      // teachers do not get transcripts
    await f(p[0]).get(`/students/${s[1].studentId}/transcript`).expect(404);
  });
});
