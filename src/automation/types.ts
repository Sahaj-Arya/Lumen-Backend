import { z } from 'zod';

/**
 * Rule shapes, validated on write so the engine never has to defend against a
 * malformed rule at 3am.
 */

export const COMPARATORS = ['>', '>=', '<', '<=', '==', '!=', 'changed', 'truthy', 'falsy'] as const;
export type Comparator = (typeof COMPARATORS)[number];

/** A predicate over one device reading. */
export const predicateSchema = z.object({
  deviceId: z.string().uuid(),
  key: z.string().min(1).max(120),
  op: z.enum(COMPARATORS),
  // Not required for changed/truthy/falsy.
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type Predicate = z.infer<typeof predicateSchema>;

export const triggerSchema = z.discriminatedUnion('kind', [
  // Fires when a reading satisfies the predicate.
  z.object({
    kind: z.literal('state'),
    deviceId: z.string().uuid(),
    key: z.string().min(1).max(120),
    op: z.enum(COMPARATORS),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    /**
     * Hysteresis. Once fired, the rule will not re-arm until the reading
     * crosses back past this value — the standard fix for a tank level sitting
     * on the threshold and flapping the pump.
     */
    clearValue: z.number().optional(),
  }),
  // Fires when a device goes online/offline (backed by the broker's Last Will).
  z.object({
    kind: z.literal('status'),
    deviceId: z.string().uuid(),
    status: z.enum(['online', 'offline']),
  }),
  // Fires on a wall-clock schedule, evaluated by the backend scheduler.
  z.object({
    kind: z.literal('schedule'),
    /** Minutes past midnight, 0-1439, in the home's timezone. */
    atMinute: z.number().int().min(0).max(1439),
    /** 0=Sunday … 6=Saturday. Empty means every day. */
    days: z.array(z.number().int().min(0).max(6)).default([]),
  }),
]);
export type Trigger = z.infer<typeof triggerSchema>;

export const actionSchema = z.discriminatedUnion('kind', [
  // Publish a command patch to a device.
  z.object({
    kind: z.literal('command'),
    deviceId: z.string().uuid(),
    patch: z.record(z.union([z.string(), z.number(), z.boolean()])),
  }),
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

export const automationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(''),
  enabled: z.boolean().default(true),
  trigger: triggerSchema,
  conditions: z.array(predicateSchema).max(10).default([]),
  actions: z.array(actionSchema).min(1).max(10),
  cooldownSeconds: z.number().int().min(0).max(86_400).default(30),
  edgeTriggered: z.boolean().default(true),
});
export type AutomationInput = z.infer<typeof automationSchema>;

export interface AutomationRow {
  id: string;
  home_id: string;
  /** Null once the creator's account is gone; such a rule may never act. */
  owner_id: string | null;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  conditions: Predicate[];
  actions: Action[];
  cooldown_seconds: number;
  edge_triggered: boolean;
  last_triggered_at: Date | null;
}

/** Reading snapshot the evaluator works against: key -> current value. */
export type ReadingSnapshot = Record<string, unknown>;
