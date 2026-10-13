import { Tx } from '../db/db.service';
import type { AuthContext } from './http';

export async function audit(tx: Tx, auth: Pick<AuthContext, 'tenantId' | 'userId' | 'ip'> | null, tenantId: string, action: string, entityType?: string, entityId?: string, campusId?: string | null, details: Record<string, unknown> = {}) {
  await tx.query(
    'insert into audit_log(tenant_id, actor_user_id, action, entity_type, entity_id, campus_id, details, ip) values ($1,$2,$3,$4,$5,$6,$7,$8)',
    [tenantId, auth?.userId ?? null, action, entityType ?? null, entityId ?? null, campusId ?? null, JSON.stringify(details), auth?.ip ?? null],
  );
}
