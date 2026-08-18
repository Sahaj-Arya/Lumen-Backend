import { readFile } from 'node:fs/promises';
import mqtt, { type MqttClient } from 'mqtt';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { ApiError } from '../errors.js';
import { query, queryOne } from '../db/index.js';
import { CHANNEL_DEVICE_UPDATE, keys, publisher, redis } from '../redis/index.js';
import {
  flatten,
  parseDeviceTopic,
  parseReadingPayload,
  parseStatusPayload,
  topics,
  type ReadingValue,
} from './topics.js';
import {
  DISCOVERY_PREFIX,
  capabilitiesFromDiscovery,
  channelFromConfig,
  channelFromDiscovery,
  declaredType,
  parseDiscoveryTopic,
  typeFromDiscovery,
  uidFromDiscovery,
  type ChannelDescriptor,
  type DiscoveryConfig,
} from './discovery.js';
import { DEVICE_TYPES, canonicalKey, normalizeType } from '../model/deviceTypes.js';

/**
 * The single MQTT client for the whole platform.
 *
 * The mobile app no longer holds broker credentials: it talks HTTPS/WebSocket
 * to this API, and the backend is the only thing that connects to the broker.
 * That removes the shared `app` password from the shipped bundle, which could
 * otherwise read every device topic and command every device.
 *
 * Node can open a raw TLS socket, so this uses the native mqtts://…:8883
 * endpoint rather than the WebSocket one the app was limited to.
 */

let client: MqttClient | null = null;
let connected = false;

export interface DeviceUpdate {
  deviceUid: string;
  status?: 'online' | 'offline';
  readings?: Record<string, ReadingValue>;
  at: number;
}

export function isConnected(): boolean {
  return connected;
}

export async function startBridge(): Promise<void> {
  if (!config.MQTT_ENABLED) {
    logger.warn('MQTT bridge disabled (MQTT_ENABLED=false); telemetry ingest is off');
    return;
  }

  const options: mqtt.IClientOptions = {
    clientId: `${config.MQTT_CLIENT_ID}-${Math.random().toString(16).slice(2, 8)}`,
    username: config.MQTT_USERNAME || undefined,
    password: config.MQTT_PASSWORD || undefined,
    protocolVersion: 5,
    clean: true,
    keepalive: 60,
    reconnectPeriod: 3000,
    connectTimeout: 15_000,
    resubscribe: true,
  };

  if (config.MQTT_CA_FILE) {
    options.ca = [await readFile(config.MQTT_CA_FILE)];
  }

  client = mqtt.connect(config.MQTT_URL, options);

  client.on('connect', () => {
    connected = true;
    reportedDown = false;
    logger.info({ url: config.MQTT_URL }, 'mqtt bridge connected');
    // Device data, plus the discovery prefix every hub in the ecosystem
    // listens on — that is where a device says what it is.
    const wanted = [topics.all(config.MQTT_BASE_TOPIC), `${DISCOVERY_PREFIX}/#`];
    client!.subscribe(wanted, { qos: 1 }, (error, granted) => {
      if (error) {
        logger.error({ err: error }, 'mqtt subscribe failed');
        return;
      }
      // The broker answers a denied subscription with QoS 128 rather than an
      // error, so an ACL problem is otherwise silent.
      const denied = (granted ?? []).filter((sub) => sub.qos > 2);
      if (denied.length) {
        logger.error({ denied }, 'mqtt subscription denied by broker ACL');
      }
    });
  });

  // The client re-emits the same failure on every retry, with a full stack.
  // Report the first, then stay quiet until it actually connects — otherwise a
  // bad credential scrolls everything else off the screen.
  let reportedDown = false;
  client.on('reconnect', () => {
    if (!reportedDown) logger.warn('mqtt reconnecting');
  });
  client.on('close', () => {
    connected = false;
  });
  client.on('error', (error: Error & { code?: number }) => {
    if (reportedDown) return;
    reportedDown = true;
    // Reason code 135 is 'Not Authorized' — almost always a wrong or missing
    // MQTT_PASSWORD, so say that rather than printing a protocol stack.
    const hint =
      error.code === 135
        ? ' — check MQTT_USERNAME / MQTT_PASSWORD in .env'
        : '';
    logger.error({ err: error.message, code: error.code }, `mqtt connection failed${hint}`);
  });
  client.on('message', (topic, payload, packet) => {
    handleMessage(topic, payload.toString(), Boolean(packet.retain)).catch((error) =>
      logger.error({ err: error, topic }, 'failed to ingest mqtt message'),
    );
  });
}

