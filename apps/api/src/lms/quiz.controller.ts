import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'crypto';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { Auth, AuthContext, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { staffCourse, studentCourse } from './access';

const questionS = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mcq'), prompt: z.string().min(1).max(2000), options: z.array(z.string().min(1).max(500)).min(2).max(8), answerKey: z.number().int().min(0), points: z.number().positive().max(100) }),
  z.object({ kind: z.literal('short'), prompt: z.string().min(1).max(2000), answerKey: z.array(z.string().min(1).max(200)).min(1).max(10), points: z.number().positive().max(100) }),
]);
const quizS = z.object({
  title: z.string().min(1).max(200), opensAt: z.string().datetime(), closesAt: z.string().datetime(),
  timeLimitMinutes: z.number().int().min(1).max(300), attemptsAllowed: z.number().int().min(1).max(10).default(1), questions: z.array(questionS).min(1).max(100),
});
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const GRACE_MS = 30_000;

/** Deterministic per-attempt shuffle so a refresh shows the same order. */
function shuffled<T>(items: T[], seed: string): T[] {
  return items.map((it, i) => ({ it, k: createHash('sha256').update(`${seed}:${i}`).digest('hex') })).sort((x, y) => (x.k < y.k ? -1 : 1)).map((x) => x.it);
}

@Controller()
export class QuizController {
  constructor(private db: DbService) {}

  @Post('courses/:id/quizzes')
  create(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const b = parse(quizS, body);
    if (Date.parse(b.closesAt) <= Date.parse(b.opensAt)) throw new UnprocessableEntityException({ error: 'closes_before_opens' });
    return this.db.withTenant(a.tenantId, async (tx) => {
      const c = await staffCourse(tx, a, id);
      for (const q of b.questions) if (q.kind === 'mcq' && q.answerKey >= q.options.length) throw new UnprocessableEntityException({ error: 'answer_key_out_of_range' });
      const { rows: [qz] } = await tx.query('insert into quizzes(tenant_id, course_id, title, opens_at, closes_at, time_limit_minutes, attempts_allowed, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, title',
        [a.tenantId, id, b.title, b.opensAt, b.closesAt, b.timeLimitMinutes, b.attemptsAllowed, a.userId]);
      let pos = 1;
      for (const q of b.questions)
        await tx.query('insert into quiz_questions(tenant_id, quiz_id, position, kind, prompt, options, answer_key, points) values ($1,$2,$3,$4,$5,$6,$7,$8)',
          [a.tenantId, qz.id, pos++, q.kind, q.prompt, q.kind === 'mcq' ? JSON.stringify(q.options) : null, JSON.stringify(q.answerKey), q.points]);
      await audit(tx, a, a.tenantId, 'lms.quiz_create', 'quiz', qz.id, c.campus_id);
      return qz;
    });
  }

