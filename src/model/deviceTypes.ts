/**
 * Device type catalogue — the authoritative copy for the platform.
 *
 * Names and values follow the Home Assistant MQTT integration rather than
 * anything invented here, because that is what the rest of the ecosystem
 * speaks: Tasmota, ESPHome, Zigbee2MQTT and Shelly all publish this vocabulary,
 * and anything that already understands them understands our devices too.
 * Concretely that means:
 *
 *  - a switchable thing reports `state` as "ON"/"OFF", never power/on/true
 *  - `brightness` is 0-255, `color_temp` is mireds, `position` is 0-100
 *  - `power` means watts and `energy` means kWh, per device_class
 *  - sensors carry a `deviceClass` and `unit`, so a client can render one
 *    without knowing the device
 *
 * A type declares:
 *  - `component`:  the Home Assistant component the device is discovered as
 *  - `readings`:   values the device *reports* (device -> broker -> here)
 *  - `controls`:   values the app/automation may *set* (here -> broker -> device)
 *
 * `aliases` carry the pre-standard names this platform used to use, so older
 * firmware keeps ingesting correctly and its readings land on the modern key.
 *
 * The broker itself is schema-free, so this is presentation and validation
 * only: an unknown device still works as `generic` with every reading shown.
 * The app ships a mirror of this file for offline use and fetches this copy
 * from GET /api/catalog/device-types to stay in sync.
 */

export type ValueKind = 'number' | 'boolean' | 'enum' | 'string';

/** The Home Assistant components a device is discovered as. */
export type HaComponent =
  | 'light'
  | 'switch'
  | 'sensor'
  | 'binary_sensor'
  | 'cover'
  | 'lock'
  | 'fan'
  | 'climate'
  | 'valve'
  | 'siren'
  | 'camera';

export interface ReadingSpec {
  key: string;
  label: string;
  kind: ValueKind;
  unit?: string;
  min?: number;
  max?: number;
  /** Allowed values when kind is 'enum'. */
  values?: string[];
  /** Home Assistant device_class, which decides icon and formatting there. */
  deviceClass?: string;
  /** Home Assistant state_class, for values that belong on a graph. */
  stateClass?: 'measurement' | 'total' | 'total_increasing';
  /** Names firmware may use for this same reading, old platform names included. */
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
  /** Component used in the discovery topic: homeassistant/<component>/<uid>/config */
  component: HaComponent;
  /** Component-level device_class — 'garage' on a cover, 'motion' on a binary sensor. */
  deviceClass?: string;
  readings: ReadingSpec[];
  controls: ControlSpec[];
}

// ── reusable pieces ────────────────────────────────────────────────
/**
 * The on/off value. Home Assistant calls it `state` with "ON"/"OFF"; this
 * platform used to call it `power` with "on"/"off", which now collides with
 * the `power` device_class (watts) — hence the rename, with the old name kept
 * as an alias so existing firmware still lands on the right key.
 */
const STATE_CONTROL: ControlSpec = {
  key: 'state',
  label: 'Power',
  kind: 'toggle',
  onValue: 'ON',
  offValue: 'OFF',
  aliases: ['power', 'switch', 'relay', 'on'],
};

const STATE_READING: ReadingSpec = {
  key: 'state',
  label: 'Power',
  kind: 'enum',
  values: ['ON', 'OFF'],
  aliases: ['power', 'switch', 'relay'],
  primary: true,
};

const BRIGHTNESS_READING: ReadingSpec = {
  key: 'brightness',
  label: 'Brightness',
  kind: 'number',
  min: 0,
  max: 255,
  aliases: ['level', 'dim'],
  primary: true,
};

const BRIGHTNESS_CONTROL: ControlSpec = {
  key: 'brightness',
  label: 'Brightness',
  kind: 'stepper',
  min: 0,
  max: 255,
  step: 25,
  aliases: ['level', 'dim'],
};

const RSSI: ReadingSpec = {
  key: 'signal_strength',
  label: 'Signal',
  kind: 'number',
  unit: 'dBm',
  deviceClass: 'signal_strength',
  stateClass: 'measurement',
  aliases: ['rssi'],
};

