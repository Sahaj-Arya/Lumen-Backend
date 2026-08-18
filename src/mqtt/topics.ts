/**
 * Topic conventions, taken from the Home Assistant MQTT integration so that
 * hubs and firmware outside this project understand our devices unchanged.
 * The mobile app and the broker's scripts follow the same layout:
 *
 *   <base>/<uid>/availability  retained + Last Will  -> "online" / "offline"
 *   <base>/<uid>/state         retained              -> JSON object of current
 *                                                       values, {"state":"ON"}
 *   <base>/<uid>/set           backend -> device     -> JSON command patch
 *   <base>/<uid>/telemetry                           -> JSON object of readings
 *   <base>/<uid>/attributes    retained              -> json_attributes_topic
 *   <base>/<uid>/<key>         retained              -> a single scalar reading
 *
 * A device may also be a group of things wired to its pins, and each of those
 * gets its own leaf under a channel segment -- the pin it is on:
 *
 *   <base>/<uid>/<channel>/state   retained            -> that pin's value
 *   <base>/<uid>/<channel>/set     backend -> device   -> command for that pin
 *
 * Devices additionally retain a discovery config on
 * homeassistant/<component>/<uid>/config — see discovery.ts.
 *
 * `status` and `cmd` are still parsed: they are what this platform used before
 * the move to the standard names, and firmware in the field still speaks them.
 */

export type TopicKind =
  | 'availability'
  | 'state'
  | 'attributes'
  | 'telemetry'
  | 'command'
  | 'reading';

export interface ParsedTopic {
  deviceUid: string;
  kind: TopicKind;
  key: string | null;
  /**
   * The entity within the device, when the topic addresses one -- `gpio5` for
   * a relay on pin 5. Null for the device's own topics.
   */
  channel: string | null;
}

/**
 * Leaves that turn `<uid>/<segment>/<leaf>` into a channel rather than a
 * nested reading key.
 *
 * Deliberately a closed set. `devices/x/power/today` is a reading called
 * `power.today` and must stay one, so only these exact leaves promote the
 * segment before them to a channel.
 */
const CHANNEL_LEAVES = new Map<string, TopicKind>([
  ['state', 'state'],
  ['set', 'command'],
  ['cmd', 'command'],
  ['availability', 'availability'],
  ['telemetry', 'telemetry'],
  ['attributes', 'attributes'],
]);

// `availability` is the standard name; the rest are what other firmware uses
// for the same thing, `status` included -- that was this platform's own name.
const AVAILABILITY_SEGMENTS = new Set(['availability', 'status', 'online', 'lwt']);
// "Online"/"Offline" (Tasmota) and "online"/"offline" (everyone else) differ
// only in case, which the caller has already folded away.
const ONLINE_WORDS = new Set(['online', 'true', '1', 'up', 'connected', 'available']);
const OFFLINE_WORDS = new Set(['offline', 'false', '0', 'down', 'disconnected', 'unavailable']);

// Both command verbs are recognised so that a device flashed before the move
// to `set` still has its echoes ignored rather than stored as readings.
const COMMAND_SEGMENTS = new Set(['set', 'cmd', 'command']);

export function parseDeviceTopic(topic: string, baseTopic = 'devices'): ParsedTopic | null {
  const segments = topic.split('/');
  if (segments.length < 2 || segments[0] !== baseTopic) return null;

  const deviceUid = segments[1];
  if (!deviceUid) return null;

  const rest = segments.slice(2);
  if (rest.length === 0) {
    // Zigbee2MQTT publishes the whole state object on the bare device topic.
    return { deviceUid, kind: 'state', key: null, channel: null };
  }

  // <uid>/<channel>/<leaf>: one thing wired to the device, addressed on its own.
  if (rest.length === 2) {
    const kind = CHANNEL_LEAVES.get(rest[1]!);
    if (kind) return { deviceUid, kind, key: null, channel: rest[0]! };
  }
  if (rest.length === 1 && AVAILABILITY_SEGMENTS.has(rest[0]!)) {
    // The segment name travels with the parse so a payload that turns out not
    // to be a presence word can still be stored as a reading.
    return { deviceUid, kind: 'availability', key: rest[0]!, channel: null };
  }
  if (rest.length === 1 && (rest[0] === 'attributes' || rest[0] === 'meta')) {
    return { deviceUid, kind: 'attributes', key: null, channel: null };
  }
  if (rest.length === 1 && rest[0] === 'state') return { deviceUid, kind: 'state', key: null, channel: null };
  if (rest.length === 1 && rest[0] === 'telemetry') {
    return { deviceUid, kind: 'telemetry', key: null, channel: null };
  }
  if (COMMAND_SEGMENTS.has(rest[0]!)) {
    return { deviceUid, kind: 'command', key: rest.slice(1).join('.') || null, channel: null };
  }

  return { deviceUid, kind: 'reading', key: rest.join('.'), channel: null };
}

export function parseStatusPayload(payload: string): 'online' | 'offline' | null {
  const raw = payload.trim();
  if (!raw) return null; // cleared retained value

  const lower = raw.toLowerCase();
  if (ONLINE_WORDS.has(lower)) return 'online';
  if (OFFLINE_WORDS.has(lower)) return 'offline';

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'boolean') return parsed ? 'online' : 'offline';
    if (parsed && typeof parsed === 'object') {
      const value = parsed.state ?? parsed.status ?? parsed.online ?? parsed.connected;
      if (value !== undefined) return parseStatusPayload(String(value));
    }
  } catch {
    // not JSON
  }
  return null;
}

export type ReadingValue = string | number | boolean | Record<string, unknown> | unknown[];

export function parseReadingPayload(payload: string): ReadingValue {
  const trimmed = payload.trim();
  if (trimmed === '') return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) return asNumber;

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return payload;
    }
  }
  return payload;
}

/** Flattens nested telemetry into dotted keys: {a:{b:1}} -> {"a.b":1}. */
export function flatten(
  value: unknown,
  prefix = '',
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix) out[prefix] = value;
    return out;
  }
  for (const [key, nested] of Object.entries(value)) {
    flatten(nested, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

export const topics = {
  all: (base: string) => `${base}/#`,
  availability: (base: string, uid: string) => `${base}/${uid}/availability`,
  state: (base: string, uid: string) => `${base}/${uid}/state`,
  telemetry: (base: string, uid: string) => `${base}/${uid}/telemetry`,
  command: (base: string, uid: string) => `${base}/${uid}/set`,
  /** A command for one thing wired to the device, rather than the device. */
  channelCommand: (base: string, uid: string, channel: string) =>
    `${base}/${uid}/${channel}/set`,
};
