import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Put, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, can, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { guardianUserIds, notify, studentAccess } from '../sis/access';
import { myStudent, staffCourse } from '../lms/access';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const periodS = z.object({ seq: z.number().int().min(1).max(20), name: z.string().min(1).max(40), startTime: hhmm, endTime: hhmm, isBreak: z.boolean().default(false) });
const slotS = z.object({ sectionId: uuid, dayOfWeek: z.number().int().min(1).max(6), periodId: uuid, courseId: uuid, room: z.string().max(40).optional() });
const subS = z.object({ subDate: z.string().date(), substituteUserId: uuid, reason: z.string().max(200).optional() });
const examS = z.object({ academicYearId: uuid, name: z.string().min(2).max(100), startsOn: z.string().date(), endsOn: z.string().date() });
const paperS = z.object({ courseId: uuid, paperDate: z.string().date(), startTime: hhmm, durationMin: z.number().int().min(10).max(360), room: z.string().min(1).max(40), maxMarks: z.number().positive().max(1000), invigilatorUserId: uuid.optional() });
const marksS = z.object({ entries: z.array(z.object({ studentId: uuid, marks: z.number().min(0).optional(), absent: z.boolean().default(false) })).min(1).max(500) });

const DOW = (d: string) => { const n = new Date(`${d}T00:00:00Z`).getUTCDay(); return n === 0 ? 7 : n; };

@Controller()
export class SchedulingController {
  constructor(private db: DbService) {}

