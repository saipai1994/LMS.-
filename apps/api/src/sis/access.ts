import { NotFoundException } from '@nestjs/common';
import { Tx } from '../db/db.service';
import { AuthContext, can } from '../common/http';
import type { Permission } from '../common/permissions';

export async function isGuardianOf(tx: Tx, userId: string, studentId: string): Promise<boolean> {
  const r = await tx.query('select 1 from student_guardians sg join guardians g on g.id = sg.guardian_id where sg.student_id = $1 and g.user_id = $2', [studentId, userId]);
  return !!r.rowCount;
}

/** Loads a student the actor holds `perm` for (campus-scoped); otherwise 404 so existence is not revealed. */
export async function scopedStudent(tx: Tx, a: AuthContext, id: string, perm: Permission) {
  const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
  if (!s || !can(a, perm, s.campus_id)) throw new NotFoundException({ error: 'not_found' });
  return s;
}

export async function currentResidence(tx: Tx, studentId: string): Promise<string | null> {
  const { rows: [r] } = await tx.query('select residence_type from residence_assignments where student_id = $1 and effective_to is null', [studentId]);
  return r?.residence_type ?? null;
}

/** Why may this actor see this student? null = they may not. */
export async function studentAccess(tx: Tx, a: AuthContext, s: { id: string; campus_id: string; user_id: string | null }): Promise<'staff' | 'guardian' | 'self' | 'teacher' | null> {
  if (can(a, 'student.read', s.campus_id)) return 'staff';
  if (s.user_id === a.userId) return 'self';
  if (await isGuardianOf(tx, a.userId, s.id)) return 'guardian';
  const t = await tx.query(`select 1 from course_enrollments ce join courses c on c.id = ce.course_id where ce.student_id = $1 and c.teacher_user_id = $2 and ce.status = 'active'`, [s.id, a.userId]);
  if (t.rowCount) return 'teacher';
  return null;
}

export async function guardianUserIds(tx: Tx, studentId: string): Promise<string[]> {
  const r = await tx.query('select distinct g.user_id from student_guardians sg join guardians g on g.id = sg.guardian_id where sg.student_id = $1 and g.user_id is not null', [studentId]);
  return r.rows.map((x) => x.user_id);
}

export async function notify(tx: Tx, tenantId: string, userIds: string[], kind: string, title: string, body: string) {
  for (const u of userIds) await tx.query('insert into notifications(tenant_id, user_id, kind, title, body) values ($1,$2,$3,$4,$5)', [tenantId, u, kind, title, body]);
}
