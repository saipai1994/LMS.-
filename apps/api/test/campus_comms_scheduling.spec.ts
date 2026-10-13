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

describe('meals, activities, calendar', () => {
  let A: Awaited<ReturnType<typeof adminSession>>; let base: Awaited<ReturnType<typeof schoolBase>>;
  let kitchen: any, coach: any, nurse: any; let s1: any, s2: any, s3: any; let p1: string, p2: string;
  beforeAll(async () => {
    A = await adminSession(app, 'lifeco');
    kitchen = await userSession(app, 'lifeco', A.token, 'kitchen@lifeco.test', 'kitchen_manager');
    coach = await userSession(app, 'lifeco', A.token, 'coach@lifeco.test', 'teacher');
    nurse = await userSession(app, 'lifeco', A.token, 'nurse@lifeco.test', 'nurse');
    base = await schoolBase(app, A.token, A.campusId);
    s1 = await base.admit('boarder', 'l1@example.test', 'Pia'); s2 = await base.admit('boarder', 'l2@example.test', 'Quin'); s3 = await base.admit('day_scholar', 'l3@example.test', 'Ravi');
    await activate(app, 'lifeco', s1.parentInviteToken); p1 = await login(app, 'lifeco', 'l1@example.test');
    await activate(app, 'lifeco', s2.parentInviteToken); p2 = await login(app, 'lifeco', 'l2@example.test');
  });

  it('menus, dietary conflict alerts, headcount that excludes boarders on leave', async () => {
    const today = day(0);
    await f(coach.token).post('/meals/menus', { campusId: A.campusId, date: today, meal: 'lunch', items: 'Peanut chutney sandwich, fruit', allergenTags: ['peanut', 'gluten'] }).expect(403);
    await f(kitchen.token).post('/meals/menus', { campusId: A.campusId, date: today, meal: 'lunch', items: 'Peanut chutney sandwich, fruit', allergenTags: ['peanut', 'gluten'] }).expect(201);
    await f(p1).post(`/students/${s1.studentId}/dietary-flags`, { tags: ['peanut'] }).expect(201);
    await f(p1).post(`/students/${s2.studentId}/dietary-flags`, { tags: ['peanut'] }).expect(404);          // not their child
    await f(nurse.token).post(`/students/${s2.studentId}/dietary-flags`, { tags: ['vegetarian'] }).expect(201);
    const hc = (await f(kitchen.token).get(`/meals/headcount?date=${today}&meal=lunch`).expect(200)).body;
    expect(hc).toMatchObject({ expected: 2, served: 0 });
    expect(hc.allergenAlerts.map((x: any) => x.conflicts)).toEqual([['peanut']]);                            // vegetarian is fine with this menu
    const served = (await f(kitchen.token).post('/meals/attendance', { date: today, meal: 'lunch', studentIds: [s2.studentId] }).expect(201)).body;
    expect(served.dietaryConflictsServed).toEqual([]);
    const bad = (await f(kitchen.token).post('/meals/attendance', { date: today, meal: 'lunch', studentIds: [s1.studentId] }).expect(201)).body;
    expect(bad.dietaryConflictsServed).toEqual([s1.studentId]);                                                  // flagged, not silently allowed
    await f(kitchen.token).post('/meals/menus', { campusId: A.campusId, date: today, meal: 'dinner', items: 'Chicken curry', allergenTags: ['meat'] }).expect(201);
    expect((await f(kitchen.token).get(`/meals/headcount?date=${today}&meal=dinner`)).body.allergenAlerts.map((x: any) => x.conflicts)).toEqual([['meat']].map(() => ['vegetarian']).map((c) => c));
    expect((await f(p1).get(`/meals/headcount?date=${today}&meal=lunch`)).status).toBe(403);
    expect((await f(p1).get(`/meals/menus?from=${today}&to=${today}`).expect(200)).body).toHaveLength(2);   // menus are public to the school community
  });

  it('activities: consent, capacity, waitlist promotion, coach-only attendance, awards', async () => {
    const act = (await f(coach.token).post('/activities', { campusId: A.campusId, name: 'Chess club', kind: 'club', capacity: 1 }).expect(201)).body;
    await f(coach.token).post(`/activities/${act.id}/register`, { studentId: s1.studentId }).expect(422);       // consent needed
    expect((await f(p1).post(`/activities/${act.id}/register`, { studentId: s1.studentId }).expect(201)).body.status).toBe('registered');
    await f(p1).post(`/activities/${act.id}/register`, { studentId: s1.studentId }).expect(409);
    expect((await f(p2).post(`/activities/${act.id}/register`, { studentId: s2.studentId }).expect(201)).body.status).toBe('waitlisted');
    await f(p2).post(`/activities/${act.id}/register`, { studentId: s1.studentId }).expect(404);
    await f(coach.token).post(`/activities/${act.id}/attendance`, { date: day(0), entries: [{ studentId: s2.studentId, present: true }] }).expect(422);   // waitlisted ≠ registered
    await f(coach.token).post(`/activities/${act.id}/attendance`, { date: day(0), entries: [{ studentId: s1.studentId, present: true }] }).expect(201);
    await f(kitchen.token).post(`/activities/${act.id}/attendance`, { date: day(0), entries: [{ studentId: s1.studentId, present: true }] }).expect(404);
    const w = (await f(p1).post(`/activities/${act.id}/withdraw`, { studentId: s1.studentId }).expect(201)).body;
    expect(w.promotedFromWaitlist).toBe(s2.studentId);
    expect((await f(p2).get('/notifications')).body.some((n: any) => n.kind === 'activities.promoted')).toBe(true);
    await f(coach.token).post('/awards', { studentId: s2.studentId, activityId: act.id, title: 'Chess champion', awardedOn: day(0) }).expect(201);
    const prof = (await f(p2).get(`/students/${s2.studentId}/activities`).expect(200)).body;
    expect(prof.awards[0].title).toBe('Chess champion'); expect(prof.registrations[0]).toMatchObject({ name: 'Chess club', status: 'registered' });
    await f(p1).get(`/students/${s2.studentId}/activities`).expect(404);
  });

  it('calendar and parent-teacher meeting booking rules', async () => {
    await f(coach.token).post('/calendar', { title: 'Diwali break', kind: 'vacation', startsOn: day(20), endsOn: day(25) }).expect(403);
    await f(A.token).post('/calendar', { title: 'Diwali break', kind: 'vacation', startsOn: day(20), endsOn: day(25) }).expect(201);
    expect((await f(p1).get(`/calendar?from=${day(0)}&to=${day(30)}`).expect(200)).body).toHaveLength(1);
    // the coach teaches nobody's child yet → PTM booking must be refused until they do
    const maths = await base.post('/subjects', { code: 'M', name: 'Maths' });
    const sec = (await f(A.token).get('/sections').expect(200)).body[0];
    await base.post('/courses', { sectionId: sec.id, subjectId: maths.id, teacherUserId: coach.userId, title: '8A Maths' });
    const slot = (await f(coach.token).post('/ptm/slots', { startsAt: new Date(Date.now() + 5 * 86400000).toISOString(), minutes: 15 }).expect(201)).body;
    await f(coach.token).post('/ptm/slots', { startsAt: slot.starts_at, minutes: 15 }).expect(409);            // double-booking own time
    await f(p1).post(`/ptm/slots/${slot.id}/book`, { studentId: s2.studentId }).expect(404);
    await f(p1).post(`/ptm/slots/${slot.id}/book`, { studentId: s1.studentId }).expect(201);
    await f(p2).post(`/ptm/slots/${slot.id}/book`, { studentId: s2.studentId }).expect(409);
    expect((await f(p2).get('/ptm/slots').expect(200)).body).toHaveLength(0);                                      // taken slots are hidden from others
    await f(p2).post(`/ptm/slots/${slot.id}/cancel`).expect(404);
    await f(p1).post(`/ptm/slots/${slot.id}/cancel`).expect(201);
    expect((await f(p2).get('/ptm/slots').expect(200)).body).toHaveLength(1);
    const B = await adminSession(app, 'lifeco-other');
    expect((await f(B.token).get('/activities').expect(200)).body).toEqual([]);
    expect((await f(B.token).get(`/calendar`).expect(200)).body).toEqual([]);
  });
});

