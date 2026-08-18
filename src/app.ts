import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { ZodError } from 'zod';

import { ApiError } from './errors.js';
import { activityRoutes } from './routes/activity.js';
import { authRoutes } from './routes/auth.js';
import { automationRoutes } from './routes/automations.js';
import { catalogRoutes } from './routes/catalog.js';
import { config } from './config.js';
import { deviceRoutes } from './routes/devices.js';
import { healthRoutes } from './routes/health.js';
import { homeRoutes } from './routes/homes.js';
import { logger } from './logger.js';
import { profileRoutes } from './routes/profile.js';
import { redis } from './redis/index.js';
import { registerRealtime } from './realtime/ws.js';
import { sceneRoutes } from './routes/scenes.js';
import { telemetryRoutes } from './routes/telemetry.js';

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true, // behind nginx; request.ip must be the real client
    bodyLimit: 256 * 1024,
  });

  /**
   * An empty body with a JSON content-type is a client being sloppy, not a
   * server fault.
   *
   * Fastify's default parser rejects it outright, and the generic handler below
   * turned that into a 500 -- so a DELETE sent with `content-type:
   * application/json` and nothing after it looked like the server had broken,
   * for a request that was perfectly answerable. An absent body is read as
   * absent; malformed JSON is still a 400.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      if (!body || body.trim() === '') {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch (error) {
        const failure = error as Error & { statusCode?: number };
        failure.statusCode = 400;
        done(failure, undefined);
      }
    },
  );

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    // Shared across instances, so the limit is global rather than per replica.
    redis,
    // Degrade open: if Redis is unreachable the API keeps serving unthrottled
    // rather than returning 500s for every request.
    skipOnError: true,
    keyGenerator: (request) => `${request.ip}:${request.routeOptions?.url ?? request.url}`,
    // Health checks come from the orchestrator on a tight loop.
    allowList: (request) => request.url === '/healthz' || request.url === '/readyz',
  });

  await app.register(websocket);

  /**
   * One error shape for every failure: validation problems become 400s with
   * field detail, ApiError passes through, and anything unexpected is logged in
   * full but answered with a bare 500 — internal messages never leave the
   * process.
   */
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'validation_error',
        message: 'Request failed validation',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    if (error instanceof ApiError) {
      return reply
        .status(error.statusCode)
        .send({ error: error.code, message: error.message, details: error.details });
    }

    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({ error: 'rate_limited', message: 'Too many requests' });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ error: 'not_found', message: `No route for ${request.method} ${request.url}` }),
  );

  await app.register(healthRoutes);
  await app.register(catalogRoutes, { prefix: '/api/catalog' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(automationRoutes, { prefix: '/api/automations' });
  await app.register(sceneRoutes, { prefix: '/api/scenes' });
  await app.register(activityRoutes, { prefix: '/api/activity' });
  await app.register(profileRoutes, { prefix: '/api' });
  await app.register(homeRoutes, { prefix: '/api/homes' });
  await app.register(deviceRoutes, { prefix: '/api/devices' });
  await app.register(telemetryRoutes, { prefix: '/api/devices' });
  await app.register(registerRealtime, { prefix: '/api/realtime' });

  app.get('/', async () => ({
    name: 'lumen-iot-backend',
    version: '0.1.0',
    docs: '/api',
    endpoints: {
      auth: '/api/auth',
      profile: '/api/me',
      homes: '/api/homes',
      devices: '/api/devices',
      realtime: '/api/realtime/ws',
      health: '/healthz',
    },
  }));

  return app;
}
