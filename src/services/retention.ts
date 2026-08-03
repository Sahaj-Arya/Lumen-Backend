import { config } from '../config.js';
import { logger } from '../logger.js';
import { query } from '../db/index.js';

/**
 * Telemetry grows without bound otherwise. Deletes in bounded batches so the
 * sweep never holds a long transaction or a large lock on a hot table.
 */

const BATCH = 10_000;
const INTERVAL_MS = 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export async function sweepOnce(): Promise<number> {
  const cutoff = new Date(Date.now() - config.TELEMETRY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let removed = 0;

  for (;;) {
    const result = await query(
      `DELETE FROM device_readings
        WHERE ctid IN (
          SELECT ctid FROM device_readings WHERE recorded_at < $1 LIMIT $2
        )`,
      [cutoff, BATCH],
    );
    const count = result.rowCount ?? 0;
    removed += count;
    if (count < BATCH) break;
  }

  // Consumed verification and reset tokens have no value once expired.
  await query('DELETE FROM user_tokens WHERE expires_at < now() - interval \'7 days\'');

  if (removed > 0) logger.info({ removed, cutoff }, 'telemetry retention sweep');
  return removed;
}

export function startRetentionJob(): void {
  const run = () =>
    sweepOnce().catch((error) => logger.error({ err: error }, 'retention sweep failed'));

  // Delay the first run so it does not compete with boot-time work.
  timer = setTimeout(function tick() {
    run();
    timer = setTimeout(tick, INTERVAL_MS);
  }, 60_000);
  timer.unref();
}

export function stopRetentionJob(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
