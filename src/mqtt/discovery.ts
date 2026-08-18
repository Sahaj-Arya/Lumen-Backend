/**
 * Home Assistant MQTT discovery.
 *
 * A device announces itself by retaining a JSON config on
 *
 *   homeassistant/<component>/<object_id>/config
 *
 * naming the topics it will use for state, commands and availability. Every
 * hub in the ecosystem — Home Assistant, openHAB, Node-RED, IoBroker — learns
 * a device from that one message, so a device that publishes it works with all
 * of them and with us, and we do not have to invent a registration protocol.
 *
 * The device is the publisher, not the backend. It is the only party that
 * knows what hardware is actually attached, it can announce before anyone has
 * claimed it, and a single retained publisher means no two writers fight over
 * the same retained topic. We read these configs to learn a device's type and
 * capabilities; an empty payload is a device retiring itself, per the spec.
 */

export const DISCOVERY_PREFIX = 'homeassistant';

export interface ParsedDiscoveryTopic {
  component: string;
  /** The device uid. HA calls it the object_id. */
  objectId: string;
  /** Present when the config is scoped to a node, .../<node_id>/<object_id>/config */
  nodeId: string | null;
}

/**
 * homeassistant/<component>/<object_id>/config, or the four-segment form with
 * a node id in the middle. Anything else is not a discovery config.
 */
export function parseDiscoveryTopic(
  topic: string,
  prefix = DISCOVERY_PREFIX,
): ParsedDiscoveryTopic | null {
  const segments = topic.split('/');
  if (segments[0] !== prefix) return null;
  if (segments.at(-1) !== 'config') return null;

  if (segments.length === 4) {
    return { component: segments[1]!, objectId: segments[2]!, nodeId: null };
  }
  if (segments.length === 5) {
    return { component: segments[1]!, objectId: segments[3]!, nodeId: segments[2]! };
  }
  return null;
}

export interface DiscoveryConfig {
  name?: string;
  unique_id?: string;
  object_id?: string;
  device_class?: string;
  state_topic?: string;
  command_topic?: string;
  availability_topic?: string;
  json_attributes_topic?: string;
  schema?: string;
  device?: {
    identifiers?: string | string[];
    name?: string;
    model?: string;
    manufacturer?: string;
    sw_version?: string;
  };
  [key: string]: unknown;
}

/** Component + device_class as the platform's own type key. */
const BY_BINARY_SENSOR_CLASS: Record<string, string> = {
  motion: 'motion_sensor',
  occupancy: 'motion_sensor',
  presence: 'motion_sensor',
  door: 'door_sensor',
  window: 'door_sensor',
  opening: 'door_sensor',
  garage_door: 'garage',
  moisture: 'leak_sensor',
  smoke: 'smoke_sensor',
  gas: 'smoke_sensor',
  carbon_monoxide: 'smoke_sensor',
};

const BY_SENSOR_CLASS: Record<string, string> = {
  temperature: 'temperature_sensor',
  humidity: 'temperature_sensor',
  illuminance: 'light_sensor',
  power: 'energy_meter',
  energy: 'energy_meter',
  current: 'energy_meter',
  voltage: 'energy_meter',
  battery: 'battery_bank',
  carbon_dioxide: 'air_quality',
  pm25: 'air_quality',
  volatile_organic_compounds: 'air_quality',
  moisture: 'soil_sensor',
  weight: 'weight_sensor',
};

const BY_COVER_CLASS: Record<string, string> = {
  garage: 'garage',
  door: 'garage',
  gate: 'garage',
  curtain: 'curtain',
  blind: 'curtain',
  shade: 'curtain',
  shutter: 'curtain',
  awning: 'curtain',
};

/**
 * A type the device states outright rather than leaving to inference. Checking
 * it against the catalogue is the caller's job — this module stays free of
 * catalogue imports so it can be unit-tested on its own.
 */
export function declaredType(config: DiscoveryConfig): string | null {
  const declared = config.lumen_type ?? config.platform_type;
  return typeof declared === 'string' && declared ? declared : null;
}

/**
 * The type this platform files a discovered entity under, inferred from the
 * component and device_class the way any other hub would infer it.
 */
