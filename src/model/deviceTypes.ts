/**
 * Device type catalogue — the authoritative copy for the platform.
 *
 * A type declares two things:
 *  - `readings`:  values the device *reports* (device -> broker -> here)
 *  - `controls`:  values the app/automation may *set* (here -> broker -> device)
 *
 * The broker itself is schema-free, so this is presentation and validation
 * only: an unknown device still works as `generic` with every reading shown.
 * The app ships a mirror of this file for offline use and fetches this copy
 * from GET /api/catalog/device-types to stay in sync.
 */

export type ValueKind = 'number' | 'boolean' | 'enum' | 'string';

export interface ReadingSpec {
  key: string;
  label: string;
  kind: ValueKind;
  unit?: string;
  min?: number;
  max?: number;
  /** Allowed values when kind is 'enum'. */
  values?: string[];
  /** Names firmware may use for this same reading. */
  aliases?: string[];
  /** Shown on the device card when present. Order = preference. */
  primary?: boolean;
}

export interface ControlSpec {
  key: string;
  label: string;
  kind: 'toggle' | 'stepper' | 'enum';
  onValue?: string | boolean | number;
  offValue?: string | boolean | number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  values?: string[];
  aliases?: string[];
}

export interface DeviceTypeSpec {
  label: string;
  icon: string;
  category: 'lighting' | 'power' | 'climate' | 'security' | 'sensor' | 'water' | 'energy' | 'other';
  readings: ReadingSpec[];
  controls: ControlSpec[];
}

// ── reusable pieces ────────────────────────────────────────────────
const POWER_CONTROL: ControlSpec = {
  key: 'power',
  label: 'Power',
  kind: 'toggle',
  onValue: 'on',
  offValue: 'off',
  aliases: ['state', 'switch', 'relay', 'on'],
};

const POWER_READING: ReadingSpec = {
  key: 'power',
  label: 'Power',
  kind: 'enum',
  values: ['on', 'off'],
  aliases: ['state', 'switch', 'relay'],
  primary: true,
};

const RSSI: ReadingSpec = { key: 'rssi', label: 'Signal', kind: 'number', unit: 'dBm' };
const UPTIME: ReadingSpec = { key: 'uptime', label: 'Uptime', kind: 'number', unit: 's' };
const BATTERY: ReadingSpec = {
  key: 'battery',
  label: 'Battery',
  kind: 'number',
  unit: '%',
  min: 0,
  max: 100,
};
const TEMP: ReadingSpec = {
  key: 'temp',
  label: 'Temperature',
  kind: 'number',
  unit: '°C',
  aliases: ['temperature'],
  primary: true,
};
const HUMIDITY: ReadingSpec = {
  key: 'humidity',
  label: 'Humidity',
  kind: 'number',
  unit: '%',
  min: 0,
  max: 100,
};

