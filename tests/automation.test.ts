import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  compare,
  evaluateConditions,
  evaluateTrigger,
  minuteOfDay,
  shouldRearm,
  toBoolean,
  watchedDeviceIds,
  actionDeviceIds,
} from '../src/automation/evaluate.ts';
import type { Predicate, Trigger } from '../src/automation/types.ts';

const TANK = '11111111-1111-1111-1111-111111111111';
const MOTOR = '22222222-2222-2222-2222-222222222222';

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
    assert.equal(toBoolean(null), null);
  });
});

describe('compare', () => {
  it('orders numbers, including numeric strings from MQTT payloads', () => {
    assert.equal(compare(95, '>', 90), true);
    assert.equal(compare('95', '>', 90), true); // payloads arrive as text
    assert.equal(compare(85, '>', 90), false);
    assert.equal(compare(90, '>=', 90), true);
    assert.equal(compare(10, '<', 20), true);
  });

  it('refuses to order non-numeric values instead of comparing as text', () => {
    // "full" > 90 would be true under string comparison — a real misfire risk.
    assert.equal(compare('full', '>', 90), false);
    assert.equal(compare(undefined, '>', 0), false);
  });

  it('compares equality tolerantly across types', () => {
    assert.equal(compare('on', '==', 'on'), true);
    assert.equal(compare('ON', '==', 'on'), true);
    assert.equal(compare(true, '==', 'on'), true);
    assert.equal(compare('1', '==', 1), true);
    assert.equal(compare('off', '!=', 'on'), true);
  });

  it('handles truthy/falsy and changed', () => {
    assert.equal(compare('open', 'truthy'), true);
    assert.equal(compare('closed', 'falsy'), true);
    assert.equal(compare(5, 'changed', undefined, 4), true);
    assert.equal(compare(5, 'changed', undefined, 5), false);
    // No previous value means first reading ever, which is not a change.
    assert.equal(compare(5, 'changed', undefined, undefined), false);
  });
});

describe('evaluateTrigger', () => {
  it('fires the water-full / motor-off rule', () => {
    const trigger: Trigger = { kind: 'state', deviceId: TANK, key: 'level', op: '>', value: 90 };
    assert.equal(evaluateTrigger(trigger, { snapshot: { level: 95 } }), true);
    assert.equal(evaluateTrigger(trigger, { snapshot: { level: 80 } }), false);
  });

  it('fires on a boolean tank-full flag', () => {
    const trigger: Trigger = { kind: 'state', deviceId: TANK, key: 'full', op: 'truthy' };
    assert.equal(evaluateTrigger(trigger, { snapshot: { full: true } }), true);
    assert.equal(evaluateTrigger(trigger, { snapshot: { full: 'no' } }), false);
  });

  it('fires on presence', () => {
    const trigger: Trigger = { kind: 'status', deviceId: MOTOR, status: 'offline' };
    assert.equal(evaluateTrigger(trigger, { snapshot: {}, status: 'offline' }), true);
    assert.equal(evaluateTrigger(trigger, { snapshot: {}, status: 'online' }), false);
    // No status on this update at all.
    assert.equal(evaluateTrigger(trigger, { snapshot: {} }), false);
  });

  it('never fires a schedule trigger from a device update', () => {
    const trigger: Trigger = { kind: 'schedule', atMinute: 420, days: [] };
    assert.equal(evaluateTrigger(trigger, { snapshot: { anything: 1 } }), false);
  });
});

