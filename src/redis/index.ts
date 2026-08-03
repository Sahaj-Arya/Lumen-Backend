import { Redis } from 'ioredis';

import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Three roles, three connections:
 *  - `redis`     general commands (sessions, cache, rate limits)
 *  - `publisher` fan-out of device updates across API instances
 *  - `subscriber` receives that fan-out (a subscribed connection cannot run
 *                 normal commands, hence the split)
 */

function create(role: string): Redis {
  const client = new Redis(config.REDIS_URL, {
    // Bounded, so a Redis outage fails requests fast instead of hanging them.
    // `null` here (the BullMQ idiom) makes every command wait indefinitely,
    // which turns a brief blip into an API-wide stall.
    maxRetriesPerRequest: 2,
    connectTimeout: 5_000,
    enableOfflineQueue: true,
    lazyConnect: false,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 5000),
  });
  /**
   * ioredis re-emits a connection error on every retry, once per resolved
   * address. Left alone that is several lines a second while Redis is down,
   * which buries whatever the real problem was. Report the first one, then stay
   * quiet until the connection actually comes back.
   */
  let reportedDown = false;
  client.on('error', (error: NodeJS.ErrnoException) => {
    const isConnectivity = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(
      error.code ?? '',
    );
    if (isConnectivity) {
      if (reportedDown) return;
      reportedDown = true;
      logger.warn({ role, err: error.message }, 'redis unreachable, retrying in the background');
      return;
    }
    logger.error({ err: error, role }, 'redis error');
  });

  client.on('ready', () => {
    if (reportedDown) logger.info({ role }, 'redis reconnected');
    reportedDown = false;
  });
  client.on('connect', () => logger.info({ role }, 'redis connected'));
  return client;
}

export const redis = create('main');
export const publisher = create('publisher');
export const subscriber = create('subscriber');

export const CHANNEL_DEVICE_UPDATE = 'lumen:device:update';

export const keys = {
  refreshToken: (jti: string) => `session:refresh:${jti}`,
  userSessions: (userId: string) => `session:user:${userId}`,
  deviceState: (deviceUid: string) => `device:state:${deviceUid}`,
  loginAttempts: (email: string) => `throttle:login:${email}`,
  signupAttempts: (ip: string) => `throttle:signup:${ip}`,
  verifyResend: (userId: string) => `throttle:verify:${userId}`,
};

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), publisher.quit(), subscriber.quit()]);
}