export const DEVICE_TYPES: Record<string, DeviceTypeSpec> = {
  // ── lighting ─────────────────────────────────────────────────────
  light: {
    label: 'Light',
    icon: 'bulb',
    category: 'lighting',
    readings: [
      POWER_READING,
      { key: 'brightness', label: 'Brightness', kind: 'number', unit: '%', min: 0, max: 100, aliases: ['level', 'dim'], primary: true },
      RSSI,
    ],
    controls: [
      POWER_CONTROL,
      { key: 'brightness', label: 'Brightness', kind: 'stepper', min: 0, max: 100, step: 10, unit: '%', aliases: ['level', 'dim'] },
    ],
  },
  rgb_light: {
    label: 'RGB light',
    icon: 'color-palette',
    category: 'lighting',
    readings: [
      POWER_READING,
      { key: 'brightness', label: 'Brightness', kind: 'number', unit: '%', min: 0, max: 100 },
      { key: 'color', label: 'Colour', kind: 'string' },
      { key: 'temperature', label: 'White temp', kind: 'number', unit: 'K', min: 2000, max: 6500 },
      { key: 'effect', label: 'Effect', kind: 'enum', values: ['none', 'fade', 'strobe', 'rainbow'] },
    ],
    controls: [
      POWER_CONTROL,
      { key: 'brightness', label: 'Brightness', kind: 'stepper', min: 0, max: 100, step: 10, unit: '%' },
      { key: 'effect', label: 'Effect', kind: 'enum', values: ['none', 'fade', 'strobe', 'rainbow'] },
    ],
  },

  // ── power ────────────────────────────────────────────────────────
  plug: {
    label: 'Smart plug',
    icon: 'flash',
    category: 'power',
    readings: [
      POWER_READING,
      { key: 'watts', label: 'Power draw', kind: 'number', unit: 'W', aliases: ['power_w'], primary: true },
      { key: 'voltage', label: 'Voltage', kind: 'number', unit: 'V' },
      { key: 'current', label: 'Current', kind: 'number', unit: 'A' },
      { key: 'energy', label: 'Energy', kind: 'number', unit: 'kWh' },
    ],
    controls: [POWER_CONTROL],
  },
  switch: {
    label: 'Switch',
    icon: 'toggle',
    category: 'power',
    readings: [POWER_READING, RSSI],
    controls: [POWER_CONTROL],
  },
  relay: {
    label: 'Relay board',
    icon: 'git-network',
    category: 'power',
    readings: [
      { key: 'ch1', label: 'Channel 1', kind: 'enum', values: ['on', 'off'], primary: true },
      { key: 'ch2', label: 'Channel 2', kind: 'enum', values: ['on', 'off'] },
      { key: 'ch3', label: 'Channel 3', kind: 'enum', values: ['on', 'off'] },
      { key: 'ch4', label: 'Channel 4', kind: 'enum', values: ['on', 'off'] },
    ],
    controls: [
      { key: 'ch1', label: 'Channel 1', kind: 'toggle', onValue: 'on', offValue: 'off' },
      { key: 'ch2', label: 'Channel 2', kind: 'toggle', onValue: 'on', offValue: 'off' },
      { key: 'ch3', label: 'Channel 3', kind: 'toggle', onValue: 'on', offValue: 'off' },
      { key: 'ch4', label: 'Channel 4', kind: 'toggle', onValue: 'on', offValue: 'off' },
    ],
  },

  // ── climate ──────────────────────────────────────────────────────
  fan: {
    label: 'Fan',
    icon: 'sync-circle',
    category: 'climate',
    readings: [
      POWER_READING,
      { key: 'speed', label: 'Speed', kind: 'enum', values: ['low', 'medium', 'high'], primary: true },
      { key: 'oscillate', label: 'Oscillating', kind: 'boolean' },
    ],
    controls: [
      POWER_CONTROL,
      { key: 'speed', label: 'Speed', kind: 'enum', values: ['low', 'medium', 'high'] },
      { key: 'oscillate', label: 'Oscillate', kind: 'toggle', onValue: true, offValue: false },
    ],
  },
  thermostat: {
    label: 'Thermostat',
    icon: 'thermometer',
    category: 'climate',
    readings: [
      TEMP,
      HUMIDITY,
      { key: 'setpoint', label: 'Target', kind: 'number', unit: '°C', min: 5, max: 35, aliases: ['target'] },
      { key: 'mode', label: 'Mode', kind: 'enum', values: ['off', 'heat', 'cool', 'auto'] },
      { key: 'heating', label: 'Heating', kind: 'boolean' },
    ],
    controls: [
      POWER_CONTROL,
      { key: 'setpoint', label: 'Target', kind: 'stepper', min: 5, max: 35, step: 0.5, unit: '°C', aliases: ['target'] },
      { key: 'mode', label: 'Mode', kind: 'enum', values: ['off', 'heat', 'cool', 'auto'] },
    ],
  },
  ac: {
    label: 'Air conditioner',
    icon: 'snow',
    category: 'climate',
    readings: [
      POWER_READING,
      TEMP,
      { key: 'setpoint', label: 'Target', kind: 'number', unit: '°C', min: 16, max: 30 },
      { key: 'mode', label: 'Mode', kind: 'enum', values: ['cool', 'heat', 'dry', 'fan', 'auto'] },
      { key: 'fan', label: 'Fan speed', kind: 'enum', values: ['auto', 'low', 'medium', 'high'] },
    ],
    controls: [
      POWER_CONTROL,
      { key: 'setpoint', label: 'Target', kind: 'stepper', min: 16, max: 30, step: 1, unit: '°C' },
      { key: 'mode', label: 'Mode', kind: 'enum', values: ['cool', 'heat', 'dry', 'fan', 'auto'] },
      { key: 'fan', label: 'Fan speed', kind: 'enum', values: ['auto', 'low', 'medium', 'high'] },
    ],
  },
  heater: {
    label: 'Heater',
    icon: 'flame',
    category: 'climate',
    readings: [POWER_READING, TEMP, { key: 'setpoint', label: 'Target', kind: 'number', unit: '°C', min: 5, max: 35 }],
    controls: [POWER_CONTROL, { key: 'setpoint', label: 'Target', kind: 'stepper', min: 5, max: 35, step: 1, unit: '°C' }],
  },
  air_purifier: {
    label: 'Air purifier',
    icon: 'leaf',
    category: 'climate',
    readings: [
      POWER_READING,
      { key: 'pm25', label: 'PM2.5', kind: 'number', unit: 'µg/m³', primary: true },
      { key: 'filter_life', label: 'Filter life', kind: 'number', unit: '%', min: 0, max: 100 },
      { key: 'speed', label: 'Speed', kind: 'enum', values: ['auto', 'low', 'medium', 'high'] },
    ],
    controls: [
      POWER_CONTROL,
      { key: 'speed', label: 'Speed', kind: 'enum', values: ['auto', 'low', 'medium', 'high'] },
    ],
  },

  // ── water ────────────────────────────────────────────────────────
  water_level: {
    label: 'Water level sensor',
    icon: 'water',
    category: 'water',
    readings: [
      { key: 'level', label: 'Level', kind: 'number', unit: '%', min: 0, max: 100, primary: true },
      { key: 'full', label: 'Tank full', kind: 'boolean' },
      { key: 'empty', label: 'Tank empty', kind: 'boolean' },
      { key: 'litres', label: 'Volume', kind: 'number', unit: 'L' },
      BATTERY,
    ],
    controls: [],
  },
  motor: {
    label: 'Water pump / motor',
    icon: 'water-outline',
    category: 'water',
    readings: [
      POWER_READING,
      { key: 'running', label: 'Running', kind: 'boolean' },
      { key: 'runtime', label: 'Runtime', kind: 'number', unit: 's' },
      { key: 'current', label: 'Current', kind: 'number', unit: 'A' },
      { key: 'dry_run', label: 'Dry run fault', kind: 'boolean' },
    ],
    controls: [POWER_CONTROL],
  },
  valve: {
    label: 'Valve',
    icon: 'git-branch',
    category: 'water',
    readings: [
      { key: 'position', label: 'Position', kind: 'enum', values: ['open', 'closed'], primary: true },
      { key: 'flow', label: 'Flow', kind: 'number', unit: 'L/min' },
    ],
    controls: [{ key: 'position', label: 'Valve', kind: 'toggle', onValue: 'open', offValue: 'closed' }],
  },
  leak_sensor: {
    label: 'Leak sensor',
    icon: 'warning',
    category: 'water',
    readings: [
      { key: 'leak', label: 'Leak detected', kind: 'boolean', primary: true },
      BATTERY,
    ],
    controls: [],
  },
  irrigation: {
    label: 'Irrigation',
    icon: 'rainy',
    category: 'water',
    readings: [
      POWER_READING,
      { key: 'zone', label: 'Zone', kind: 'number' },
      { key: 'soil_moisture', label: 'Soil moisture', kind: 'number', unit: '%', min: 0, max: 100, primary: true },
    ],
    controls: [POWER_CONTROL, { key: 'zone', label: 'Zone', kind: 'stepper', min: 1, max: 8, step: 1 }],
  },

  // ── security ─────────────────────────────────────────────────────
  lock: {
    label: 'Lock',
    icon: 'lock-closed',
    category: 'security',
    readings: [
      { key: 'lock', label: 'Locked', kind: 'enum', values: ['locked', 'unlocked'], primary: true },
      { key: 'jammed', label: 'Jammed', kind: 'boolean' },
      BATTERY,
    ],
    controls: [{ key: 'lock', label: 'Locked', kind: 'toggle', onValue: 'lock', offValue: 'unlock' }],
  },
  door_sensor: {
    label: 'Door / window sensor',
    icon: 'log-in',
    category: 'security',
    readings: [
      { key: 'contact', label: 'State', kind: 'enum', values: ['open', 'closed'], aliases: ['door', 'window'], primary: true },
      BATTERY,
    ],
    controls: [],
  },
  motion_sensor: {
    label: 'Motion sensor',
    icon: 'walk',
    category: 'security',
    readings: [
      { key: 'motion', label: 'Motion', kind: 'boolean', aliases: ['occupancy', 'pir'], primary: true },
      { key: 'lux', label: 'Light level', kind: 'number', unit: 'lx' },
      BATTERY,
    ],
    controls: [],
  },
  camera: {
    label: 'Camera',
    icon: 'videocam',
    category: 'security',
    readings: [
      { key: 'recording', label: 'Recording', kind: 'boolean', primary: true },
      { key: 'motion', label: 'Motion', kind: 'boolean' },
      { key: 'night_vision', label: 'Night vision', kind: 'boolean' },
    ],
    controls: [
      { key: 'recording', label: 'Recording', kind: 'toggle', onValue: 'on', offValue: 'off' },
      { key: 'night_vision', label: 'Night vision', kind: 'toggle', onValue: 'on', offValue: 'off' },
    ],
  },
  siren: {
    label: 'Siren',
    icon: 'volume-high',
    category: 'security',
    readings: [POWER_READING, { key: 'volume', label: 'Volume', kind: 'number', unit: '%', min: 0, max: 100 }],
    controls: [
      POWER_CONTROL,
      { key: 'volume', label: 'Volume', kind: 'stepper', min: 0, max: 100, step: 10, unit: '%' },
    ],
  },
  smoke_sensor: {
    label: 'Smoke / gas sensor',
    icon: 'cloud',
    category: 'security',
    readings: [
      { key: 'smoke', label: 'Smoke', kind: 'boolean', primary: true },
      { key: 'gas', label: 'Gas', kind: 'boolean' },
      { key: 'co', label: 'CO', kind: 'number', unit: 'ppm' },
      BATTERY,
    ],
    controls: [],
  },
  garage: {
    label: 'Garage door',
    icon: 'car',
    category: 'security',
    readings: [{ key: 'door', label: 'Door', kind: 'enum', values: ['open', 'closed', 'opening', 'closing'], primary: true }],
    controls: [{ key: 'door', label: 'Door', kind: 'toggle', onValue: 'open', offValue: 'close' }],
  },
  curtain: {
    label: 'Curtain / blind',
    icon: 'browsers',
    category: 'other',
    readings: [{ key: 'position', label: 'Position', kind: 'number', unit: '%', min: 0, max: 100, primary: true }],
    controls: [{ key: 'position', label: 'Position', kind: 'stepper', min: 0, max: 100, step: 10, unit: '%' }],
  },

  // ── sensors ──────────────────────────────────────────────────────
  sensor: {
    label: 'Sensor',
    icon: 'pulse',
    category: 'sensor',
    readings: [TEMP, HUMIDITY, BATTERY, RSSI],
    controls: [],
  },
  temperature_sensor: {
    label: 'Temperature sensor',
    icon: 'thermometer-outline',
    category: 'sensor',
    readings: [TEMP, HUMIDITY, BATTERY],
    controls: [],
  },
  air_quality: {
    label: 'Air quality',
    icon: 'cloudy',
    category: 'sensor',
    readings: [
      { key: 'co2', label: 'CO₂', kind: 'number', unit: 'ppm', primary: true },
      { key: 'pm25', label: 'PM2.5', kind: 'number', unit: 'µg/m³' },
      { key: 'voc', label: 'VOC', kind: 'number', unit: 'ppb' },
      TEMP,
      HUMIDITY,
    ],
    controls: [],
  },
  light_sensor: {
    label: 'Light sensor',
    icon: 'sunny',
    category: 'sensor',
    readings: [{ key: 'lux', label: 'Illuminance', kind: 'number', unit: 'lx', primary: true }, BATTERY],
    controls: [],
  },
  soil_sensor: {
    label: 'Soil sensor',
    icon: 'flower',
    category: 'sensor',
    readings: [
      { key: 'soil_moisture', label: 'Soil moisture', kind: 'number', unit: '%', min: 0, max: 100, primary: true },
      { key: 'ph', label: 'pH', kind: 'number', min: 0, max: 14 },
      TEMP,
      BATTERY,
    ],
    controls: [],
  },
  weight_sensor: {
    label: 'Weight / load cell',
    icon: 'barbell',
    category: 'sensor',
    readings: [{ key: 'weight', label: 'Weight', kind: 'number', unit: 'kg', primary: true }],
    controls: [],
  },

  // ── energy ───────────────────────────────────────────────────────
  energy_meter: {
    label: 'Energy meter',
    icon: 'speedometer',
    category: 'energy',
    readings: [
      { key: 'watts', label: 'Power', kind: 'number', unit: 'W', primary: true },
      { key: 'energy', label: 'Energy', kind: 'number', unit: 'kWh' },
      { key: 'voltage', label: 'Voltage', kind: 'number', unit: 'V' },
      { key: 'current', label: 'Current', kind: 'number', unit: 'A' },
    ],
    controls: [],
  },
  battery_bank: {
    label: 'Battery / inverter',
    icon: 'battery-charging',
    category: 'energy',
    readings: [
      { key: 'charge', label: 'Charge', kind: 'number', unit: '%', min: 0, max: 100, primary: true },
      { key: 'voltage', label: 'Voltage', kind: 'number', unit: 'V' },
      { key: 'charging', label: 'Charging', kind: 'boolean' },
      { key: 'load', label: 'Load', kind: 'number', unit: 'W' },
    ],
    controls: [],
  },
  solar: {
    label: 'Solar inverter',
    icon: 'sunny-outline',
    category: 'energy',
    readings: [
      { key: 'watts', label: 'Generating', kind: 'number', unit: 'W', primary: true },
      { key: 'energy_today', label: 'Today', kind: 'number', unit: 'kWh' },
      { key: 'voltage', label: 'Voltage', kind: 'number', unit: 'V' },
    ],
    controls: [],
  },

  // ── other ────────────────────────────────────────────────────────
  gateway: {
    label: 'Gateway',
    icon: 'wifi',
    category: 'other',
    readings: [{ key: 'clients', label: 'Clients', kind: 'number', primary: true }, UPTIME, RSSI],
    controls: [],
  },
  generic: {
    label: 'Generic device',
    icon: 'hardware-chip',
    category: 'other',
    readings: [],
    controls: [],
  },
};

