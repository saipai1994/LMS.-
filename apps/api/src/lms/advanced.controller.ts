import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, can, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { guardianUserIds, notify, studentAccess } from '../sis/access';
import { myStudent, staffCourse, studentCourse } from './access';

const LEVELS = ['', 'emerging', 'developing', 'proficient', 'mastered'];

@Controller()
export class AdvancedLearningController {
  constructor(private db: DbService) {}

  // ---------------- moderated discussions ----------------
  @Post('courses/:id/threads')
  openThread(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(z.object({ title: z.string().min(3).max(200), moderated: z.boolean().default(true) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      await staffCourse(tx, a, id);
      return (await tx.query('insert into discussion_threads(tenant_id, course_id, title, moderated, created_by) values ($1,$2,$3,$4,$5) returning id, title, moderated', [a.tenantId, id, b.title, b.moderated, a.userId])).rows[0];
    });
  }
  private async threadAccess(tx: Tx, a: AuthContext, threadId: string) {
    const { rows: [t] } = await tx.query('select t.*, c.teacher_user_id, sec.campus_id from discussion_threads t join courses c on c.id = t.course_id join sections sec on sec.id = c.section_id where t.id = $1', [threadId]);
    if (!t) throw new NotFoundException({ error: 'not_found' });
    const staff = t.teacher_user_id === a.userId || can(a, 'course.manage', t.campus_id);
    if (!staff) { await studentCourse(tx, a, t.course_id); }
    return { t, staff };
  }
  @Get('courses/:id/threads')
  threads(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [c] } = await tx.query('select c.*, s.campus_id from courses c join sections s on s.id = c.section_id where c.id = $1', [id]);
      if (!c) throw new NotFoundException({ error: 'not_found' });
      if (!(c.teacher_user_id === a.userId || can(a, 'course.manage', c.campus_id))) await studentCourse(tx, a, id);
      return (await tx.query(`select t.id, t.title, t.moderated, t.locked, (select count(*) from discussion_posts p where p.thread_id = t.id and p.status = 'approved')::int as posts from discussion_threads t where t.course_id = $1 order by t.created_at desc`, [id])).rows;
    });
  }
  @Get('threads/:id')
  thread(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { t, staff } = await this.threadAccess(tx, a, id);
      const posts = (await tx.query(`select p.id, p.body, p.status, p.created_at, u.full_name as author, (p.author_user_id = $2) as mine from discussion_posts p join users u on u.id = p.author_user_id where p.thread_id = $1 and ($3::boolean or p.status = 'approved' or (p.author_user_id = $2 and p.status = 'pending')) order by p.created_at`, [id, a.userId, staff])).rows;
      return { id: t.id, title: t.title, locked: t.locked, moderated: t.moderated, posts };
    });
  }
  /** Student posts in a moderated thread wait for teacher approval; teacher posts are published immediately. */
  @Post('threads/:id/posts')
  post(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(z.object({ body: z.string().min(1).max(4000) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { t, staff } = await this.threadAccess(tx, a, id);
      if (t.locked) throw new ConflictException({ error: 'thread_locked' });
      const status = staff || !t.moderated ? 'approved' : 'pending';
      const p = (await tx.query('insert into discussion_posts(tenant_id, thread_id, author_user_id, body, status) values ($1,$2,$3,$4,$5) returning id, status', [a.tenantId, id, a.userId, b.body, status])).rows[0];
      return p;
    });
  }
  @Post('posts/:id/moderate')
  moderate(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const { action } = parse(z.object({ action: z.enum(['approve', 'remove']) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [p] } = await tx.query('select p.*, t.course_id from discussion_posts p join discussion_threads t on t.id = p.thread_id where p.id = $1 for update of p', [id]);
      if (!p) throw new NotFoundException({ error: 'not_found' });
      await staffCourse(tx, a, p.course_id);
      await tx.query('update discussion_posts set status = $2, moderated_by = $3 where id = $1', [id, action === 'approve' ? 'approved' : 'removed', a.userId]);
      await audit(tx, a, a.tenantId, `lms.post_${action}`, 'post', id);
      return { status: action === 'approve' ? 'approved' : 'removed' };
    });
  }

  // ---------------- competencies ----------------
  @Post('competencies')
  addCompetency(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'academic.manage'); const b = parse(z.object({ subjectId: uuid, code: z.string().min(2).max(30), description: z.string().min(5).max(300) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('insert into competencies(tenant_id, subject_id, code, description) values ($1,$2,$3,$4) returning id, code', [a.tenantId, b.subjectId, b.code, b.description])).rows[0]);
  }
  /** A teacher who teaches this student's course in the competency's subject records a level with evidence. */
  @Post('competency-assessments')
  assess(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(z.object({ studentId: uuid, competencyId: uuid, level: z.number().int().min(1).max(4), evidence: z.string().min(3).max(500) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const ok = await tx.query(`select 1 from competencies k join courses c on c.subject_id = k.subject_id join course_enrollments ce on ce.course_id = c.id and ce.student_id = $2 and ce.status = 'active' where k.id = $1 and c.teacher_user_id = $3`, [b.competencyId, b.studentId, a.userId]);
      if (!ok.rowCount) throw new NotFoundException({ error: 'not_found' });
      await tx.query('insert into competency_assessments(tenant_id, student_id, competency_id, level, evidence, assessed_by) values ($1,$2,$3,$4,$5,$6)', [a.tenantId, b.studentId, b.competencyId, b.level, b.evidence, a.userId]);
      return { level: LEVELS[b.level] };
    });
  }
  @Get('students/:id/competencies')
  competencies(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      if (!s || !(await studentAccess(tx, a, s))) throw new NotFoundException({ error: 'not_found' });
      const rows = (await tx.query(`select k.code, k.description, sub.name as subject, h.level, h.evidence, h.at, (select count(*) from competency_assessments x where x.student_id = h.student_id and x.competency_id = h.competency_id)::int as assessments
        from (select distinct on (competency_id) * from competency_assessments where student_id = $1 order by competency_id, id desc) h join competencies k on k.id = h.competency_id join subjects sub on sub.id = k.subject_id order by sub.name, k.code`, [id])).rows;
      return rows.map((r) => ({ ...r, levelName: LEVELS[r.level] }));
    });
  }

  // ---------------- remedial / enrichment plans, at-risk detection ----------------
  @Get('courses/:id/at-risk')
  atRisk(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      await staffCourse(tx, a, id);
      return (await tx.query(
        `select st.id as student_id, st.first_name, st.last_name,
           coalesce(round(100.0 * sum(sub.marks) filter (where sub.status = 'graded') / nullif(sum(x.max_marks) filter (where sub.status = 'graded'), 0), 1), null) as average_percent,
           count(*) filter (where x.due_at < now() and coalesce(sub.status, 'draft') in ('draft','returned'))::int as missing
         from course_enrollments ce join students st on st.id = ce.student_id join assignments x on x.course_id = ce.course_id and x.published
         left join submissions sub on sub.assignment_id = x.id and sub.student_id = st.id where ce.course_id = $1 and ce.status = 'active' group by st.id
         having (sum(sub.marks) filter (where sub.status = 'graded') / nullif(sum(x.max_marks) filter (where sub.status = 'graded'), 0) * 100 < 40) or count(*) filter (where x.due_at < now() and coalesce(sub.status, 'draft') in ('draft','returned')) >= 2
         order by average_percent nulls last`, [id])).rows.map((r) => ({ ...r, average_percent: r.average_percent === null ? null : Number(r.average_percent) }));
    });
  }
  @Post('learning-plans')
  plan(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(z.object({ studentId: uuid, courseId: uuid, kind: z.enum(['remedial', 'enrichment']), goal: z.string().min(5).max(500), startsOn: z.string().date(), endsOn: z.string().date() }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      await staffCourse(tx, a, b.courseId);
      if (!(await tx.query(`select 1 from course_enrollments where course_id = $1 and student_id = $2 and status = 'active'`, [b.courseId, b.studentId])).rowCount) throw new UnprocessableEntityException({ error: 'student_not_in_course' });
      const p = (await tx.query('insert into learning_plans(tenant_id, student_id, course_id, kind, goal, starts_on, ends_on, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, status', [a.tenantId, b.studentId, b.courseId, b.kind, b.goal, b.startsOn, b.endsOn, a.userId])).rows[0];
      await notify(tx, a.tenantId, await guardianUserIds(tx, b.studentId), 'learning.plan', b.kind === 'remedial' ? 'Support plan started' : 'Enrichment plan started', b.goal);
      return p;
    });
  }
  @Post('learning-plans/:id/close')
  closePlan(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(z.object({ status: z.enum(['completed', 'cancelled']), outcome: z.string().min(3).max(500) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [p] } = await tx.query('select * from learning_plans where id = $1 for update', [id]);
      if (!p) throw new NotFoundException({ error: 'not_found' });
      await staffCourse(tx, a, p.course_id);
      if (p.status !== 'active') throw new ConflictException({ error: 'not_active' });
      await tx.query('update learning_plans set status = $2, outcome = $3 where id = $1', [id, b.status, b.outcome]);
      return { status: b.status };
    });
  }
  @Get('students/:id/learning-plans')
  plans(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      const acc = s && await studentAccess(tx, a, s);
      if (!s || !acc) throw new NotFoundException({ error: 'not_found' });
      return (await tx.query(`select p.id, p.kind, p.goal, p.starts_on, p.ends_on, p.status, p.outcome, c.title as course from learning_plans p join courses c on c.id = p.course_id where p.student_id = $1 and ($2 <> 'teacher' or c.teacher_user_id = $3) order by p.starts_on desc`, [id, acc, a.userId])).rows;
    });
  }

  // ---------------- portfolio ----------------
  @Post('me/portfolio')
  addPortfolio(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(z.object({ title: z.string().min(2).max(200), reflection: z.string().min(5).max(3000), fileId: uuid.optional() }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const st = await myStudent(tx, a);
      if (!st) throw new NotFoundException({ error: 'no_student_profile' });
      if (b.fileId && !(await tx.query('select 1 from files where id = $1 and uploaded_by = $2', [b.fileId, a.userId])).rowCount) throw new UnprocessableEntityException({ error: 'file_not_owned' });
      const e = (await tx.query('insert into portfolio_entries(tenant_id, student_id, title, reflection, file_id) values ($1,$2,$3,$4,$5) returning id', [a.tenantId, st.id, b.title, b.reflection, b.fileId ?? null])).rows[0];
      if (b.fileId) await tx.query(`insert into file_links(tenant_id, file_id, entity_type, entity_id) values ($1,$2,'portfolio',$3)`, [a.tenantId, b.fileId, e.id]);
      return e;
    });
  }
  @Get('students/:id/portfolio')
  portfolio(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      if (!s || !(await studentAccess(tx, a, s))) throw new NotFoundException({ error: 'not_found' });
      return (await tx.query('select id, title, reflection, file_id, teacher_comment, created_at from portfolio_entries where student_id = $1 order by created_at desc', [id])).rows;
    });
  }
  @Post('portfolio/:id/comment')
  commentPortfolio(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const { comment } = parse(z.object({ comment: z.string().min(2).max(1000) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [e] } = await tx.query('select e.*, s.campus_id from portfolio_entries e join students s on s.id = e.student_id where e.id = $1', [id]);
      const teaches = e && (await tx.query(`select 1 from course_enrollments ce join courses c on c.id = ce.course_id where ce.student_id = $1 and c.teacher_user_id = $2 and ce.status = 'active'`, [e.student_id, a.userId])).rowCount;
      if (!e || !teaches) throw new NotFoundException({ error: 'not_found' });
      await tx.query('update portfolio_entries set teacher_comment = $2, commented_by = $3 where id = $1', [id, comment, a.userId]);
      return { commented: true };
    });
  }

  // ---------------- course analytics ----------------
  @Get('courses/:id/analytics')
  analytics(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      await staffCourse(tx, a, id);
      const n = async (sql: string) => Number((await tx.query(sql, [id])).rows[0].n);
      const students = await n(`select count(*) n from course_enrollments where course_id = $1 and status = 'active'`);
      const lessons = await n(`select count(*) n from lessons where course_id = $1 and published`);
      const completions = await n(`select count(*) n from lesson_progress lp join lessons l on l.id = lp.lesson_id where l.course_id = $1`);
      const assignments = await n(`select count(*) n from assignments where course_id = $1 and published`);
      const submitted = await n(`select count(*) n from submissions s join assignments x on x.id = s.assignment_id where x.course_id = $1 and s.status in ('submitted','graded')`);
      const avg = (await tx.query(`select round(avg(s.marks / x.max_marks * 100), 1) a from submissions s join assignments x on x.id = s.assignment_id where x.course_id = $1 and s.status = 'graded'`, [id])).rows[0].a;
      const perAssignment = (await tx.query(`select x.title, count(*) filter (where s.status in ('submitted','graded'))::int as submitted, round(avg(s.marks / x.max_marks * 100) filter (where s.status = 'graded'), 1) as average_percent from assignments x left join submissions s on s.assignment_id = x.id where x.course_id = $1 and x.published group by x.id order by x.due_at`, [id])).rows;
      return {
        students, lessons, assignments,
        lessonCompletionPercent: students && lessons ? Math.round((completions / (students * lessons)) * 1000) / 10 : null,
        submissionRatePercent: students && assignments ? Math.round((submitted / (students * assignments)) * 1000) / 10 : null,
        averageGradePercent: avg === null ? null : Number(avg),
        perAssignment: perAssignment.map((p) => ({ ...p, average_percent: p.average_percent === null ? null : Number(p.average_percent) })),
      };
    });
  }
}