describe('communications & tickets', () => {
  let A: Awaited<ReturnType<typeof adminSession>>; let base: Awaited<ReturnType<typeof schoolBase>>;
  let reg: any, tch: any; let s1: any, s2: any; let p1: string, p2: string;
  beforeAll(async () => {
    A = await adminSession(app, 'commsco');
    reg = await userSession(app, 'commsco', A.token, 'reg@commsco.test', 'registrar');
    tch = await userSession(app, 'commsco', A.token, 'tch@commsco.test', 'teacher');
    base = await schoolBase(app, A.token, A.campusId);
    const sec2 = await base.post('/sections', { campusId: A.campusId, academicYearId: base.year.id, gradeLevelId: base.grade.id, name: 'B', capacity: 30 });
    s1 = await base.admit('day_scholar', 'c1@example.test', 'Uma'); s2 = await base.admit('day_scholar', 'c2@example.test', 'Vik');
    await f(A.token).post(`/students/${s2.studentId}/section-transfer`, { sectionId: sec2.id, effectiveFrom: '2026-05-01' }).expect(201);
    await activate(app, 'commsco', s1.parentInviteToken); p1 = await login(app, 'commsco', 'c1@example.test');
    await activate(app, 'commsco', s2.parentInviteToken); p2 = await login(app, 'commsco', 'c2@example.test');
    base.section.id = (await f(A.token).get('/sections').expect(200)).body.find((s: any) => s.name === 'A').id;
  });

  it('audience targeting, delivery honesty for email/SMS, preferences and emergency override', async () => {
    await f(tch.token).post('/announcements', { title: 'Hello', body: 'World', audienceType: 'all' }).expect(403);
    await f(reg.token).post('/announcements', { title: 'Section notice', body: 'Class A trip form due', audienceType: 'section' }).expect(422);
    const r = (await f(reg.token).post('/announcements', { title: 'Class A trip', body: 'Trip form due Friday', audienceType: 'section', audienceRef: base.section.id, channels: ['in_app', 'email'] }).expect(201)).body;
    expect(r).toMatchObject({ status: 'sent', recipients: 1 });                                                     // parent of the one student in section A
    expect((await f(p1).get('/notifications')).body.some((n: any) => n.title === 'Class A trip')).toBe(true);
    expect((await f(p2).get('/notifications')).body.some((n: any) => n.title === 'Class A trip')).toBe(false);
    const d = (await f(reg.token).get(`/announcements/${r.id}/delivery`).expect(200)).body;
    expect(d.external).toEqual([{ channel: 'email', status: 'not_configured', n: 1 }]);
    expect(d.note).toMatch(/NOT delivered/);
    // opt-out is respected for ordinary announcements, overridden for emergencies
    await f(p2).post('/me/notification-prefs', { channel: 'in_app', enabled: false }).expect(201);
    await f(reg.token).post('/announcements', { title: 'Newsletter', body: 'Monthly newsletter', audienceType: 'parents' }).expect(201);
    expect((await f(p2).get('/notifications')).body.some((n: any) => n.title === 'Newsletter')).toBe(false);
    expect((await f(p1).get('/notifications')).body.some((n: any) => n.title === 'Newsletter')).toBe(true);
    await f(reg.token).post('/announcements', { title: 'Emergency', body: 'Early closure due to storm', audienceType: 'parents', priority: 'emergency', scheduledFor: new Date(Date.now() + 3600000).toISOString() }).expect(422);
    await f(reg.token).post('/announcements', { title: 'Storm closure', body: 'School closes at noon', audienceType: 'parents', priority: 'emergency' }).expect(201);
    expect((await f(p2).get('/notifications')).body.some((n: any) => n.kind === 'announcement.emergency')).toBe(true);
  });

  it('scheduled announcements only dispatch when due', async () => {
    const soon = new Date(Date.now() + 3600_000).toISOString();
    const s = (await f(reg.token).post('/announcements', { title: 'PTM reminder', body: 'PTM next week', audienceType: 'staff', scheduledFor: soon }).expect(201)).body;
    expect(s.status).toBe('scheduled');
    expect((await f(reg.token).post('/announcements/dispatch-due').expect(201)).body.dispatched).toBe(0);
    await app.get(DbService).withTenant(A.tenantId, (tx) => tx.query(`update announcements set scheduled_for = now() - interval '1 minute' where id = $1`, [s.id]));
    expect((await f(reg.token).post('/announcements/dispatch-due').expect(201)).body.dispatched).toBe(1);
    expect((await f(tch.token).get('/notifications')).body.some((n: any) => n.title === 'PTM reminder')).toBe(true);
    await f(reg.token).post('/announcements/dispatch-due').expect(201).expect((r: any) => expect(r.body.dispatched).toBe(0));
    const later = (await f(reg.token).post('/announcements', { title: 'Cancel me', body: 'Not needed', audienceType: 'all', scheduledFor: soon }).expect(201)).body;
    await f(reg.token).post(`/announcements/${later.id}/cancel`).expect(201);
    await f(reg.token).post(`/announcements/${later.id}/cancel`).expect(409);
  });

  it('templates render with variables and refuse missing ones', async () => {
    await f(reg.token).post('/templates', { key: 'fee_reminder', channel: 'sms', body: 'Dear {{parent}}, fees of {{amount}} are due on {{date}}.' }).expect(201);
    const ok = (await f(reg.token).post('/templates/render', { key: 'fee_reminder', channel: 'sms', vars: { parent: 'Mr Rao', amount: '₹12,000', date: '31 Oct' } }).expect(201)).body;
    expect(ok.body).toBe('Dear Mr Rao, fees of ₹12,000 are due on 31 Oct.');
    await f(reg.token).post('/templates/render', { key: 'fee_reminder', channel: 'sms', vars: { parent: 'x' } }).expect(422);
  });

  it('tickets: SLA, privacy of internal notes, requester-only visibility', async () => {
    await f(p1).post('/tickets', { category: 'fees', subject: 'Fee query', body: 'Why is there a late fee?', studentId: s2.studentId }).expect(404);
    const t = (await f(p1).post('/tickets', { category: 'complaint', subject: 'Bus delay', body: 'Bus was 30 minutes late', studentId: s1.studentId }).expect(201)).body;
    expect(Date.parse(t.sla_due_at) - Date.now()).toBeLessThan(25 * 3600_000);                                      // complaints: 24h SLA
    expect((await f(p2).get('/tickets').expect(200)).body).toHaveLength(0);
    await f(p2).get(`/tickets/${t.id}`).expect(404);
    await f(reg.token).post(`/tickets/${t.id}/comments`, { body: 'Escalated to transport; driver was on leave', internal: true }).expect(201);
    await f(reg.token).post(`/tickets/${t.id}/comments`, { body: 'Sorry for the delay — we are looking into it.' }).expect(201);
    await f(p1).post(`/tickets/${t.id}/comments`, { body: 'internal?', internal: true }).expect(404);
    const view = (await f(p1).get(`/tickets/${t.id}`).expect(200)).body;
    expect(view.comments.map((c: any) => c.body)).toEqual(['Sorry for the delay — we are looking into it.']);       // internal note hidden
    expect((await f(p1).get('/notifications')).body.some((n: any) => n.kind === 'ticket.reply')).toBe(true);
    await f(p1).post(`/tickets/${t.id}/status`, { status: 'resolved' }).expect(403);
    await app.get(DbService).withTenant(A.tenantId, (tx) => tx.query(`update tickets set sla_due_at = now() - interval '1 hour' where id = $1`, [t.id]));
    expect((await f(reg.token).get('/tickets').expect(200)).body[0].sla_breached).toBe(true);
    await f(reg.token).post(`/tickets/${t.id}/status`, { status: 'resolved' }).expect(201);
    expect((await f(reg.token).get('/tickets').expect(200)).body[0].sla_breached).toBe(false);
  });
});

