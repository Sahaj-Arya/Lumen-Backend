import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEVICE_TYPES,
  canonicalKey,
  controlKeysFor,
  getType,
  guessType,
  normalizeType,
  readingKeysFor,
} from '../src/model/deviceTypes.ts';

describe('canonicalKey', () => {
  it('folds the pre-standard names onto the standard ones', () => {
    assert.equal(canonicalKey('light', 'power'), 'state');
    assert.equal(canonicalKey('sensor', 'temp'), 'temperature');
    assert.equal(canonicalKey('light_sensor', 'lux'), 'illuminance');
    assert.equal(canonicalKey('soil_sensor', 'soil_moisture'), 'moisture');
    assert.equal(canonicalKey('motion_sensor', 'occupancy'), 'state');
  });

  it('prefers an exact key over any alias of another reading', () => {
    // The trap: on a plug `power` is the watts reading *and* the old name for
    // `state`. Folding it onto `state` would overwrite ON/OFF with a wattage.
    assert.equal(canonicalKey('plug', 'power'), 'power');
    assert.equal(canonicalKey('plug', 'state'), 'state');
    assert.equal(canonicalKey('plug', 'watts'), 'power');
    // A thermostat has the same shape: `temperature` is the target, and the
    // measured value is current_temperature.
    assert.equal(canonicalKey('thermostat', 'temperature'), 'temperature');
    assert.equal(canonicalKey('thermostat', 'setpoint'), 'temperature');
  });

  it('passes unknown keys through untouched', () => {
    assert.equal(canonicalKey('light', 'wobble'), 'wobble');
    assert.equal(canonicalKey('generic', 'anything'), 'anything');
  });
});

describe('the catalogue speaks the standard vocabulary', () => {
  it('uses state/ON/OFF for the switchable value', () => {
    const control = getType('light').controls.find((entry) => entry.key === 'state');
    assert.ok(control);
    assert.equal(control.onValue, 'ON');
    assert.equal(control.offValue, 'OFF');
    // ...and keeps the old name reachable for firmware that still sends it.
    assert.ok(control.aliases?.includes('power'));
  });

  it('scales brightness 0-255, not 0-100', () => {
    const brightness = getType('light').readings.find((entry) => entry.key === 'brightness');
    assert.equal(brightness?.max, 255);
  });

  it('gives every type a Home Assistant component to be discovered as', () => {
    for (const [name, spec] of Object.entries(DEVICE_TYPES)) {
      assert.ok(spec.component, `${name} has no component`);
    }
  });

  it('still resolves aliased type names', () => {
    assert.equal(normalizeType('pump'), 'motor');
    assert.equal(normalizeType('Smart-Plug'), 'smart_plug'); // unknown, passed through
    assert.equal(normalizeType('outlet'), 'plug');
  });
});

describe('key listings', () => {
  it('include both the standard names and the aliases', () => {
    const keys = readingKeysFor('light');
    assert.ok(keys.includes('state'));
    assert.ok(keys.includes('power'));
    assert.ok(controlKeysFor('light').includes('brightness'));
  });
});

describe('guessType', () => {
  it('recognises a device from the standard reading names', () => {
    assert.equal(guessType(['state', 'brightness']), 'light');
    assert.equal(guessType(['illuminance']), 'light_sensor');
    assert.equal(guessType(['temperature', 'humidity']), 'sensor');
    assert.equal(guessType(['state']), 'switch');
  });

  it('still recognises one from the old names', () => {
    assert.equal(guessType(['power', 'brightness']), 'light');
    assert.equal(guessType(['lux']), 'light_sensor');
    assert.equal(guessType(['temp']), 'sensor');
  });
});