export const DEVICE_TYPE_KEYS = Object.keys(DEVICE_TYPES);

/** Names firmware uses for a type this catalogue spells differently. */
const TYPE_ALIASES: Record<string, string> = {
  lamp: 'light',
  bulb: 'light',
  led: 'light',
  dimmer: 'light',
  rgb: 'rgb_light',
  strip: 'rgb_light',
  socket: 'plug',
  outlet: 'plug',
  thermo: 'thermostat',
  hvac: 'ac',
  climate: 'thermostat',
  aircon: 'ac',
  pump: 'motor',
  waterpump: 'motor',
  tank: 'water_level',
  watertank: 'water_level',
  levelsensor: 'water_level',
  float: 'water_level',
  doorlock: 'lock',
  contact: 'door_sensor',
  reed: 'door_sensor',
  pir: 'motion_sensor',
  occupancy: 'motion_sensor',
  cam: 'camera',
  alarm: 'siren',
  buzzer: 'siren',
  smoke: 'smoke_sensor',
  gas: 'smoke_sensor',
  blind: 'curtain',
  shade: 'curtain',
  ldr: 'light_sensor',
  lux: 'light_sensor',
  soil: 'soil_sensor',
  meter: 'energy_meter',
  inverter: 'battery_bank',
  broker: 'gateway',
  router: 'gateway',
};