describe('shouldRearm (hysteresis)', () => {
  const trigger: Trigger = {
    kind: 'state',
    deviceId: TANK,
    key: 'level',
    op: '>',
    value: 90,
    clearValue: 80,
  };

  it('stays latched inside the band, so the pump does not chatter', () => {
    // Fired at 95; wobbling between 80 and 90 must not re-arm it.
    assert.equal(shouldRearm(trigger, { level: 95 }), false);
    assert.equal(shouldRearm(trigger, { level: 89 }), false);
    assert.equal(shouldRearm(trigger, { level: 81 }), false);
  });

  it('re-arms once the level clears the band', () => {
    assert.equal(shouldRearm(trigger, { level: 79 }), true);
  });

  it('re-arms in the other direction for a lower-bound rule', () => {
    const low: Trigger = {
      kind: 'state',
      deviceId: TANK,
      key: 'level',
      op: '<',
      value: 20,
      clearValue: 30,
    };
    assert.equal(shouldRearm(low, { level: 25 }), false);
    assert.equal(shouldRearm(low, { level: 35 }), true);
  });

  it('without a band, re-arms as soon as the predicate stops holding', () => {
    const plain: Trigger = { kind: 'state', deviceId: TANK, key: 'level', op: '>', value: 90 };
    assert.equal(shouldRearm(plain, { level: 95 }), false);
    assert.equal(shouldRearm(plain, { level: 90 }), true);
  });

  it('does not re-arm on an unreadable value', () => {
    assert.equal(shouldRearm(trigger, { level: 'unknown' }), false);
  });
});

describe('evaluateConditions', () => {
  const conditions: Predicate[] = [{ deviceId: MOTOR, key: 'power', op: '==', value: 'on' }];

  it('requires every condition to hold', () => {
    const snapshots = new Map([[MOTOR, { power: 'on' }]]);
    assert.equal(evaluateConditions(conditions, snapshots), true);
    assert.equal(evaluateConditions(conditions, new Map([[MOTOR, { power: 'off' }]])), false);
  });

  it('is false when a referenced device has never reported', () => {
    // Must not fire a rule on an assumption about a silent device.
    assert.equal(evaluateConditions(conditions, new Map()), false);
  });

  it('is vacuously true with no conditions', () => {
    assert.equal(evaluateConditions([], new Map()), true);
  });
});

describe('watchedDeviceIds', () => {
  it('collects trigger and condition devices, deduplicated', () => {
    const ids = watchedDeviceIds({ kind: 'state', deviceId: TANK, key: 'level', op: '>', value: 90 }, [
      { deviceId: MOTOR, key: 'power', op: '==', value: 'on' },
      { deviceId: TANK, key: 'full', op: 'truthy' },
    ]);
    assert.deepEqual(ids.sort(), [TANK, MOTOR].sort());
  });

  it('ignores the action target — a rule watches what it reads', () => {
    const ids = watchedDeviceIds({ kind: 'schedule', atMinute: 0, days: [] }, []);
    assert.deepEqual(ids, []);
  });
});

describe('minuteOfDay', () => {
  it('converts to the home timezone', () => {
    const utcNoon = new Date('2026-08-03T12:00:00Z');
    assert.equal(minuteOfDay(utcNoon, 'UTC').minute, 12 * 60);
    // IST is UTC+5:30.
    assert.equal(minuteOfDay(utcNoon, 'Asia/Kolkata').minute, 17 * 60 + 30);
  });

  it('normalises midnight to 0 rather than 1440', () => {
    const midnight = new Date('2026-08-03T00:00:00Z');
    assert.equal(minuteOfDay(midnight, 'UTC').minute, 0);
  });

  it('reports the weekday in the target zone', () => {
    // Monday 2026-08-03 in UTC.
    assert.equal(minuteOfDay(new Date('2026-08-03T12:00:00Z'), 'UTC').weekday, 1);
  });
});

describe('actionDeviceIds', () => {
  it('collects only command targets, deduplicated', () => {
    assert.deepEqual(
      actionDeviceIds([
        { kind: 'command', deviceId: MOTOR },
        { kind: 'delay' },
        { kind: 'command', deviceId: MOTOR },
        { kind: 'webhook' },
      ]),
      [MOTOR],
    );
  });

  it('is empty when a rule only notifies', () => {
    assert.deepEqual(actionDeviceIds([{ kind: 'webhook' }, { kind: 'delay' }]), []);
  });
});
