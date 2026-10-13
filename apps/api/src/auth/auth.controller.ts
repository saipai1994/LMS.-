import { Body, Controller, Get, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { AllowWithoutMfa, Auth, AuthContext, parse, Public } from '../common/http';

const loginSchema = z.object({ tenant: z.string().min(2), email: z.string().email(), password: z.string().min(1), mfaCode: z.string().regex(/^\d{6}$/).optional() });
const activateSchema = z.object({ tenant: z.string().min(2), token: z.string().min(10), password: z.string().min(12) });

@Controller('auth')
export class AuthController {
  constructor(private svc: AuthService) {}

  @Public() @Post('login') @HttpCode(200)
  login(@Body() b: unknown, @Req() req: any) { return this.svc.login({ ...parse(loginSchema, b), ip: req.ip }); }

  @Public() @Post('activate') @HttpCode(200)
  activate(@Body() b: unknown) { return this.svc.activate(parse(activateSchema, b)); }

  @Post('logout') @HttpCode(204) @AllowWithoutMfa()
  async logout(@Auth() a: AuthContext, @Headers('authorization') h: string) { await this.svc.logout(a, h.slice(7)); }

  @Get('me') @AllowWithoutMfa()
  me(@Auth() a: AuthContext) { return { userId: a.userId, email: a.email, mfaEnabled: a.mfaEnabled, privileged: a.privileged, grants: a.grants }; }

  @Post('mfa/setup') @AllowWithoutMfa()
  mfaSetup(@Auth() a: AuthContext) { return this.svc.mfaSetup(a); }

  @Post('mfa/enable') @HttpCode(200) @AllowWithoutMfa()
  mfaEnable(@Auth() a: AuthContext, @Body() b: unknown) { return this.svc.mfaEnable(a, parse(z.object({ code: z.string().regex(/^\d{6}$/) }), b).code); }
}
