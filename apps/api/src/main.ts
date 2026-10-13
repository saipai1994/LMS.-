import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DbService } from './db/db.service';
import { CommsController } from './comms/comms.controller';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use((_req: any, res: any, next: any) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store'); next(); });
  await app.get(DbService).migrate();
  await app.listen(process.env.PORT ?? 3001);
  // In-process scheduler for scheduled announcements (a durable job queue is on the roadmap).
  const db = app.get(DbService), comms = app.get(CommsController);
  setInterval(async () => {
    try { for (const t of await db.raw(`select id from tenants where status = 'active'`)) await comms.dispatchDueFor(t.id); } catch (e) { console.error('scheduler:', (e as Error).message); }
  }, 60_000).unref();
}
bootstrap();
