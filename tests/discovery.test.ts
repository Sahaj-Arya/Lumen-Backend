import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  capabilitiesFromDiscovery,
  declaredType,
  parseDiscoveryTopic,
  typeFromDiscovery,
  uidFromDiscovery,
} from '../src/mqtt/discovery.ts';

describe('parseDiscoveryTopic', () => {
  it('reads the component and object id', () => {
    assert.deepEqual(parseDiscoveryTopic('homeassistant/light/lumen-6f1234/config'), {
      component: 'light',
      objectId: 'lumen-6f1234',
      nodeId: null,
    });
  });

  it('accepts the node id form firmware with several entities uses', () => {
    assert.deepEqual(parseDiscoveryTopic('homeassistant/sensor/lumen-6f1234/temp/config'), {
      component: 'sensor',
      objectId: 'temp',
      nodeId: 'lumen-6f1234',
    });
  });

  it('rejects anything that is not a config topic', () => {
    assert.equal(parseDiscoveryTopic('homeassistant/light/x/state'), null);
    assert.equal(parseDiscoveryTopic('devices/x/state'), null);
    assert.equal(parseDiscoveryTopic('homeassistant/config'), null);
  });
});

describe('typeFromDiscovery', () => {
  it('maps a plain light and a colour light apart', () => {
    assert.equal(typeFromDiscovery('light', {}), 'light');
    assert.equal(
      typeFromDiscovery('light', { supported_color_modes: ['rgb', 'color_temp'] }),
      'rgb_light',
    );
  });

  it('uses device_class to tell entities of one component apart', () => {
    assert.equal(typeFromDiscovery('switch', { device_class: 'outlet' }), 'plug');
    assert.equal(typeFromDiscovery('switch', {}), 'switch');
    assert.equal(typeFromDiscovery('binary_sensor', { device_class: 'motion' }), 'motion_sensor');
    assert.equal(typeFromDiscovery('binary_sensor', { device_class: 'moisture' }), 'leak_sensor');
    assert.equal(typeFromDiscovery('cover', { device_class: 'garage' }), 'garage');
    assert.equal(typeFromDiscovery('sensor', { device_class: 'illuminance' }), 'light_sensor');
  });

  it('treats a climate entity that can cool as an air conditioner', () => {
    assert.equal(typeFromDiscovery('climate', { modes: ['off', 'heat'] }), 'thermostat');
    assert.equal(typeFromDiscovery('climate', { modes: ['off', 'cool', 'dry'] }), 'ac');
  });

});

describe('declaredType', () => {
  it('surfaces a type the device names outright, for the caller to validate', () => {
    assert.equal(declaredType({ lumen_type: 'motor' }), 'motor');
    assert.equal(declaredType({ platform_type: 'valve' }), 'valve');
    assert.equal(declaredType({ device_class: 'outlet' }), null);
    assert.equal(declaredType({ lumen_type: '' }), null);
  });
});

describe('uidFromDiscovery', () => {
  const topic = { component: 'light', objectId: 'entity-1', nodeId: 'lumen-6f1234' };

  it('prefers unique_id over the topic segment', () => {
    assert.equal(uidFromDiscovery(topic, { unique_id: 'lumen-6f1234' }), 'lumen-6f1234');
  });

  it('falls back to the device identifier, then the topic', () => {
    assert.equal(
      uidFromDiscovery(topic, { device: { identifiers: ['lumen-aabbcc'] } }),
      'lumen-aabbcc',
    );
    assert.equal(uidFromDiscovery(topic, {}), 'entity-1');
  });
});

describe('capabilitiesFromDiscovery', () => {
  it('keeps the fields a client needs and drops the rest', () => {
    const capabilities = capabilitiesFromDiscovery('light', {
      name: 'Desk lamp',
      schema: 'json',
      brightness: true,
      state_topic: 'devices/lumen-6f1234/state',
      command_topic: 'devices/lumen-6f1234/set',
      availability_topic: 'devices/lumen-6f1234/availability',
      device: { model: 'lumen-c3', sw_version: '1.0.0' },
    });

    assert.equal(capabilities.component, 'light');
    assert.equal(capabilities.schema, 'json');
    assert.equal(capabilities.model, 'lumen-c3');
    assert.deepEqual(capabilities.topics, {
      state: 'devices/lumen-6f1234/state',
      command: 'devices/lumen-6f1234/set',
      availability: 'devices/lumen-6f1234/availability',
    });
    assert.equal('name' in capabilities, false);
  });
});
