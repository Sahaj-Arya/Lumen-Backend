import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../errors.js';
import { audit } from '../services/audit.js';
import { config } from '../config.js';
import { currentUser, requireAuth, requireDeviceAccess, requireHomeRole } from '../auth/guard.js';
import { generateSecret, hashPassword } from '../auth/password.js';
import {
  listUnclaimed,
  publishCommand,
  readCachedState,
  readChannels,
  readDiscovered,
  typeForChannel,
} from '../mqtt/bridge.js';
import { topics } from '../mqtt/topics.js';
import { query, queryOne } from '../db/index.js';

/**
 * `device_uid` is the MQTT principal id, so it must match what
 * `scripts/add-device.mjs` on the broker accepts.
 */
const DEVICE_UID = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{3,64}$/, 'Use 3-64 characters of A-Z, a-z, 0-9, _ or -');

const createBody = z.object({
  deviceUid: DEVICE_UID,
  name: z.string().trim().min(1).max(80).optional(),
  type: z.string().trim().max(40).default('generic'),
  groupId: z.string().uuid().nullable().optional(),
  manufacturer: z.string().trim().max(80).optional(),
  model: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(500).optional(),
});

/**
 * Type is deliberately absent: it is chosen once, at claim time.
 *
 * The type decides which controls the app renders and which keys an automation
 * may command, so changing it afterwards would silently invalidate every rule
 * already written against the device. Zod strips unknown keys by default, which
 * would make a client's attempt vanish without a word, so it is rejected
 * explicitly below instead.
 */
const updateBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  groupId: z.string().uuid().nullable().optional(),
  manufacturer: z.string().trim().max(80).optional(),
  model: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(500).optional(),
  favourite: z.boolean().optional(),
});

/**
 * The payload a device puts in its QR code, built by the firmware in
 * `Lumen-Devices/main/device.c`.
 *
 * Identity only, and none of it is trusted for authorisation: whoever scanned
 * the code still has to be a member of the home they are claiming into, and the
 * uid is validated exactly as a hand-typed one is. A QR code saves someone
 * typing 64 characters; it is not a credential, because anyone who can
 * photograph a device can reproduce it.
 */
const claimPayload = z.object({
  v: z.literal(1),
  id: DEVICE_UID,
  name: z.string().trim().max(80).optional(),
  type: z.string().trim().max(40).optional(),
  comp: z.string().trim().max(40).optional(),
  mac: z.string().trim().max(32).optional(),
  model: z.string().trim().max(80).optional(),
  fw: z.string().trim().max(40).optional(),
  root: z.string().trim().max(40).optional(),
  disc: z.string().trim().max(40).optional(),
});

/**
 * Accepts the whole scanned string as well as an already-decoded object,
 * because what a scanner hands over varies: the full URL, the bare base64url
 * fragment, or JSON somebody pasted.
 */
const claimBody = z.object({
  payload: z.union([z.string().trim().min(1), claimPayload]),
});

function decodeClaim(payload: string | z.infer<typeof claimPayload>): z.infer<typeof claimPayload> {
  if (typeof payload !== 'string') return payload;

  const text = payload.trim();
  let json: string;
  if (text.startsWith('{')) {
    json = text;
  } else {
    const hash = text.indexOf('#');
    const encoded = (hash >= 0 ? text.slice(hash + 1) : text).replace(/-/g, '+').replace(/_/g, '/');
    // The firmware drops base64 padding to keep the printed code small.
    const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
    json = Buffer.from(padded, 'base64').toString('utf8');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw ApiError.badRequest('That code is not a Lumen device code');
  }
  return claimPayload.parse(parsed);
}

const commandBody = z.object({
  // A command is a patch of key -> value, e.g. {"state":"ON","brightness":128}
  // -- Home Assistant's light JSON schema, which is what devices expect.
  patch: z.record(z.union([z.string(), z.number(), z.boolean()])).refine(
    (patch) => Object.keys(patch).length > 0,
    'Command patch cannot be empty',
  ),
});

interface DeviceRow {
  id: string;
  home_id: string;
  group_id: string | null;
  device_uid: string;
  parent_uid: string | null;
  channel: string | null;
  name: string;
  type: string;
  manufacturer: string;
  model: string;
  notes: string;
  favourite: boolean;
  status: string;
  status_source: string;
  last_seen_at: Date | null;
  last_live_at: Date | null;
  capabilities: unknown;
  created_at: Date;
}

