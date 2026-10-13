import { Body, Controller, Get, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { Auth, AuthContext, parse, needs, pid, uuid, campusScope } from '../common/http';
import { audit } from '../common/audit';

const year = z.object({ name: z.string().min(1), startsOn: z.string().date(), endsOn: z.string().date(), isCurrent: z.boolean().default(false) });
const grade = z.object({ name: z.string().min(1), ordinal: z.number().int().min(-5).max(20) });
const subject = z.object({ code: z.string().min(1), name: z.string().min(1) });
const section = z.object({ campusId: uuid, academicYearId: uuid, gradeLevelId: uuid, name: z.string().min(1), capacity: z.number().int().min(1).max(500), classTeacherUserId: uuid.optional() });
const course = z.object({ sectionId: uuid, subjectId: uuid, teacherUserId: uuid.optional(), title: z.string().min(1) });

@Controller()
export class AcademicsController {
  constructor(private db: DbService) {}

  /** Campus-level overrides (dismissal time, lateness thresholds, timezone). Inherits tenant defaults when unset. */
  @Put('campuses/:id/settings')
  campusSettings(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); needs(a, 'campus.manage', id);
    const b = parse(z.object({ dismissalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(), lateGraceMinutes: z.number().int().min(0).max(240).optional(), lateEscalateMinutes: z.number().int().min(1).max(480).optional(), timezone: z.string().regex(/^[A-Za-z_]+\/[A-Za-z_]+$/).optional() }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const r = await tx.query(`update campuses set settings = settings || $2::jsonb where id = $1 returning settings`, [id, JSON.stringify(Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)))]);
      if (!r.rowCount) throw new NotFoundException({ error: 'not_found' });
      await audit(tx, a, a.tenantId, 'campus.settings', 'campus', id, id, b as any);
      return r.rows[0].settings;
    });
  }

  @Post('academic-years')
  createYear(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'academic.manage');
    const b = parse(year, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      if (b.isCurrent) await tx.query('update academic_years set is_current = false where tenant_id = $1', [a.tenantId]);
      const { rows: [r] } = await tx.query('insert into academic_years(tenant_id, name, starts_on, ends_on, is_current) values ($1,$2,$3,$4,$5) returning *', [a.tenantId, b.name, b.startsOn, b.endsOn, b.isCurrent]);
      await audit(tx, a, a.tenantId, 'academic_year.create', 'academic_year', r.id);
      return r;
    });
  }
  @Get('academic-years')
  listYears(@Auth() a: AuthContext) {
    needs(a, 'academic.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('select * from academic_years order by starts_on desc')).rows);
  }

  @Post('grade-levels')
  createGrade(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'academic.manage');
    const b = parse(grade, body);
    return this.db.withTenant(a.tenantId, async (tx) =>
      (await tx.query('insert into grade_levels(tenant_id, name, ordinal) values ($1,$2,$3) returning *', [a.tenantId, b.name, b.ordinal])).rows[0]);
  }
  @Get('grade-levels')
  listGrades(@Auth() a: AuthContext) {
    needs(a, 'academic.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('select * from grade_levels order by ordinal')).rows);
  }

  @Post('subjects')
  createSubject(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'academic.manage');
    const b = parse(subject, body);
    return this.db.withTenant(a.tenantId, async (tx) =>
      (await tx.query('insert into subjects(tenant_id, code, name) values ($1,$2,$3) returning *', [a.tenantId, b.code, b.name])).rows[0]);
  }

  @Post('sections')
  createSection(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(section, body);
    needs(a, 'academic.manage', b.campusId);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [r] } = await tx.query('insert into sections(tenant_id, campus_id, academic_year_id, grade_level_id, name, capacity, class_teacher_user_id) values ($1,$2,$3,$4,$5,$6,$7) returning *',
        [a.tenantId, b.campusId, b.academicYearId, b.gradeLevelId, b.name, b.capacity, b.classTeacherUserId ?? null]);
      await audit(tx, a, a.tenantId, 'section.create', 'section', r.id, b.campusId);
      return r;
    });
  }
  @Get('sections')
  listSections(@Auth() a: AuthContext) {
    needs(a, 'academic.read');
    const scope = campusScope(a, 'academic.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select s.*, g.name as grade_name, (select count(*) from enrollments e where e.section_id = s.id and e.effective_to is null)::int as enrolled
       from sections s join grade_levels g on g.id = s.grade_level_id where ($1::uuid[] is null or s.campus_id = any($1)) order by g.ordinal, s.name`, [scope])).rows);
  }

  @Post('courses')
  createCourse(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(course, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select id, campus_id from sections where id = $1', [b.sectionId]);
      if (!s) throw new NotFoundException({ error: 'section_not_found' });
      needs(a, 'course.manage', s.campus_id);
      const { rows: [c] } = await tx.query('insert into courses(tenant_id, section_id, subject_id, teacher_user_id, title) values ($1,$2,$3,$4,$5) returning *',
        [a.tenantId, b.sectionId, b.subjectId, b.teacherUserId ?? null, b.title]);
      // Roster sync: everyone currently enrolled in the section gets access.
      await tx.query(`insert into course_enrollments(tenant_id, course_id, student_id) select $1, $2, e.student_id from enrollments e where e.section_id = $3 and e.effective_to is null`, [a.tenantId, c.id, b.sectionId]);
      await audit(tx, a, a.tenantId, 'course.create', 'course', c.id, s.campus_id);
      return c;
    });
  }

  @Get('courses/:id/roster')
  roster(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [c] } = await tx.query('select c.*, s.campus_id from courses c join sections s on s.id = c.section_id where c.id = $1', [id]);
      if (!c) throw new NotFoundException({ error: 'not_found' });
      // Teachers see only their own courses; others need course.read_all for the campus.
      if (c.teacher_user_id !== a.userId) needs(a, 'course.read_all', c.campus_id);
      return (await tx.query(`select st.id, st.admission_no, st.first_name, st.last_name from course_enrollments ce join students st on st.id = ce.student_id where ce.course_id = $1 and ce.status = 'active' order by st.last_name`, [id])).rows;
    });
  }
}
