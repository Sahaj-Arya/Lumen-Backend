import type { FastifyInstance } from 'fastify';

import { COMPARATORS } from '../automation/types.js';
import { DEVICE_TYPES } from '../model/deviceTypes.js';

/**
 * The device type catalogue, served so the app can build its type pickers and
 * automation rule editors from the same definitions the backend validates
 * against. Public and unauthenticated: it is static reference data, and the app
 * needs it on the sign-in screen before any token exists.
 */
export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.get('/device-types', async (_request, reply) => {
    // Static for a given deployment — let clients and any CDN cache it.
    reply.header('cache-control', 'public, max-age=3600');
    return {
      deviceTypes: Object.entries(DEVICE_TYPES).map(([key, spec]) => ({ key, ...spec })),
      comparators: COMPARATORS,
    };
  });
}