/**
 * Presence rules, matched to the app's:
 *  1. an explicit retained status topic (kept honest by the Last Will) wins;
 *  2. otherwise infer from how recently the device published anything live;
 *  3. seen only via retained messages means 'stale' — the broker's memory is
 *     not evidence the device is up.
 */
function effectiveStatus(row: DeviceRow): string {
  if (row.status_source === 'status_topic' && (row.status === 'online' || row.status === 'offline')) {
    return row.status;
  }
  if (!row.last_live_at) return row.last_seen_at ? 'stale' : 'unknown';
  const age = Date.now() - new Date(row.last_live_at).getTime();
  return age <= config.DEVICE_STALE_SECONDS * 1000 ? 'online' : 'stale';
}

const present = (row: DeviceRow) => ({
  id: row.id,
  homeId: row.home_id,
  groupId: row.group_id,
  deviceUid: row.device_uid,
  // Set when this device is one pin of a board. The app shows such devices
  // normally -- they are ordinary devices -- and only uses these to say which
  // board a thing lives on.
  parentUid: row.parent_uid,
  channel: row.channel,
  name: row.name,
  type: row.type,
  manufacturer: row.manufacturer,
  model: row.model,
  notes: row.notes,
  favourite: row.favourite,
  status: effectiveStatus(row),
  statusSource: row.status_source,
  lastSeenAt: row.last_seen_at,
  lastLiveAt: row.last_live_at,
  capabilities: row.capabilities,
  createdAt: row.created_at,
});

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // ─────────────────────────── listing ──────────────────────────
  app.get('/', async (request) => {
    const user = currentUser(request);
    const filter = z
      .object({ homeId: z.string().uuid().optional(), groupId: z.string().uuid().optional() })
      .parse(request.query);

    if (filter.homeId) await requireHomeRole(user.id, filter.homeId);

    const rows = await query<DeviceRow>(
      `SELECT d.* FROM devices d
         JOIN home_members m ON m.home_id = d.home_id AND m.user_id = $1
        WHERE ($2::uuid IS NULL OR d.home_id = $2)
          AND ($3::uuid IS NULL OR d.group_id = $3)
        ORDER BY d.favourite DESC, d.name`,
      [user.id, filter.homeId ?? null, filter.groupId ?? null],
    );

    // Current values come along with the list. They are already in Redis (the
    // retained state the broker replayed on connect), so this costs one cheap
    // read per device -- and without it a freshly opened app shows a grid of
    // devices with no values and every toggle off until each one is opened.
    const readings = Object.fromEntries(
      await Promise.all(
        rows.rows.map(
          async (row) => [row.id, (await readCachedState(row.device_uid)).readings] as const,
        ),
      ),
    );

    // Channels come with the list for the same reason as readings: a board
    // that is a group of things has to render as one on the first paint, not
    // after the app has opened each device in turn.
    const channels = Object.fromEntries(
      await Promise.all(
        rows.rows.map(async (row) => [row.id, await readChannels(row.device_uid)] as const),
      ),
    );

    return { devices: rows.rows.map(present), readings, channels };
  });

  /**
   * Device ids publishing to the broker that no home has claimed. Retained
   * messages mean this is populated the moment the bridge subscribes — there is
   * no discovery protocol to run.
   */
  app.get('/unclaimed', async () => ({ deviceUids: await listUnclaimed() }));

  // ──────────────────────── provisioning ────────────────────────

  /**
   * Claim a device from its QR code.
   *
   * The same claim as `POST /` — same uniqueness rule, same credential, same
   * audit entry — reached without anyone transcribing a device id. It is a
   * separate route rather than an extra field on the existing body because the
   * input is a scanned string of unknown shape that has to be decoded and
   * validated before it can be treated as a claim at all.
   *
   * Scanning proves nothing about who is scanning: membership of the home is
   * still required, and a device already claimed still conflicts.
   */
  app.post('/from-qr', async (request, reply) => {
    const user = currentUser(request);
    const { payload } = claimBody.parse(request.body);
    const { homeId } = z.object({ homeId: z.string().uuid() }).parse(request.query);
    await requireHomeRole(user.id, homeId, 'member');

    const claim = decodeClaim(payload);

    // A board with things on its pins is a group of devices, not one device.
    // A light and a fan on the same ESP are two things a person switches, and
    // one row holding both would make every downstream feature -- cards,
    // automations, scenes, history -- special-case it forever.
    const channels = await readChannels(claim.id);
    if (channels.length > 0) {
      return claimBoard(reply, homeId, user.id, claim, channels);
    }

    // Goes through the same claim as a typed-in id, so the two routes cannot
    // drift on what claiming means.
    return claimDevice(reply, homeId, user.id, {
      deviceUid: claim.id,
      name: claim.name,
      type: claim.type ?? 'generic',
      model: claim.model,
    });
  });

  /**
   * Claims every pin of a board as its own device, gathered into one group.
   *
   * The group is the board: it says these things share a box and a power
   * supply. It is an ordinary group though, so a pin can be moved out of it
   * into a room like any other device -- the grouping is a starting point, not
   * a cage.
   *
   * One credential, not one per pin. The MQTT principal belongs to the board;
   * the pins are segments beneath it and have nothing of their own to
   * authenticate.
   */
  async function claimBoard(
    reply: FastifyReply,
    homeId: string,
    userId: string,
    claim: z.infer<typeof claimPayload>,
    channels: Awaited<ReturnType<typeof readChannels>>,
  ) {
    const taken = await queryOne<{ id: string }>(
      'SELECT id FROM devices WHERE device_uid = $1 OR parent_uid = $1',
      [claim.id],
    );
    if (taken) throw ApiError.conflict('That device id is already claimed');

    const boardName = claim.name || claim.id;
    const group = await queryOne<{ id: string; name: string }>(
      `INSERT INTO device_groups (home_id, name, icon)
       VALUES ($1, $2, 'hardware-chip-outline')
       RETURNING id, name`,
      [homeId, boardName],
    );

    // One password for the board, hashed onto every row that speaks for it, so
    // rotating it later through any of them keeps them consistent.
    const mqttPassword = generateSecret(18);
    const passwordHash = await hashPassword(mqttPassword);

    const created = [];
    for (const channel of channels) {
      const row = await queryOne<DeviceRow>(
        `INSERT INTO devices (home_id, group_id, device_uid, parent_uid, channel, name, type,
                              model, capabilities, mqtt_password_hash, credential_issued_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, now())
         RETURNING *`,
        [
          homeId,
          group!.id,
          `${claim.id}_${channel.channel}`,
          claim.id,
          channel.channel,
          channel.name || `${boardName} ${channel.channel}`,
          typeForChannel(channel),
          claim.model ?? '',
          JSON.stringify({
            component: channel.component,
            ...(channel.kind ? { lumen_kind: channel.kind } : {}),
            ...(channel.deviceClass ? { device_class: channel.deviceClass } : {}),
            ...(channel.unit ? { unit_of_measurement: channel.unit } : {}),
            ...(channel.gpio === null ? {} : { gpio: channel.gpio }),
          }),
          passwordHash,
        ],
      );
      created.push(present(row!));
    }

    await audit({ userId, homeId, action: 'device.claim', subject: claim.id });

    return reply.status(201).send({
      group,
      devices: created,
      credentials: {
        username: claim.id,
        password: mqttPassword,
        endpoint: config.MQTT_URL,
        note: 'One credential for the whole board. Shown once — register it on the broker with scripts/add-device.mjs and restart the broker.',
      },
    });
  }

  app.post('/', async (request, reply) => {
    const user = currentUser(request);
    const { homeId } = z.object({ homeId: z.string().uuid() }).parse(request.query);
    await requireHomeRole(user.id, homeId, 'member');
    return claimDevice(reply, homeId, user.id, createBody.parse(request.body));
  });

  /** The claim itself, shared by the typed and the scanned routes. Callers have
   *  already checked the user may write to this home. */
  async function claimDevice(
    reply: FastifyReply,
    homeId: string,
    userId: string,
    body: z.infer<typeof createBody>,
  ) {
    const taken = await queryOne<{ id: string }>('SELECT id FROM devices WHERE device_uid = $1', [
      body.deviceUid,
    ]);
    // device_uid is the broker principal, so it is unique platform-wide rather
    // than per home — two homes cannot claim the same physical device.
    if (taken) throw ApiError.conflict('That device id is already claimed');

    if (body.groupId) {
      const group = await queryOne<{ id: string }>(
        'SELECT id FROM device_groups WHERE id = $1 AND home_id = $2',
        [body.groupId, homeId],
      );
      if (!group) throw ApiError.badRequest('Group does not belong to this home');
    }

    // What the device announced about itself before anyone claimed it. Its
    // retained discovery config was consumed while no device row existed, so
    // without this the claim would drop the type and capabilities on the floor.
    const discovered = await readDiscovered(body.deviceUid);
    const type = body.type === 'generic' && discovered.type ? discovered.type : body.type;
    // Only take a field the device sent as a plain string; anything else is
    // firmware sending something unexpected, not a manufacturer name.
    const announced = (key: string): string => {
      const value = discovered.capabilities?.[key];
      return typeof value === 'string' ? value : '';
    };

    // Credential for the device's own broker principal. Returned once, stored
    // only as a scrypt hash, in the format the broker's users.json expects.
    const mqttPassword = generateSecret(18);
    const row = await queryOne<DeviceRow>(
      `INSERT INTO devices (home_id, group_id, device_uid, name, type, manufacturer, model, notes,
                            capabilities, mqtt_password_hash, credential_issued_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, now())
       RETURNING *`,
      [
        homeId,
        body.groupId ?? null,
        body.deviceUid,
        body.name ?? discovered.name ?? body.deviceUid,
        type,
        body.manufacturer ?? announced('manufacturer'),
        body.model ?? announced('model'),
        body.notes ?? '',
        discovered.capabilities ? JSON.stringify(discovered.capabilities) : null,
        await hashPassword(mqttPassword),
      ],
    );

    await audit({
      userId,
      homeId,
      action: 'device.claim',
      subject: body.deviceUid,
    });

    return reply.status(201).send({
      device: present(row!),
      credentials: {
        username: body.deviceUid,
        password: mqttPassword,
        endpoint: config.MQTT_URL,
        note: 'Shown once. Register it on the broker with scripts/add-device.mjs and restart the broker.',
      },
    });
  }

  app.post('/:deviceId/credentials', async (request) => {
    const user = currentUser(request);
    const { deviceId } = z.object({ deviceId: z.string().uuid() }).parse(request.params);
    const access = await requireDeviceAccess(user.id, deviceId, 'admin');

    const mqttPassword = generateSecret(18);
    await query(
      'UPDATE devices SET mqtt_password_hash = $2, credential_issued_at = now() WHERE id = $1',
      [deviceId, await hashPassword(mqttPassword)],
    );
    await audit({
      userId: user.id,
      homeId: access.homeId,
      action: 'device.credential_rotate',
      subject: access.deviceUid,
    });

    return {
      username: access.deviceUid,
      password: mqttPassword,
      endpoint: config.MQTT_URL,
      note: 'Shown once. Update the broker principal and reflash the device.',
    };
  });

  // ──────────────────────── single device ───────────────────────
  app.get('/:deviceId', async (request) => {
    const user = currentUser(request);
    const { deviceId } = z.object({ deviceId: z.string().uuid() }).parse(request.params);
    await requireDeviceAccess(user.id, deviceId);

    const row = await queryOne<DeviceRow>('SELECT * FROM devices WHERE id = $1', [deviceId]);
    if (!row) throw ApiError.notFound('Device not found');

    // Redis holds the hot copy; Postgres is the fallback if the cache is cold
    // (fresh deploy, flushed Redis) so a reload never shows an empty device.
    const cached = await readCachedState(row.device_uid);
    let readings = cached.readings;
    if (Object.keys(readings).length === 0) {
      const stored = await query<{ key: string; value: unknown; retained: boolean; recorded_at: Date }>(
        'SELECT key, value, retained, recorded_at FROM device_state WHERE device_id = $1',
        [deviceId],
      );
      readings = Object.fromEntries(
        stored.rows.map((state) => [
          state.key,
          { value: state.value, at: state.recorded_at.getTime(), retained: state.retained },
        ]),
      );
    }

    // What is wired to the device's pins, if anything. A board with channels
    // is a group of entities, and the app renders it as one.
    const channels = await readChannels(row.device_uid);
    return { device: present(row), readings, channels };
  });

  app.patch('/:deviceId', async (request) => {
    const user = currentUser(request);
    const { deviceId } = z.object({ deviceId: z.string().uuid() }).parse(request.params);
    if (request.body && typeof request.body === 'object' && 'type' in request.body) {
      throw ApiError.badRequest(
        'Device type is set when the device is claimed and cannot be changed afterwards — ' +
          'automations are written against it. Remove and re-claim the device to change its type.',
      );
    }
    const body = updateBody.parse(request.body);
    const access = await requireDeviceAccess(user.id, deviceId, 'member');

    if (body.groupId) {
      const group = await queryOne<{ id: string }>(
        'SELECT id FROM device_groups WHERE id = $1 AND home_id = $2',
        [body.groupId, access.homeId],
      );
      if (!group) throw ApiError.badRequest('Group does not belong to this device’s home');
    }

    const row = await queryOne<DeviceRow>(
      `UPDATE devices
          SET name = COALESCE($2, name),
              group_id = CASE WHEN $3::boolean THEN $4 ELSE group_id END,
              manufacturer = COALESCE($5, manufacturer),
              model = COALESCE($6, model),
              notes = COALESCE($7, notes),
              favourite = COALESCE($8, favourite)
        WHERE id = $1
        RETURNING *`,
      [
        deviceId,
        body.name ?? null,
        Object.prototype.hasOwnProperty.call(body, 'groupId'),
        body.groupId ?? null,
        body.manufacturer ?? null,
        body.model ?? null,
        body.notes ?? null,
        body.favourite ?? null,
      ],
    );

    await audit({ userId: user.id, homeId: access.homeId, action: 'device.update', subject: access.deviceUid });
    return { device: present(row!) };
  });

  app.delete('/:deviceId', async (request) => {
    const user = currentUser(request);
    const { deviceId } = z.object({ deviceId: z.string().uuid() }).parse(request.params);
    const access = await requireDeviceAccess(user.id, deviceId, 'admin');

    await query('DELETE FROM devices WHERE id = $1', [deviceId]);
    await audit({
      userId: user.id,
      homeId: access.homeId,
      action: 'device.delete',
      subject: access.deviceUid,
    });
    // The physical device keeps publishing; it simply becomes unclaimed again.
    return { ok: true };
  });

  // ─────────────────────────── commands ─────────────────────────
  app.post('/:deviceId/commands', async (request) => {
    const user = currentUser(request);
    const { deviceId } = z.object({ deviceId: z.string().uuid() }).parse(request.params);
    const body = commandBody.parse(request.body);
    // Viewers can watch but not actuate.
    const access = await requireDeviceAccess(user.id, deviceId, 'member');

    try {
      // A pin is commanded on its board's topic. Which board, and which
      // segment, comes from the device row rather than from the caller: a
      // client that had to know would be a client that can get it wrong.
      const target = access.parentUid ?? access.deviceUid;
      const topic = await publishCommand(target, body.patch, access.channel);
      await query(
        `INSERT INTO device_commands (device_id, issued_by, payload, topic, status)
         VALUES ($1, $2, $3::jsonb, $4, 'sent')`,
        [deviceId, user.id, JSON.stringify(body.patch), topic],
      );
      await audit({
        userId: user.id,
        homeId: access.homeId,
        action: 'device.command',
        subject: access.deviceUid,
        metadata: body.patch,
      });
      return { ok: true, topic, patch: body.patch, channel: access.channel };
    } catch (error) {
      await query(
        `INSERT INTO device_commands (device_id, issued_by, payload, topic, status, error)
         VALUES ($1, $2, $3::jsonb, $4, 'failed', $5)`,
        [
          deviceId,
          user.id,
          JSON.stringify(body.patch),
          access.channel
            ? topics.channelCommand(
                config.MQTT_BASE_TOPIC,
                access.parentUid ?? access.deviceUid,
                access.channel,
              )
            : topics.command(config.MQTT_BASE_TOPIC, access.deviceUid),
          (error as Error).message,
        ],
      );
      throw error;
    }
  });

  app.get('/:deviceId/commands', async (request) => {
    const user = currentUser(request);
    const { deviceId } = z.object({ deviceId: z.string().uuid() }).parse(request.params);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(
      request.query,
    );
    await requireDeviceAccess(user.id, deviceId);

    const rows = await query(
      `SELECT c.id, c.payload, c.topic, c.status, c.error, c.created_at,
              u.email AS issued_by_email
         FROM device_commands c
         LEFT JOIN users u ON u.id = c.issued_by
        WHERE c.device_id = $1
        ORDER BY c.created_at DESC
        LIMIT $2`,
      [deviceId, limit],
    );
    return { commands: rows.rows };
  });
}