  // ---------------- bell schedule & timetable ----------------
  @Post('periods')
  addPeriod(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'academic.manage'); const b = parse(periodS, body);
    if (b.endTime <= b.startTime) throw new UnprocessableEntityException({ error: 'end_before_start' });
    return this.db.withTenant(a.tenantId, async (tx) => {
      const overlap = await tx.query('select 1 from periods where start_time < $2::time and end_time > $1::time', [b.startTime, b.endTime]);
      if (overlap.rowCount) throw new ConflictException({ error: 'overlapping_period' });
      return (await tx.query('insert into periods(tenant_id, seq, name, start_time, end_time, is_break) values ($1,$2,$3,$4,$5,$6) returning *', [a.tenantId, b.seq, b.name, b.startTime, b.endTime, b.isBreak])).rows[0];
    });
  }
  @Get('periods')
  periods(@Auth() a: AuthContext) { return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('select * from periods order by seq')).rows); }

  /** Rejects teacher, room and section clashes before saving. */
  @Post('timetable/slots')
  addSlot(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(slotS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [sec] } = await tx.query('select * from sections where id = $1', [b.sectionId]);
      if (!sec) throw new NotFoundException({ error: 'not_found' });
      needs(a, 'academic.manage', sec.campus_id);
      const { rows: [c] } = await tx.query('select * from courses where id = $1 and section_id = $2', [b.courseId, b.sectionId]);
      if (!c) throw new UnprocessableEntityException({ error: 'course_not_in_section' });
      const per = (await tx.query('select is_break from periods where id = $1', [b.periodId])).rows[0];
      if (!per) throw new UnprocessableEntityException({ error: 'unknown_period' });
      if (per.is_break) throw new UnprocessableEntityException({ error: 'period_is_a_break' });
      if (c.teacher_user_id) {
        const clash = (await tx.query(`select s.name, g.name as grade from timetable_slots t join courses c2 on c2.id = t.course_id join sections s on s.id = t.section_id join grade_levels g on g.id = s.grade_level_id where t.day_of_week = $1 and t.period_id = $2 and c2.teacher_user_id = $3`, [b.dayOfWeek, b.periodId, c.teacher_user_id])).rows[0];
        if (clash) throw new ConflictException({ error: 'teacher_conflict', with: `${clash.grade} ${clash.name}` });
      }
      if (b.room) {
        const clash = await tx.query('select 1 from timetable_slots where day_of_week = $1 and period_id = $2 and room = $3', [b.dayOfWeek, b.periodId, b.room]);
        if (clash.rowCount) throw new ConflictException({ error: 'room_conflict' });
      }
      const r = (await tx.query('insert into timetable_slots(tenant_id, section_id, day_of_week, period_id, course_id, room) values ($1,$2,$3,$4,$5,$6) returning id', [a.tenantId, b.sectionId, b.dayOfWeek, b.periodId, b.courseId, b.room ?? null])).rows[0];
      await audit(tx, a, a.tenantId, 'timetable.slot', 'section', b.sectionId, sec.campus_id);
      return r;
    });
  }
  @Get('sections/:id/timetable')
  sectionTimetable(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [sec] } = await tx.query('select * from sections where id = $1', [id]);
      if (!sec) throw new NotFoundException({ error: 'not_found' });
      const mine = await tx.query(`select 1 from enrollments e join students s on s.id = e.student_id where e.section_id = $1 and e.effective_to is null and (s.user_id = $2 or exists (select 1 from student_guardians sg join guardians g on g.id = sg.guardian_id where sg.student_id = s.id and g.user_id = $2))`, [id, a.userId]);
      const teaches = await tx.query('select 1 from courses where section_id = $1 and teacher_user_id = $2', [id, a.userId]);
      if (!(can(a, 'academic.read', sec.campus_id) || mine.rowCount || teaches.rowCount)) throw new NotFoundException({ error: 'not_found' });
      return this.view(tx, `t.section_id = $1`, [id]);
    });
  }
  @Get('me/timetable')
  myTimetable(@Auth() a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => {
      const st = await myStudent(tx, a);
      if (st) { const e = (await tx.query('select section_id from enrollments where student_id = $1 and effective_to is null', [st.id])).rows[0]; return e ? this.view(tx, 't.section_id = $1', [e.section_id]) : []; }
      return this.view(tx, 'c.teacher_user_id = $1', [a.userId]);
    });
  }
  private async view(tx: Tx, where: string, params: unknown[]) {
    return (await tx.query(
      `select t.id, t.day_of_week, p.seq, p.name as period, p.start_time, p.end_time, sub.name as subject, c.title as course, t.room, u.full_name as teacher, g.name as grade, s.name as section
       from timetable_slots t join periods p on p.id = t.period_id join courses c on c.id = t.course_id join subjects sub on sub.id = c.subject_id join sections s on s.id = t.section_id join grade_levels g on g.id = s.grade_level_id left join users u on u.id = c.teacher_user_id
       where ${where} order by t.day_of_week, p.seq`, params)).rows;
  }
  @Post('timetable/slots/:id/substitute')
  substitute(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(subS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [t] } = await tx.query('select t.*, s.campus_id, c.teacher_user_id from timetable_slots t join sections s on s.id = t.section_id join courses c on c.id = t.course_id where t.id = $1', [id]);
      if (!t) throw new NotFoundException({ error: 'not_found' });
      needs(a, 'academic.manage', t.campus_id);
      if (DOW(b.subDate) !== t.day_of_week) throw new UnprocessableEntityException({ error: 'date_not_on_slot_day' });
      if (b.substituteUserId === t.teacher_user_id) throw new UnprocessableEntityException({ error: 'substitute_is_original_teacher' });
      const isTeacher = await tx.query(`select 1 from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1 and r.key = 'teacher'`, [b.substituteUserId]);
      if (!isTeacher.rowCount) throw new UnprocessableEntityException({ error: 'substitute_must_be_a_teacher' });
      const busy = await tx.query(`select 1 from timetable_slots t2 join courses c2 on c2.id = t2.course_id where t2.day_of_week = $1 and t2.period_id = $2 and c2.teacher_user_id = $3
        union select 1 from substitutions s2 join timetable_slots t3 on t3.id = s2.slot_id where s2.sub_date = $4 and t3.period_id = $2 and s2.substitute_user_id = $3`, [t.day_of_week, t.period_id, b.substituteUserId, b.subDate]);
      if (busy.rowCount) throw new ConflictException({ error: 'substitute_busy' });
      const dup = await tx.query('select 1 from substitutions where slot_id = $1 and sub_date = $2', [id, b.subDate]);
      if (dup.rowCount) throw new ConflictException({ error: 'already_covered' });
      const r = (await tx.query('insert into substitutions(tenant_id, slot_id, sub_date, substitute_user_id, reason, created_by) values ($1,$2,$3,$4,$5,$6) returning id', [a.tenantId, id, b.subDate, b.substituteUserId, b.reason ?? null, a.userId])).rows[0];
      await notify(tx, a.tenantId, [b.substituteUserId], 'timetable.substitution', 'Cover assigned', `You are covering a class on ${b.subDate}.`);
      await audit(tx, a, a.tenantId, 'timetable.substitution', 'slot', id, t.campus_id);
      return r;
    });
  }
  @Get('me/cover')
  myCover(@Auth() a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(`select s.sub_date, p.name as period, p.start_time, c.title as course from substitutions s join timetable_slots t on t.id = s.slot_id join periods p on p.id = t.period_id join courses c on c.id = t.course_id where s.substitute_user_id = $1 and s.sub_date >= current_date order by s.sub_date, p.seq`, [a.userId])).rows);
  }

  // ---------------- examinations ----------------
  @Post('exams')
  addExam(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'academic.manage'); const b = parse(examS, body);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('insert into exams(tenant_id, academic_year_id, name, starts_on, ends_on) values ($1,$2,$3,$4,$5) returning id, name', [a.tenantId, b.academicYearId, b.name, b.startsOn, b.endsOn])).rows[0]);
  }
  @Post('exams/:id/papers')
  addPaper(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); needs(a, 'academic.manage'); const b = parse(paperS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [ex] } = await tx.query('select * from exams where id = $1', [id]);
      if (!ex) throw new NotFoundException({ error: 'not_found' });
      if (b.paperDate < ex.starts_on || b.paperDate > ex.ends_on) throw new UnprocessableEntityException({ error: 'outside_exam_window' });
      const { rows: [c] } = await tx.query('select * from courses where id = $1', [b.courseId]);
      if (!c) throw new UnprocessableEntityException({ error: 'unknown_course' });
      const overlap = (cond: string, p: unknown[]) => tx.query(
        `select 1 from exam_papers x join courses c2 on c2.id = x.course_id where x.paper_date = $1 and x.start_time < ($2::time + ($3 || ' minutes')::interval) and (x.start_time + (x.duration_min || ' minutes')::interval) > $2::time and (${cond})`, [b.paperDate, b.startTime, b.durationMin, ...p]);
      if ((await overlap('c2.section_id = $4', [c.section_id])).rowCount) throw new ConflictException({ error: 'section_has_another_paper_at_that_time' });
      if ((await overlap('x.room = $4', [b.room])).rowCount) throw new ConflictException({ error: 'room_conflict' });
      if (b.invigilatorUserId && (await overlap('x.invigilator_user_id = $4', [b.invigilatorUserId])).rowCount) throw new ConflictException({ error: 'invigilator_conflict' });
      const r = (await tx.query('insert into exam_papers(tenant_id, exam_id, course_id, paper_date, start_time, duration_min, room, max_marks, invigilator_user_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id', [a.tenantId, id, b.courseId, b.paperDate, b.startTime, b.durationMin, b.room, b.maxMarks, b.invigilatorUserId ?? null])).rows[0];
      await audit(tx, a, a.tenantId, 'exam.paper', 'exam', id);
      return r;
    });
  }
  @Get('exams/:id/schedule')
  schedule(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const rows = (await tx.query(
        `select p.id, p.paper_date, p.start_time, p.duration_min, p.room, p.max_marks, p.status, c.title as course, c.section_id, c.teacher_user_id, s.campus_id, g.name as grade, s.name as section, iu.full_name as invigilator
         from exam_papers p join courses c on c.id = p.course_id join sections s on s.id = c.section_id join grade_levels g on g.id = s.grade_level_id left join users iu on iu.id = p.invigilator_user_id where p.exam_id = $1 order by p.paper_date, p.start_time`, [id])).rows;
      const mine = new Set((await tx.query(`select e.section_id from enrollments e join students s on s.id = e.student_id where e.effective_to is null and (s.user_id = $1 or exists (select 1 from student_guardians sg join guardians g on g.id = sg.guardian_id where sg.student_id = s.id and g.user_id = $1))`, [a.userId])).rows.map((r) => r.section_id));
      return rows.filter((r) => can(a, 'academic.read', r.campus_id) || mine.has(r.section_id) || r.teacher_user_id === a.userId).map(({ section_id, teacher_user_id, campus_id, ...r }) => r);
    });
  }
  @Post('exam-papers/:id/seating')
  seating(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id); needs(a, 'academic.manage');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [p] } = await tx.query('select p.*, c.section_id from exam_papers p join courses c on c.id = p.course_id where p.id = $1', [id]);
      if (!p) throw new NotFoundException({ error: 'not_found' });
      const studs = (await tx.query(`select s.id from enrollments e join students s on s.id = e.student_id where e.section_id = $1 and e.effective_to is null order by s.admission_no`, [p.section_id])).rows;
      await tx.query('delete from exam_seating where paper_id = $1', [id]);
      let n = 1;
      for (const s of studs) await tx.query('insert into exam_seating(tenant_id, paper_id, student_id, seat_no) values ($1,$2,$3,$4)', [a.tenantId, id, s.id, n++]);
      return { seated: studs.length };
    });
  }

  /** Marks entry by the course teacher, only once the paper date has arrived. */
  @Put('exam-papers/:id/marks')
  enterMarks(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(marksS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const p = await this.paper(tx, a, id);
      await staffCourse(tx, a, p.course_id);
      if (p.status === 'approved' || p.status === 'submitted') throw new ConflictException({ error: 'locked', status: p.status });
      if (p.paper_date > new Date().toISOString().slice(0, 10)) throw new UnprocessableEntityException({ error: 'exam_not_held_yet' });
      for (const e of b.entries) {
        if (!e.absent && e.marks === undefined) throw new UnprocessableEntityException({ error: 'marks_required', studentId: e.studentId });
        if (e.marks !== undefined && e.marks > Number(p.max_marks)) throw new UnprocessableEntityException({ error: 'exceeds_max_marks', maxMarks: Number(p.max_marks) });
        const enrolled = await tx.query(`select 1 from course_enrollments where course_id = $1 and student_id = $2 and status = 'active'`, [p.course_id, e.studentId]);
        if (!enrolled.rowCount) throw new UnprocessableEntityException({ error: 'student_not_in_course', studentId: e.studentId });
        await tx.query('insert into exam_marks(tenant_id, paper_id, student_id, marks, absent, entered_by) values ($1,$2,$3,$4,$5,$6) on conflict (paper_id, student_id) do update set marks = excluded.marks, absent = excluded.absent, entered_by = excluded.entered_by', [a.tenantId, id, e.studentId, e.absent ? null : e.marks, e.absent, a.userId]);
      }
      if (p.status === 'rejected') await tx.query(`update exam_papers set status = 'scheduled' where id = $1`, [id]);
      return { saved: b.entries.length };
    });
  }
  @Post('exam-papers/:id/submit')
  submit(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const p = await this.paper(tx, a, id);
      await staffCourse(tx, a, p.course_id);
      if (!['scheduled', 'rejected'].includes(p.status)) throw new ConflictException({ error: 'not_submittable', status: p.status });
      const missing = (await tx.query(`select ce.student_id from course_enrollments ce where ce.course_id = $1 and ce.status = 'active' and not exists (select 1 from exam_marks m where m.paper_id = $2 and m.student_id = ce.student_id)`, [p.course_id, id])).rows.map((r) => r.student_id);
      if (missing.length) throw new UnprocessableEntityException({ error: 'marks_missing', studentIds: missing });
      await tx.query(`update exam_papers set status = 'submitted', submitted_by = $2 where id = $1`, [id, a.userId]);
      return { status: 'submitted' };
    });
  }
  /** Moderation: a different person approves; approval publishes immutable official marks and notifies guardians. */
  @Post('exam-papers/:id/decision')
  decide(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const { decision } = parse(z.object({ decision: z.enum(['approve', 'reject']) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const p = await this.paper(tx, a, id);
      needs(a, 'grades.approve', p.campus_id);
      if (p.status !== 'submitted') throw new ConflictException({ error: 'not_submitted', status: p.status });
      if (p.submitted_by === a.userId) throw new UnprocessableEntityException({ error: 'cannot_approve_own_submission' });
      await tx.query('update exam_papers set status = $2, decided_by = $3 where id = $1', [id, decision === 'approve' ? 'approved' : 'rejected', a.userId]);
      if (decision === 'approve') {
        const pub = (await tx.query(`insert into grade_publications(tenant_id, course_id, assessment_name, source_assignment_ids, status, submitted_by, decided_by, decided_at) values ($1,$2,$3,'{}','approved',$4,$5,now()) returning id`, [a.tenantId, p.course_id, p.exam_name, p.submitted_by, a.userId])).rows[0];
        const marks = (await tx.query('select * from exam_marks where paper_id = $1 and not absent', [id])).rows;
        for (const m of marks) {
          await tx.query('insert into publication_entries(tenant_id, publication_id, student_id, marks, max_marks) values ($1,$2,$3,$4,$5)', [a.tenantId, pub.id, m.student_id, m.marks, p.max_marks]);
          await tx.query('insert into official_marks(tenant_id, student_id, course_id, academic_year_id, assessment_name, marks, max_marks, publication_id) values ($1,$2,$3,$4,$5,$6,$7,$8)', [a.tenantId, m.student_id, p.course_id, p.academic_year_id, p.exam_name, m.marks, p.max_marks, pub.id]);
          await notify(tx, a.tenantId, await guardianUserIds(tx, m.student_id), 'results.published', 'Results published', `${p.exam_name}: ${Number(m.marks)}/${Number(p.max_marks)}.`);
        }
      }
      await audit(tx, a, a.tenantId, `exam.${decision}`, 'exam_paper', id, p.campus_id);
      return { decision };
    });
  }

  @Post('exam-papers/:id/revaluations')
  requestReval(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(z.object({ studentId: uuid, reason: z.string().min(5).max(500) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const p = await this.paper(tx, a, id);
      if (p.status !== 'approved') throw new ConflictException({ error: 'results_not_published' });
      const { rows: [s] } = await tx.query('select * from students where id = $1', [b.studentId]);
      const acc = s && await studentAccess(tx, a, s);
      if (!s || (acc !== 'guardian' && acc !== 'self')) throw new NotFoundException({ error: 'not_found' });
      const r = await tx.query('insert into revaluations(tenant_id, paper_id, student_id, requested_by, reason) values ($1,$2,$3,$4,$5) on conflict do nothing returning id', [a.tenantId, id, b.studentId, a.userId, b.reason]);
      if (!r.rowCount) throw new ConflictException({ error: 'already_requested' });
      return { id: r.rows[0].id };
    });
  }
  @Post('revaluations/:id/decision')
  decideReval(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(z.object({ decision: z.enum(['approve', 'reject']), newMarks: z.number().min(0).optional() }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [r] } = await tx.query('select r.*, p.course_id, p.max_marks, e.name as exam_name, s.campus_id from revaluations r join exam_papers p on p.id = r.paper_id join exams e on e.id = p.exam_id join courses c on c.id = p.course_id join sections s on s.id = c.section_id where r.id = $1 for update of r', [id]);
      if (!r) throw new NotFoundException({ error: 'not_found' });
      needs(a, 'grades.approve', r.campus_id);
      if (r.status !== 'requested') throw new ConflictException({ error: 'already_decided' });
      if (b.decision === 'approve') {
        if (b.newMarks === undefined || b.newMarks > Number(r.max_marks)) throw new UnprocessableEntityException({ error: 'valid_new_marks_required' });
        const { rows: [om] } = await tx.query(`select om.id, coalesce((select new_marks from official_mark_corrections c where c.official_mark_id = om.id order by id desc limit 1), om.marks) as current from official_marks om where om.student_id = $1 and om.course_id = $2 and om.assessment_name = $3`, [r.student_id, r.course_id, r.exam_name]);
        if (!om) throw new NotFoundException({ error: 'no_official_mark' });
        await tx.query('insert into official_mark_corrections(tenant_id, official_mark_id, old_marks, new_marks, reason, approved_by) values ($1,$2,$3,$4,$5,$6)', [a.tenantId, om.id, om.current, b.newMarks, `Re-evaluation: ${r.reason}`, a.userId]);
        await notify(tx, a.tenantId, await guardianUserIds(tx, r.student_id), 'results.revised', 'Result revised', `${r.exam_name} marks revised to ${b.newMarks}/${Number(r.max_marks)} after re-evaluation.`);
      }
      await tx.query('update revaluations set status = $2, new_marks = $3, decided_by = $4, decided_at = now() where id = $1', [id, b.decision === 'approve' ? 'approved' : 'rejected', b.newMarks ?? null, a.userId]);
      await audit(tx, a, a.tenantId, `exam.reval_${b.decision}`, 'revaluation', id, r.campus_id);
      return { decision: b.decision };
    });
  }

  private async paper(tx: Tx, a: AuthContext, id: string) {
    const { rows: [p] } = await tx.query(`select p.*, e.name as exam_name, e.academic_year_id, c.teacher_user_id, s.campus_id from exam_papers p join exams e on e.id = p.exam_id join courses c on c.id = p.course_id join sections s on s.id = c.section_id where p.id = $1`, [id]);
    if (!p) throw new NotFoundException({ error: 'not_found' });
    return p;
  }
}