export async function stopBridge(): Promise<void> {
  if (!client) return;
  await new Promise<void>((resolve) => client!.end(false, {}, () => resolve()));
  client = null;
  connected = false;
}

/** Publishes a command patch. QoS 1, never retained — commands are events. */
/**
 * What a device's channels are, cached from their discovery configs.
 *
 * Redis rather than a table: the device is the authority and re-announces
 * every one of these on each connect, so a row would be a second copy that can
 * only be wrong. A channel that stops being announced -- a pin removed from the
 * map -- stops being listed the next time the device reconnects, because the
 * whole set is rewritten rather than merged.
 */
async function rememberChannel(deviceUid: string, descriptor: ChannelDescriptor): Promise<void> {
  const existing = await readChannels(deviceUid);
  const next = [
    ...existing.filter((entry) => entry.channel !== descriptor.channel),
    descriptor,
  ].sort((a, b) => (a.gpio ?? 0) - (b.gpio ?? 0) || a.channel.localeCompare(b.channel));

  await redis.hset(keys.deviceState(deviceUid), { channels: JSON.stringify(next) });
}

export async function readChannels(deviceUid: string): Promise<ChannelDescriptor[]> {
  const raw = await redis.hget(keys.deviceState(deviceUid), 'channels');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ChannelDescriptor[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function publishCommand(
  deviceUid: string,
  patch: Record<string, unknown>,
  channel?: string | null,
): Promise<string> {
  if (!client || !connected) {
    throw ApiError.unavailable('Not connected to the MQTT broker');
  }
  // A device with things on its pins answers per pin. Commanding the device
  // itself would reach whatever its single-entity firmware does, which for a
  // board holding a relay and a sensor is nothing.
  const topic = channel
    ? topics.channelCommand(config.MQTT_BASE_TOPIC, deviceUid, channel)
    : topics.command(config.MQTT_BASE_TOPIC, deviceUid);

  await new Promise<void>((resolve, reject) => {
    client!.publish(topic, JSON.stringify(patch), { qos: 1, retain: false }, (error) =>
      error ? reject(error) : resolve(),
    );
  });

  return topic;
}

// ───────────────────────────── ingest ─────────────────────────────

interface DeviceRow {
  id: string;
  status: string;
  type: string;
}

/**
 * Devices publish whether or not anyone registered them, so unknown ids are
 * cached in Redis only. They surface through the discovery endpoint and start
 * being persisted the moment someone claims them.
 */
async function lookupDevice(deviceUid: string): Promise<DeviceRow | null> {
  return queryOne<DeviceRow>('SELECT id, status, type FROM devices WHERE device_uid = $1', [
    deviceUid,
  ]);
}

/**
 * Folds the names firmware uses onto the catalogue's own: `temp` becomes
 * `temperature`, `lux` becomes `illuminance`, and this platform's old `power`
 * on/off becomes `state`. Done on ingest so one device reporting `temp` and
 * another reporting `temperature` land on the same key, and an automation
 * written against one works with both.
 */
function canonicalizeReadings(
  type: string | null,
  readings: Record<string, ReadingValue>,
): Record<string, ReadingValue> {
  if (!type) return readings;
  const out: Record<string, ReadingValue> = {};
  for (const [key, value] of Object.entries(readings)) {
    out[canonicalKey(type, key)] = value;
  }
  return out;
}

/**
 * A device announcing itself on the discovery prefix. The type and
 * capabilities it declares are recorded against the device once it exists;
 * before that the announcement is only useful as proof of life, which the
 * device's own state topics already provide.
 */
async function handleDiscovery(topic: string, payload: string): Promise<void> {
  const parsed = parseDiscoveryTopic(topic);
  if (!parsed) return;

  if (payload.trim() === '') {
    logger.info({ topic }, 'device withdrew its discovery config');
    return;
  }

  let config: DiscoveryConfig;
  try {
    config = JSON.parse(payload) as DiscoveryConfig;
  } catch {
    logger.warn({ topic }, 'discovery config is not valid JSON');
    return;
  }

  const deviceUid = uidFromDiscovery(parsed, config);
  // A type the firmware names outright wins, as long as this catalogue has it;
  // otherwise infer one from the component and device_class.
  const declared = declaredType(config);
  const named = declared ? normalizeType(declared) : null;
  const type =
    named && Object.hasOwn(DEVICE_TYPES, named)
      ? named
      : typeFromDiscovery(parsed.component, config);
  const capabilities = capabilitiesFromDiscovery(parsed.component, config);

  // Cached whether or not the device is claimed, so the Add device screen can
  // show what an unclaimed device says it is.
  const channel = channelFromDiscovery(parsed);
  if (channel) {
    // One entity of a device that has several. Its own type must not become the
    // device's -- a board is not a relay because its first pin is one -- so
    // only the channel list is updated here.
    await rememberChannel(deviceUid, channelFromConfig(channel, parsed.component, config));
    logger.info({ deviceUid, channel, component: parsed.component }, 'channel discovered');
    return;
  }

  await redis.hset(keys.deviceState(deviceUid), {
    discoveredType: type,
    discoveredName: String(config.name ?? config.device?.name ?? ''),
    capabilities: JSON.stringify(capabilities),
  });

  const device = await lookupDevice(deviceUid);
  if (!device) return;

  // The type is only filled in, never overwritten: whatever the owner chose in
  // the app outranks what the firmware guesses about itself.
  await query(
    `UPDATE devices
        SET capabilities = $2::jsonb,
            type = CASE WHEN type IS NULL OR type = 'generic' THEN $3 ELSE type END
      WHERE id = $1`,
    [device.id, JSON.stringify(capabilities), type],
  );
  logger.info({ deviceUid, component: parsed.component, type }, 'device discovered');
}

async function handleMessage(topic: string, payload: string, retained: boolean): Promise<void> {
  if (topic.startsWith('$SYS/')) return;

  if (topic.startsWith(`${DISCOVERY_PREFIX}/`)) {
    await handleDiscovery(topic, payload);
    return;
  }

  const parsed = parseDeviceTopic(topic, config.MQTT_BASE_TOPIC);
  if (!parsed || parsed.kind === 'command') return; // our own commands echo back

  const at = Date.now();
  const update: DeviceUpdate = { deviceUid: parsed.deviceUid, at };
  const readings: Record<string, ReadingValue> = {};

  // One pin of a device that has several. Its value is stored under the
  // channel name, so `gpio5` is the relay's state and `gpio5.brightness` is its
  // extra -- flat keys the app, the automation engine and the history table all
  // already understand, rather than a nested shape only new code could read.
  if (parsed.channel) {
    if (parsed.kind === 'state' || parsed.kind === 'telemetry') {
      if (payload.trim() === '' && retained) {
        await clearReading(parsed.deviceUid, parsed.channel);
        return;
      }
      const value = parseReadingPayload(payload);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, nested] of Object.entries(flatten(value) as Record<string, ReadingValue>)) {
          // `state` is the channel's own value, not a sub-reading of it.
          readings[key === 'state' ? parsed.channel : `${parsed.channel}.${key}`] = nested;
        }
      } else if (value !== '') {
        readings[parsed.channel] = value;
      }
    }
    // Availability per channel is not a thing here: a pin is reachable exactly
    // when its board is, and the board already publishes that.
    if (Object.keys(readings).length === 0) return;
    update.readings = readings;
    await applyUpdate(parsed.deviceUid, update, retained);
    return;
  }

  switch (parsed.kind) {
    case 'availability': {
      const status = parseStatusPayload(payload);
      if (status) update.status = status;
      else if (payload.trim() !== '' && parsed.key) {
        // Firmware using `status` for its power state rather than presence.
        readings[parsed.key] = parseReadingPayload(payload);
      }
      break;
    }
    case 'state': {
      const value = parseReadingPayload(payload);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(readings, flatten(value) as Record<string, ReadingValue>);
      } else {
        const status = parseStatusPayload(payload);
        if (status) update.status = status;
        else if (value !== '') readings.state = value;
      }
      break;
    }
    case 'attributes': {
      const attributes = parseReadingPayload(payload);
      if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
        await persistMeta(parsed.deviceUid, attributes as Record<string, unknown>);
      }
      break;
    }
    case 'telemetry': {
      const value = parseReadingPayload(payload);
      Object.assign(
        readings,
        (value && typeof value === 'object'
          ? flatten(value)
          : { telemetry: value }) as Record<string, ReadingValue>,
      );
      break;
    }
    case 'reading': {
      if (!parsed.key) break;
      // An empty retained payload clears the value, per MQTT convention.
      if (payload.trim() === '' && retained) {
        await clearReading(parsed.deviceUid, parsed.key);
        return;
      }
      readings[parsed.key] = parseReadingPayload(payload);
      break;
    }
  }

  update.readings = readings;
  await applyUpdate(parsed.deviceUid, update, retained);
}