export function typeFromDiscovery(component: string, config: DiscoveryConfig): string {
  const deviceClass = String(config.device_class ?? '').toLowerCase();

  switch (component) {
    case 'light':
      // A light that advertises colour is an rgb_light to us; supported_color_modes
      // is the field every implementation sets for that.
      return Array.isArray(config.supported_color_modes) &&
        config.supported_color_modes.some((mode) => String(mode).includes('rgb') || String(mode).includes('hs') || String(mode).includes('xy'))
        ? 'rgb_light'
        : 'light';
    case 'switch':
      return deviceClass === 'outlet' ? 'plug' : 'switch';
    case 'binary_sensor':
      return BY_BINARY_SENSOR_CLASS[deviceClass] ?? 'motion_sensor';
    case 'sensor':
      return BY_SENSOR_CLASS[deviceClass] ?? 'sensor';
    case 'cover':
      return BY_COVER_CLASS[deviceClass] ?? 'curtain';
    case 'climate':
      // Anything that can cool is treated as an AC, which is the type carrying
      // the fan and dry modes.
      return Array.isArray(config.modes) && config.modes.some((mode) => String(mode) === 'cool')
        ? 'ac'
        : 'thermostat';
    case 'fan':
      return 'fan';
    case 'lock':
      return 'lock';
    case 'valve':
      return 'valve';
    case 'siren':
      return 'siren';
    case 'camera':
      return 'camera';
    default:
      return 'generic';
  }
}

/**
 * The uid a config belongs to.
 *
 * A node id in the topic means the config is one entity of a device that has
 * several -- a relay on one pin, a sensor on another. There, `unique_id` is
 * per-entity (`lumen-6f1234_gpio5`) and would file every pin as a separate
 * device, so the node id and the shared `device.identifiers` win instead. That
 * is exactly what those fields are for: identifiers are what every hub uses to
 * group entities into one physical thing.
 *
 * Without a node id there is one entity, and `unique_id` is the identity the
 * rest of the ecosystem uses -- some firmware puts a suffix in the topic.
 */
export function uidFromDiscovery(parsed: ParsedDiscoveryTopic, config: DiscoveryConfig): string {
  const identifiers = config.device?.identifiers;
  const identifier = Array.isArray(identifiers) ? identifiers[0] : identifiers;
  if (parsed.nodeId) return String(identifier ?? parsed.nodeId);
  return String(config.unique_id ?? identifier ?? parsed.objectId);
}

/**
 * The entity within the device this config describes, or null when it is the
 * device itself. The object id is the channel -- `gpio5` -- which is also the
 * segment its state and command topics sit under.
 */
export function channelFromDiscovery(parsed: ParsedDiscoveryTopic): string | null {
  return parsed.nodeId ? parsed.objectId : null;
}

/** What the app needs to render one channel without asking the device. */
export interface ChannelDescriptor {
  channel: string;
  component: string;
  name: string;
  /** Our own kind -- relay, motion, analog -- when the firmware declared one. */
  kind: string | null;
  deviceClass: string | null;
  unit: string | null;
  /** A command topic in the config is what makes an entity controllable. */
  writable: boolean;
  gpio: number | null;
}

export function channelFromConfig(
  channel: string,
  component: string,
  config: DiscoveryConfig,
): ChannelDescriptor {
  const gpio = config.lumen_gpio;
  return {
    channel,
    component,
    name: String(config.name ?? channel),
    kind: config.lumen_kind ? String(config.lumen_kind) : null,
    deviceClass: config.device_class ? String(config.device_class) : null,
    unit: config.unit_of_measurement ? String(config.unit_of_measurement) : null,
    writable: Boolean(config.command_topic),
    gpio: typeof gpio === 'number' ? gpio : null,
  };
}

/** The subset worth keeping on the device row. */
export function capabilitiesFromDiscovery(
  component: string,
  config: DiscoveryConfig,
): Record<string, unknown> {
  return {
    component,
    ...(config.device_class ? { device_class: config.device_class } : {}),
    ...(config.schema ? { schema: config.schema } : {}),
    ...(config.supported_color_modes ? { supported_color_modes: config.supported_color_modes } : {}),
    ...(config.modes ? { modes: config.modes } : {}),
    ...(config.preset_modes ? { preset_modes: config.preset_modes } : {}),
    ...(config.effect_list ? { effect_list: config.effect_list } : {}),
    ...(config.unit_of_measurement ? { unit_of_measurement: config.unit_of_measurement } : {}),
    ...(config.device?.model ? { model: config.device.model } : {}),
    ...(config.device?.manufacturer ? { manufacturer: config.device.manufacturer } : {}),
    ...(config.device?.sw_version ? { sw_version: config.device.sw_version } : {}),
    topics: {
      ...(config.state_topic ? { state: config.state_topic } : {}),
      ...(config.command_topic ? { command: config.command_topic } : {}),
      ...(config.availability_topic ? { availability: config.availability_topic } : {}),
    },
  };
}
