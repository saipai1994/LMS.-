import { NotFoundException } from '@nestjs/common';
import { Tx } from '../db/db.service';
import { AuthContext, can } from '../common/http';

/** Course the actor teaches or manages (course.manage on its campus). Otherwise 404. */
export async function staffCourse(tx: Tx, a: AuthContext, courseId: string) {
  const { rows: [c] } = await tx.query('select c.*, s.campus_id, s.academic_year_id from courses c join sections s on s.id = c.section_id where c.id = $1', [courseId]);
  if (!c || !(c.teacher_user_id === a.userId || can(a, 'course.manage', c.campus_id))) throw new NotFoundException({ error: 'not_found' });
  return c;
}

/** The student record linked to the signed-in user (student portal), or null. */
export async function myStudent(tx: Tx, a: AuthContext) {
  const { rows: [s] } = await tx.query('select * from students where user_id = $1', [a.userId]);
  return s ?? null;
}

/** Course where the signed-in student is actively enrolled. */
export async function studentCourse(tx: Tx, a: AuthContext, courseId: string) {
  const st = await myStudent(tx, a);
  if (!st) throw new NotFoundException({ error: 'not_found' });
  const { rows: [c] } = await tx.query(`select c.* from courses c join course_enrollments ce on ce.course_id = c.id where c.id = $1 and ce.student_id = $2 and ce.status = 'active'`, [courseId, st.id]);
  if (!c) throw new NotFoundException({ error: 'not_found' });
  return { course: c, student: st };
}
