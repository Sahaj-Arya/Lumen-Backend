import { logger } from '../logger.js';
import { query, queryOne } from '../db/index.js';
import { redis } from '../redis/index.js';
import { publishCommand } from '../mqtt/bridge.js';
import {
  evaluateConditions,
  evaluateTrigger,
  minuteOfDay,
  shouldRearm,
  actionDeviceIds,
} from './evaluate.js';
import { ownerMayActuate } from './ownership.js';
import type { Action, AutomationRow, ReadingSnapshot } from './types.js';

/**
 * Server-side rule engine.
 *
 * Runs inside the API process next to the MQTT bridge, so automations execute
 * whether or not any phone is awake — the app is a remote control, never the
 * control loop. Two entry points: `onDeviceUpdate` from the ingest path, and
 * `tickSchedules` from a one-minute timer.
 */

/** Latched state per rule, so edge-triggered rules fire once per crossing. */
const armedKey = (automationId: string) => `automation:armed:${automationId}`;
const cooldownKey = (automationId: string) => `automation:cooldown:${automationId}`;
/**
 * Depth of the current cause-and-effect chain. A rule acting on a device can
 * make that device report, which can trigger another rule; without a ceiling a
 * pair of rules ("pump on when tank low" / "tank low when pump on") would ping
 * -pong forever against real hardware.
 */
const MAX_CHAIN_DEPTH = 3;
const chainKey = (deviceUid: string) => `automation:chain:${deviceUid}`;
const CHAIN_TTL_SECONDS = 10;

async function readSnapshot(deviceId: string): Promise<ReadingSnapshot | null> {
  const rows = await query<{ key: string; value: unknown }>(
    'SELECT key, value FROM device_state WHERE device_id = $1',
    [deviceId],
  );
  if (rows.rowCount === 0) return null;
  return Object.fromEntries(rows.rows.map((row) => [row.key, row.value]));
}

async function loadSnapshots(deviceIds: string[]): Promise<Map<string, ReadingSnapshot>> {
  const map = new Map<string, ReadingSnapshot>();
  for (const id of new Set(deviceIds)) {
    const snapshot = await readSnapshot(id);
    if (snapshot) map.set(id, snapshot);
  }
  return map;
}

