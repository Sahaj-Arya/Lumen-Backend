import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

import { logger } from '../logger.js';
import { query } from '../db/index.js';
import { verifyAccessToken } from '../auth/tokens.js';
import { CHANNEL_DEVICE_UPDATE, subscriber } from '../redis/index.js';
import type { DeviceUpdate } from '../mqtt/bridge.js';

/**
 * Live device updates for the app, replacing its old direct MQTT connection.
 *
 * The bridge publishes each update on a Redis channel, so a client connected to
 * any API instance sees updates ingested by any other. Each socket is filtered
 * to the device ids the authenticated user can actually see.
 */

interface Client {
  socket: WebSocket;
  userId: string;
  /** device_uid values this user may receive. */
  visible: Set<string>;
}

const clients = new Set<Client>();

async function visibleDeviceUids(userId: string): Promise<Set<string>> {
  const rows = await query<{ device_uid: string }>(
    `SELECT d.device_uid
       FROM devices d
       JOIN home_members m ON m.home_id = d.home_id AND m.user_id = $1`,
    [userId],
  );
  return new Set(rows.rows.map((row) => row.device_uid));
}

export async function registerRealtime(app: FastifyInstance): Promise<void> {
  // Deliberately not awaited: blocking plugin registration on Redis means a
  // momentarily unreachable Redis stops the whole API from booting. ioredis
  // retries on its own and re-subscribes after a reconnect, so the fan-out
  // recovers by itself while HTTP keeps serving.
  subscriber.subscribe(CHANNEL_DEVICE_UPDATE).catch((error) => {
    logger.error({ err: error }, 'failed to subscribe to device update channel');
  });

  subscriber.on('message', (channel: string, raw: string) => {
    if (channel !== CHANNEL_DEVICE_UPDATE) return;
    let update: DeviceUpdate;
    try {
      update = JSON.parse(raw);
    } catch {
      return;
    }
    const frame = JSON.stringify({ type: 'device.update', ...update });
    for (const client of clients) {
      if (!client.visible.has(update.deviceUid)) continue;
      if (client.socket.readyState === client.socket.OPEN) client.socket.send(frame);
    }
  });

  app.get('/ws', { websocket: true }, async (socket, request) => {
    // Browsers cannot set headers on a WebSocket handshake, so the token comes
    // in the query string. It is a short-lived access token, never the refresh
    // token, and TLS keeps it off the wire in clear text.
    const token =
      typeof (request.query as Record<string, unknown>)?.token === 'string'
        ? ((request.query as Record<string, string>).token as string)
        : null;

    if (!token) {
      socket.close(4401, 'token required');
      return;
    }

    let userId: string;
    try {
      const claims = await verifyAccessToken(token);
      userId = claims.sub;
    } catch {
      socket.close(4401, 'invalid token');
      return;
    }

    const client: Client = { socket, userId, visible: await visibleDeviceUids(userId) };
    clients.add(client);
    logger.debug({ userId, devices: client.visible.size }, 'realtime client connected');

    socket.send(
      JSON.stringify({ type: 'ready', devices: [...client.visible], at: Date.now() }),
    );

    socket.on('message', (data: Buffer) => {
      let message: { type?: string };
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', at: Date.now() }));
        return;
      }
      // Claiming or removing a device changes what this socket should receive.
      if (message.type === 'refresh') {
        visibleDeviceUids(userId)
          .then((visible) => {
            client.visible = visible;
            socket.send(JSON.stringify({ type: 'ready', devices: [...visible], at: Date.now() }));
          })
          .catch((error) => logger.error({ err: error }, 'failed to refresh visibility'));
      }
    });

    socket.on('close', () => {
      clients.delete(client);
      logger.debug({ userId }, 'realtime client disconnected');
    });
    socket.on('error', () => clients.delete(client));
  });
}

export function connectedClients(): number {
  return clients.size;
}
