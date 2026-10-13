import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DbService } from './db/db.service';
import { Public } from './common/http';

/** Liveness/readiness probe: confirms the process is up and the database answers. */
@Controller('health')
@Public()
export class HealthProbeController {
  constructor(private db: DbService) {}
  @Get()
  async check() {
    try { await this.db.raw('select 1'); return { status: 'ok' }; } catch { throw new ServiceUnavailableException({ status: 'database_unavailable' }); }
  }
}
