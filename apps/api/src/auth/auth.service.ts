import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { hashPassword, newTotpSecret, randomToken, sha256, verifyPassword, verifyTotp } from '../common/crypto';
import { audit } from '../common/audit';
import { AuthContext } from '../common/http';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const SESSION_HOURS = 12;
const attempts = new Map<string, number[]>(); // per-process limiter; see KNOWN_LIMITATIONS

export function rateLimit(key: string, max = 20, windowMs = 60_000) {
  const now = Date.now();
  const hits = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
  hits.push(now);
  attempts.set(key, hits);
  if (hits.length > max) throw new HttpException({ error: 'rate_limited' }, 429);
}
export const resetRateLimits = () => attempts.clear();

export const PASSWORD_MIN = 12;

@Injectable()
export class AuthService {
  constructor(private db: DbService) {}

  async login(i: { tenant: string; email: string; password: string; mfaCode?: string; ip?: string }) {
    // Per-IP ceiling (schools share one NAT address, so it is generous); per-account lockout is the stronger control.
    rateLimit(`login:${i.ip}`, Number(process.env.LOGIN_RATE_LIMIT_PER_MIN ?? 100));
    const [t] = await this.db.raw('select id, status from tenants where slug = $1', [i.tenant]);
    const invalid = new UnauthorizedException({ error: 'invalid_credentials' });
    if (!t || t.status !== 'active') throw invalid;
    return this.db.withTenant(t.id, async (tx) => {
      const { rows: [u] } = await tx.query('select * from users where email = $1 for update', [i.email]);
      if (!u) { await verifyPassword(i.password, null); throw invalid; }
      if (u.status === 'disabled' || u.status === 'invited') throw invalid;
      if (u.locked_until && u.locked_until > new Date()) throw new HttpException({ error: 'account_locked' }, 423);
      const ok = await verifyPassword(i.password, u.password_hash);
      const mfaOk = !u.mfa_enabled || (!!i.mfaCode && verifyTotp(u.mfa_secret, i.mfaCode));
      if (!ok || !mfaOk) {
        const fails = u.failed_attempts + 1;
        const lock = fails >= MAX_FAILS;
        await tx.query('update users set failed_attempts = $2, locked_until = $3 where id = $1',
          [u.id, lock ? 0 : fails, lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null]);
        await audit(tx, null, t.id, lock ? 'auth.account_locked' : 'auth.login_failed', 'user', u.id, null, { ip: i.ip });
        // commit the failure counters, then report
        throw Object.assign(new UnauthorizedException({ error: ok && u.mfa_enabled && !i.mfaCode ? 'mfa_required' : 'invalid_credentials' }), { commit: true });
      }
      const token = `${t.id}.${randomToken()}`;
      await tx.query('update users set failed_attempts = 0, locked_until = null where id = $1', [u.id]);
      await tx.query('insert into sessions(tenant_id, user_id, token_hash, expires_at) values ($1,$2,$3, now() + $4::interval)',
        [t.id, u.id, sha256(token), `${SESSION_HOURS} hours`]);
      await audit(tx, { tenantId: t.id, userId: u.id, ip: i.ip }, t.id, 'auth.login', 'user', u.id);
      return { token, mfaEnabled: u.mfa_enabled };
    });
  }

  async logout(a: AuthContext, token: string) {
    await this.db.withTenant(a.tenantId, async (tx) => {
      await tx.query('update sessions set revoked_at = now() where token_hash = $1', [sha256(token)]);
      await audit(tx, a, a.tenantId, 'auth.logout', 'user', a.userId);
    });
  }

