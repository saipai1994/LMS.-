import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DbService } from '../src/db/db.service';
import { totp } from '../src/common/crypto';

export const PLATFORM_TOKEN = 'test-platform-token-0123456789abcdef';

export async function bootApp(): Promise<INestApplication> {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://lms:lms_dev_pw@localhost:5432/lms_test';
  if (!process.env.DATABASE_URL.includes('lms_test')) throw new Error('Tests must run against a *_test database');
  process.env.PLATFORM_BOOTSTRAP_TOKEN = PLATFORM_TOKEN;
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  const db = app.get(DbService);
  await db.pool.query('drop schema public cascade; create schema public;'); // test database only
  await db.migrate();
  await app.init();
  return app;
}

export const http = (app: INestApplication) => request(app.getHttpServer());

export async function createTenant(app: INestApplication, slug: string, boarding = true) {
  const r = await http(app).post('/platform/tenants').set('x-platform-token', PLATFORM_TOKEN)
    .send({ slug, name: `${slug} school`, adminEmail: `admin@${slug}.test`, adminName: 'Admin', campus: { code: 'MAIN', name: 'Main', isBoarding: boarding } });
  if (r.status !== 201) throw new Error('tenant create failed ' + JSON.stringify(r.body));
  return r.body as { tenantId: string; campusId: string; adminInviteToken: string };
}

export const PASSWORD = 'Correct-Horse-Battery-9';

export async function activate(app: INestApplication, tenant: string, token: string) {
  const r = await http(app).post('/auth/activate').send({ tenant, token, password: PASSWORD });
  if (r.status !== 200) throw new Error('activate failed ' + JSON.stringify(r.body));
}

/** Logs in; privileged users are taken through MFA enrolment first. */
export async function login(app: INestApplication, tenant: string, email: string, mfaSecret?: string) {
  const body: any = { tenant, email, password: PASSWORD };
  if (mfaSecret) body.mfaCode = totp(mfaSecret);
  const r = await http(app).post('/auth/login').send(body);
  if (r.status !== 200) throw new Error('login failed ' + JSON.stringify(r.body));
  return r.body.token as string;
}

export async function enrolMfa(app: INestApplication, token: string) {
  const s = await http(app).post('/auth/mfa/setup').set('Authorization', `Bearer ${token}`);
  const secret = s.body.secret as string;
  const e = await http(app).post('/auth/mfa/enable').set('Authorization', `Bearer ${token}`).send({ code: totp(secret) });
  if (e.status !== 200) throw new Error('mfa enable failed ' + JSON.stringify(e.body));
  return secret;
}

export async function adminSession(app: INestApplication, slug: string, boarding = true) {
  const t = await createTenant(app, slug, boarding);
  await activate(app, slug, t.adminInviteToken);
  const tmp = await login(app, slug, `admin@${slug}.test`);
  const secret = await enrolMfa(app, tmp);
  const token = await login(app, slug, `admin@${slug}.test`, secret);
  return { ...t, token, secret, slug };
}
