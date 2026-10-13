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
