import { config } from './config.js';
import { pool } from './db/index.js';
import { redis } from './redis/index.js';

/**
 * Checks the two hard dependencies before anything else runs.
 *
 * Without this the first failure is a bare `AggregateError [ECONNREFUSED]` from
 * deep inside the pg driver, which says nothing about which service is down or
 * how to start it. A boot failure should tell you what to do next.
 */

function describe(url: string, fallbackPort: number): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || fallbackPort}`;
  } catch {
    return url;
  }
}

function isConnectionRefused(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') return true;
  // pg aggregates one error per resolved address (IPv4 + IPv6).
  const errors = (error as AggregateError).errors;
  return Array.isArray(errors) && errors.some(isConnectionRefused);
}

export class DependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependencyError';
  }
}

const HOW_TO_START = [
  '',
  'Start the dependencies, then try again:',
  '',
  '  docker compose up -d postgres redis     # if you have Docker',
  '',
  'or install them natively:',
  '',
  '  brew install postgresql@16 redis',
  '  brew services start postgresql@16 && brew services start redis',
  '  createdb lumen',
  '',
  'or point DATABASE_URL / REDIS_URL in .env at hosted instances.',
].join('\n');

export async function preflight(): Promise<void> {
  const failures: string[] = [];

  try {
    const client = await pool.connect();
    client.release();
  } catch (error) {
    const where = describe(config.DATABASE_URL, 5432);
    failures.push(
      isConnectionRefused(error)
        ? `  PostgreSQL is not reachable at ${where} (DATABASE_URL)`
        : `  PostgreSQL at ${where} rejected the connection: ${(error as Error).message}`,
    );
  }

  try {
    // ioredis queues commands while disconnected, so a bare ping can hang for
    // the full retry budget. Bound it.
    await Promise.race([
      redis.ping(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('timed out after 5s')), 5000),
      ),
    ]);
  } catch (error) {
    const where = describe(config.REDIS_URL, 6379);
    failures.push(`  Redis is not reachable at ${where} (REDIS_URL): ${(error as Error).message}`);
  }

  if (failures.length > 0) {
    throw new DependencyError(
      `Cannot start — required services are unavailable:\n\n${failures.join('\n')}\n${HOW_TO_START}`,
    );
  }
}
