import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  actionDeviceIds,
  compare,
  evaluateCondition,
  isSatisfied,
  isWithinWindow,
  minuteOfDay,
  shouldRearm,
  toBoolean,
  watchedDeviceIds,
} from '../dist/automation/evaluate.js';
import { isFiring } from '../dist/automation/types.js';
import type { EvalContext } from '../src/automation/evaluate.ts';
import type { Condition } from '../src/automation/types.ts';

const TANK = '11111111-1111-1111-1111-111111111111';
const MOTOR = '22222222-2222-2222-2222-222222222222';

const ctx = (over: Partial<EvalContext> = {}): EvalContext => ({
  snapshots: new Map(),
  statuses: new Map(),
  clock: { minute: 12 * 60, weekday: 1 },
  ...over,
});

const tankLevelAbove90: Condition = {
  kind: 'device',
  deviceId: TANK,
  key: 'level',
  op: '>',
  value: 90,
};
const nightWindow: Condition = { kind: 'time', fromMinute: 22 * 60, toMinute: 6 * 60, days: [] };
const motorOffline: Condition = { kind: 'status', deviceId: MOTOR, status: 'offline' };
const atSeven: Condition = { kind: 'schedule', atMinute: 7 * 60, days: [] };

describe('toBoolean', () => {
  it('reads the vocabulary devices actually publish', () => {
    for (const truthy of [true, 1, 'on', 'ON', 'true', '1', 'open', 'full', 'wet']) {
      assert.equal(toBoolean(truthy), true, String(truthy));
    }
    for (const falsy of [false, 0, 'off', 'false', '0', 'closed', 'empty', 'dry']) {
      assert.equal(toBoolean(falsy), false, String(falsy));
    }
  });

  it('returns null for values that are not boolean-ish', () => {
    assert.equal(toBoolean('banana'), null);
    assert.equal(toBoolean(undefined), null);
  });
});

describe('compare', () => {
  it('orders numbers, including numeric strings from MQTT payloads', () => {
    assert.equal(compare(95, '>', 90), true);
    assert.equal(compare('95', '>', 90), true);
    assert.equal(compare(85, '>', 90), false);
    assert.equal(compare(90, '>=', 90), true);
  });

  it('refuses to order non-numeric values instead of comparing as text', () => {
    // "full" > 90 would be true under string comparison — a real misfire risk.
    assert.equal(compare('full', '>', 90), false);
    assert.equal(compare(undefined, '>', 0), false);
  });

  it('compares equality tolerantly across types', () => {
    assert.equal(compare('ON', '==', 'on'), true);
    assert.equal(compare(true, '==', 'on'), true);
    assert.equal(compare('1', '==', 1), true);
    assert.equal(compare('off', '!=', 'on'), true);
  });

  it('handles truthy/falsy and changed', () => {
    assert.equal(compare('open', 'truthy'), true);
    assert.equal(compare('closed', 'falsy'), true);
    assert.equal(compare(5, 'changed', undefined, 4), true);
    // No previous value means first reading ever, which is not a change.
    assert.equal(compare(5, 'changed', undefined, undefined), false);
  });
});

describe('condition roles', () => {
  it('separates what can set a rule off from what only narrows it', () => {
    assert.equal(isFiring(tankLevelAbove90), true);
    assert.equal(isFiring(motorOffline), true);
    assert.equal(isFiring(atSeven), true);
    // A time window is not an event.
    assert.equal(isFiring(nightWindow), false);
  });
});

