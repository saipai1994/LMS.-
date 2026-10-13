import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DbService } from '../db/db.service';
import { sha256 } from '../common/crypto';
import { ALLOW_NO_MFA, AuthContext, IS_PUBLIC } from '../common/http';
import { PRIVILEGED } from '../common/permissions';
import { FEATURE_BY_SEGMENT, featureEnabled } from '../common/entitlements';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private db: DbService, private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride(IS_PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const tenantId = token.split('.')[0];
    if (!UUID.test(tenantId)) throw new UnauthorizedException({ error: 'unauthenticated' });

    const auth = await this.db.withTenant(tenantId, async (tx) => {
      const s = await tx.query(
        `select u.id, u.email, u.mfa_enabled, t.plan, t.features from sessions s join users u on u.id = s.user_id
         join tenants t on t.id = s.tenant_id
         where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()
           and u.status = 'active' and t.status = 'active'`,
        [sha256(token)],
      );
      if (!s.rows[0]) return null;
      const g = await tx.query(
        `select rp.permission, ur.campus_id from user_roles ur join role_permissions rp on rp.role_id = ur.role_id where ur.user_id = $1`,
        [s.rows[0].id],
      );
      const grants = g.rows.map((r) => ({ permission: r.permission as string, campusId: r.campus_id as string | null }));
      return {
        plan: s.rows[0].plan as string, features: s.rows[0].features as Record<string, boolean>,
        tenantId, userId: s.rows[0].id, email: s.rows[0].email, grants,
        mfaEnabled: s.rows[0].mfa_enabled,
        privileged: grants.some((x) => (PRIVILEGED as string[]).includes(x.permission)),
        ip: req.ip,
      } as AuthContext;
    });
    if (!auth) throw new UnauthorizedException({ error: 'unauthenticated' });
    const feature = FEATURE_BY_SEGMENT[(req.path as string).split('/')[1] ?? ''];
    if (feature && !featureEnabled((auth as any).plan, (auth as any).features, feature)) throw new ForbiddenException({ error: 'feature_not_in_plan', feature });
    if (auth.privileged && !auth.mfaEnabled && !this.reflector.getAllAndOverride(ALLOW_NO_MFA, targets)) {
      throw new ForbiddenException({ error: 'mfa_setup_required' });
    }
    req.auth = auth;
    return true;
  }
}
