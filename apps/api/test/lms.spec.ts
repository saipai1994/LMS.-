import { INestApplication } from '@nestjs/common';
import { activate, adminSession, bearer, bootApp, http, login, schoolBase, userSession } from './helpers';
import { resetRateLimits } from '../src/auth/auth.service';
import { DbService } from '../src/db/db.service';
import * as os from 'os';
import * as path from 'path';

let app: INestApplication;
beforeAll(async () => { process.env.FILE_STORAGE_DIR = path.join(os.tmpdir(), 'lms-test-files'); app = await bootApp(); });
afterAll(async () => { await app.close(); });
beforeEach(() => resetRateLimits());

const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const pdf = (text = 'hello') => Buffer.from(`%PDF-1.4\n${text}`).toString('base64');

describe('LMS: lessons, assignments, files, quizzes, grade publication, report card', () => {
  let A: Awaited<ReturnType<typeof adminSession>>; let base: Awaited<ReturnType<typeof schoolBase>>;
  let t1: any, t2: any, coord: any; let course: any, course2: any;
  let s1: any, s2: any, st1: string, st2: string, p1: string, p2: string;
  const f = (tok: string) => ({
    get: (u: string) => http(app).get(u).set(bearer(tok)),
    post: (u: string, b?: any) => http(app).post(u).set(bearer(tok)).send(b ?? {}),
    put: (u: string, b?: any) => http(app).put(u).set(bearer(tok)).send(b ?? {}),
  });
  const studentLogin = async (admission: any, email: string) => {
    const acc = (await f(A.token).post(`/students/${admission.studentId}/account`, { email }).expect(201)).body;
    await activate(app, 'lmsco', acc.inviteToken);
    return login(app, 'lmsco', email);
  };

  beforeAll(async () => {
    A = await adminSession(app, 'lmsco');
    t1 = await userSession(app, 'lmsco', A.token, 't1@lmsco.test', 'teacher');
    t2 = await userSession(app, 'lmsco', A.token, 't2@lmsco.test', 'teacher');
    coord = await userSession(app, 'lmsco', A.token, 'coord@lmsco.test', 'exam_coordinator');
    base = await schoolBase(app, A.token, A.campusId);
    const maths = await base.post('/subjects', { code: 'MATH', name: 'Mathematics' });
    const sci = await base.post('/subjects', { code: 'SCI', name: 'Science' });
    course = await base.post('/courses', { sectionId: base.section.id, subjectId: maths.id, teacherUserId: t1.userId, title: 'Maths 8A' });
    course2 = await base.post('/courses', { sectionId: base.section.id, subjectId: sci.id, teacherUserId: t2.userId, title: 'Science 8A' });
    s1 = await base.admit('day_scholar', 'l1@example.test', 'Lia');
    s2 = await base.admit('boarder', 'l2@example.test', 'Max');
    await activate(app, 'lmsco', s1.parentInviteToken); p1 = await login(app, 'lmsco', 'l1@example.test');
    await activate(app, 'lmsco', s2.parentInviteToken); p2 = await login(app, 'lmsco', 'l2@example.test');
    st1 = await studentLogin(s1, 'lia@lmsco.test'); st2 = await studentLogin(s2, 'max@lmsco.test');
  });

  it('course content respects teacher ownership, release schedules, prerequisites and publication', async () => {
    const l = (tok: string, b: any) => f(tok).post(`/courses/${course.id}/lessons`, { title: 'L', published: true, ...b });
    await l(t2.token, { title: 'Hijack' }).expect(404);                           // not this course's teacher
    const l1 = (await l(t1.token, { title: 'Fractions', position: 1, body: 'Intro to fractions' }).expect(201)).body;
    const l2 = (await l(t1.token, { title: 'Adding fractions', position: 2, body: 'Secret body', prerequisiteLessonId: l1.id }).expect(201)).body;
    await l(t1.token, { title: 'Future', position: 3, body: 'Future body', releaseAt: hours(48) }).expect(201);
    await l(t1.token, { title: 'Draft', position: 4, published: false }).expect(201);
    await l(t1.token, { title: 'Bad prereq', prerequisiteLessonId: '00000000-0000-4000-8000-000000000000' }).expect(422);
    const view = (await f(st1).get(`/courses/${course.id}/lessons`).expect(200)).body;
    expect(view.map((x: any) => x.title)).toEqual(['Fractions', 'Adding fractions', 'Future']);   // draft hidden
    expect(view[1]).toMatchObject({ locked: true, reason: 'prerequisite_pending' }); expect(view[1].body).toBeUndefined();
    expect(view[2]).toMatchObject({ locked: true, reason: 'not_yet_released' }); expect(view[2].body).toBeUndefined();
    await f(st1).post(`/lessons/${l2.id}/complete`).expect(422);
    await f(st1).post(`/lessons/${l1.id}/complete`).expect(201);
    expect((await f(st1).get(`/courses/${course.id}/lessons`)).body[1]).toMatchObject({ locked: false, body: 'Secret body' });
    expect((await f(t1.token).get(`/courses/${course.id}/lessons`).expect(200)).body).toHaveLength(4);
    await f(t2.token).get(`/courses/${course.id}/lessons`).expect(404);          // another course's teacher is not staff here
  });

  it('secure files: type/size/content checks and access limited to people with a legitimate link', async () => {
    await f(st1).post('/files', { name: 'x.exe', mime: 'application/x-msdownload', contentBase64: pdf() }).expect(422);
    await f(st1).post('/files', { name: 'fake.pdf', mime: 'application/pdf', contentBase64: Buffer.from('not a pdf').toString('base64') }).expect(422);
    await f(st1).post('/files', { name: '../evil.pdf', mime: 'application/pdf', contentBase64: pdf() }).expect(400);
    const file = (await f(st1).post('/files', { name: 'homework.pdf', mime: 'application/pdf', contentBase64: pdf('answers') }).expect(201)).body;
    await f(st2).get(`/files/${file.id}`).expect(404);                             // unlinked: only uploader
    const asg = (await f(t1.token).post(`/courses/${course.id}/assignments`, { title: 'Worksheet 1', dueAt: hours(24), maxMarks: 10, published: true }).expect(201)).body;
    await f(st2).put(`/assignments/${asg.id}/submission`, { answerText: 'x', submit: false, fileIds: [file.id] }).expect(422); // not their file
    await f(st1).put(`/assignments/${asg.id}/submission`, { answerText: 'my work', submit: true, fileIds: [file.id] }).expect(200);
    const dl = await f(t1.token).get(`/files/${file.id}`).expect(200);
    expect(dl.headers['content-disposition']).toMatch(/attachment/); expect(dl.headers['x-content-type-options']).toBe('nosniff');
    await f(t2.token).get(`/files/${file.id}`).expect(404);                        // other course's teacher
    await f(st2).get(`/files/${file.id}`).expect(404);                             // classmate
    await f(p2).get(`/files/${file.id}`).expect(404);                              // other child's parent
    await f(p1).get(`/files/${file.id}`).expect(200);                              // own child's parent
    ids.worksheet = asg.id;
  });
  const ids: any = {};

  it('Scenario D: publish → targeted visibility → draft/submit/resubmit → late rules → grade → history → parent view', async () => {
    const mk = (b: any) => f(t1.token).post(`/courses/${course.id}/assignments`, { instructions: 'Do it', maxMarks: 10, ...b });
    const targeted = (await mk({ title: 'Extension task', dueAt: hours(24), published: true, studentIds: [s1.studentId] }).expect(201)).body;
    const overdue = (await mk({ title: 'Last week', dueAt: hours(-48), allowLate: false, published: true }).expect(201)).body;
    const lateOk = (await mk({ title: 'Late ok', dueAt: hours(-48), allowLate: true, published: true }).expect(201)).body;
    const unpublished = (await mk({ title: 'Hidden', dueAt: hours(24) }).expect(201)).body;

    // visibility
    const v1 = (await f(st1).get('/me/learning').expect(200)).body.assignments.map((x: any) => x.title);
    const v2 = (await f(st2).get('/me/learning').expect(200)).body.assignments.map((x: any) => x.title);
    expect(v1).toEqual(expect.arrayContaining(['Extension task', 'Worksheet 1'])); expect(v1).not.toContain('Hidden');
    expect(v2).not.toContain('Extension task');
    await f(st2).put(`/assignments/${targeted.id}/submission`, { answerText: 'sneaky', submit: true }).expect(404);
    await f(st1).put(`/assignments/${unpublished.id}/submission`, { answerText: 'x', submit: true }).expect(404);
    await f(t2.token).post(`/assignments/${targeted.id}/publish`).expect(404);
    const pub = (await f(t1.token).post(`/assignments/${unpublished.id}/publish`).expect(201)).body;
    expect(pub.notified).toBe(2);
    expect((await f(p2).get('/notifications')).body.some((n: any) => n.kind === 'lms.assignment' && /Hidden/.test(n.body))).toBe(true);

    // draft → submit → resubmit
    expect((await f(st1).put(`/assignments/${targeted.id}/submission`, { answerText: 'draft', submit: false }).expect(200)).body).toMatchObject({ status: 'draft', version: 0 });
    const s = (await f(st1).put(`/assignments/${targeted.id}/submission`, { answerText: 'v1', submit: true }).expect(200)).body;
    expect(s).toMatchObject({ status: 'submitted', version: 1, is_late: false });
    expect((await f(st1).put(`/assignments/${targeted.id}/submission`, { answerText: 'v2', submit: true }).expect(200)).body.version).toBe(2);

    // deadline rules
    await f(st1).put(`/assignments/${overdue.id}/submission`, { answerText: 'x', submit: true }).expect(422).expect((r: any) => expect(r.body.error).toBe('deadline_passed'));
    expect((await f(st1).put(`/assignments/${lateOk.id}/submission`, { answerText: 'x', submit: true }).expect(200)).body.is_late).toBe(true);

    // missing-work alert data
    const missing = (await f(t1.token).get(`/courses/${course.id}/missing-work`).expect(200)).body;
    expect(missing.filter((m: any) => m.title === 'Last week').map((m: any) => m.student_id).sort()).toEqual([s1.studentId, s2.studentId].sort());
    expect(missing.some((m: any) => m.title === 'Late ok' && m.student_id === s1.studentId)).toBe(false);
    expect((await f(p1).get(`/students/${s1.studentId}/learning`).expect(200)).body.missing).toBe(1);

    // grading
    const subs = (await f(t1.token).get(`/assignments/${targeted.id}/submissions`).expect(200)).body;
    expect(subs).toHaveLength(1);
    await f(t1.token).post(`/submissions/${subs[0].submission_id}/grade`, { marks: 11 }).expect(422);
    await f(t2.token).post(`/submissions/${subs[0].submission_id}/grade`, { marks: 5 }).expect(404);
    await f(st1).post(`/submissions/${subs[0].submission_id}/grade`, { marks: 10 }).expect(404);
    await f(t1.token).post(`/submissions/${subs[0].submission_id}/grade`, { marks: 8, feedback: 'Good reasoning' }).expect(201);
    await f(st1).put(`/assignments/${targeted.id}/submission`, { answerText: 'v3', submit: true }).expect(409);
    const hist = (await f(st1).get(`/submissions/${subs[0].submission_id}/history`).expect(200)).body;
    expect(hist.map((h: any) => h.event)).toEqual(['submitted', 'submitted', 'graded']);
    await f(st2).get(`/submissions/${subs[0].submission_id}/history`).expect(404);
    // return-for-revision flow
    const ws = (await f(t1.token).get(`/assignments/${ids.worksheet}/submissions`)).body.find((x: any) => x.student_id === s1.studentId);
    await f(t1.token).post(`/submissions/${ws.submission_id}/return`, { feedback: 'Show your working' }).expect(201);
    expect((await f(st1).put(`/assignments/${ids.worksheet}/submission`, { answerText: 'with working', submit: true }).expect(200)).body).toMatchObject({ status: 'submitted', version: 2 });
    await f(t1.token).post(`/submissions/${ws.submission_id}/grade`, { marks: 7 }).expect(201);

    // results visible to the right people only
    const parentView = (await f(p1).get(`/students/${s1.studentId}/learning`).expect(200)).body.assignments.find((x: any) => x.title === 'Extension task');
    expect(parentView).toMatchObject({ status: 'graded', feedback: 'Good reasoning' }); expect(Number(parentView.marks)).toBe(8);
    await f(p2).get(`/students/${s1.studentId}/learning`).expect(404);
    expect((await f(p1).get('/notifications')).body.some((n: any) => n.kind === 'lms.graded')).toBe(true);
    const gb = (await f(t1.token).get(`/courses/${course.id}/gradebook`).expect(200)).body;
    expect(gb.students).toHaveLength(2);
    await f(p1).get(`/courses/${course.id}/gradebook`).expect(404);
    ids.targeted = targeted.id;
  });

  it('quizzes: window, attempt limits, timer, auto-grading, answer-key secrecy, analytics', async () => {
    const q = (await f(t1.token).post(`/courses/${course.id}/quizzes`, {
      title: 'Fractions quiz', opensAt: hours(-1), closesAt: hours(2), timeLimitMinutes: 20, attemptsAllowed: 1,
      questions: [
        { kind: 'mcq', prompt: '1/2 + 1/2 = ?', options: ['1', '2', '1/4', '0'], answerKey: 0, points: 2 },
        { kind: 'mcq', prompt: '1/4 of 8 = ?', options: ['1', '2', '4', '8'], answerKey: 1, points: 2 },
        { kind: 'short', prompt: 'Name the top number of a fraction', answerKey: ['numerator'], points: 1 },
      ] }).expect(201)).body;
    await f(t1.token).post(`/courses/${course.id}/quizzes`, { title: 'bad', opensAt: hours(-1), closesAt: hours(2), timeLimitMinutes: 5, questions: [{ kind: 'mcq', prompt: 'x', options: ['a', 'b'], answerKey: 5, points: 1 }] }).expect(422);
    await f(st1).post(`/quizzes/${q.id}/attempts`).expect(404);                    // unpublished
    await f(st1).get(`/quizzes/${q.id}`).expect(404);                              // students cannot read the key view
    await f(t1.token).post(`/quizzes/${q.id}/publish`).expect(201);
    const start = (await f(st1).post(`/quizzes/${q.id}/attempts`).expect(201)).body;
    const raw = JSON.stringify(start);
    expect(raw).not.toMatch(/answerKey|answer_key/);
    const again = (await f(st1).post(`/quizzes/${q.id}/attempts`).expect(201)).body;
    expect(again.attemptId).toBe(start.attemptId);                                  // resume, not a new attempt
    expect(again.questions.map((x: any) => x.id)).toEqual(start.questions.map((x: any) => x.id)); // stable shuffle
    const full = (await f(t1.token).get(`/quizzes/${q.id}`).expect(200)).body.questions;
    const mcq1 = full.find((x: any) => x.position === 1), mcq2 = full.find((x: any) => x.position === 2), sh = full.find((x: any) => x.position === 3);
    // option ids map to original indexes, so the correct option is found by text
    const opt = (qid: string, text: string) => start.questions.find((x: any) => x.id === qid).options.find((o: any) => o.text === text).id;
    await f(st2).post(`/attempts/${start.attemptId}/submit`, { answers: {} }).expect(404);     // someone else's attempt
    const res = (await f(st1).post(`/attempts/${start.attemptId}/submit`, { answers: { [mcq1.id]: opt(mcq1.id, '1'), [mcq2.id]: opt(mcq2.id, '4'), [sh.id]: '  Numerator ' } }).expect(201)).body;
    expect(res).toEqual({ score: 3, maxScore: 5 });                                 // q1 ✓, q2 ✗, short ✓ (normalised)
    await f(st1).post(`/attempts/${start.attemptId}/submit`, { answers: {} }).expect(409);
    await f(st1).post(`/quizzes/${q.id}/attempts`).expect(409);                    // attempt limit
    // timer: expired attempt cannot be submitted
    const s2start = (await f(st2).post(`/quizzes/${q.id}/attempts`).expect(201)).body;
    await app.get(DbService).withTenant(A.tenantId, (tx) => tx.query(`update quiz_attempts set deadline_at = now() - interval '5 minutes' where id = $1`, [s2start.attemptId]));
    await f(st2).post(`/attempts/${s2start.attemptId}/submit`, { answers: {} }).expect(422).expect((r: any) => expect(r.body.error).toBe('time_expired'));
    const an = (await f(t1.token).get(`/quizzes/${q.id}/analytics`).expect(200)).body;
    expect(an.attempts).toBe(1); expect(an.items.map((i: any) => i.correctRate)).toEqual([100, 0, 100]);
    await f(t2.token).get(`/quizzes/${q.id}/analytics`).expect(404);
    // closed window
    const closed = (await f(t1.token).post(`/courses/${course.id}/quizzes`, { title: 'Old', opensAt: hours(-5), closesAt: hours(-4), timeLimitMinutes: 5, questions: [{ kind: 'short', prompt: 'x', answerKey: ['y'], points: 1 }] }).expect(201)).body;
    await f(t1.token).post(`/quizzes/${closed.id}/publish`);
    await f(st1).post(`/quizzes/${closed.id}/attempts`).expect(422);
  });

  it('grade pipeline: propose → approve (maker-checker) → immutable official marks → report card', async () => {
    const asgs = (await f(t1.token).get(`/courses/${course.id}/assignments`).expect(200)).body;
    const worksheet = asgs.find((x: any) => x.title === 'Worksheet 1');
    const propose = (b: any) => f(t1.token).post(`/courses/${course.id}/grade-publications`, b);
    await propose({ assessmentName: 'Unit 1', assignmentIds: [ids.targeted, worksheet.id] }).expect(422); // s2 has no graded work yet
    // s2 submits and is graded on the worksheet only; targeted assignment is s1-only so propose on worksheet
    await f(st2).put(`/assignments/${worksheet.id}/submission`, { answerText: 'max work', submit: true }).expect(200);
    const sub2 = (await f(t1.token).get(`/assignments/${worksheet.id}/submissions`)).body.find((x: any) => x.student_id === s2.studentId);
    await f(t1.token).post(`/submissions/${sub2.submission_id}/grade`, { marks: 9 }).expect(201);
    const pub = (await propose({ assessmentName: 'Unit 1', assignmentIds: [worksheet.id] }).expect(201)).body;
    expect(pub.maxMarks).toBe(10);
    await propose({ assessmentName: 'Unit 1', assignmentIds: [worksheet.id] }).expect(409);
    expect((await f(p1).get(`/students/${s1.studentId}/report-card`).expect(200)).body.items).toEqual([]);   // nothing official yet
    await f(t1.token).post(`/grade-publications/${pub.id}/decision`, { decision: 'approve' }).expect(403);   // teacher cannot approve
    await f(coord.token).post(`/grade-publications/${pub.id}/decision`, { decision: 'approve' }).expect(201);
    await f(coord.token).post(`/grade-publications/${pub.id}/decision`, { decision: 'approve' }).expect(409);
    const rc = (await f(p1).get(`/students/${s1.studentId}/report-card`).expect(200)).body;
    expect(rc.items).toHaveLength(1);
    expect(rc.items[0]).toMatchObject({ course: 'Maths 8A', subject: 'Mathematics', marks: 7, max_marks: 10, percent: 70, grade: 'C' });
    expect(rc.scale).toBe('default-fallback');
    await f(A.token).post('/grade-scales', { bands: [{ minPercent: 0, grade: 'E' }, { minPercent: 50, grade: 'B' }, { minPercent: 80, grade: 'A' }] }).expect(201);
    expect((await f(p1).get(`/students/${s1.studentId}/report-card`)).body).toMatchObject({ overallGrade: 'B', scale: 'configured' });
    await f(p2).get(`/students/${s1.studentId}/report-card`).expect(404);
    expect((await f(p1).get('/notifications')).body.some((n: any) => n.kind === 'results.published')).toBe(true);
    // published results cannot be altered, even by the database owner role
    await expect(app.get(DbService).withTenant(A.tenantId, (tx) => tx.query('update official_marks set marks = 100'))).rejects.toThrow(/append-only/);
    // a different teacher cannot propose for this course
    await f(t2.token).post(`/courses/${course.id}/grade-publications`, { assessmentName: 'Hack', assignmentIds: [worksheet.id] }).expect(404);
  });

  it('isolates LMS data between tenants', async () => {
    const B = await adminSession(app, 'lms-other');
    await f(B.token).get(`/courses/${course.id}/lessons`).expect(404);
    await f(B.token).get(`/courses/${course.id}/gradebook`).expect(404);
    await f(B.token).get(`/students/${s1.studentId}/report-card`).expect(404);
    expect((await f(B.token).get('/grade-publications').expect(200)).body).toEqual([]);
  });
});
