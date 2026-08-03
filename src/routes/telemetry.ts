import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { currentUser, requireAuth, requireDeviceAccess } from '../auth/guard.js';
import { query } from '../db/index.js';

/**
 * History queries over device_readings. Raw points for short windows; bucketed
 * aggregates for long ones, because a month of 10-second telemetry is ~260k
 * rows per key and no client wants that on a chart.
 */

const rangeQuery = z.object({
  key: z.string().min(1).max(120).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(500),
});

const seriesQuery = rangeQuery.extend({
  key: z.string().min(1).max(120),
  // Postgres interval accepted by date_bin, constrained to a safe set.
  bucket: z.enum(['1 minute', '5 minutes', '15 minutes', '1 hour', '6 hours', '1 day']).default('5 minutes'),
});

export async function telemetryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Raw readings, newest first. */
  app.get('/:deviceId/readings', async (request) => {
    const user = currentUser(request);
    const { deviceId } = z.object({ deviceId: z.string().uuid() }).parse(request.params);
    const filter = rangeQuery.parse(request.query);
    await requireDeviceAccess(user.id, deviceId);

    const rows = await query(
      `SELECT key, value, numeric_value, recorded_at
         FROM device_readings
        WHERE device_id = $1
          AND ($2::text IS NULL OR key = $2)
          AND ($3::timestamptz IS NULL OR recorded_at >= $3)
          AND ($4::timestamptz IS NULL OR recorded_at <= $4)
        ORDER BY recorded_at DESC
        LIMIT $5`,
      [deviceId, filter.key ?? null, filter.from ?? null, filter.to ?? null, filter.limit],
    );
    return { readings: rows.rows };
  });

  /** Which keys this device has ever reported, and when it last did. */
  app.get('/:deviceId/keys', async (request) => {
    const user = currentUser(request);
    const { deviceId } = z.object({ deviceId: z.string().uuid() }).parse(request.params);
    await requireDeviceAccess(user.id, deviceId);

    const rows = await query(
      `SELECT key, value, retained, recorded_at
         FROM device_state WHERE device_id = $1 ORDER BY key`,
      [deviceId],
    );
    return { keys: rows.rows };
  });

  /** Bucketed min/max/avg for charting. */
  app.get('/:deviceId/series', async (request) => {
    const user = currentUser(request);
    const { deviceId } = z.object({ deviceId: z.string().uuid() }).parse(request.params);
    const filter = seriesQuery.parse(request.query);
    await requireDeviceAccess(user.id, deviceId);

    const from = filter.from ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = filter.to ?? new Date();

    // date_bin needs a fixed origin so buckets line up across queries.
    const rows = await query(
      `SELECT date_bin($4::interval, recorded_at, timestamptz 'epoch') AS bucket,
              avg(numeric_value)   AS avg,
              min(numeric_value)   AS min,
              max(numeric_value)   AS max,
              count(*)::int        AS samples
         FROM device_readings
        WHERE device_id = $1 AND key = $2
          AND numeric_value IS NOT NULL
          AND recorded_at >= $3 AND recorded_at <= $5
        GROUP BY bucket
        ORDER BY bucket`,
      [deviceId, filter.key, from, filter.bucket, to],
    );

    return { key: filter.key, bucket: filter.bucket, from, to, points: rows.rows };
  });

  /** Latest value per key, straight from the durable copy. */
  app.get('/:deviceId/latest', async (request) => {
    const user = currentUser(request);
    const { deviceId } = z.object({ deviceId: z.string().uuid() }).parse(request.params);
    await requireDeviceAccess(user.id, deviceId);

    const rows = await query<{ key: string; value: unknown; recorded_at: Date }>(
      'SELECT key, value, recorded_at FROM device_state WHERE device_id = $1',
      [deviceId],
    );
    return {
      readings: Object.fromEntries(
        rows.rows.map((row) => [row.key, { value: row.value, at: row.recorded_at }]),
      ),
    };
  });
}