async function record(
  automationId: string,
  status: 'fired' | 'skipped' | 'failed',
  detail: { reason?: string; triggerValue?: unknown; actionsRun?: number; error?: string } = {},
): Promise<void> {
  try {
    await query(
      `INSERT INTO automation_runs (automation_id, status, reason, trigger_value, actions_run, error)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        automationId,
        status,
        detail.reason ?? null,
        JSON.stringify(detail.triggerValue ?? null),
        detail.actionsRun ?? 0,
        detail.error ?? null,
      ],
    );
  } catch (error) {
    logger.error({ err: error, automationId }, 'failed to record automation run');
  }
}

/**
 * Re-checks the owner's access immediately before acting.
 *
 * Membership is not static: someone leaves a shared home or is demoted to
 * viewer long after writing a rule. Authorising only at creation time would let
 * a removed housemate keep commanding the hardware indefinitely.
 */
async function ownerStillAllowed(automation: AutomationRow): Promise<string | null> {
  const check = await ownerMayActuate(
    automation.owner_id ?? null,
    automation.home_id,
    actionDeviceIds(automation.actions),
  );
  return check.ok ? null : check.reason;
}

async function runActions(
  automation: AutomationRow,
  chainDepth: number,
): Promise<{ ran: number; error?: string }> {
  let ran = 0;

  for (const action of automation.actions as Action[]) {
    try {
      if (action.kind === 'delay') {
        await new Promise((resolve) => setTimeout(resolve, action.ms));
        ran += 1;
        continue;
      }

      if (action.kind === 'webhook') {
        const response = await fetch(action.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            automation: { id: automation.id, name: automation.name },
            firedAt: new Date().toISOString(),
            ...(action.body ?? {}),
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`webhook responded ${response.status}`);
        ran += 1;
        continue;
      }

      // command
      const device = await queryOne<{ device_uid: string; home_id: string }>(
        'SELECT device_uid, home_id FROM devices WHERE id = $1',
        [action.deviceId],
      );
      if (!device) throw new Error(`action target device ${action.deviceId} no longer exists`);
      // A rule may only actuate devices in its own home.
      if (device.home_id !== automation.home_id) {
        throw new Error('action target belongs to a different home');
      }

      // Tag the target so an update it emits inherits this chain depth.
      await redis.set(chainKey(device.device_uid), String(chainDepth + 1), 'EX', CHAIN_TTL_SECONDS);
      await publishCommand(device.device_uid, action.patch);
      ran += 1;
    } catch (error) {
      return { ran, error: (error as Error).message };
    }
  }

  return { ran };
}

async function considerAutomation(
  automation: AutomationRow,
  context: { snapshot: ReadingSnapshot; previous?: ReadingSnapshot; status?: 'online' | 'offline' },
  chainDepth: number,
): Promise<void> {
  const satisfied = evaluateTrigger(automation.trigger, context);

  // Edge triggering: only act on the false -> true crossing, and re-arm when
  // the reading clears (respecting a hysteresis band if the rule sets one).
  if (automation.edge_triggered) {
    const armed = (await redis.get(armedKey(automation.id))) !== 'fired';
    if (!satisfied) {
      if (!armed && shouldRearm(automation.trigger, context.snapshot)) {
        await redis.del(armedKey(automation.id));
      }
      return;
    }
    if (!armed) return; // already latched, nothing to do
  } else if (!satisfied) {
    return;
  }

  if (chainDepth >= MAX_CHAIN_DEPTH) {
    await record(automation.id, 'skipped', { reason: 'depth' });
    logger.warn({ automationId: automation.id, chainDepth }, 'automation chain depth exceeded');
    return;
  }

  if (automation.cooldown_seconds > 0) {
    // NX+EX: whoever sets the key first wins, so two API instances ingesting
    // the same message cannot both fire the rule.
    const claimed = await redis.set(
      cooldownKey(automation.id),
      '1',
      'EX',
      automation.cooldown_seconds,
      'NX',
    );
    if (claimed === null) {
      await record(automation.id, 'skipped', { reason: 'cooldown' });
      return;
    }
  }

  const conditionSnapshots = await loadSnapshots(
    automation.conditions.map((condition) => condition.deviceId),
  );
  if (!evaluateConditions(automation.conditions, conditionSnapshots)) {
    await record(automation.id, 'skipped', { reason: 'condition' });
    return;
  }

  if (automation.edge_triggered) {
    await redis.set(armedKey(automation.id), 'fired', 'EX', 24 * 60 * 60);
  }

  const triggerValue =
    automation.trigger.kind === 'state' ? context.snapshot[automation.trigger.key] : context.status;

  const denied = await ownerStillAllowed(automation);
  if (denied) {
    await record(automation.id, 'skipped', { reason: denied });
    logger.warn({ automationId: automation.id, reason: denied }, 'automation blocked: owner access');
    return;
  }

  const result = await runActions(automation, chainDepth);
  await query(
    'UPDATE automations SET last_triggered_at = now(), run_count = run_count + 1 WHERE id = $1',
    [automation.id],
  );
  await record(automation.id, result.error ? 'failed' : 'fired', {
    triggerValue,
    actionsRun: result.ran,
    error: result.error,
  });

  logger.info(
    { automation: automation.name, actionsRun: result.ran, error: result.error },
    result.error ? 'automation failed' : 'automation fired',
  );
}

/**
 * Called by the MQTT bridge for every ingested update from a claimed device.
 * `previous` is the reading snapshot from before this message, needed by the
 * `changed` comparator.
 */
export async function onDeviceUpdate(input: {
  deviceId: string;
  deviceUid: string;
  snapshot: ReadingSnapshot;
  previous?: ReadingSnapshot;
  status?: 'online' | 'offline';
}): Promise<void> {
  const rules = await query<AutomationRow>(
    `SELECT a.* FROM automations a
       JOIN automation_watches w ON w.automation_id = a.id
      WHERE w.device_id = $1 AND a.enabled
      GROUP BY a.id`,
    [input.deviceId],
  );
  if (rules.rowCount === 0) return;

  const depthRaw = await redis.get(chainKey(input.deviceUid));
  const chainDepth = depthRaw ? Number(depthRaw) : 0;

  for (const rule of rules.rows) {
    // One failing rule must not stop the others from being evaluated.
    try {
      await considerAutomation(
        rule,
        { snapshot: input.snapshot, previous: input.previous, status: input.status },
        chainDepth,
      );
    } catch (error) {
      logger.error({ err: error, automationId: rule.id }, 'automation evaluation failed');
      await record(rule.id, 'failed', { error: (error as Error).message });
    }
  }
}

/** Fires any schedule-triggered rule due this minute. Called once a minute. */
export async function tickSchedules(now = new Date()): Promise<number> {
  const rules = await query<AutomationRow & { timezone: string }>(
    `SELECT a.*, h.timezone FROM automations a
       JOIN homes h ON h.id = a.home_id
      WHERE a.enabled AND a.trigger->>'kind' = 'schedule'`,
  );

  let fired = 0;
  for (const rule of rules.rows) {
    if (rule.trigger.kind !== 'schedule') continue;
    const { minute, weekday } = minuteOfDay(now, rule.timezone || 'UTC');
    if (minute !== rule.trigger.atMinute) continue;
    if (rule.trigger.days.length > 0 && !rule.trigger.days.includes(weekday)) continue;

    try {
      // Schedules have no reading to latch on, so they rely on the cooldown
      // (defaulted past 60s by the route) not to double-fire within a minute.
      const claimed = await redis.set(
        cooldownKey(rule.id),
        '1',
        'EX',
        Math.max(rule.cooldown_seconds, 61),
        'NX',
      );
      if (claimed === null) continue;

      const snapshots = await loadSnapshots(rule.conditions.map((c) => c.deviceId));
      if (!evaluateConditions(rule.conditions, snapshots)) {
        await record(rule.id, 'skipped', { reason: 'condition' });
        continue;
      }

      const scheduleDenied = await ownerStillAllowed(rule);
      if (scheduleDenied) {
        await record(rule.id, 'skipped', { reason: scheduleDenied });
        continue;
      }

      const result = await runActions(rule, 0);
      await query(
        'UPDATE automations SET last_triggered_at = now(), run_count = run_count + 1 WHERE id = $1',
        [rule.id],
      );
      await record(rule.id, result.error ? 'failed' : 'fired', {
        actionsRun: result.ran,
        error: result.error,
      });
      fired += 1;
    } catch (error) {
      logger.error({ err: error, automationId: rule.id }, 'scheduled automation failed');
      await record(rule.id, 'failed', { error: (error as Error).message });
    }
  }
  return fired;
}

/** Runs a rule's actions immediately, ignoring trigger and cooldown. */
export async function runNow(automation: AutomationRow): Promise<{ ran: number; error?: string }> {
  const denied = await ownerStillAllowed(automation);
  if (denied) {
    await record(automation.id, 'skipped', { reason: denied });
    return { ran: 0, error: 'Owner no longer has access to these devices' };
  }

  const result = await runActions(automation, 0);
  await record(automation.id, result.error ? 'failed' : 'fired', {
    reason: 'manual',
    actionsRun: result.ran,
    error: result.error,
  });
  return result;
}

let timer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  // Align to the top of the next minute so a rule set for 07:00 fires at 07:00.
  const msToNextMinute = 60_000 - (Date.now() % 60_000);
  timer = setTimeout(function tick() {
    tickSchedules().catch((error) => logger.error({ err: error }, 'schedule tick failed'));
    timer = setTimeout(tick, 60_000);
  }, msToNextMinute);
  timer.unref();
  logger.info('automation scheduler started');
}

export function stopScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