/**
 * Everything that happens to an update once its shape is known: canonicalise,
 * cache, persist, wake the automation engine, fan out to WebSocket clients.
 *
 * Shared so a channel's reading takes exactly the same path as a device's.
 * Anything less and per-pin values would be invisible to automations, or
 * absent from history, in ways nobody would notice until a rule silently
 * never fired.
 */
async function applyUpdate(
  deviceUid: string,
  update: DeviceUpdate,
  retained: boolean,
): Promise<void> {
  const device = await lookupDevice(deviceUid);

  const named = canonicalizeReadings(device?.type ?? null, update.readings ?? {});
  if (Object.keys(named).length > 0) update.readings = named;
  else delete update.readings;
  if (!update.status && !update.readings) return;

  await cacheState(update, retained);

  if (device) {
    // Snapshot before the write, so a rule using `changed` can see what the
    // value actually changed from.
    const previous = updateHook ? await readStoredSnapshot(device.id) : undefined;
    await persist(device, update, retained);

    if (updateHook) {
      const snapshot = (await readStoredSnapshot(device.id)) ?? {};
      // Automations must never block or break ingest.
      updateHook({
        deviceId: device.id,
        deviceUid,
        snapshot,
        previous,
        status: update.status,
      }).catch((error) => logger.error({ err: error }, 'automation hook failed'));
    }
  }

  // Fan out to WebSocket clients on every API instance, not just this one.
  // `retained` travels with it: a retained replay is the broker's memory, not
  // evidence the device is up, and a client that treated it as live traffic
  // would show a dead device as online.
  await publisher.publish(
    CHANNEL_DEVICE_UPDATE,
    JSON.stringify({
      ...update,
      retained,
      // Presence read off an availability topic is authoritative (the Last Will
      // keeps it honest); anything else is inferred from traffic. Clients need
      // to know which, to age it correctly.
      ...(update.status ? { statusSource: 'status_topic' } : {}),
    }),
  );
}