const UPTIME: ReadingSpec = {
  key: 'uptime',
  label: 'Uptime',
  kind: 'number',
  unit: 's',
  deviceClass: 'duration',
};

const BATTERY: ReadingSpec = {
  key: 'battery',
  label: 'Battery',
  kind: 'number',
  unit: '%',
  min: 0,
  max: 100,
  deviceClass: 'battery',
  stateClass: 'measurement',
};

const TEMPERATURE: ReadingSpec = {
  key: 'temperature',
  label: 'Temperature',
  kind: 'number',
  unit: '°C',
  deviceClass: 'temperature',
  stateClass: 'measurement',
  aliases: ['temp'],
  primary: true,
};

const HUMIDITY: ReadingSpec = {
  key: 'humidity',
  label: 'Humidity',
  kind: 'number',
  unit: '%',
  min: 0,
  max: 100,
  deviceClass: 'humidity',
  stateClass: 'measurement',
};

const WATTS: ReadingSpec = {
  key: 'power',
  label: 'Power draw',
  kind: 'number',
  unit: 'W',
  deviceClass: 'power',
  stateClass: 'measurement',
  aliases: ['watts', 'power_w'],
  primary: true,
};

const ENERGY: ReadingSpec = {
  key: 'energy',
  label: 'Energy',
  kind: 'number',
  unit: 'kWh',
  deviceClass: 'energy',
  stateClass: 'total_increasing',
};

const VOLTAGE: ReadingSpec = {
  key: 'voltage',
  label: 'Voltage',
  kind: 'number',
  unit: 'V',
  deviceClass: 'voltage',
  stateClass: 'measurement',
};

const CURRENT: ReadingSpec = {
  key: 'current',
  label: 'Current',
  kind: 'number',
  unit: 'A',
  deviceClass: 'current',
  stateClass: 'measurement',
};