describe('timetable & examinations', () => {
  let A: Awaited<ReturnType<typeof adminSession>>; let base: Awaited<ReturnType<typeof schoolBase>>;
  let t1: any, t2: any, t3: any, coord: any, reg: any; let secA: any, secB: any; let cA: any, cB: any, cB2: any; let per: any[]; let s1: any, s2: any; let p1: string;
  beforeAll(async () => {
    A = await adminSession(app, 'schedco');
    t1 = await userSession(app, 'schedco', A.token, 't1@schedco.test', 'teacher'); t2 = await userSession(app, 'schedco', A.token, 't2@schedco.test', 'teacher'); t3 = await userSession(app, 'schedco', A.token, 't3@schedco.test', 'teacher');
    coord = await userSession(app, 'schedco', A.token, 'coord@schedco.test', 'exam_coordinator');
    reg = await userSession(app, 'schedco', A.token, 'reg@schedco.test', 'registrar');
    base = await schoolBase(app, A.token, A.campusId);
    secA = base.section; secB = await base.post('/sections', { campusId: A.campusId, academicYearId: base.year.id, gradeLevelId: base.grade.id, name: 'B', capacity: 30 });
    const math = await base.post('/subjects', { code: 'MATH', name: 'Maths' }); const sci = await base.post('/subjects', { code: 'SCI', name: 'Science' });
    cA = await base.post('/courses', { sectionId: secA.id, subjectId: math.id, teacherUserId: t1.userId, title: 'Maths A' });
    cB = await base.post('/courses', { sectionId: secB.id, subjectId: math.id, teacherUserId: t1.userId, title: 'Maths B' });          // same teacher as cA
    cB2 = await base.post('/courses', { sectionId: secB.id, subjectId: sci.id, teacherUserId: t2.userId, title: 'Science B' });
    s1 = await base.admit('day_scholar', 'e1@example.test', 'Eli'); s2 = await base.admit('day_scholar', 'e2@example.test', 'Eve');
    await activate(app, 'schedco', s1.parentInviteToken); p1 = await login(app, 'schedco', 'e1@example.test');
  });

  it('bell schedule and timetable reject teacher/room/section clashes; substitutions respect availability', async () => {
    await f(t1.token).post('/periods', { seq: 1, name: 'P1', startTime: '09:00', endTime: '09:45' }).expect(403);
    per = [];
    for (const [seq, s, e, br] of [[1, '09:00', '09:45', false], [2, '09:45', '10:30', false], [3, '10:30', '10:50', true]] as const) per.push((await f(reg.token).post('/periods', { seq, name: br ? 'Break' : `P${seq}`, startTime: s, endTime: e, isBreak: br }).expect(201)).body);
    await f(reg.token).post('/periods', { seq: 4, name: 'Overlap', startTime: '09:30', endTime: '10:00' }).expect(409);
    const slot = (sec: string, course: string, p: number, extra: any = {}) => f(reg.token).post('/timetable/slots', { sectionId: sec, courseId: course, dayOfWeek: 1, periodId: per[p].id, ...extra });
    const first = (await slot(secA.id, cA.id, 0, { room: 'R1' }).expect(201)).body;
    await slot(secB.id, cB.id, 0).expect(409).expect((r: any) => expect(r.body.error).toBe('teacher_conflict'));   // t1 already in 8A at that time
    await slot(secB.id, cB2.id, 0, { room: 'R1' }).expect(409).expect((r: any) => expect(r.body.error).toBe('room_conflict'));
    await slot(secA.id, cB.id, 1).expect(422);                                                                          // course belongs to another section
    await slot(secA.id, cA.id, 2).expect(422);                                                                          // cannot schedule in a break
    await slot(secB.id, cB.id, 1).expect(201); await slot(secB.id, cB2.id, 0).expect(201);
    const tt = (await f(p1).get(`/sections/${secA.id}/timetable`).expect(200)).body;
    expect(tt).toHaveLength(1); expect(tt[0]).toMatchObject({ period: 'P1', teacher: 't1' });
    await f(p1).get(`/sections/${secB.id}/timetable`).expect(404);
    expect((await f(t1.token).get('/me/timetable').expect(200)).body).toHaveLength(2);
    // substitution: 2024-01-01 is a Monday (day 1)
    const monday = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7)); return d.toISOString().slice(0, 10); })();
    await f(reg.token).post(`/timetable/slots/${first.id}/substitute`, { subDate: monday, substituteUserId: t1.userId }).expect(422);       // original teacher
    await f(reg.token).post(`/timetable/slots/${first.id}/substitute`, { subDate: monday, substituteUserId: t2.userId }).expect(409);       // t2 teaches 8B P1 on Mondays
    await f(reg.token).post(`/timetable/slots/${first.id}/substitute`, { subDate: monday, substituteUserId: coord.userId }).expect(422);    // not a teacher
    await f(reg.token).post(`/timetable/slots/${first.id}/substitute`, { subDate: day(1) === monday ? day(2) : day(1), substituteUserId: t3.userId }).expect(422);   // wrong weekday
    await f(reg.token).post(`/timetable/slots/${first.id}/substitute`, { subDate: monday, substituteUserId: t3.userId }).expect(201);
    await f(reg.token).post(`/timetable/slots/${first.id}/substitute`, { subDate: monday, substituteUserId: t3.userId }).expect(409);
    expect((await f(t3.token).get('/me/cover').expect(200)).body[0].course).toBe('Maths A');
  });

  it('exam schedule conflicts, seating, marks entry, moderation, publication and re-evaluation', async () => {
    const ex = (await f(reg.token).post('/exams', { academicYearId: base.year.id, name: 'Mid-term 2026', startsOn: day(-3), endsOn: day(3) }).expect(201)).body;
    const paper = (course: string, extra: any = {}) => f(reg.token).post(`/exams/${ex.id}/papers`, { courseId: course, paperDate: day(-1), startTime: '09:00', durationMin: 90, room: 'Hall 1', maxMarks: 50, ...extra });
    await paper(cA.id, { paperDate: day(30) }).expect(422);                                                              // outside window
    const pA = (await paper(cA.id, { invigilatorUserId: t2.userId }).expect(201)).body;
    await paper(cB2.id).expect(409).expect((r: any) => expect(r.body.error).toBe('room_conflict'));
    await paper(cB2.id, { room: 'Hall 2', invigilatorUserId: t2.userId }).expect(409).expect((r: any) => expect(r.body.error).toBe('invigilator_conflict'));
    const pB = (await paper(cB2.id, { room: 'Hall 2', startTime: '11:00' }).expect(201)).body;
    expect((await f(reg.token).post(`/exam-papers/${pA.id}/seating`).expect(201)).body.seated).toBe(2);
    const sch = (await f(p1).get(`/exams/${ex.id}/schedule`).expect(200)).body;
    expect(sch.map((x: any) => x.course)).toEqual(['Maths A']);                                                           // parent sees only their child's section
    // marks entry
    await f(t2.token).put(`/exam-papers/${pA.id}/marks`, { entries: [{ studentId: s1.studentId, marks: 40 }] }).expect(404);   // not this paper's teacher
    await f(t1.token).put(`/exam-papers/${pA.id}/marks`, { entries: [{ studentId: s1.studentId, marks: 51 }] }).expect(422);
    await f(t1.token).put(`/exam-papers/${pA.id}/marks`, { entries: [{ studentId: s1.studentId, marks: 40 }] }).expect(200);
    await f(t1.token).post(`/exam-papers/${pA.id}/submit`).expect(422).expect((r: any) => expect(r.body.error).toBe('marks_missing'));
    await f(t1.token).put(`/exam-papers/${pA.id}/marks`, { entries: [{ studentId: s2.studentId, absent: true }] }).expect(200);
    await f(t1.token).post(`/exam-papers/${pA.id}/submit`).expect(201);
    await f(t1.token).put(`/exam-papers/${pA.id}/marks`, { entries: [{ studentId: s1.studentId, marks: 45 }] }).expect(409);   // locked after submission
    await f(t1.token).post(`/exam-papers/${pA.id}/decision`, { decision: 'approve' }).expect(403);
    await f(coord.token).post(`/exam-papers/${pA.id}/decision`, { decision: 'approve' }).expect(201);
    const rc = (await f(p1).get(`/students/${s1.studentId}/report-card`).expect(200)).body;
    expect(rc.items[0]).toMatchObject({ assessment_name: 'Mid-term 2026', marks: 40, percent: 80, revised: false });
    // re-evaluation: only the child's guardian may ask; approval layers a correction and preserves the original
    await f(p1).post(`/exam-papers/${pB.id}/revaluations`, { studentId: s1.studentId, reason: 'Question 4 not marked' }).expect(409);   // results of pB not published
    const rv = (await f(p1).post(`/exam-papers/${pA.id}/revaluations`, { studentId: s1.studentId, reason: 'Question 4 not marked' }).expect(201)).body;
    await f(p1).post(`/exam-papers/${pA.id}/revaluations`, { studentId: s1.studentId, reason: 'again' }).expect(409);
    await f(t1.token).post(`/revaluations/${rv.id}/decision`, { decision: 'approve', newMarks: 46 }).expect(403);
    await f(coord.token).post(`/revaluations/${rv.id}/decision`, { decision: 'approve' }).expect(422);
    await f(coord.token).post(`/revaluations/${rv.id}/decision`, { decision: 'approve', newMarks: 46 }).expect(201);
    const rc2 = (await f(p1).get(`/students/${s1.studentId}/report-card`)).body;
    expect(rc2.items[0]).toMatchObject({ marks: 46, revised: true });
    const orig = await app.get(DbService).withTenant(A.tenantId, async (tx) => (await tx.query(`select om.marks, c.old_marks, c.new_marks from official_marks om join official_mark_corrections c on c.official_mark_id = om.id`)).rows[0]);
    expect([Number(orig.marks), Number(orig.old_marks), Number(orig.new_marks)]).toEqual([40, 40, 46]);   // history preserved
    expect(rc2.items).toHaveLength(1);                                                                    // absent student has no official mark
    const B = await adminSession(app, 'schedco-other');
    await f(B.token).get(`/exams/${ex.id}/schedule`).expect(200).expect((r: any) => expect(r.body).toEqual([]));
    await f(B.token).post(`/exam-papers/${pA.id}/decision`, { decision: 'reject' }).expect(404);
  });
});
