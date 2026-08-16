import { z } from 'zod';

/**
 * If-this-then-that, as smart-home apps actually present it.
 *
 * There is no separate "trigger" any more. A rule is a list of **conditions**
 * and a match mode — "when ANY condition is met" (OR) or "when ALL conditions
 * are met" (AND) — followed by actions. That is the Tuya/SmartLife model, and
 * IFTTT is the same shape with exactly one condition.
 *
 * Conditions divide into two roles, which is what makes the model work:
 *
 *  - **firing** (`device`, `status`, `schedule`) — something happens at a
 *    moment in time, so these can set a rule off.
 *  - **gating** (`time`) — a window that is either open or closed. A time
 *    window can never set a rule off on its own; "between 22:00 and 06:00" is
 *    not an event. It only narrows when the firing conditions count.
 *
 * A rule made only of gates would never run, so validation rejects it.
 */

export const COMPARATORS = ['>', '>=', '<', '<=', '==', '!=', 'changed', 'truthy', 'falsy'] as const;
export type Comparator = (typeof COMPARATORS)[number];

/** A device reading crossing a comparison. Fires. */
export const deviceConditionSchema = z.object({
  kind: z.literal('device').default('device'),
  deviceId: z.string().uuid(),
  key: z.string().min(1).max(120),
  op: z.enum(COMPARATORS),
  // Not required for changed/truthy/falsy.
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /**
   * Hysteresis. Once met, the condition stays latched until the reading crosses
   * back past this value — the standard fix for a tank level sitting on the
   * threshold and flapping the pump.
   */
  clearValue: z.number().optional(),
});

/** A device coming online or dropping off, per the broker's Last Will. Fires. */
export const statusConditionSchema = z.object({
  kind: z.literal('status'),
  deviceId: z.string().uuid(),
  status: z.enum(['online', 'offline']),
});

/** A moment on the clock. Fires. This is how a timer is expressed. */
export const scheduleConditionSchema = z.object({
  kind: z.literal('schedule'),
  /** Minutes past midnight, 0-1439, in the home's timezone. */
  atMinute: z.number().int().min(0).max(1439),
  /** 0=Sunday … 6=Saturday. Empty means every day. */
  days: z.array(z.number().int().min(0).max(6)).default([]),
});

/**
 * A daily window. Gates only — never fires.
 * `fromMinute` > `toMinute` wraps midnight, so 22:00-06:00 is one night.
 */
export const timeConditionSchema = z.object({
  kind: z.literal('time'),
  fromMinute: z.number().int().min(0).max(1439),
  toMinute: z.number().int().min(0).max(1439),
  days: z.array(z.number().int().min(0).max(6)).default([]),
});

export const conditionSchema = z.union([
  statusConditionSchema,
  scheduleConditionSchema,
  timeConditionSchema,
  // Last: it is the only member with a defaulted discriminator, so it must not
  // shadow the others during union resolution.
  deviceConditionSchema,
]);

export type DeviceCondition = z.infer<typeof deviceConditionSchema>;
export type StatusCondition = z.infer<typeof statusConditionSchema>;
export type ScheduleCondition = z.infer<typeof scheduleConditionSchema>;
export type TimeCondition = z.infer<typeof timeConditionSchema>;
export type Condition = z.infer<typeof conditionSchema>;

/** Can this condition set a rule off, or does it only narrow one? */
export function isFiring(condition: Condition): boolean {
  return condition.kind !== 'time';
}

export const actionSchema = z.discriminatedUnion('kind', [
  // Publish a command patch to a device.
  z.object({
    kind: z.literal('command'),
    deviceId: z.string().uuid(),
    patch: z.record(z.union([z.string(), z.number(), z.boolean()])),
  }),
  // Run a scene, so a rule and a button can share one definition.
  z.object({ kind: z.literal('scene'), sceneId: z.string().uuid() }),
  // Pause between actions (e.g. close a valve, wait, then stop the pump).
  z.object({ kind: z.literal('delay'), ms: z.number().int().min(0).max(300_000) }),
  // Outbound notification hook.
  z.object({
    kind: z.literal('webhook'),
    url: z.string().url(),
    body: z.record(z.unknown()).optional(),
  }),
]);
export type Action = z.infer<typeof actionSchema>;

export const MATCH_MODES = ['any', 'all'] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

export const automationSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).default(''),
    enabled: z.boolean().default(true),
    /** 'any' = OR, 'all' = AND. */
    match: z.enum(MATCH_MODES).default('all'),
    conditions: z.array(conditionSchema).min(1).max(10),
    actions: z.array(actionSchema).min(1).max(10),
    cooldownSeconds: z.number().int().min(0).max(86_400).default(30),
    edgeTriggered: z.boolean().default(true),
  })
  .refine((rule) => rule.conditions.some(isFiring), {
    message:
      'A rule needs at least one condition that can set it off — a device reading, a device going ' +
      'online or offline, or a time of day. A time window only narrows when a rule may run.',
    path: ['conditions'],
  });
export type AutomationInput = z.infer<typeof automationSchema>;

export interface AutomationRow {
  id: string;
  home_id: string;
  /** Null once the creator's account is gone; such a rule may never act. */
  owner_id: string | null;
  name: string;
  enabled: boolean;
  match: MatchMode;
  conditions: Condition[];
  actions: Action[];
  cooldown_seconds: number;
  edge_triggered: boolean;
  last_triggered_at: Date | null;
}

/** Reading snapshot the evaluator works against: key -> current value. */
export type ReadingSnapshot = Record<string, unknown>;

export const sceneSchema = z.object({
  name: z.string().trim().min(1).max(120),
  icon: z.string().trim().max(40).default('sparkles'),
  actions: z.array(actionSchema).min(1).max(20),
  sortOrder: z.number().int().default(0),
});
export type SceneInput = z.infer<typeof sceneSchema>;

export interface SceneRow {
  id: string;
  home_id: string;
  owner_id: string | null;
  name: string;
  icon: string;
  actions: Action[];
  sort_order: number;
  last_run_at: Date | null;
  run_count: number;
}
