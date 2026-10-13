import { DbService } from './db.service';
(async () => {
  const db = new DbService();
  const ran = await db.migrate();
  console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'No pending migrations');
  await db.onModuleDestroy();
})().catch((e) => { console.error(e.message); process.exit(1); });
