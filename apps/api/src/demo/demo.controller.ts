import { Controller, Get, NotFoundException } from '@nestjs/common';
import { Public } from '../common/http';
import { DEMO_PASSWORD, DEMO_SLUG } from './seed';

/** Exposes demo login hints only when DEMO_MODE=true (never in production). */
@Controller('demo')
@Public()
export class DemoController {
  @Get('info')
  info() {
    if (process.env.DEMO_MODE !== 'true' || process.env.NODE_ENV === 'production') throw new NotFoundException();
    const accounts = ['admin', 'principal', 'admissions', 'accountant', 'teacher', 'parent', 'student', 'warden', 'transport', 'nurse', 'librarian', 'inventory', 'gate', 'registrar', 'examcoord']
      .map((l) => `${l}@greenwood.demo`);
    return {
      demo: true, banner: 'DEMO — fictional data; payments, messaging, GPS and AI are not connected',
      tenant: DEMO_SLUG, password: DEMO_PASSWORD, accounts,
      mfa: 'admin, principal, admissions, accountant and nurse require a TOTP code: run `npm run demo:code`',
    };
  }
}