describe('evaluateCondition', () => {
  it('evaluates a device reading', () => {
    const context = ctx({ snapshots: new Map([[TANK, { level: 95 }]]) });
    assert.equal(evaluateCondition(tankLevelAbove90, context), true);
    assert.equal(
      evaluateCondition(tankLevelAbove90, ctx({ snapshots: new Map([[TANK, { level: 10 }]]) })),
      false,
    );
  });

  it('is false for a device that has never reported', () => {
    assert.equal(evaluateCondition(tankLevelAbove90, ctx()), false);
  });

  it('evaluates presence', () => {
    assert.equal(
      evaluateCondition(motorOffline, ctx({ statuses: new Map([[MOTOR, 'offline']]) })),
      true,
    );
    assert.equal(
      evaluateCondition(motorOffline, ctx({ statuses: new Map([[MOTOR, 'online']]) })),
      false,
    );
  });

  it('never reports a schedule as currently true', () => {
    // A schedule is a moment, not a state; the scheduler says when it is due.
    // If this returned true an ANY rule would fire on every message.
    assert.equal(evaluateCondition(atSeven, ctx()), false);
  });

  it('refuses a time window with no clock rather than assuming', () => {
    assert.equal(evaluateCondition(nightWindow, ctx({ clock: undefined })), false);
  });
});

describe('isSatisfied — ALL (AND)', () => {
  const conditions = [tankLevelAbove90, motorOffline];

  it('needs every firing condition', () => {
    const both = ctx({
      snapshots: new Map([[TANK, { level: 95 }]]),
      statuses: new Map([[MOTOR, 'offline']]),
    });
    assert.equal(isSatisfied('all', conditions, both), true);

    const onlyOne = ctx({
      snapshots: new Map([[TANK, { level: 95 }]]),
      statuses: new Map([[MOTOR, 'online']]),
    });
    assert.equal(isSatisfied('all', conditions, onlyOne), false);
  });
});

describe('isSatisfied — ANY (OR)', () => {
  const conditions = [tankLevelAbove90, motorOffline];

  it('needs only one firing condition', () => {
    const onlyTank = ctx({
      snapshots: new Map([[TANK, { level: 95 }]]),
      statuses: new Map([[MOTOR, 'online']]),
    });
    assert.equal(isSatisfied('any', conditions, onlyTank), true);
  });

  it('is false when none hold', () => {
    const neither = ctx({
      snapshots: new Map([[TANK, { level: 10 }]]),
      statuses: new Map([[MOTOR, 'online']]),
    });
    assert.equal(isSatisfied('any', conditions, neither), false);
  });
});

describe('isSatisfied — time windows gate rather than widen', () => {
  it('blocks an ALL rule outside the window', () => {
    const conditions = [tankLevelAbove90, nightWindow];
    const noon = ctx({ snapshots: new Map([[TANK, { level: 95 }]]) });
    assert.equal(isSatisfied('all', conditions, noon), false);

    const night = ctx({
      snapshots: new Map([[TANK, { level: 95 }]]),
      clock: { minute: 23 * 60, weekday: 1 },
    });
    assert.equal(isSatisfied('all', conditions, night), true);
  });

  it('also blocks an ANY rule outside the window', () => {
    // "night OR tank full" must not run the pump at noon just because the
    // window was one of two alternatives — a gate narrows, never widens.
    const conditions = [tankLevelAbove90, nightWindow];
    const noon = ctx({ snapshots: new Map([[TANK, { level: 95 }]]) });
    assert.equal(isSatisfied('any', conditions, noon), false);
  });

  it('is false for a rule made only of gates', () => {
    // Nothing could ever set it off; the API rejects this on write too.
    assert.equal(isSatisfied('any', [nightWindow], ctx({ clock: { minute: 23 * 60, weekday: 1 } })), false);
  });
});

describe('isSatisfied — a due schedule', () => {
  it('counts the schedule the scheduler matched', () => {
    // Index 0 is the schedule the tick found due.
    assert.equal(isSatisfied('all', [atSeven], ctx(), 0), true);
  });

  it('still checks the rest of an ALL rule', () => {
    const conditions = [atSeven, tankLevelAbove90];
    const dry = ctx({ snapshots: new Map([[TANK, { level: 10 }]]) });
    assert.equal(isSatisfied('all', conditions, dry, 0), false);

    const full = ctx({ snapshots: new Map([[TANK, { level: 95 }]]) });
    assert.equal(isSatisfied('all', conditions, full, 0), true);
  });

  it('still respects a gate', () => {
    const conditions = [atSeven, nightWindow];
    const noon = ctx();
    assert.equal(isSatisfied('all', conditions, noon, 0), false);
  });
});

