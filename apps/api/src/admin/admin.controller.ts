import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Put, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { Auth, AuthContext, can, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { PERMISSIONS } from '../common/permissions';
import { hashPassword, sha256, verifyPassword } from '../common/crypto';
import { PASSWORD_MIN } from '../auth/auth.service';

const roleS = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/), name: z.string().min(3).max(100), permissions: z.array(z.enum(PERMISSIONS as unknown as [string, ...string[]])).max(80) });

/** Organisation, role, user-lifecycle and session administration. */
@Controller()
export class AdminController {
  constructor(private db: DbService) {}

  // ---------------- campuses ----------------
  @Get('campuses')
  campuses(@Auth() a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('select id, code, name, is_boarding, settings from campuses order by code')).rows);
  }
  @Post('campuses')
  addCampus(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'tenant.manage'); const b = parse(z.object({ code: z.string().regex(/^[A-Z0-9-]{2,12}$/), name: z.string().min(2).max(100), isBoarding: z.boolean().default(false) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const c = (await tx.query('insert into campuses(tenant_id, code, name, is_boarding) values ($1,$2,$3,$4) returning id, code, name, is_boarding', [a.tenantId, b.code, b.name, b.isBoarding])).rows[0];
      await audit(tx, a, a.tenantId, 'campus.create', 'campus', c.id, c.id);
      return c;
    });
  }

  // ---------------- roles & permissions ----------------
  @Get('permissions')
  permissions(@Auth() a: AuthContext) { needs(a, 'role.manage'); return PERMISSIONS; }
  @Get('roles')
  roles(@Auth() a: AuthContext) {
    needs(a, 'role.manage');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(`select r.id, r.key, r.name, r.is_system, coalesce(array_agg(rp.permission order by rp.permission) filter (where rp.permission is not null), '{}') as permissions, (select count(distinct user_id) from user_roles ur where ur.role_id = r.id)::int as users from roles r left join role_permissions rp on rp.role_id = r.id group by r.id order by r.is_system desc, r.name`)).rows);
  }
  @Post('roles')
  addRole(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'role.manage'); const b = parse(roleS, body);
    this.noEscalation(a, b.permissions);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const r = (await tx.query('insert into roles(tenant_id, key, name, is_system) values ($1,$2,$3,false) returning id, key, name', [a.tenantId, b.key, b.name])).rows[0];
      for (const p of b.permissions) await tx.query('insert into role_permissions(tenant_id, role_id, permission) values ($1,$2,$3)', [a.tenantId, r.id, p]);
      await audit(tx, a, a.tenantId, 'role.create', 'role', r.id, null, { permissions: b.permissions });
      return r;
    });
  }
  /** Replaces a role's permissions. System roles can be tuned per school, except the group administrator role, which always keeps full rights. */
  @Put('roles/:id/permissions')
  setPerms(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); needs(a, 'role.manage'); const { permissions } = parse(z.object({ permissions: roleS.shape.permissions }), body);
    this.noEscalation(a, permissions);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [r] } = await tx.query('select * from roles where id = $1', [id]);
      if (!r) throw new NotFoundException({ error: 'not_found' });
      if (r.key === 'group_admin') throw new ConflictException({ error: 'group_admin_role_is_fixed' });
      const old = (await tx.query('select permission from role_permissions where role_id = $1', [id])).rows.map((x) => x.permission);
      await tx.query('delete from role_permissions where role_id = $1', [id]);
      for (const p of permissions) await tx.query('insert into role_permissions(tenant_id, role_id, permission) values ($1,$2,$3)', [a.tenantId, id, p]);
      await audit(tx, a, a.tenantId, 'role.permissions', 'role', id, null, { added: permissions.filter((p) => !old.includes(p)), removed: old.filter((p: string) => !permissions.includes(p as any)) });
      return { permissions };
    });
  }
  /** A role manager cannot hand out rights they do not hold themselves. */
  private noEscalation(a: AuthContext, perms: string[]) {
    const held = new Set(a.grants.filter((g) => g.campusId === null).map((g) => g.permission));
    const over = perms.filter((p) => !held.has(p));
    if (over.length) throw new ForbiddenException({ error: 'cannot_grant_permissions_you_do_not_hold', permissions: over });
  }

  // ---------------- users ----------------
  @Get('users')
  users(@Auth() a: AuthContext) {
    needs(a, 'user.manage');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select u.id, u.email, u.full_name, u.status, u.mfa_enabled, u.created_at,
         coalesce(json_agg(json_build_object('userRoleId', ur.id, 'role', r.key, 'campusId', ur.campus_id)) filter (where ur.id is not null), '[]') as roles,
         (select max(at) from audit_log l where l.actor_user_id = u.id and l.action = 'auth.login') as last_login
       from users u left join user_roles ur on ur.user_id = u.id left join roles r on r.id = ur.role_id group by u.id order by u.full_name limit 500`)).rows);
  }
  @Post('users/:id/enable')
  enable(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id); needs(a, 'user.manage');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const r = await tx.query(`update users set status = 'active', failed_attempts = 0, locked_until = null where id = $1 and status in ('disabled','locked') and password_hash is not null returning id`, [id]);
      if (!r.rowCount) throw new ConflictException({ error: 'cannot_enable', hint: 'only disabled or locked accounts that already set a password can be re-enabled' });
      await audit(tx, a, a.tenantId, 'user.enable', 'user', id);
      return { enabled: true };
    });
  }
  @Post('users/:id/roles')
  grant(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(z.object({ roleKey: z.string().min(2), campusId: uuid.nullable().default(null) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      needs(a, 'user.manage', b.campusId);
      const { rows: [role] } = await tx.query('select id from roles where key = $1', [b.roleKey]);
      if (!role) throw new UnprocessableEntityException({ error: 'unknown_role' });
      if (b.roleKey === 'group_admin') needs(a, 'tenant.manage');
      const perms = (await tx.query('select permission from role_permissions where role_id = $1', [role.id])).rows.map((r) => r.permission as string);
      const missing = perms.filter((p) => !can(a, p as any, b.campusId));
      if (missing.length) throw new ForbiddenException({ error: 'cannot_grant_permissions_you_do_not_hold', permissions: missing });
      if (!(await tx.query('select 1 from users where id = $1', [id])).rowCount) throw new NotFoundException({ error: 'not_found' });
      const r = await tx.query('insert into user_roles(tenant_id, user_id, role_id, campus_id) values ($1,$2,$3,$4) on conflict do nothing returning id', [a.tenantId, id, role.id, b.campusId]);
      if (!r.rowCount) throw new ConflictException({ error: 'already_granted' });
      await audit(tx, a, a.tenantId, 'user.role_grant', 'user', id, b.campusId, { role: b.roleKey });
      return { userRoleId: r.rows[0].id };
    });
  }
  @Delete('users/:id/roles/:userRoleId')
  revoke(@Auth() a: AuthContext, @Param('id') id: string, @Param('userRoleId') urid: string) {
    pid(id); pid(urid); needs(a, 'user.manage');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [ur] } = await tx.query('select ur.*, r.key from user_roles ur join roles r on r.id = ur.role_id where ur.id = $1 and ur.user_id = $2', [urid, id]);
      if (!ur) throw new NotFoundException({ error: 'not_found' });
      if (ur.key === 'group_admin') {
        needs(a, 'tenant.manage');
        const others = (await tx.query(`select count(distinct ur2.user_id)::int n from user_roles ur2 join users u on u.id = ur2.user_id where ur2.role_id = $1 and u.status = 'active' and ur2.user_id <> $2`, [ur.role_id, id])).rows[0].n;
        if (others === 0) throw new ConflictException({ error: 'cannot_remove_last_group_administrator' });
      }
      await tx.query('delete from user_roles where id = $1', [urid]);
      await tx.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);   // permissions are re-read at next sign-in
      await audit(tx, a, a.tenantId, 'user.role_revoke', 'user', id, ur.campus_id, { role: ur.key });
      return { revoked: true };
    });
  }
  @Get('users/:id/login-history')
  history(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id); needs(a, 'user.manage');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(`select action, at, ip from audit_log where (actor_user_id = $1 and action in ('auth.login','auth.logout','auth.password_change','auth.mfa_enabled')) or (entity_id = $1::text and action in ('auth.login_failed','auth.account_locked','auth.password_reset','user.reset_issued')) order by id desc limit 100`, [id])).rows);
  }

  // ---------------- own sessions & password ----------------
  @Get('auth/sessions')
  sessions(@Auth() a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(`select id, created_at, expires_at from sessions where user_id = $1 and revoked_at is null and expires_at > now() order by created_at desc`, [a.userId])).rows);
  }
  @Post('auth/sessions/:id/revoke') @HttpCode(200)
  revokeOne(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const r = await tx.query('update sessions set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null returning id', [id, a.userId]);
      if (!r.rowCount) throw new NotFoundException({ error: 'not_found' });
      return { revoked: true };
    });
  }
  /** Changes the password after re-checking the current one; every other session is signed out. */
  @Post('auth/password') @HttpCode(200)
  changePassword(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(PASSWORD_MIN).max(200), currentSessionToken: z.string().optional() }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [u] } = await tx.query('select password_hash from users where id = $1', [a.userId]);
      if (!(await verifyPassword(b.currentPassword, u.password_hash))) throw new ForbiddenException({ error: 'wrong_current_password' });
      if (b.currentPassword === b.newPassword) throw new UnprocessableEntityException({ error: 'new_password_must_differ' });
      await tx.query('update users set password_hash = $2 where id = $1', [a.userId, await hashPassword(b.newPassword)]);
      await tx.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null and token_hash <> $2', [a.userId, b.currentSessionToken ? sha256(b.currentSessionToken) : '']);
      await audit(tx, a, a.tenantId, 'auth.password_change', 'user', a.userId);
      return { changed: true };
    });
  }
}
