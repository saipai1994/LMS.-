import { Body, Controller, ForbiddenException, Headers, Post, Get, Param, Patch } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { parse, Public } from '../common/http';
import { randomToken, sha256 } from '../common/crypto';
import { SYSTEM_ROLES } from '../common/permissions';
import { audit } from '../common/audit';
import { OPTIONAL_FEATURES, PLAN_DEFAULTS } from '../common/entitlements';

/**
 * Platform-administrator operations (SaaS onboarding). Authenticated with the
 * PLATFORM_BOOTSTRAP_TOKEN secret; there is no tenant-level platform admin user yet.
 */
function guardPlatform(token?: string) {
  const expected = process.env.PLATFORM_BOOTSTRAP_TOKEN;
  if (!expected || expected.length < 24 || !token || token.length !== expected.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) throw new ForbiddenException({ error: 'forbidden' });
}

const createTenant = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  name: z.string().min(2),
  adminEmail: z.string().email(),
  adminName: z.string().min(2),
  campus: z.object({ code: z.string().min(1), name: z.string().min(2), isBoarding: z.boolean().default(false) }),
});

@Controller('platform')
@Public()
export class PlatformController {
  constructor(private db: DbService) {}

  @Post('tenants')
  async create(@Headers('x-platform-token') tok: string, @Body() body: unknown) {
    guardPlatform(tok);
    const b = parse(createTenant, body);
    const [dup] = await this.db.raw('select 1 from tenants where slug = $1', [b.slug]);
    if (dup) throw new ForbiddenException({ error: 'slug_taken' });
    const [t] = await this.db.raw('insert into tenants(slug, name) values ($1,$2) returning id', [b.slug, b.name]);
    const invite = randomToken();
    const out = await this.db.withTenant(t.id, async (tx) => {
      const { rows: [campus] } = await tx.query('insert into campuses(tenant_id, code, name, is_boarding) values ($1,$2,$3,$4) returning id', [t.id, b.campus.code, b.campus.name, b.campus.isBoarding]);
      const roleIds: Record<string, string> = {};
      for (const r of SYSTEM_ROLES) {
        const { rows: [row] } = await tx.query('insert into roles(tenant_id, key, name, is_system) values ($1,$2,$3,true) returning id', [t.id, r.key, r.name]);
        roleIds[r.key] = row.id;
        for (const p of r.permissions) await tx.query('insert into role_permissions(tenant_id, role_id, permission) values ($1,$2,$3)', [t.id, row.id, p]);
      }
      const { rows: [u] } = await tx.query(
        `insert into users(tenant_id, email, full_name, status, invite_token_hash, invite_expires_at) values ($1,$2,$3,'invited',$4, now() + interval '7 days') returning id`,
        [t.id, b.adminEmail, b.adminName, sha256(invite)]);
      await tx.query('insert into user_roles(tenant_id, user_id, role_id, campus_id) values ($1,$2,$3,null)', [t.id, u.id, roleIds['group_admin']]);
      await tx.query(`insert into document_sequences(tenant_id, key, prefix) values ($1,'student_admission_no','ADM-')`, [t.id]);
      await audit(tx, null, t.id, 'tenant.created', 'tenant', t.id, null, { slug: b.slug });
      return { tenantId: t.id, campusId: campus.id, adminUserId: u.id };
    });
    // No email provider is configured: the invite token is returned to the platform operator.
    return { ...out, adminInviteToken: invite, notice: 'Email delivery is not configured; deliver this token to the admin securely.' };
  }

  @Patch('tenants/:id/status')
  async setStatus(@Headers('x-platform-token') tok: string, @Param('id') id: string, @Body() body: unknown) {
    guardPlatform(tok);
    const { status } = parse(z.object({ status: z.enum(['active', 'suspended', 'offboarding']) }), body);
    const rows = await this.db.raw('update tenants set status = $2 where id = $1 returning id, status', [id, status]);
    return rows[0] ?? { error: 'not_found' };
  }

  @Patch('tenants/:id/plan')
  async setPlan(@Headers('x-platform-token') tok: string, @Param('id') id: string, @Body() body: unknown) {
    guardPlatform(tok);
    const b = parse(z.object({ plan: z.enum(Object.keys(PLAN_DEFAULTS) as [string, ...string[]]), features: z.record(z.enum(OPTIONAL_FEATURES as [string, ...string[]]), z.boolean()).default({}) }), body);
    const rows = await this.db.raw('update tenants set plan = $2, features = $3 where id = $1 returning id, plan, features', [id, b.plan, JSON.stringify(b.features)]);
    return rows[0] ?? { error: 'not_found' };
  }

  @Get('tenants')
  async list(@Headers('x-platform-token') tok: string) {
    guardPlatform(tok);
    return this.db.raw('select id, slug, name, status, plan, features, created_at from tenants order by created_at');
  }

  /** Usage and limits for subscription monitoring. */
  @Get('tenants/:id/usage')
  async usage(@Headers('x-platform-token') tok: string, @Param('id') id: string) {
    guardPlatform(tok);
    const [t] = await this.db.raw('select id, slug, plan, status from tenants where id = $1', [id]);
    if (!t) return { error: 'not_found' };
    return this.db.withTenant(id, async (tx) => {
      const n = async (sql: string) => Number((await tx.query(sql)).rows[0].n);
      return {
        tenant: t, activeUsers: await n(`select count(*) n from users where status = 'active'`), students: await n(`select count(*) n from students where status = 'active'`),
        campuses: await n('select count(*) n from campuses'), storageBytes: await n('select coalesce(sum(size_bytes),0) n from files'), auditEvents: await n('select count(*) n from audit_log'),
      };
    });
  }

  /** Full tenant data export (portability / offboarding). Secrets such as password hashes and token hashes are never exported. */
  @Get('tenants/:id/export')
  async export(@Headers('x-platform-token') tok: string, @Param('id') id: string) {
    guardPlatform(tok);
    const [t] = await this.db.raw('select id, slug, name, status, plan, features, branding, created_at from tenants where id = $1', [id]);
    if (!t) return { error: 'not_found' };
    const SENSITIVE = new Set(['password_hash', 'mfa_secret', 'invite_token_hash', 'token_hash', 'request_hash', 'sha256']);
    const tables = (await this.db.raw(`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'tenant_id' and table_name not in ('schema_migrations') order by table_name`)).map((r) => r.table_name as string);
    const data: Record<string, unknown[]> = {};
    await this.db.withTenant(id, async (tx) => {
      for (const name of tables) {
        const cols = (await tx.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [name])).rows.map((r) => r.column_name as string).filter((c) => !SENSITIVE.has(c));
        data[name] = (await tx.query(`select ${cols.map((c) => `"${c}"`).join(', ')} from "${name}"`)).rows;
      }
      await audit(tx, null, id, 'platform.tenant_export', 'tenant', id, null, { tables: tables.length });
    });
    return { exportedAt: new Date().toISOString(), tenant: t, tables: data };
  }
}
