import { Body, Controller, Get, NotFoundException, Param, Post, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { Auth, AuthContext, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { randomToken, sha256 } from '../common/crypto';

const createUser = z.object({ email: z.string().email(), fullName: z.string().min(2), roleKey: z.string().min(1), campusId: uuid.nullable().default(null) });

@Controller()
export class UsersController {
  constructor(private db: DbService) {}

  @Post('users')
  create(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'user.manage');
    const b = parse(createUser, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [role] } = await tx.query('select id from roles where key = $1', [b.roleKey]);
      if (!role) throw new UnprocessableEntityException({ error: 'unknown_role' });
      // Only tenant-wide user managers may mint tenant-wide roles or grant on other campuses.
      needs(a, 'user.manage', b.campusId);
      if (b.roleKey === 'group_admin') needs(a, 'tenant.manage');
      const invite = randomToken();
      const { rows: [u] } = await tx.query(`insert into users(tenant_id, email, full_name, status, invite_token_hash, invite_expires_at) values ($1,$2,$3,'invited',$4, now() + interval '7 days') returning id`, [a.tenantId, b.email, b.fullName, sha256(invite)]);
      await tx.query('insert into user_roles(tenant_id, user_id, role_id, campus_id) values ($1,$2,$3,$4)', [a.tenantId, u.id, role.id, b.campusId]);
      await audit(tx, a, a.tenantId, 'user.create', 'user', u.id, b.campusId, { role: b.roleKey });
      return { userId: u.id, inviteToken: invite, notice: 'Email delivery is not configured; deliver the invite token securely.' };
    });
  }

  @Get('audit-log')
  auditLog(@Auth() a: AuthContext) {
    needs(a, 'audit.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('select id, actor_user_id, action, entity_type, entity_id, campus_id, details, at from audit_log order by id desc limit 200')).rows);
  }

  @Post('users/:id/disable')
  disable(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    needs(a, 'user.manage');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const r = await tx.query(`update users set status = 'disabled' where id = $1 returning id`, [id]);
      if (!r.rowCount) throw new NotFoundException({ error: 'not_found' });
      await tx.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
      await audit(tx, a, a.tenantId, 'user.disable', 'user', id);
      return { disabled: true };
    });
  }
}
