import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Auth, AuthContext, pid } from '../common/http';

@Controller('notifications')
export class NotificationsController {
  constructor(private db: DbService) {}
  @Get()
  list(@Auth() a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('select id, kind, title, body, channel, created_at, read_at from notifications where user_id = $1 order by created_at desc limit 100', [a.userId])).rows);
  }
  @Post(':id/read') @HttpCode(200)
  read(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => ({ updated: (await tx.query('update notifications set read_at = coalesce(read_at, now()) where id = $1 and user_id = $2', [id, a.userId])).rowCount }));
  }
}