/**
 * The automation engine registers itself here rather than being imported.
 * The engine already imports `publishCommand` from this module, so importing
 * it back would make a cycle.
 */
export type UpdateHook = (input: {
  deviceId: string;
  deviceUid: string;
  snapshot: Record<string, unknown>;
  previous?: Record<string, unknown>;
  status?: 'online' | 'offline';
}) => Promise<void>;

let updateHook: UpdateHook | null = null;

export function setUpdateHook(hook: UpdateHook | null): void {
  updateHook = hook;
}

async function readStoredSnapshot(deviceId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await query<{ key: string; value: unknown }>(
    'SELECT key, value FROM device_state WHERE device_id = $1',
    [deviceId],
  );
  if (rows.rowCount === 0) return undefined;
  return Object.fromEntries(rows.rows.map((row) => [row.key, row.value]));
}

async function cacheState(update: DeviceUpdate, retained: boolean): Promise<void> {
  const key = keys.deviceState(update.deviceUid);
  const patch: Record<string, string> = { lastSeenAt: String(update.at) };
  if (!retained) patch.lastLiveAt = String(update.at);
  if (update.status) patch.status = update.status;
  for (const [name, value] of Object.entries(update.readings ?? {})) {
    patch[`r:${name}`] = JSON.stringify({ value, at: update.at, retained });
  }
  await redis.hset(key, patch);
}