export function normalizeType(type: string | null | undefined): string {
  const key = String(type ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  return TYPE_ALIASES[key] ?? key;
}

export function getType(type: string | null | undefined): DeviceTypeSpec {
  return DEVICE_TYPES[normalizeType(type)] ?? DEVICE_TYPES.generic!;
}

/** Reading keys a type declares, including aliases — used to validate rules. */
export function readingKeysFor(type: string): string[] {
  const spec = getType(type);
  const keys = new Set<string>();
  for (const reading of spec.readings) {
    keys.add(reading.key);
    for (const alias of reading.aliases ?? []) keys.add(alias);
  }
  return [...keys];
}

/** Control keys a type accepts, including aliases. */
export function controlKeysFor(type: string): string[] {
  const spec = getType(type);
  const keys = new Set<string>();
  for (const control of spec.controls) {
    keys.add(control.key);
    for (const alias of control.aliases ?? []) keys.add(alias);
  }
  return [...keys];
}

/** Best-effort type guess from the reading keys a device publishes. */
export function guessType(readingKeys: string[]): string {
  const keys = new Set(readingKeys.map((key) => key.split('.').pop()!.toLowerCase()));
  const has = (...names: string[]) => names.some((name) => keys.has(name));

  if (has('leak')) return 'leak_sensor';
  if (has('level', 'full', 'empty') && !has('brightness')) return 'water_level';
  if (has('dry_run', 'running') && has('power')) return 'motor';
  if (has('smoke', 'co')) return 'smoke_sensor';
  if (has('motion', 'occupancy', 'pir')) return 'motion_sensor';
  if (has('contact', 'door') && !has('position')) return 'door_sensor';
  if (has('lock', 'jammed')) return 'lock';
  if (has('soil_moisture', 'ph')) return 'soil_sensor';
  if (has('co2', 'voc')) return 'air_quality';
  if (has('charge', 'charging')) return 'battery_bank';
  if (has('energy', 'watts') && !has('power')) return 'energy_meter';
  if (has('brightness', 'dim')) return 'light';
  if (has('setpoint', 'target')) return 'thermostat';
  if (has('speed') && has('power')) return 'fan';
  if (has('watts', 'current')) return 'plug';
  if (has('lux')) return 'light_sensor';
  if (has('temp', 'temperature', 'humidity')) return 'sensor';
  if (has('power', 'state')) return 'switch';
  return 'generic';
}
