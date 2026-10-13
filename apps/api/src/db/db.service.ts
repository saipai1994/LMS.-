import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, types } from 'pg';

types.setTypeParser(1082, (v: string) => v); // keep DATE columns as 'YYYY-MM-DD' strings
import * as fs from 'fs';
import * as path from 'path';

export type Tx = PoolClient;

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://lms:lms_dev_pw@localhost:5432/lms_dev',
  });

  /** Runs fn in a transaction with Postgres RLS bound to the tenant. */
  async withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (e) {
      // Errors flagged `commit` (e.g. failed-login counters) persist their side effects.
      if ((e as { commit?: boolean }).commit) await client.query('commit').catch(() => undefined);
      else await client.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** For non-tenant tables only (tenants registry, migrations). */
  async raw<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params)).rows;
  }

  async migrate(dir = path.join(__dirname, '..', '..', 'migrations')): Promise<string[]> {
    await this.pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const applied = new Set((await this.pool.query('select name from schema_migrations')).rows.map((r) => r.name));
    const ran: string[] = [];
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (applied.has(f)) continue;
      const client = await this.pool.connect();
      try {
        await client.query('begin');
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('insert into schema_migrations(name) values ($1)', [f]);
        await client.query('commit');
        ran.push(f);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      } finally {
        client.release();
      }
    }
    return ran;
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
