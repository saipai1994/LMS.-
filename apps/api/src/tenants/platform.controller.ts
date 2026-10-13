import { Body, Controller, ForbiddenException, Headers, Post, Get, Param, Patch } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { parse, Public } from '../common/http';
import { randomToken, sha256 } from '../common/crypto';
import { SYSTEM_ROLES } from '../common/permissions';
import { audit } from '../common/audit';

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
}