  async activate(i: { tenant: string; token: string; password: string }) {
    if (i.password.length < PASSWORD_MIN) throw new BadRequestException({ error: 'weak_password', min: PASSWORD_MIN });
    const [t] = await this.db.raw('select id from tenants where slug = $1 and status = $2', [i.tenant, 'active']);
    if (!t) throw new BadRequestException({ error: 'invalid_invite' });
    return this.db.withTenant(t.id, async (tx) => {
      const r = await tx.query(
        `update users set password_hash = $2, status = 'active', invite_token_hash = null, invite_expires_at = null
         where invite_token_hash = $1 and invite_expires_at > now() and status = 'invited' returning id`,
        [sha256(i.token), await hashPassword(i.password)]);
      if (!r.rows[0]) throw new BadRequestException({ error: 'invalid_invite' });
      await audit(tx, null, t.id, 'auth.activate', 'user', r.rows[0].id);
      return { activated: true };
    });
  }

  async mfaSetup(a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [u] } = await tx.query('select mfa_enabled from users where id = $1', [a.userId]);
      if (u.mfa_enabled) throw new ConflictException({ error: 'mfa_already_enabled' });
      const secret = newTotpSecret();
      await tx.query('update users set mfa_secret = $2 where id = $1', [a.userId, secret]);
      return { secret, otpauth: `otpauth://totp/LMS:${encodeURIComponent(a.email)}?secret=${secret}&issuer=LMS` };
    });
  }

  async mfaEnable(a: AuthContext, code: string) {
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [u] } = await tx.query('select mfa_secret from users where id = $1', [a.userId]);
      if (!u.mfa_secret || !verifyTotp(u.mfa_secret, code)) throw new ForbiddenException({ error: 'invalid_mfa_code' });
      await tx.query('update users set mfa_enabled = true where id = $1', [a.userId]);
      await audit(tx, a, a.tenantId, 'auth.mfa_enabled', 'user', a.userId);
      return { mfaEnabled: true };
    });
  }

  /** Public: always answers the same way so accounts cannot be enumerated. The token is only returned in demo mode (no email provider exists). */
  async forgot(i: { tenant: string; email: string; ip?: string }) {
    rateLimit(`forgot:${i.ip}`, 10);
    const generic = { accepted: true, notice: 'If the account exists, reset instructions will be sent. Email delivery is not configured: ask a school administrator to issue a reset link.' };
    const [t] = await this.db.raw('select id from tenants where slug = $1 and status = $2', [i.tenant, 'active']);
    if (!t) return generic;
    return this.db.withTenant(t.id, async (tx) => {
      const { rows: [u] } = await tx.query(`select id from users where email = $1 and status in ('active','locked')`, [i.email]);
      if (!u) return generic;
      const token = await this.issueReset(tx, t.id, u.id, null);
      await audit(tx, null, t.id, 'auth.reset_requested', 'user', u.id);
      return process.env.DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production' ? { ...generic, demoResetToken: token } : generic;
    });
  }

  async issueReset(tx: import('../db/db.service').Tx, tenantId: string, userId: string, createdBy: string | null) {
    await tx.query('update password_resets set used_at = now() where user_id = $1 and used_at is null', [userId]);
    const token = randomToken();
    await tx.query(`insert into password_resets(tenant_id, user_id, token_hash, expires_at, created_by) values ($1,$2,$3, now() + interval '1 hour', $4)`, [tenantId, userId, sha256(token), createdBy]);
    return token;
  }

  async reset(i: { tenant: string; token: string; password: string }) {
    if (i.password.length < PASSWORD_MIN) throw new BadRequestException({ error: 'weak_password', min: PASSWORD_MIN });
    const [t] = await this.db.raw('select id from tenants where slug = $1 and status = $2', [i.tenant, 'active']);
    if (!t) throw new BadRequestException({ error: 'invalid_reset' });
    return this.db.withTenant(t.id, async (tx) => {
      const { rows: [r] } = await tx.query('update password_resets set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning user_id', [sha256(i.token)]);
      if (!r) throw new BadRequestException({ error: 'invalid_reset' });
      await tx.query(`update users set password_hash = $2, failed_attempts = 0, locked_until = null, status = case when status = 'locked' then 'active' else status end where id = $1`, [r.user_id, await hashPassword(i.password)]);
      await tx.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [r.user_id]);   // sign out everywhere
      await audit(tx, null, t.id, 'auth.password_reset', 'user', r.user_id);
      return { reset: true };
    });
  }
}
