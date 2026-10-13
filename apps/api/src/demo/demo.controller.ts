import { Body, Controller, Get, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { z } from 'zod';
import { Auth, AuthContext, needs, parse, Public } from '../common/http';
import { DbService } from '../db/db.service';
import { DEMO_PASSWORD, DEMO_SLUG, seedDemo } from './seed';

const isDemo = () => process.env.DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production';

/** Exposes demo login hints only when DEMO_MODE=true (never in production). */
@Controller('demo')
export class DemoController {
  constructor(private db: DbService) {}

  /** Wipes the whole (demo) database and reseeds it. Demo mode only; requires a tenant administrator with MFA and an explicit confirmation. */
  @Post('reset') @HttpCode(200)
  async reset(@Auth() a: AuthContext, @Body() body: unknown) {
    if (!isDemo()) throw new NotFoundException();
    needs(a, 'tenant.manage');
    parse(z.object({ confirm: z.literal('RESET DEMO DATA') }), body);
    await this.db.pool.query('drop schema public cascade; create schema public;');
    await this.db.migrate();
    return { reset: true, seeded: await seedDemo(this.db), note: 'All sessions were cleared; sign in again.' };
  }

  @Public() @Get('info')
  info() {
    if (!isDemo()) throw new NotFoundException();
    const accounts = ['admin', 'principal', 'admissions', 'accountant', 'teacher', 'parent', 'student', 'warden', 'transport', 'nurse', 'librarian', 'inventory', 'gate', 'registrar', 'examcoord', 'hr', 'kitchen', 'safeguarding', 'lmsadmin', 'campusadmin']
      .map((l) => `${l}@greenwood.demo`);
    return {
      demo: true, banner: 'DEMO — fictional data; payments, messaging, GPS and AI are not connected',
      tenant: DEMO_SLUG, password: DEMO_PASSWORD, accounts,
      mfa: 'admin, principal, admissions, accountant, nurse, hr, safeguarding and examcoord require a TOTP code: run `npm run demo:code`',
    };
  }
}
