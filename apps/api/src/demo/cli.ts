import { DbService } from '../db/db.service';
import { DEMO_MFA_SECRET, seedDemo } from './seed';
import { totp } from '../common/crypto';

async function main() {
  const cmd = process.argv[2];
  const db = new DbService();
  try {
    if (cmd === 'code') { console.log(totp(DEMO_MFA_SECRET)); return; }
    if (process.env.NODE_ENV === 'production' || process.env.DEMO_MODE !== 'true') {
      throw new Error('Refusing: demo commands require DEMO_MODE=true and NODE_ENV!=production');
    }
    if (cmd === 'reset') {
      // Destroys ALL data in the configured database; demo databases only.
      if (process.env.CONFIRM_RESET !== 'yes') throw new Error('Refusing: set CONFIRM_RESET=yes to wipe this (demo) database');
      await db.pool.query('drop schema public cascade; create schema public;');
    }
    await db.migrate();
    console.log(JSON.stringify(await seedDemo(db)));
  } finally { await db.onModuleDestroy(); }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