describe('shouldRearm (hysteresis)', () => {
  const banded: Condition = { ...tankLevelAbove90, clearValue: 80 } as Condition;

  it('stays latched inside the band, so the pump does not chatter', () => {
    for (const level of [95, 89, 81]) {
      assert.equal(
        shouldRearm([banded], ctx({ snapshots: new Map([[TANK, { level }]]) })),
        false,
        `level ${level}`,
      );
    }
  });

  it('re-arms once the level clears the band', () => {
    assert.equal(shouldRearm([banded], ctx({ snapshots: new Map([[TANK, { level: 79 }]]) })), true);
  });

  it('re-arms in the other direction for a lower-bound condition', () => {
    const low = { kind: 'device', deviceId: TANK, key: 'level', op: '<', value: 20, clearValue: 30 } as Condition;
    assert.equal(shouldRearm([low], ctx({ snapshots: new Map([[TANK, { level: 25 }]]) })), false);
    assert.equal(shouldRearm([low], ctx({ snapshots: new Map([[TANK, { level: 35 }]]) })), true);
  });

  it('re-arms immediately when no condition sets a band', () => {
    assert.equal(shouldRearm([tankLevelAbove90], ctx()), true);
  });
});

describe('isWithinWindow', () => {
  const day = (h: number, m = 0) => h * 60 + m;

  it('handles a normal daytime window', () => {
    const window = { fromMinute: day(6), toMinute: day(23), days: [] };
    assert.equal(isWithinWindow(window, day(12), 1), true);
    assert.equal(isWithinWindow(window, day(5, 59), 1), false);
  });

  it('wraps midnight rather than matching nothing', () => {
    const night = { fromMinute: day(22), toMinute: day(6), days: [] };
    assert.equal(isWithinWindow(night, day(23), 1), true);
    assert.equal(isWithinWindow(night, day(2), 2), true);
    assert.equal(isWithinWindow(night, day(12), 1), false);
  });

  it('attributes the small hours of a wrapping window to the day it started', () => {
    const fridayNight = { fromMinute: day(22), toMinute: day(4), days: [5] };
    assert.equal(isWithinWindow(fridayNight, day(23), 5), true);
    assert.equal(isWithinWindow(fridayNight, day(1), 6), true, 'Saturday 01:00 belongs to Friday');
    assert.equal(isWithinWindow(fridayNight, day(23), 6), false);
  });
});

describe('watchedDeviceIds', () => {
  it('collects device and status conditions, deduplicated', () => {
    const ids = watchedDeviceIds([tankLevelAbove90, motorOffline, { ...tankLevelAbove90 }]);
    assert.deepEqual(ids.sort(), [TANK, MOTOR].sort());
  });

  it('ignores clock conditions — they watch no device', () => {
    assert.deepEqual(watchedDeviceIds([nightWindow, atSeven]), []);
  });
});

describe('actionDeviceIds', () => {
  it('collects only command targets, deduplicated', () => {
    assert.deepEqual(
      actionDeviceIds([
        { kind: 'command', deviceId: MOTOR },
        { kind: 'delay' },
        { kind: 'command', deviceId: MOTOR },
      ]),
      [MOTOR],
    );
  });
});

describe('minuteOfDay', () => {
  it('converts to the home timezone', () => {
    const utcNoon = new Date('2026-08-03T12:00:00Z');
    assert.equal(minuteOfDay(utcNoon, 'UTC').minute, 12 * 60);
    assert.equal(minuteOfDay(utcNoon, 'Asia/Kolkata').minute, 17 * 60 + 30);
  });

  it('normalises midnight to 0 rather than 1440', () => {
    assert.equal(minuteOfDay(new Date('2026-08-03T00:00:00Z'), 'UTC').minute, 0);
  });
});