export const DEVICE_TYPES: Record<string, DeviceTypeSpec> = {
  // ── lighting ─────────────────────────────────────────────────────
  light: {
    label: 'Light',
    icon: 'bulb',
    category: 'lighting',
    component: 'light',
    readings: [STATE_READING, BRIGHTNESS_READING, RSSI],
    controls: [STATE_CONTROL, BRIGHTNESS_CONTROL],
  },
  rgb_light: {
    label: 'RGB light',
    icon: 'color-palette',
    category: 'lighting',
    component: 'light',
    readings: [
      STATE_READING,
      { ...BRIGHTNESS_READING, primary: false },
      { key: 'color', label: 'Colour', kind: 'string', aliases: ['rgb_color'] },
      // Mireds, not kelvin: that is what the light component publishes.
      { key: 'color_temp', label: 'White temp', kind: 'number', unit: 'mired', min: 153, max: 500, aliases: ['temperature'] },
      { key: 'effect', label: 'Effect', kind: 'enum', values: ['none', 'fade', 'strobe', 'rainbow'] },
    ],
    controls: [
      STATE_CONTROL,
      BRIGHTNESS_CONTROL,
      { key: 'effect', label: 'Effect', kind: 'enum', values: ['none', 'fade', 'strobe', 'rainbow'] },
    ],
  },

  // ── power ────────────────────────────────────────────────────────
  plug: {
    label: 'Smart plug',
    icon: 'flash',
    category: 'power',
    component: 'switch',
    deviceClass: 'outlet',
    readings: [STATE_READING, WATTS, VOLTAGE, CURRENT, ENERGY],
    controls: [STATE_CONTROL],
  },
  switch: {
    label: 'Switch',
    icon: 'toggle',
    category: 'power',
    component: 'switch',
    readings: [STATE_READING, RSSI],
    controls: [STATE_CONTROL],
  },
  relay: {
    label: 'Relay board',
    icon: 'git-network',
    category: 'power',
    component: 'switch',
    readings: [
      { key: 'ch1', label: 'Channel 1', kind: 'enum', values: ['ON', 'OFF'], primary: true },
      { key: 'ch2', label: 'Channel 2', kind: 'enum', values: ['ON', 'OFF'] },
      { key: 'ch3', label: 'Channel 3', kind: 'enum', values: ['ON', 'OFF'] },
      { key: 'ch4', label: 'Channel 4', kind: 'enum', values: ['ON', 'OFF'] },
    ],
    controls: [
      { key: 'ch1', label: 'Channel 1', kind: 'toggle', onValue: 'ON', offValue: 'OFF' },
      { key: 'ch2', label: 'Channel 2', kind: 'toggle', onValue: 'ON', offValue: 'OFF' },
      { key: 'ch3', label: 'Channel 3', kind: 'toggle', onValue: 'ON', offValue: 'OFF' },
      { key: 'ch4', label: 'Channel 4', kind: 'toggle', onValue: 'ON', offValue: 'OFF' },
    ],
  },

  // ── climate ──────────────────────────────────────────────────────
  fan: {
    label: 'Fan',
    icon: 'sync-circle',
    category: 'climate',
    component: 'fan',
    readings: [
      STATE_READING,
      // The fan component speaks percentages; named speeds are preset modes.
      { key: 'percentage', label: 'Speed', kind: 'number', unit: '%', min: 0, max: 100, aliases: ['speed'], primary: true },
      { key: 'preset_mode', label: 'Preset', kind: 'enum', values: ['low', 'medium', 'high'] },
      { key: 'oscillating', label: 'Oscillating', kind: 'boolean', aliases: ['oscillate'] },
    ],
    controls: [
      STATE_CONTROL,
      { key: 'percentage', label: 'Speed', kind: 'stepper', min: 0, max: 100, step: 25, unit: '%', aliases: ['speed'] },
      { key: 'preset_mode', label: 'Preset', kind: 'enum', values: ['low', 'medium', 'high'] },
      { key: 'oscillating', label: 'Oscillate', kind: 'toggle', onValue: true, offValue: false, aliases: ['oscillate'] },
    ],
  },
  thermostat: {
    label: 'Thermostat',
    icon: 'thermometer',
    category: 'climate',
    component: 'climate',
    readings: [
      { ...TEMPERATURE, key: 'current_temperature', label: 'Temperature', aliases: ['temp', 'temperature'] },
      HUMIDITY,
      // On a climate entity `temperature` is the target, and the measured value
      // is `current_temperature`. Naming them the other way round is the single
      // most common mistake when wiring one of these up.
      { key: 'temperature', label: 'Target', kind: 'number', unit: '°C', min: 5, max: 35, deviceClass: 'temperature', aliases: ['setpoint', 'target'] },
      { key: 'mode', label: 'Mode', kind: 'enum', values: ['off', 'heat', 'cool', 'auto'] },
      { key: 'action', label: 'Action', kind: 'enum', values: ['off', 'heating', 'cooling', 'idle'], aliases: ['heating'] },
    ],
    controls: [
      { key: 'temperature', label: 'Target', kind: 'stepper', min: 5, max: 35, step: 0.5, unit: '°C', aliases: ['setpoint', 'target'] },
      { key: 'mode', label: 'Mode', kind: 'enum', values: ['off', 'heat', 'cool', 'auto'] },
    ],
  },
  ac: {
    label: 'Air conditioner',
    icon: 'snow',
    category: 'climate',
    component: 'climate',
    readings: [
      STATE_READING,
      { ...TEMPERATURE, key: 'current_temperature', label: 'Temperature', aliases: ['temp', 'temperature'] },
      { key: 'temperature', label: 'Target', kind: 'number', unit: '°C', min: 16, max: 30, deviceClass: 'temperature', aliases: ['setpoint'] },
      { key: 'mode', label: 'Mode', kind: 'enum', values: ['off', 'cool', 'heat', 'dry', 'fan_only', 'auto'] },
      { key: 'fan_mode', label: 'Fan speed', kind: 'enum', values: ['auto', 'low', 'medium', 'high'], aliases: ['fan'] },
    ],
    controls: [
      STATE_CONTROL,
      { key: 'temperature', label: 'Target', kind: 'stepper', min: 16, max: 30, step: 1, unit: '°C', aliases: ['setpoint'] },
      { key: 'mode', label: 'Mode', kind: 'enum', values: ['off', 'cool', 'heat', 'dry', 'fan_only', 'auto'] },
      { key: 'fan_mode', label: 'Fan speed', kind: 'enum', values: ['auto', 'low', 'medium', 'high'], aliases: ['fan'] },
    ],
  },
  heater: {
    label: 'Heater',
    icon: 'flame',
    category: 'climate',
    component: 'climate',
    readings: [
      STATE_READING,
      { ...TEMPERATURE, key: 'current_temperature', label: 'Temperature', aliases: ['temp', 'temperature'] },
      { key: 'temperature', label: 'Target', kind: 'number', unit: '°C', min: 5, max: 35, deviceClass: 'temperature', aliases: ['setpoint'] },
    ],
    controls: [
      STATE_CONTROL,
      { key: 'temperature', label: 'Target', kind: 'stepper', min: 5, max: 35, step: 1, unit: '°C', aliases: ['setpoint'] },
    ],
  },
  air_purifier: {
    label: 'Air purifier',
    icon: 'leaf',
    category: 'climate',
    component: 'fan',
    readings: [
      STATE_READING,
      { key: 'pm25', label: 'PM2.5', kind: 'number', unit: 'µg/m³', deviceClass: 'pm25', stateClass: 'measurement', primary: true },
      { key: 'filter_life', label: 'Filter life', kind: 'number', unit: '%', min: 0, max: 100 },
      { key: 'preset_mode', label: 'Speed', kind: 'enum', values: ['auto', 'low', 'medium', 'high'], aliases: ['speed'] },
    ],
    controls: [
      STATE_CONTROL,
      { key: 'preset_mode', label: 'Speed', kind: 'enum', values: ['auto', 'low', 'medium', 'high'], aliases: ['speed'] },
    ],
  },

  // ── water ────────────────────────────────────────────────────────
  water_level: {
    label: 'Water level sensor',
    icon: 'water',
    category: 'water',
    component: 'sensor',
    readings: [
      { key: 'level', label: 'Level', kind: 'number', unit: '%', min: 0, max: 100, stateClass: 'measurement', primary: true },
      { key: 'full', label: 'Tank full', kind: 'boolean' },
      { key: 'empty', label: 'Tank empty', kind: 'boolean' },
      { key: 'volume', label: 'Volume', kind: 'number', unit: 'L', deviceClass: 'volume_storage', aliases: ['litres'] },
      BATTERY,
    ],
    controls: [],
  },
  motor: {
    label: 'Water pump / motor',
    icon: 'water-outline',
    category: 'water',
    component: 'switch',
    readings: [
      STATE_READING,
      { key: 'running', label: 'Running', kind: 'boolean' },
      { key: 'runtime', label: 'Runtime', kind: 'number', unit: 's', deviceClass: 'duration' },
      CURRENT,
      { key: 'dry_run', label: 'Dry run fault', kind: 'boolean' },
    ],
    controls: [STATE_CONTROL],
  },
  valve: {
    label: 'Valve',
    icon: 'git-branch',
    category: 'water',
    component: 'valve',
    deviceClass: 'water',
    readings: [
      { key: 'state', label: 'Position', kind: 'enum', values: ['open', 'closed', 'opening', 'closing'], aliases: ['position'], primary: true },
      { key: 'flow', label: 'Flow', kind: 'number', unit: 'L/min', stateClass: 'measurement' },
    ],
    controls: [
      { key: 'state', label: 'Valve', kind: 'toggle', onValue: 'OPEN', offValue: 'CLOSE', aliases: ['position'] },
    ],
  },
  leak_sensor: {
    label: 'Leak sensor',
    icon: 'warning',
    category: 'water',
    component: 'binary_sensor',
    deviceClass: 'moisture',
    readings: [
      { key: 'state', label: 'Leak detected', kind: 'enum', values: ['ON', 'OFF'], aliases: ['leak', 'moisture'], primary: true },
      BATTERY,
    ],
    controls: [],
  },
  irrigation: {
    label: 'Irrigation',
    icon: 'rainy',
    category: 'water',
    component: 'switch',
    readings: [
      STATE_READING,
      { key: 'zone', label: 'Zone', kind: 'number' },
      { key: 'moisture', label: 'Soil moisture', kind: 'number', unit: '%', min: 0, max: 100, deviceClass: 'moisture', stateClass: 'measurement', aliases: ['soil_moisture'], primary: true },
    ],
    controls: [STATE_CONTROL, { key: 'zone', label: 'Zone', kind: 'stepper', min: 1, max: 8, step: 1 }],
  },

  // ── security ─────────────────────────────────────────────────────
  lock: {
    label: 'Lock',
    icon: 'lock-closed',
    category: 'security',
    component: 'lock',
    readings: [
      { key: 'state', label: 'Locked', kind: 'enum', values: ['LOCKED', 'UNLOCKED', 'JAMMED'], aliases: ['lock'], primary: true },
      BATTERY,
    ],
    // payload_lock / payload_unlock on the lock component are LOCK and UNLOCK,
    // which are the commands -- the state words are LOCKED / UNLOCKED.
    controls: [{ key: 'state', label: 'Locked', kind: 'toggle', onValue: 'LOCK', offValue: 'UNLOCK', aliases: ['lock'] }],
  },
  door_sensor: {
    label: 'Door / window sensor',
    icon: 'log-in',
    category: 'security',
    component: 'binary_sensor',
    deviceClass: 'door',
    readings: [
      { key: 'state', label: 'State', kind: 'enum', values: ['ON', 'OFF'], aliases: ['contact', 'door', 'window'], primary: true },
      BATTERY,
    ],
    controls: [],
  },
  motion_sensor: {
    label: 'Motion sensor',
    icon: 'walk',
    category: 'security',
    component: 'binary_sensor',
    deviceClass: 'motion',
    readings: [
      { key: 'state', label: 'Motion', kind: 'enum', values: ['ON', 'OFF'], aliases: ['motion', 'occupancy', 'pir'], primary: true },
      { key: 'illuminance', label: 'Light level', kind: 'number', unit: 'lx', deviceClass: 'illuminance', stateClass: 'measurement', aliases: ['lux'] },
      BATTERY,
    ],
    controls: [],
  },
  camera: {
    label: 'Camera',
    icon: 'videocam',
    category: 'security',
    component: 'camera',
    readings: [
      { key: 'recording', label: 'Recording', kind: 'enum', values: ['ON', 'OFF'], primary: true },
      { key: 'motion', label: 'Motion', kind: 'enum', values: ['ON', 'OFF'] },
      { key: 'night_vision', label: 'Night vision', kind: 'enum', values: ['ON', 'OFF'] },
    ],
    controls: [
      { key: 'recording', label: 'Recording', kind: 'toggle', onValue: 'ON', offValue: 'OFF' },
      { key: 'night_vision', label: 'Night vision', kind: 'toggle', onValue: 'ON', offValue: 'OFF' },
    ],
  },
  siren: {
    label: 'Siren',
    icon: 'volume-high',
    category: 'security',
    component: 'siren',
    readings: [STATE_READING, { key: 'volume_level', label: 'Volume', kind: 'number', min: 0, max: 100, unit: '%', aliases: ['volume'] }],
    controls: [
      STATE_CONTROL,
      { key: 'volume_level', label: 'Volume', kind: 'stepper', min: 0, max: 100, step: 10, unit: '%', aliases: ['volume'] },
    ],
  },
  smoke_sensor: {
    label: 'Smoke / gas sensor',
    icon: 'cloud',
    category: 'security',
    component: 'binary_sensor',
    deviceClass: 'smoke',
    readings: [
      { key: 'state', label: 'Smoke', kind: 'enum', values: ['ON', 'OFF'], aliases: ['smoke'], primary: true },
      { key: 'gas', label: 'Gas', kind: 'enum', values: ['ON', 'OFF'] },
      { key: 'carbon_monoxide', label: 'CO', kind: 'number', unit: 'ppm', deviceClass: 'carbon_monoxide', stateClass: 'measurement', aliases: ['co'] },
      BATTERY,
    ],
    controls: [],
  },
  garage: {
    label: 'Garage door',
    icon: 'car',
    category: 'security',
    component: 'cover',
    deviceClass: 'garage',
    readings: [
      { key: 'state', label: 'Door', kind: 'enum', values: ['open', 'closed', 'opening', 'closing'], aliases: ['door'], primary: true },
    ],
    controls: [{ key: 'state', label: 'Door', kind: 'toggle', onValue: 'OPEN', offValue: 'CLOSE', aliases: ['door'] }],
  },
  curtain: {
    label: 'Curtain / blind',
    icon: 'browsers',
    category: 'other',
    component: 'cover',
    deviceClass: 'curtain',
    readings: [
      { key: 'state', label: 'State', kind: 'enum', values: ['open', 'closed', 'opening', 'closing'] },
      { key: 'position', label: 'Position', kind: 'number', unit: '%', min: 0, max: 100, primary: true },
    ],
    controls: [
      { key: 'position', label: 'Position', kind: 'stepper', min: 0, max: 100, step: 10, unit: '%' },
      { key: 'state', label: 'Open', kind: 'toggle', onValue: 'OPEN', offValue: 'CLOSE' },
    ],
  },

  // ── sensors ──────────────────────────────────────────────────────
  sensor: {
    label: 'Sensor',
    icon: 'pulse',
    category: 'sensor',
    component: 'sensor',
    readings: [TEMPERATURE, HUMIDITY, BATTERY, RSSI],
    controls: [],
  },
  temperature_sensor: {
    label: 'Temperature sensor',
    icon: 'thermometer-outline',
    category: 'sensor',
    component: 'sensor',
    deviceClass: 'temperature',
    readings: [TEMPERATURE, HUMIDITY, BATTERY],
    controls: [],
  },
  air_quality: {
    label: 'Air quality',
    icon: 'cloudy',
    category: 'sensor',
    component: 'sensor',
    readings: [
      { key: 'carbon_dioxide', label: 'CO₂', kind: 'number', unit: 'ppm', deviceClass: 'carbon_dioxide', stateClass: 'measurement', aliases: ['co2'], primary: true },
      { key: 'pm25', label: 'PM2.5', kind: 'number', unit: 'µg/m³', deviceClass: 'pm25', stateClass: 'measurement' },
      { key: 'volatile_organic_compounds', label: 'VOC', kind: 'number', unit: 'ppb', deviceClass: 'volatile_organic_compounds', stateClass: 'measurement', aliases: ['voc'] },
      TEMPERATURE,
      HUMIDITY,
    ],
    controls: [],
  },
  light_sensor: {
    label: 'Light sensor',
    icon: 'sunny',
    category: 'sensor',
    component: 'sensor',
    deviceClass: 'illuminance',
    readings: [
      { key: 'illuminance', label: 'Illuminance', kind: 'number', unit: 'lx', deviceClass: 'illuminance', stateClass: 'measurement', aliases: ['lux'], primary: true },
      BATTERY,
    ],
    controls: [],
  },
  soil_sensor: {
    label: 'Soil sensor',
    icon: 'flower',
    category: 'sensor',
    component: 'sensor',
    readings: [
      { key: 'moisture', label: 'Soil moisture', kind: 'number', unit: '%', min: 0, max: 100, deviceClass: 'moisture', stateClass: 'measurement', aliases: ['soil_moisture'], primary: true },
      { key: 'ph', label: 'pH', kind: 'number', min: 0, max: 14, deviceClass: 'ph' },
      TEMPERATURE,
      BATTERY,
    ],
    controls: [],
  },
  weight_sensor: {
    label: 'Weight / load cell',
    icon: 'barbell',
    category: 'sensor',
    component: 'sensor',
    deviceClass: 'weight',
    readings: [
      { key: 'weight', label: 'Weight', kind: 'number', unit: 'kg', deviceClass: 'weight', stateClass: 'measurement', primary: true },
    ],
    controls: [],
  },

  // ── energy ───────────────────────────────────────────────────────
  energy_meter: {
    label: 'Energy meter',
    icon: 'speedometer',
    category: 'energy',
    component: 'sensor',
    deviceClass: 'power',
    readings: [WATTS, ENERGY, VOLTAGE, CURRENT],
    controls: [],
  },
  battery_bank: {
    label: 'Battery / inverter',
    icon: 'battery-charging',
    category: 'energy',
    component: 'sensor',
    deviceClass: 'battery',
    readings: [
      { ...BATTERY, label: 'Charge', aliases: ['charge'], primary: true },
      VOLTAGE,
      { key: 'charging', label: 'Charging', kind: 'enum', values: ['ON', 'OFF'] },
      { ...WATTS, label: 'Load', aliases: ['load', 'watts'], primary: false },
    ],
    controls: [],
  },
  solar: {
    label: 'Solar inverter',
    icon: 'sunny-outline',
    category: 'energy',
    component: 'sensor',
    deviceClass: 'power',
    readings: [
      { ...WATTS, label: 'Generating' },
      { ...ENERGY, key: 'energy_today', label: 'Today', stateClass: 'total' },
      VOLTAGE,
    ],
    controls: [],
  },

  // ── other ────────────────────────────────────────────────────────
  gateway: {
    label: 'Gateway',
    icon: 'wifi',
    category: 'other',
    component: 'sensor',
    readings: [{ key: 'clients', label: 'Clients', kind: 'number', primary: true }, UPTIME, RSSI],
    controls: [],
  },
  generic: {
    label: 'Generic device',
    icon: 'hardware-chip',
    category: 'other',
    component: 'sensor',
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
  cover: 'curtain',
  ldr: 'light_sensor',
  lux: 'light_sensor',
  soil: 'soil_sensor',
  meter: 'energy_meter',
  inverter: 'battery_bank',
  broker: 'gateway',
  router: 'gateway',
  binary_sensor: 'motion_sensor',
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

/**
 * Canonical name for a key a device published, so `temp`, `lux` and the old
 * `power` land on the same reading as `temperature`, `illuminance` and
 * `state`. Unknown keys pass through untouched.
 */
export function canonicalKey(type: string | null | undefined, key: string): string {
  const spec = getType(type);
  const lower = key.toLowerCase();

  // Exact matches first, across every reading and control, before any alias is
  // considered. One name can be both: on a plug, `power` is the watts reading
  // *and* the old name for `state`. Alias-first would fold the watts onto the
  // on/off value and each would destroy the other.
  for (const reading of spec.readings) {
    if (reading.key === lower) return reading.key;
  }
  for (const control of spec.controls) {
    if (control.key === lower) return control.key;
  }

  for (const reading of spec.readings) {
    if (reading.aliases?.includes(lower)) return reading.key;
  }
  for (const control of spec.controls) {
    if (control.aliases?.includes(lower)) return control.key;
  }
  return key;
}

/** Best-effort type guess from the reading keys a device publishes. */
export function guessType(readingKeys: string[]): string {
  const keys = new Set(readingKeys.map((key) => key.split('.').pop()!.toLowerCase()));
  const has = (...names: string[]) => names.some((name) => keys.has(name));

  if (has('leak', 'moisture') && !has('soil_moisture')) return 'leak_sensor';
  if (has('level', 'full', 'empty') && !has('brightness')) return 'water_level';
  if (has('dry_run', 'running')) return 'motor';
  if (has('smoke', 'co', 'carbon_monoxide')) return 'smoke_sensor';
  if (has('motion', 'occupancy', 'pir')) return 'motion_sensor';
  if (has('contact', 'door') && !has('position')) return 'door_sensor';
  if (has('lock', 'jammed')) return 'lock';
  if (has('soil_moisture', 'ph')) return 'soil_sensor';
  if (has('co2', 'carbon_dioxide', 'voc', 'volatile_organic_compounds')) return 'air_quality';
  if (has('charge', 'charging')) return 'battery_bank';
  if (has('energy', 'watts') && !has('state', 'power')) return 'energy_meter';
  if (has('brightness', 'dim', 'color_temp')) return 'light';
  if (has('setpoint', 'target', 'current_temperature')) return 'thermostat';
  if (has('percentage', 'speed') && has('state')) return 'fan';
  if (has('watts', 'current')) return 'plug';
  if (has('lux', 'illuminance')) return 'light_sensor';
  if (has('temp', 'temperature', 'humidity')) return 'sensor';
  if (has('state', 'power', 'switch', 'relay')) return 'switch';
  return 'generic';
}
