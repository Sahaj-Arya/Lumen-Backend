import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  flatten,
  parseDeviceTopic,
  parseReadingPayload,
  parseStatusPayload,
} from '../src/mqtt/topics.ts';

describe('parseDeviceTopic', () => {
  it('recognises each well-known topic kind', () => {
    assert.deepEqual(parseDeviceTopic('devices/esp32-01/availability'), {
      deviceUid: 'esp32-01',
      kind: 'availability',
      key: 'availability',
      channel: null,
    });
    assert.deepEqual(parseDeviceTopic('devices/s1/state'), {
      deviceUid: 's1',
      kind: 'state',
      key: null,
      channel: null,
    });
    assert.deepEqual(parseDeviceTopic('devices/s1/attributes'), {
      deviceUid: 's1',
      kind: 'attributes',
      key: null,
      channel: null,
    });
    assert.deepEqual(parseDeviceTopic('devices/s1/telemetry'), {
      deviceUid: 's1',
      kind: 'telemetry',
      key: null,
      channel: null,
    });
    assert.deepEqual(parseDeviceTopic('devices/s1/set'), {
      deviceUid: 's1',
      kind: 'command',
      key: null,
      channel: null,
    });
  });

  it('reads a channel out of <uid>/<channel>/<leaf>', () => {
    // A device can be a group of things wired to its pins; each is addressed
    // on its own leaf under the pin it sits on.
    assert.deepEqual(parseDeviceTopic('devices/lumen-6f1234/gpio5/state'), {
      deviceUid: 'lumen-6f1234',
      kind: 'state',
      key: null,
      channel: 'gpio5',
    });
    assert.deepEqual(parseDeviceTopic('devices/lumen-6f1234/gpio5/set'), {
      deviceUid: 'lumen-6f1234',
      kind: 'command',
      key: null,
      channel: 'gpio5',
    });
  });

  it('keeps a nested reading key a reading, not a channel', () => {
    // Only a closed set of leaves promotes the segment before them. Without
    // that rule `devices/x/power/today` would silently become a channel called
    // `power`, and the reading it actually is would vanish.
    assert.deepEqual(parseDeviceTopic('devices/s1/power/today'), {
      deviceUid: 's1',
      kind: 'reading',
      key: 'power.today',
      channel: null,
    });
  });

  it('still parses the names this platform used before the standard ones', () => {
    // Firmware in the field publishes these; ingest must not regress.
    assert.deepEqual(parseDeviceTopic('devices/s1/status'), {
      deviceUid: 's1',
      kind: 'availability',
      key: 'status',
      channel: null,
    });
    assert.deepEqual(parseDeviceTopic('devices/s1/meta'), {
      deviceUid: 's1',
      kind: 'attributes',
      key: null,
      channel: null,
    });
    assert.deepEqual(parseDeviceTopic('devices/s1/cmd'), {
      deviceUid: 's1',
      kind: 'command',
      key: null,
      channel: null,
    });
    // Zigbee2MQTT puts the whole state object on the bare device topic.
    assert.deepEqual(parseDeviceTopic('devices/s1'), {
      deviceUid: 's1',
      kind: 'state',
      key: null,
      channel: null,
    });
  });

  it('treats anything else under a device as a reading key', () => {
    assert.deepEqual(parseDeviceTopic('devices/s1/temp'), {
      deviceUid: 's1',
      kind: 'reading',
      key: 'temp',
      channel: null,
    });
    // Nested paths flatten to a dotted key.
    assert.deepEqual(parseDeviceTopic('devices/s1/sensor/indoor/temp'), {
      deviceUid: 's1',
      kind: 'reading',
      key: 'sensor.indoor.temp',
      channel: null,
    });
  });

  it('ignores topics outside the configured base', () => {
    assert.equal(parseDeviceTopic('$SYS/broker/uptime'), null);
    assert.equal(parseDeviceTopic('sensors/s1/temp'), null);
    assert.equal(parseDeviceTopic('devices'), null);
  });

  it('carries the segment name on status topics', () => {
    // So a payload that is not a presence word can still be kept as a reading
    // rather than silently discarded.
    assert.equal(parseDeviceTopic('devices/s1/online')?.key, 'online');
  });
});

describe('parseStatusPayload', () => {
  it('maps presence words in both directions', () => {
    for (const word of ['online', 'true', '1', 'up', 'connected']) {
      assert.equal(parseStatusPayload(word), 'online', word);
    }
    for (const word of ['offline', 'false', '0', 'down', 'disconnected']) {
      assert.equal(parseStatusPayload(word), 'offline', word);
    }
  });

  it('reads presence out of a JSON body', () => {
    assert.equal(parseStatusPayload('{"state":"OFFLINE"}'), 'offline');
    assert.equal(parseStatusPayload('{"online":true}'), 'online');
  });

  it('returns null for a cleared retained payload', () => {
    assert.equal(parseStatusPayload(''), null);
    assert.equal(parseStatusPayload('   '), null);
  });

  it('does not mistake a power state for presence', () => {
    // "on" is not "online": the caller stores it as a reading instead.
    assert.equal(parseStatusPayload('on'), null);
    assert.equal(parseStatusPayload('off'), null);
  });
});

describe('parseReadingPayload', () => {
  it('coerces scalars', () => {
    assert.equal(parseReadingPayload('23.5'), 23.5);
    assert.equal(parseReadingPayload('true'), true);
    assert.equal(parseReadingPayload('false'), false);
    assert.equal(parseReadingPayload('hello'), 'hello');
    assert.equal(parseReadingPayload(''), '');
  });

  it('parses JSON bodies and survives malformed ones', () => {
    assert.deepEqual(parseReadingPayload('{"a":1}'), { a: 1 });
    assert.equal(parseReadingPayload('{not json'), '{not json');
  });
});

describe('flatten', () => {
  it('produces dotted keys', () => {
    assert.deepEqual(flatten({ a: { b: 1 }, c: 2 }), { 'a.b': 1, c: 2 });
  });

  it('leaves arrays whole', () => {
    assert.deepEqual(flatten({ list: [1, 2] }), { list: [1, 2] });
  });
});
