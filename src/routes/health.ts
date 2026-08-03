import type { FastifyInstance } from 'fastify';

import { isConnected } from '../mqtt/bridge.js';
import { connectedClients } from '../realtime/ws.js';
import { query } from '../db/index.js';
import { redis } from '../redis/index.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /** Liveness: is the process up. Must not touch dependencies. */
  app.get('/healthz', async () => ({ status: 'ok', uptime: Math.round(process.uptime()) }));

  /**
   * Readiness: can this instance actually serve traffic. Postgres and Redis are
   * required; the MQTT bridge being down degrades the service (no live
   * telemetry) but reads still work, so it is reported without failing.
   */
  app.get('/readyz', async (_request, reply) => {
    const checks: Record<string, { ok: boolean; error?: string }> = {};

    try {
      await query('SELECT 1');
      checks.postgres = { ok: true };
    } catch (error) {
      checks.postgres = { ok: false, error: (error as Error).message };
    }

    try {
      await redis.ping();
      checks.redis = { ok: true };
    } catch (error) {
      checks.redis = { ok: false, error: (error as Error).message };
    }

    checks.mqtt = { ok: isConnected() };

    const ready = checks.postgres.ok && checks.redis.ok;
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'degraded',
      checks,
      realtimeClients: connectedClients(),
    });
  });
}
