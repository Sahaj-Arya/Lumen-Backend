import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from '../logger.js';
import { closePool, pool } from './index.js';

/**
 * Minimal forward-only migration runner: every .sql file in migrations/ is
 * applied once, in filename order, each inside its own transaction. No
 * down-migrations — rolling back a schema in production is a restore, not a
 * script.
 */

const here = dirname(fileURLToPath(import.meta.url));
// dist/db/migrate.js and src/db/migrate.ts are both two levels below the root.
const migrationsDir = join(here, '..', '..', 'migrations');

export async function migrate(): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Serialise concurrent boots (compose starts one API container per replica)
    // so two of them cannot apply the same migration at once.
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['lumen_migrations']);

    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (row) => row.name,
      ),
    );

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      logger.info({ migration: file }, 'applying migration');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${file} failed: ${(error as Error).message}`);
      }
    }

    logger.info(
      { applied: applied.length, total: files.length },
      applied.length ? 'migrations applied' : 'schema already up to date',
    );
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['lumen_migrations']).catch(() => {});
    client.release();
  }
}

// Allow `npm run migrate` as a standalone step as well as boot-time migration.
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (invokedDirectly) {
  migrate()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error({ err: error }, 'migration failed');
      process.exit(1);
    });
}
