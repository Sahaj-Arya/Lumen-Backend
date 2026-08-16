import {
  isFiring,
  type Comparator,
  type Condition,
  type MatchMode,
  type ReadingSnapshot,
} from './types.js';

/**
 * Pure rule logic. No database, no MQTT, no clock reads beyond what is passed
 * in — so the interesting behaviour (comparisons across mixed payload types,
 * hysteresis, any/all matching) is testable without any infrastructure.
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
 * Compares a reported value against a condition's target.
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

/**
 * Is 'now' inside a daily window?
 *
 * A window whose end is before its start wraps midnight — 22:00-06:00 is a
 * single night, not an empty set. The weekday is the day the window *started*,
 * so a Friday-night rule still holds at 01:00 on Saturday.
 */
export function isWithinWindow(
  window: { fromMinute: number; toMinute: number; days: number[] },
  nowMinute: number,
  weekday: number,
): boolean {
  const wraps = window.fromMinute > window.toMinute;
  const inClock = wraps
    ? nowMinute >= window.fromMinute || nowMinute <= window.toMinute
    : nowMinute >= window.fromMinute && nowMinute <= window.toMinute;
  if (!inClock) return false;

  if (window.days.length === 0) return true;
  // Past midnight inside a wrapping window, the window belongs to yesterday.
  const startDay = wraps && nowMinute <= window.toMinute ? (weekday + 6) % 7 : weekday;
  return window.days.includes(startDay);
}

export interface EvalContext {
  /** Current readings per device id. */
  snapshots: Map<string, ReadingSnapshot>;
  /** Readings before the message being processed, for `changed`. */
  previous?: Map<string, ReadingSnapshot>;
  /** Current presence per device id. */
  statuses?: Map<string, 'online' | 'offline' | null>;
  /** Wall clock in the home's timezone. */
  clock?: { minute: number; weekday: number };
}

/**
 * Is one condition currently true?
 *
 * A schedule condition is a moment, not a state, so it is never "currently
 * true" — the scheduler decides when it comes due and tells the engine which
 * one fired. Treating it as satisfiable here would make an ALL rule containing
 * a schedule impossible to satisfy from a device update.
 */
export function evaluateCondition(condition: Condition, context: EvalContext): boolean {
  switch (condition.kind) {
    case 'time':
      // No clock supplied means the caller cannot evaluate time, and a rule
      // must not run on an unchecked condition.
      if (!context.clock) return false;
      return isWithinWindow(condition, context.clock.minute, context.clock.weekday);

    case 'status':
      return (context.statuses?.get(condition.deviceId) ?? null) === condition.status;

    case 'schedule':
      return false;

    default: {
      const snapshot = context.snapshots.get(condition.deviceId);
      // A rule referencing a device we have never heard from must not run.
      if (!snapshot) return false;
      return compare(
        snapshot[condition.key],
        condition.op,
        condition.value,
        context.previous?.get(condition.deviceId)?.[condition.key],
      );
    }
  }
}

/**
 * Does the rule as a whole hold?
 *
 * `all` (AND) — every firing condition must be true.
 * `any` (OR)  — at least one firing condition must be true.
 *
 * Either way **every time window must be open**. A gate narrows rather than
 * widens, even under ANY: "between 22:00 and 06:00 OR motion" reads as a
 * mistake, and running the pump at noon because the window happened to be one
 * of two alternatives is the wrong answer.
 */
export function isSatisfied(
  match: MatchMode,
  conditions: Condition[],
  context: EvalContext,
  /** Force one condition true — the schedule the scheduler just matched. */
  firedIndex?: number,
): boolean {
  const gatesOpen = conditions
    .filter((condition) => !isFiring(condition))
    .every((gate) => evaluateCondition(gate, context));
  if (!gatesOpen) return false;

  const firing = conditions
    .map((condition, index) => ({ condition, index }))
    .filter((entry) => isFiring(entry.condition));
  // A rule of gates alone can never run; validation rejects it on write.
  if (firing.length === 0) return false;

  const holds = ({ condition, index }: { condition: Condition; index: number }) =>
    index === firedIndex || evaluateCondition(condition, context);

  return match === 'all' ? firing.every(holds) : firing.some(holds);
}

/**
 * Should a rule that has already run re-arm?
 *
 * With `clearValue` set on a device condition it stays latched until the
 * reading crosses back past that value — real hysteresis. A tank at 90% with
 * `> 90 / clear 80` runs once and will not run again until the level drops
 * below 80, instead of re-running every time it wobbles across 90.
 */
export function shouldRearm(conditions: Condition[], context: EvalContext): boolean {
  const banded = conditions.filter(
    (condition): condition is Extract<Condition, { kind: 'device' }> =>
      condition.kind === 'device' && condition.clearValue !== undefined,
  );

  // No hysteresis anywhere: re-arm as soon as the rule stops holding, which the
  // caller has already established before asking.
  if (banded.length === 0) return true;

  // Every banded condition must have cleared its own band.
  return banded.every((condition) => {
    const current = toNumber(context.snapshots.get(condition.deviceId)?.[condition.key]);
    if (current === null) return false;
    const rising = condition.op === '>' || condition.op === '>=';
    return rising ? current < condition.clearValue! : current > condition.clearValue!;
  });
}

/** Device ids a rule reads from, for the watch index. */
export function watchedDeviceIds(conditions: Condition[]): string[] {
  const ids = new Set<string>();
  for (const condition of conditions) {
    // Time windows and schedules watch the clock, not a device.
    if (condition.kind === 'device' || condition.kind === 'status') ids.add(condition.deviceId);
  }
  return [...ids];
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
