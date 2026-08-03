import type { Comparator, Predicate, ReadingSnapshot, Trigger } from './types.js';

/**
 * Pure rule logic. No database, no MQTT, no clock reads beyond what is passed
 * in — so the interesting behaviour (comparisons across mixed payload types,
 * hysteresis, edge detection) is testable without any infrastructure.
 */

/** Truthiness as IoT payloads express it: "on"/"open"/"1"/1/true are all true. */
const TRUE_WORDS = new Set(['on', 'true', '1', 'yes', 'open', 'locked', 'full', 'active', 'wet']);
const FALSE_WORDS = new Set(['off', 'false', '0', 'no', 'closed', 'unlocked', 'empty', 'inactive', 'dry']);

export function toBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const lower = String(value).trim().toLowerCase();
  if (TRUE_WORDS.has(lower)) return true;
  if (FALSE_WORDS.has(lower)) return false;
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Compares a reported value against a rule's target.
 *
 * Ordering comparisons need numbers on both sides; a device that reports
 * `"full"` where the rule expects `> 90` must not silently compare as strings
 * and produce nonsense, so it returns false instead.
 */
export function compare(
  actual: unknown,
  op: Comparator,
  target?: string | number | boolean,
  previous?: unknown,
): boolean {
  switch (op) {
    case 'changed':
      // Undefined previous means "first ever reading" — not a change.
      return previous !== undefined && JSON.stringify(actual) !== JSON.stringify(previous);
    case 'truthy':
      return toBoolean(actual) === true;
    case 'falsy':
      return toBoolean(actual) === false;
    case '==':
    case '!=': {
      // Equality is type-tolerant: boolean-ish payloads compare as booleans,
      // numeric ones as numbers, everything else case-insensitively as text.
      const bothBool = toBoolean(actual) !== null && toBoolean(target) !== null;
      let equal: boolean;
      if (bothBool && typeof target !== 'number') {
        equal = toBoolean(actual) === toBoolean(target);
      } else {
        const a = toNumber(actual);
        const b = toNumber(target);
        equal =
          a !== null && b !== null
            ? a === b
            : String(actual).trim().toLowerCase() === String(target).trim().toLowerCase();
      }
      return op === '==' ? equal : !equal;
    }
    default: {
      const a = toNumber(actual);
      const b = toNumber(target);
      if (a === null || b === null) return false;
      if (op === '>') return a > b;
      if (op === '>=') return a >= b;
      if (op === '<') return a < b;
      if (op === '<=') return a <= b;
      return false;
    }
  }
}

/** All conditions must hold. An empty list is vacuously true. */
export function evaluateConditions(
  conditions: Predicate[],
  snapshots: Map<string, ReadingSnapshot>,
): boolean {
  return conditions.every((condition) => {
    const snapshot = snapshots.get(condition.deviceId);
    // A rule referencing a device we have never heard from must not fire.
    if (!snapshot) return false;
    return compare(snapshot[condition.key], condition.op, condition.value);
  });
}

export interface TriggerContext {
  /** Readings for the device that just reported. */
  snapshot: ReadingSnapshot;
  /** The same device's readings before this message, for `changed`. */
  previous?: ReadingSnapshot;
  /** Presence, when the update carried a status change. */
  status?: 'online' | 'offline';
}

/** Is the trigger's predicate satisfied right now? */
export function evaluateTrigger(trigger: Trigger, context: TriggerContext): boolean {
  if (trigger.kind === 'status') return context.status === trigger.status;
  if (trigger.kind === 'schedule') return false; // handled by the scheduler
  return compare(
    context.snapshot[trigger.key],
    trigger.op,
    trigger.value,
    context.previous?.[trigger.key],
  );
}

/**
 * Should a rule that has already fired re-arm?
 *
 * With `clearValue` set the rule stays latched until the reading crosses back
 * past that value — real hysteresis. A tank at 90% with `> 90 / clear 80` fires
 * once, and will not fire again until the level drops below 80, instead of
 * re-firing every time the level wobbles across 90.
 */
export function shouldRearm(trigger: Trigger, snapshot: ReadingSnapshot): boolean {
  if (trigger.kind !== 'state') return true;
  if (trigger.clearValue === undefined) {
    // No hysteresis band: re-arm as soon as the predicate stops holding.
    return !compare(snapshot[trigger.key], trigger.op, trigger.value);
  }

  const current = toNumber(snapshot[trigger.key]);
  if (current === null) return false;

  // Direction is taken from the trigger comparator: an upper-bound rule clears
  // by falling below clearValue, a lower-bound rule by rising above it.
  const risingTrigger = trigger.op === '>' || trigger.op === '>=';
  return risingTrigger ? current < trigger.clearValue : current > trigger.clearValue;
}

/** Device ids a rule reads from, for the watch index. */
export function watchedDeviceIds(trigger: Trigger, conditions: Predicate[]): string[] {
  const ids = new Set<string>();
  if (trigger.kind === 'state' || trigger.kind === 'status') ids.add(trigger.deviceId);
  for (const condition of conditions) ids.add(condition.deviceId);
  return [...ids];
}

/** Minutes past midnight for a Date in a given IANA timezone. */
export function minuteOfDay(date: Date, timezone: string): { minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '0';
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // Intl renders midnight as 24 in some locales/engines; normalise to 0.
  const hour = Number(get('hour')) % 24;

  return {
    minute: hour * 60 + Number(get('minute')),
    weekday: weekdays[get('weekday')] ?? 0,
  };
}

/** Device ids a rule's actions command — the targets it actuates. */
export function actionDeviceIds(actions: Array<{ kind: string; deviceId?: string }>): string[] {
  return [
    ...new Set(
      actions
        .filter((action) => action.kind === 'command' && action.deviceId)
        .map((action) => action.deviceId!),
    ),
  ];
}
