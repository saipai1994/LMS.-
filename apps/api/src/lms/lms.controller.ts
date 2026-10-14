import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Put, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, can, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { guardianUserIds, notify, studentAccess } from '../sis/access';
import { myStudent, staffCourse, studentCourse } from './access';

const lessonS = z.object({
  title: z.string().min(1).max(200), unit: z.string().max(100).optional(), body: z.string().max(20000).optional(),
  externalUrl: z.string().url().regex(/^https?:\/\//).optional(), position: z.number().int().min(0).default(0),
  releaseAt: z.string().datetime().optional(), prerequisiteLessonId: uuid.optional(), published: z.boolean().default(false), fileIds: z.array(uuid).max(10).default([]),
});
const asgS = z.object({
  title: z.string().min(1).max(200), instructions: z.string().max(10000).default(''), dueAt: z.string().datetime(),
  maxMarks: z.number().positive().max(10000), allowLate: z.boolean().default(true), published: z.boolean().default(false), studentIds: z.array(uuid).max(500).optional(),
});
const subS = z.object({ answerText: z.string().max(20000).default(''), submit: z.boolean().default(false), fileIds: z.array(uuid).max(10).default([]) });
const gradeS = z.object({ marks: z.number().min(0), feedback: z.string().max(5000).optional() });

@Controller()
export class LmsController {
  constructor(private db: DbService) {}

  private async linkFiles(tx: Tx, a: AuthContext, fileIds: string[], type: 'lesson' | 'submission', entityId: string) {
    for (const fid of fileIds) {
      const own = await tx.query('select 1 from files where id = $1 and uploaded_by = $2', [fid, a.userId]);
      if (!own.rowCount) throw new UnprocessableEntityException({ error: 'file_not_owned', fileId: fid });
      await tx.query('insert into file_links(tenant_id, file_id, entity_type, entity_id) values ($1,$2,$3,$4) on conflict do nothing', [a.tenantId, fid, type, entityId]);
    }
  }

  // ---------------- lessons ----------------
  @Post('courses/:id/lessons')
  createLesson(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(lessonS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const c = await staffCourse(tx, a, id);
      if (b.prerequisiteLessonId) {
        const ok = await tx.query('select 1 from lessons where id = $1 and course_id = $2', [b.prerequisiteLessonId, id]);
        if (!ok.rowCount) throw new UnprocessableEntityException({ error: 'invalid_prerequisite' });
      }
      const { rows: [l] } = await tx.query('insert into lessons(tenant_id, course_id, unit, title, body, external_url, position, release_at, prerequisite_lesson_id, published, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id, title, published',
        [a.tenantId, id, b.unit ?? null, b.title, b.body ?? null, b.externalUrl ?? null, b.position, b.releaseAt ?? null, b.prerequisiteLessonId ?? null, b.published, a.userId]);
      await this.linkFiles(tx, a, b.fileIds, 'lesson', l.id);
      await audit(tx, a, a.tenantId, 'lms.lesson_create', 'lesson', l.id, c.campus_id);
      return l;
    });
  }

  @Get('courses/:id/lessons')
  lessons(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [c] } = await tx.query('select c.*, s.campus_id from courses c join sections s on s.id = c.section_id where c.id = $1 and c.tenant_id = $2', [id, a.tenantId]);
      if (!c) throw new NotFoundException({ error: 'not_found' });
      const staff = c.teacher_user_id === a.userId || can(a, 'course.manage', c.campus_id);
      if (staff) return (await tx.query('select l.*, (select coalesce(json_agg(file_id), \'[]\') from file_links where entity_id = l.id and entity_type = \'lesson\') as file_ids from lessons l where course_id = $1 and tenant_id = $2 order by position, created_at', [id, a.tenantId])).rows;
      const { student } = await studentCourse(tx, a, id);
      const rows = (await tx.query(
        `select l.id, l.unit, l.title, l.position, l.release_at, l.body, l.external_url, l.prerequisite_lesson_id,
           (lp.student_id is not null) as completed,
           (l.release_at is not null and l.release_at > now()) as not_yet_released,
           (l.prerequisite_lesson_id is not null and not exists (select 1 from lesson_progress p where p.lesson_id = l.prerequisite_lesson_id and p.student_id = $2)) as prerequisite_pending,
           (select coalesce(json_agg(file_id), '[]') from file_links where entity_id = l.id and entity_type = 'lesson') as file_ids
         from lessons l left join lesson_progress lp on lp.lesson_id = l.id and lp.student_id = $2
         where l.course_id = $1 and l.tenant_id = $3 and l.published order by l.position, l.created_at`, [id, student.id, a.tenantId])).rows;
      return rows.map((r) => {
        const locked = r.not_yet_released || r.prerequisite_pending;
        return locked ? { id: r.id, unit: r.unit, title: r.title, locked: true, reason: r.not_yet_released ? 'not_yet_released' : 'prerequisite_pending', release_at: r.release_at }
                      : { id: r.id, unit: r.unit, title: r.title, body: r.body, external_url: r.external_url, file_ids: r.file_ids, completed: r.completed, locked: false };
      });
    });
  }

  @Post('lessons/:id/complete')
  completeLesson(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [l] } = await tx.query('select * from lessons where id = $1 and published', [id]);
      if (!l) throw new NotFoundException({ error: 'not_found' });
      const { student } = await studentCourse(tx, a, l.course_id);
      if (l.release_at && l.release_at > new Date()) throw new UnprocessableEntityException({ error: 'not_yet_released' });
      if (l.prerequisite_lesson_id && !(await tx.query('select 1 from lesson_progress where lesson_id = $1 and student_id = $2', [l.prerequisite_lesson_id, student.id])).rowCount)
        throw new UnprocessableEntityException({ error: 'prerequisite_pending' });
      await tx.query('insert into lesson_progress(tenant_id, lesson_id, student_id) values ($1,$2,$3) on conflict do nothing', [a.tenantId, id, student.id]);
      return { completed: true };
    });
  }

  // ---------------- assignments ----------------
  @Post('courses/:id/assignments')
  createAssignment(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(asgS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const c = await staffCourse(tx, a, id);
      const { rows: [x] } = await tx.query('insert into assignments(tenant_id, course_id, title, instructions, due_at, max_marks, allow_late, published, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, title, published, due_at',
        [a.tenantId, id, b.title, b.instructions, b.dueAt, b.maxMarks, b.allowLate, b.published, a.userId]);
      for (const sid of b.studentIds ?? []) {
        const ok = await tx.query(`select 1 from course_enrollments where course_id = $1 and student_id = $2 and status = 'active'`, [id, sid]);
        if (!ok.rowCount) throw new UnprocessableEntityException({ error: 'student_not_in_course', studentId: sid });
        await tx.query('insert into assignment_targets(tenant_id, assignment_id, student_id) values ($1,$2,$3)', [a.tenantId, x.id, sid]);
      }
      await audit(tx, a, a.tenantId, 'lms.assignment_create', 'assignment', x.id, c.campus_id);
      return x;
    });
  }

  @Post('assignments/:id/publish')
  publishAssignment(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [x] } = await tx.query('select * from assignments where id = $1', [id]);
      if (!x) throw new NotFoundException({ error: 'not_found' });
      await staffCourse(tx, a, x.course_id);
      await tx.query('update assignments set published = true where id = $1', [id]);
      const targets = (await tx.query(
        `select s.id from students s join course_enrollments ce on ce.student_id = s.id and ce.course_id = $1 and ce.status = 'active'
         where not exists (select 1 from assignment_targets t where t.assignment_id = $2) or exists (select 1 from assignment_targets t where t.assignment_id = $2 and t.student_id = s.id)`, [x.course_id, id])).rows;
      for (const t of targets) {
        const users = [...(await guardianUserIds(tx, t.id)), ...((await tx.query('select user_id from students where id = $1 and user_id is not null', [t.id])).rows.map((r) => r.user_id))];
        await notify(tx, a.tenantId, users, 'lms.assignment', 'New assignment', `${x.title} is due ${new Date(x.due_at).toISOString().slice(0, 10)}.`);
      }
      return { published: true, notified: targets.length };
    });
  }

  @Get('courses/:id/assignments')
  assignments(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [c] } = await tx.query('select c.*, s.campus_id from courses c join sections s on s.id = c.section_id where c.id = $1', [id]);
      if (!c) throw new NotFoundException({ error: 'not_found' });
      if (c.teacher_user_id === a.userId || can(a, 'course.manage', c.campus_id))
        return (await tx.query(`select x.*, (select count(*) from submissions s where s.assignment_id = x.id and s.status <> 'draft')::int as submitted from assignments x where course_id = $1 order by due_at desc`, [id])).rows;
      const { student } = await studentCourse(tx, a, id);
      return this.studentAssignments(tx, student.id, id);
    });
  }

  private async studentAssignments(tx: Tx, studentId: string, courseId?: string) {
    return (await tx.query(
      `select x.id, x.course_id, c.title as course, x.title, x.instructions, x.due_at, x.max_marks, x.allow_late,
         coalesce(s.status, 'not_started') as status, s.is_late, s.marks, s.feedback, s.submitted_at,
         (coalesce(s.status, 'not_started') in ('not_started','draft','returned') and x.due_at < now()) as missing
       from assignments x join courses c on c.id = x.course_id join course_enrollments ce on ce.course_id = x.course_id and ce.student_id = $1 and ce.status = 'active'
       left join submissions s on s.assignment_id = x.id and s.student_id = $1
       where x.published and ($2::uuid is null or x.course_id = $2)
         and (not exists (select 1 from assignment_targets t where t.assignment_id = x.id) or exists (select 1 from assignment_targets t where t.assignment_id = x.id and t.student_id = $1))
       order by x.due_at desc`, [studentId, courseId ?? null])).rows;
  }

  /** Student: save a draft or submit (and resubmit until graded). */
  @Put('assignments/:id/submission')
  submit(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(subS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [x] } = await tx.query('select * from assignments where id = $1 and published', [id]);
      if (!x) throw new NotFoundException({ error: 'not_found' });
      const { student } = await studentCourse(tx, a, x.course_id);
      const targeted = await tx.query('select 1 from assignment_targets where assignment_id = $1', [id]);
      if (targeted.rowCount && !(await tx.query('select 1 from assignment_targets where assignment_id = $1 and student_id = $2', [id, student.id])).rowCount) throw new NotFoundException({ error: 'not_found' });
      const { rows: [ex] } = await tx.query('select * from submissions where assignment_id = $1 and student_id = $2 for update', [id, student.id]);
      if (ex && ex.status === 'graded') throw new ConflictException({ error: 'already_graded' });
      const late = new Date(x.due_at) < new Date();
      if (b.submit && late && !x.allow_late) throw new UnprocessableEntityException({ error: 'deadline_passed' });
      const version = (ex?.version ?? 0) + (b.submit ? 1 : 0);
      const status = b.submit ? 'submitted' : (ex?.status === 'returned' ? 'returned' : (ex?.status === 'submitted' ? 'submitted' : 'draft'));
      let sub;
      if (ex) ({ rows: [sub] } = await tx.query('update submissions set answer_text = $2, status = $3, version = $4, submitted_at = case when $5 then now() else submitted_at end, is_late = case when $5 then $6 else is_late end where id = $1 returning id, status, version, is_late', [ex.id, b.answerText, status, version, b.submit, late]));
      else ({ rows: [sub] } = await tx.query('insert into submissions(tenant_id, assignment_id, student_id, answer_text, status, version, submitted_at, is_late) values ($1,$2,$3,$4,$5,$6,case when $7 then now() end,$8) returning id, status, version, is_late', [a.tenantId, id, student.id, b.answerText, status, version, b.submit, b.submit && late]));
      await this.linkFiles(tx, a, b.fileIds, 'submission', sub.id);
      if (b.submit) await tx.query(`insert into submission_history(tenant_id, submission_id, event, version, answer_text, actor_user_id) values ($1,$2,'submitted',$3,$4,$5)`, [a.tenantId, sub.id, version, b.answerText, a.userId]);
      return sub;
    });
  }

  @Get('assignments/:id/submissions')
  submissions(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [x] } = await tx.query('select * from assignments where id = $1', [id]);
      if (!x) throw new NotFoundException({ error: 'not_found' });
      await staffCourse(tx, a, x.course_id);
      return (await tx.query(
        `select st.id as student_id, st.admission_no, st.first_name, st.last_name, sub.id as submission_id, coalesce(sub.status, 'not_submitted') as status, sub.is_late, sub.marks, sub.version, sub.answer_text, sub.submitted_at,
           (select coalesce(json_agg(file_id), '[]') from file_links where entity_id = sub.id and entity_type = 'submission') as file_ids
         from course_enrollments ce join students st on st.id = ce.student_id left join submissions sub on sub.assignment_id = $1 and sub.student_id = st.id
         where ce.course_id = $2 and ce.status = 'active'
           and (not exists (select 1 from assignment_targets t where t.assignment_id = $1) or exists (select 1 from assignment_targets t where t.assignment_id = $1 and t.student_id = st.id))
         order by st.last_name`, [id, x.course_id])).rows;
    });
  }

  @Post('submissions/:id/grade')
  grade(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(gradeS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select s.*, x.course_id, x.max_marks, x.title from submissions s join assignments x on x.id = s.assignment_id where s.id = $1 for update of s', [id]);
      if (!s) throw new NotFoundException({ error: 'not_found' });
      await staffCourse(tx, a, s.course_id);
      if (s.status === 'draft') throw new ConflictException({ error: 'not_submitted' });
      if (b.marks > Number(s.max_marks)) throw new UnprocessableEntityException({ error: 'exceeds_max_marks', maxMarks: Number(s.max_marks) });
      await tx.query(`update submissions set marks = $2, feedback = $3, status = 'graded', graded_by = $4, graded_at = now() where id = $1`, [id, b.marks, b.feedback ?? null, a.userId]);
      await tx.query(`insert into submission_history(tenant_id, submission_id, event, version, marks, feedback, actor_user_id) values ($1,$2,'graded',$3,$4,$5,$6)`, [a.tenantId, id, s.version, b.marks, b.feedback ?? null, a.userId]);
      const users = [...(await guardianUserIds(tx, s.student_id)), ...((await tx.query('select user_id from students where id = $1 and user_id is not null', [s.student_id])).rows.map((r) => r.user_id))];
      await notify(tx, a.tenantId, users, 'lms.graded', 'Work graded', `${s.title}: ${b.marks}/${Number(s.max_marks)}.`);
      await audit(tx, a, a.tenantId, 'lms.grade', 'submission', id, null, { marks: b.marks });
      return { status: 'graded', marks: b.marks };
    });
  }

  @Post('submissions/:id/return')
  returnForRevision(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const { feedback } = parse(z.object({ feedback: z.string().min(3).max(2000) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select s.*, x.course_id from submissions s join assignments x on x.id = s.assignment_id where s.id = $1 for update of s', [id]);
      if (!s) throw new NotFoundException({ error: 'not_found' });
      await staffCourse(tx, a, s.course_id);
      if (s.status === 'draft') throw new ConflictException({ error: 'not_submitted' });
      await tx.query(`update submissions set status = 'returned', feedback = $2, marks = null, graded_by = null, graded_at = null where id = $1`, [id, feedback]);
      await tx.query(`insert into submission_history(tenant_id, submission_id, event, version, feedback, actor_user_id) values ($1,$2,'returned',$3,$4,$5)`, [a.tenantId, id, s.version, feedback, a.userId]);
      return { status: 'returned' };
    });
  }

  @Get('submissions/:id/history')
  history(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select s.*, x.course_id from submissions s join assignments x on x.id = s.assignment_id where s.id = $1', [id]);
      if (!s) throw new NotFoundException({ error: 'not_found' });
      const mine = (await myStudent(tx, a))?.id === s.student_id;
      if (!mine) await staffCourse(tx, a, s.course_id);
      return (await tx.query('select event, version, answer_text, marks, feedback, at from submission_history where submission_id = $1 order by id', [id])).rows;
    });
  }

  @Get('courses/:id/gradebook')
  gradebook(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      await staffCourse(tx, a, id);
      const assignments = (await tx.query('select id, title, max_marks, due_at from assignments where course_id = $1 and published order by due_at', [id])).rows;
      const rows = (await tx.query(
        `select st.id as student_id, st.admission_no, st.first_name, st.last_name,
           (select coalesce(json_object_agg(sub.assignment_id, json_build_object('status', sub.status, 'marks', sub.marks, 'late', sub.is_late)), '{}') from submissions sub join assignments x on x.id = sub.assignment_id where sub.student_id = st.id and x.course_id = $1) as work
         from course_enrollments ce join students st on st.id = ce.student_id where ce.course_id = $1 and ce.status = 'active' order by st.last_name`, [id])).rows;
      return { assignments, students: rows };
    });
  }

  @Get('courses/:id/missing-work')
  missing(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      await staffCourse(tx, a, id);
      return (await tx.query(
        `select x.id as assignment_id, x.title, x.due_at, st.id as student_id, st.first_name, st.last_name
         from assignments x join course_enrollments ce on ce.course_id = x.course_id and ce.status = 'active' join students st on st.id = ce.student_id
         left join submissions sub on sub.assignment_id = x.id and sub.student_id = st.id
         where x.course_id = $1 and x.published and x.due_at < now() and coalesce(sub.status, 'draft') in ('draft','returned')
           and (not exists (select 1 from assignment_targets t where t.assignment_id = x.id) or exists (select 1 from assignment_targets t where t.assignment_id = x.id and t.student_id = st.id))
         order by x.due_at, st.last_name`, [id])).rows;
    });
  }

  /** Parent/student/staff view of a student's homework and marks across courses. */
  @Get('students/:id/learning')
  learning(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      if (!s || !(await studentAccess(tx, a, s))) throw new NotFoundException({ error: 'not_found' });
      const work = await this.studentAssignments(tx, id);
      return { assignments: work, missing: work.filter((w) => w.missing).length };
    });
  }

  @Get('me/learning')
  myLearning(@Auth() a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => {
      const st = await myStudent(tx, a);
      if (!st) throw new NotFoundException({ error: 'no_student_profile' });
      return { assignments: await this.studentAssignments(tx, st.id) };
    });
  }
}