async function persist(device: DeviceRow, update: DeviceUpdate, retained: boolean): Promise<void> {
  const at = new Date(update.at);

  if (update.status) {
    await query(
      `UPDATE devices
          SET status = $2, status_source = 'status_topic', last_seen_at = $3,
              last_live_at = CASE WHEN $4 THEN last_live_at ELSE $3 END
        WHERE id = $1`,
      [device.id, update.status, at, retained],
    );
  } else {
    await query(
      `UPDATE devices
          SET last_seen_at = $2,
              last_live_at = CASE WHEN $3 THEN last_live_at ELSE $2 END,
              status = CASE WHEN status_source = 'status_topic' THEN status
                            WHEN $3 THEN status ELSE 'online' END,
              status_source = CASE WHEN status_source = 'status_topic' THEN status_source
                                   ELSE 'inferred' END
        WHERE id = $1`,
      [device.id, at, retained],
    );
  }

  for (const [key, value] of Object.entries(update.readings ?? {})) {
    const numeric = typeof value === 'number' ? value : typeof value === 'boolean' ? Number(value) : null;
    const json = JSON.stringify(value);

    await query(
      `INSERT INTO device_state (device_id, key, value, retained, recorded_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (device_id, key)
       DO UPDATE SET value = EXCLUDED.value,
                     retained = EXCLUDED.retained,
                     recorded_at = EXCLUDED.recorded_at`,
      [device.id, key, json, retained, at],
    );

    // Retained messages are the broker replaying what it already held; writing
    // them to history would fabricate a data point at every reconnect.
    if (!retained) {
      await query(
        `INSERT INTO device_readings (device_id, key, value, numeric_value, recorded_at)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [device.id, key, json, numeric, at],
      );
    }
  }
}

async function persistMeta(deviceUid: string, meta: Record<string, unknown>): Promise<void> {
  const device = await lookupDevice(deviceUid);
  if (!device) return;
  await query('UPDATE devices SET capabilities = $2::jsonb WHERE id = $1', [
    device.id,
    JSON.stringify(meta.capabilities ?? meta),
  ]);
}

async function clearReading(deviceUid: string, key: string): Promise<void> {
  await redis.hdel(keys.deviceState(deviceUid), `r:${key}`);
  const device = await lookupDevice(deviceUid);
  if (device) {
    await query('DELETE FROM device_state WHERE device_id = $1 AND key = $2', [device.id, key]);
  }
}

/** Latest cached state for a device, as the API returns it. */
/**
 * What a device said about itself on the discovery prefix, cached from before
 * it was claimed. A retained config is delivered once per subscription, so by
 * the time a device row exists the announcement is long consumed — this is how
 * a freshly claimed device still arrives with its type and capabilities.
 */
export async function readDiscovered(deviceUid: string): Promise<{
  type: string | null;
  name: string | null;
  capabilities: Record<string, unknown> | null;
}> {
  const raw = await redis.hmget(
    keys.deviceState(deviceUid),
    'discoveredType',
    'discoveredName',
    'capabilities',
  );
  const [type, name, capabilities] = raw;

  let parsed: Record<string, unknown> | null = null;
  if (capabilities) {
    try {
      parsed = JSON.parse(capabilities) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  return { type: type || null, name: name || null, capabilities: parsed };
}

export async function readCachedState(deviceUid: string): Promise<{
  status: string | null;
  lastSeenAt: number | null;
  lastLiveAt: number | null;
  readings: Record<string, { value: unknown; at: number; retained: boolean }>;
}> {
  const raw = await redis.hgetall(keys.deviceState(deviceUid));
  const readings: Record<string, { value: unknown; at: number; retained: boolean }> = {};
  for (const [field, value] of Object.entries(raw)) {
    if (!field.startsWith('r:')) continue;
    try {
      readings[field.slice(2)] = JSON.parse(value);
    } catch {
      // ignore a corrupt cache entry rather than failing the request
    }
  }
  return {
    status: raw.status ?? null,
    lastSeenAt: raw.lastSeenAt ? Number(raw.lastSeenAt) : null,
    lastLiveAt: raw.lastLiveAt ? Number(raw.lastLiveAt) : null,
    readings,
  };
}

/** Device ids seen on the broker that no home has claimed yet. */
export async function listUnclaimed(): Promise<string[]> {
  const seen = new Set<string>();
  const stream = redis.scanStream({ match: keys.deviceState('*'), count: 200 });
  for await (const batch of stream) {
    for (const key of batch as string[]) seen.add(String(key).split(':').pop()!);
  }
  if (seen.size === 0) return [];

  const known = await query<{ device_uid: string }>(
    'SELECT device_uid FROM devices WHERE device_uid = ANY($1)',
    [[...seen]],
  );
  for (const row of known.rows) seen.delete(row.device_uid);
  return [...seen].sort();
}