  @Post('quizzes/:id/publish')
  publish(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [q] } = await tx.query('select * from quizzes where id = $1', [id]);
      if (!q) throw new NotFoundException({ error: 'not_found' });
      await staffCourse(tx, a, q.course_id);
      await tx.query('update quizzes set published = true where id = $1', [id]);
      return { published: true };
    });
  }

  /** Teacher view includes answer keys; students never receive them. */
  @Get('quizzes/:id')
  get(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [q] } = await tx.query('select * from quizzes where id = $1', [id]);
      if (!q) throw new NotFoundException({ error: 'not_found' });
      await staffCourse(tx, a, q.course_id);
      const questions = (await tx.query('select id, position, kind, prompt, options, answer_key, points from quiz_questions where quiz_id = $1 order by position', [id])).rows;
      return { ...q, questions };
    });
  }

  @Post('quizzes/:id/attempts')
  start(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [q] } = await tx.query('select * from quizzes where id = $1 and published', [id]);
      if (!q) throw new NotFoundException({ error: 'not_found' });
      const { student } = await studentCourse(tx, a, q.course_id);
      const now = new Date();
      if (now < q.opens_at) throw new UnprocessableEntityException({ error: 'not_open_yet' });
      if (now > q.closes_at) throw new UnprocessableEntityException({ error: 'closed' });
      await tx.query('select id from students where id = $1 for update', [student.id]); // serialize attempt creation
      const { rows: [open] } = await tx.query('select * from quiz_attempts where quiz_id = $1 and student_id = $2 and submitted_at is null and deadline_at > now()', [id, student.id]);
      let attempt = open;
      if (!attempt) {
        const used = (await tx.query('select count(*)::int n from quiz_attempts where quiz_id = $1 and student_id = $2', [id, student.id])).rows[0].n;
        if (used >= q.attempts_allowed) throw new ConflictException({ error: 'attempt_limit_reached', attemptsAllowed: q.attempts_allowed });
        const deadline = new Date(Math.min(now.getTime() + q.time_limit_minutes * 60_000, q.closes_at.getTime()));
        ({ rows: [attempt] } = await tx.query('insert into quiz_attempts(tenant_id, quiz_id, student_id, attempt_no, deadline_at) values ($1,$2,$3,$4,$5) returning *', [a.tenantId, id, student.id, used + 1, deadline]));
      }
      const qs = (await tx.query('select id, position, kind, prompt, options, points from quiz_questions where quiz_id = $1 order by position', [id])).rows;
      return {
        attemptId: attempt.id, attemptNo: attempt.attempt_no, deadlineAt: attempt.deadline_at,
        questions: shuffled(qs, attempt.id).map((x) => ({
          id: x.id, kind: x.kind, prompt: x.prompt, points: Number(x.points),
          options: x.options ? shuffled((x.options as string[]).map((text, i) => ({ id: i, text })), `${attempt.id}:${x.id}`) : undefined,
        })),
      };
    });
  }

  @Post('attempts/:id/submit')
  submit(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id);
    const { answers } = parse(z.object({ answers: z.record(uuid, z.union([z.number().int(), z.string().max(1000)])) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [at] } = await tx.query('select at.*, s.user_id from quiz_attempts at join students s on s.id = at.student_id where at.id = $1 for update of at', [id]);
      if (!at || at.user_id !== a.userId) throw new NotFoundException({ error: 'not_found' });
      if (at.submitted_at) throw new ConflictException({ error: 'already_submitted' });
      if (Date.now() > at.deadline_at.getTime() + GRACE_MS) throw new UnprocessableEntityException({ error: 'time_expired' });
      const qs = (await tx.query('select id, kind, answer_key, points from quiz_questions where quiz_id = $1', [at.quiz_id])).rows;
      let score = 0, max = 0;
      for (const q of qs) {
        max += Number(q.points);
        const given = answers[q.id];
        if (given === undefined) continue;
        if (q.kind === 'mcq' && given === q.answer_key) score += Number(q.points);
        if (q.kind === 'short' && typeof given === 'string' && (q.answer_key as string[]).some((k) => norm(k) === norm(given))) score += Number(q.points);
      }
      await tx.query('update quiz_attempts set submitted_at = now(), answers = $2, auto_score = $3 where id = $1', [id, JSON.stringify(answers), score]);
      return { score, maxScore: max };
    });
  }

  @Get('quizzes/:id/analytics')
  analytics(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [q] } = await tx.query('select * from quizzes where id = $1', [id]);
      if (!q) throw new NotFoundException({ error: 'not_found' });
      await staffCourse(tx, a, q.course_id);
      const attempts = (await tx.query('select answers, auto_score from quiz_attempts where quiz_id = $1 and submitted_at is not null', [id])).rows;
      const qs = (await tx.query('select id, position, kind, prompt, answer_key from quiz_questions where quiz_id = $1 order by position', [id])).rows;
      const items = qs.map((x) => {
        const correct = attempts.filter((at) => {
          const g = (at.answers ?? {})[x.id];
          if (g === undefined) return false;
          return x.kind === 'mcq' ? g === x.answer_key : typeof g === 'string' && (x.answer_key as string[]).some((k) => norm(k) === norm(g));
        }).length;
        return { questionId: x.id, position: x.position, prompt: x.prompt, correctRate: attempts.length ? Math.round((correct / attempts.length) * 100) : null };
      });
      const avg = attempts.length ? attempts.reduce((t, r) => t + Number(r.auto_score), 0) / attempts.length : null;
      return { attempts: attempts.length, averageScore: avg, items };
    });
  }
}
