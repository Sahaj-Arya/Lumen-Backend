/**
 * Topic conventions, kept identical to the mobile app and the broker's own
 * scripts so all three agree on what a topic means:
 *
 *   <base>/<uid>/status      retained + Last Will  -> "online" / "offline"
 *   <base>/<uid>/state       retained              -> presence word, or a JSON
 *                                                     object of current values
 *   <base>/<uid>/meta        retained              -> {"type","capabilities"}
 *   <base>/<uid>/telemetry                         -> JSON object of readings
 *   <base>/<uid>/cmd         backend -> device     -> JSON command patch
 *   <base>/<uid>/<key>       retained              -> a single scalar reading
 */

export type TopicKind = 'status' | 'state' | 'meta' | 'telemetry' | 'cmd' | 'reading';

export interface ParsedTopic {
  deviceUid: string;
  kind: TopicKind;
  key: string | null;
}

const STATUS_SEGMENTS = new Set(['status', 'availability', 'online']);
const ONLINE_WORDS = new Set(['online', 'true', '1', 'up', 'connected', 'available']);
const OFFLINE_WORDS = new Set(['offline', 'false', '0', 'down', 'disconnected', 'unavailable']);

export function parseDeviceTopic(topic: string, baseTopic = 'devices'): ParsedTopic | null {
  const segments = topic.split('/');
  if (segments.length < 2 || segments[0] !== baseTopic) return null;

  const deviceUid = segments[1];
  if (!deviceUid) return null;

  const rest = segments.slice(2);
  if (rest.length === 0) return { deviceUid, kind: 'reading', key: 'value' };
  if (rest.length === 1 && STATUS_SEGMENTS.has(rest[0]!)) {
    // The segment name travels with the parse so a payload that turns out not
    // to be a presence word can still be stored as a reading.
    return { deviceUid, kind: 'status', key: rest[0]! };
  }
  if (rest.length === 1 && rest[0] === 'meta') return { deviceUid, kind: 'meta', key: null };
  if (rest.length === 1 && rest[0] === 'state') return { deviceUid, kind: 'state', key: null };
  if (rest.length === 1 && rest[0] === 'telemetry') {
    return { deviceUid, kind: 'telemetry', key: null };
  }
  if (rest[0] === 'cmd') return { deviceUid, kind: 'cmd', key: rest.slice(1).join('.') || null };

  return { deviceUid, kind: 'reading', key: rest.join('.') };
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
  status: (base: string, uid: string) => `${base}/${uid}/status`,
  telemetry: (base: string, uid: string) => `${base}/${uid}/telemetry`,
  command: (base: string, uid: string) => `${base}/${uid}/cmd`,
};
