import { logger } from '../logger.js';
import { query, queryOne } from '../db/index.js';
import { redis } from '../redis/index.js';
import { publishCommand } from '../mqtt/bridge.js';
import { actionDeviceIds, isSatisfied, minuteOfDay, shouldRearm } from './evaluate.js';
import type { EvalContext } from './evaluate.js';
import { ownerMayActuate } from './ownership.js';
import type { Action, AutomationRow, ReadingSnapshot, SceneRow } from './types.js';

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

/**
 * Wall-clock reading in the home's timezone, for time-window conditions. Rules
 * are written against local time, so evaluating them in UTC would shift every
 * window by the offset.
 */
async function homeClock(homeId: string): Promise<{ minute: number; weekday: number }> {
  const row = await queryOne<{ timezone: string }>('SELECT timezone FROM homes WHERE id = $1', [
    homeId,
  ]);
  return minuteOfDay(new Date(), row?.timezone || 'UTC');
}

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

/** Loads a scene the automation is allowed to run. */
async function loadScene(sceneId: string, ownerId: string | null): Promise<SceneRow | null> {
  return queryOne<SceneRow>(
    `SELECT s.* FROM scenes s
       JOIN home_members m ON m.home_id = s.home_id AND m.user_id = $2
      WHERE s.id = $1`,
    [sceneId, ownerId],
  );
}

interface ActionSource {
  id: string;
  name: string;
  homeId: string;
  /** Whose access authorises the actions. Null means the account is gone. */
  ownerId: string | null;
  actions: Action[];
  kind: 'automation' | 'scene';
}

async function runActions(
  source: ActionSource,
  chainDepth: number,
): Promise<{ ran: number; error?: string }> {
  let ran = 0;

  for (const action of source.actions) {
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
            automation: { id: source.id, name: source.name },
            firedAt: new Date().toISOString(),
            ...(action.body ?? {}),
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`webhook responded ${response.status}`);
        ran += 1;
        continue;
      }

      if (action.kind === 'scene') {
        // A rule running a scene is still one step deeper in the chain, so a
        // scene that re-triggers the rule cannot loop forever.
        const scene = await loadScene(action.sceneId, source.ownerId);
        if (!scene) throw new Error('scene no longer exists or is not reachable by this rule\'s owner');
        const nested = await runActions(
          {
            id: scene.id,
            name: scene.name,
            homeId: scene.home_id,
            // The rule's owner authorises the scene it runs, not the scene's.
            ownerId: source.ownerId,
            actions: scene.actions,
            kind: 'scene',
          },
          chainDepth + 1,
        );
        ran += nested.ran;
        if (nested.error) throw new Error(nested.error);
        continue;
      }

      // command
      const device = await queryOne<{ device_uid: string; home_id: string }>(
        'SELECT device_uid, home_id FROM devices WHERE id = $1',
        [action.deviceId],
      );
      if (!device) throw new Error(`action target device ${action.deviceId} no longer exists`);
      // The boundary is the owner's membership, not the rule's own home: a rule
      // may drive any device its owner can reach, including one in another of
      // their homes. `ownerStillAllowed` pre-checks the whole action list, and
      // this re-checks per device so a scene reached indirectly is covered too.
      const reachable = await queryOne<{ id: string }>(
        `SELECT d.id FROM devices d
           JOIN home_members m ON m.home_id = d.home_id AND m.user_id = $2
          WHERE d.id = $1`,
        [action.deviceId, source.ownerId],
      );
      if (!reachable) {
        throw new Error('action target is not reachable by this rule\'s owner');
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

const asSource = (automation: AutomationRow): ActionSource => ({
  id: automation.id,
  name: automation.name,
  homeId: automation.home_id,
  ownerId: automation.owner_id,
  actions: automation.actions,
  kind: 'automation',
});

/**
 * Assembles everything a rule needs to be judged: the readings and presence of
 * every device it mentions, plus the home's wall clock.
 */
async function buildContext(
  automation: AutomationRow,
  overrides?: { deviceId: string; snapshot: ReadingSnapshot; previous?: ReadingSnapshot; status?: 'online' | 'offline' },
): Promise<EvalContext> {
  const ids = [
    ...new Set(
      automation.conditions.flatMap((condition) =>
        condition.kind === 'device' || condition.kind === 'status' ? [condition.deviceId] : [],
      ),
    ),
  ];

  const snapshots = new Map<string, ReadingSnapshot>();
  const statuses = new Map<string, 'online' | 'offline' | null>();
  const previous = new Map<string, ReadingSnapshot>();

  for (const id of ids) {
    const snapshot = await readSnapshot(id);
    if (snapshot) snapshots.set(id, snapshot);
    const row = await queryOne<{ status: string }>('SELECT status FROM devices WHERE id = $1', [id]);
    statuses.set(id, (row?.status as 'online' | 'offline') ?? null);
  }

  // The message being processed is fresher than anything already stored.
  if (overrides) {
    snapshots.set(overrides.deviceId, overrides.snapshot);
    if (overrides.previous) previous.set(overrides.deviceId, overrides.previous);
    if (overrides.status) statuses.set(overrides.deviceId, overrides.status);
  }

  return { snapshots, previous, statuses, clock: await homeClock(automation.home_id) };
}

async function considerAutomation(
  automation: AutomationRow,
  context: { deviceId: string; snapshot: ReadingSnapshot; previous?: ReadingSnapshot; status?: 'online' | 'offline' } | undefined,
  chainDepth: number,
  firedIndex?: number,
): Promise<void> {
  const evalContext = await buildContext(automation, context);
  const satisfied = isSatisfied(automation.match, automation.conditions, evalContext, firedIndex);

  // Edge triggering: act on the false -> true crossing of the rule as a whole,
  // and re-arm when it clears (respecting any hysteresis band it sets).
  if (automation.edge_triggered) {
    const armed = (await redis.get(armedKey(automation.id))) !== 'fired';
    if (!satisfied) {
      if (!armed && shouldRearm(automation.conditions, evalContext)) {
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

  if (automation.edge_triggered) {
    await redis.set(armedKey(automation.id), 'fired', 'EX', 24 * 60 * 60);
  }

  const triggerValue = context?.status ?? context?.snapshot ?? null;

  const denied = await ownerStillAllowed(automation);
  if (denied) {
    await record(automation.id, 'skipped', { reason: denied });
    logger.warn({ automationId: automation.id, reason: denied }, 'automation blocked: owner access');
    return;
  }

  const result = await runActions(asSource(automation), chainDepth);
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
        {
          deviceId: input.deviceId,
          snapshot: input.snapshot,
          previous: input.previous,
          status: input.status,
        },
        chainDepth,
      );
    } catch (error) {
      logger.error({ err: error, automationId: rule.id }, 'automation evaluation failed');
      await record(rule.id, 'failed', { error: (error as Error).message });
    }
  }
}

/** Fires any schedule-triggered rule due this minute. Called once a minute. */
/**
 * Fires any rule with a schedule condition due this minute. Called once a
 * minute.
 *
 * The scheduler only decides *which* condition came due — the rule still has
 * to satisfy its match mode and its gates, so 'at 07:00 AND the tank is low'
 * checks the tank before acting.
 */
export async function tickSchedules(now = new Date()): Promise<number> {
  const rules = await query<AutomationRow & { timezone: string }>(
    `SELECT a.*, h.timezone FROM automations a
       JOIN homes h ON h.id = a.home_id
      WHERE a.enabled AND a.conditions @> '[{kind:schedule}]'::jsonb`,
  );

  let fired = 0;
  for (const rule of rules.rows) {
    const { minute, weekday } = minuteOfDay(now, rule.timezone || 'UTC');

    // Which schedule condition, if any, matches this minute?
    const dueIndex = rule.conditions.findIndex(
      (condition) =>
        condition.kind === 'schedule' &&
        condition.atMinute === minute &&
        (condition.days.length === 0 || condition.days.includes(weekday)),
    );
    if (dueIndex === -1) continue;

    try {
      // A schedule lands on a minute boundary, so the cooldown floor keeps two
      // ticks in the same minute from double-firing it.
      const claimed = await redis.set(
        cooldownKey(rule.id),
        '1',
        'EX',
        Math.max(rule.cooldown_seconds, 61),
        'NX',
      );
      if (claimed === null) continue;
      // Already claimed the cooldown, so let the shared path skip its own.
      await considerAutomation({ ...rule, cooldown_seconds: 0 }, undefined, 0, dueIndex);
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

  const result = await runActions(asSource(automation), 0);
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

/** Runs a scene's actions now. Used by the API's tap-to-run endpoint. */
export async function runScene(scene: SceneRow): Promise<{ ran: number; error?: string }> {
  const result = await runActions(
    {
      id: scene.id,
      name: scene.name,
      homeId: scene.home_id,
      ownerId: scene.owner_id,
      actions: scene.actions,
      kind: 'scene',
    },
    0,
  );
  await query(
    'UPDATE scenes SET last_run_at = now(), run_count = run_count + 1 WHERE id = $1',
    [scene.id],
  );
  await query(
    `INSERT INTO automation_runs (scene_id, status, reason, actions_run, error)
     VALUES ($1, $2, 'manual', $3, $4)`,
    [scene.id, result.error ? 'failed' : 'fired', result.ran, result.error ?? null],
  );
  return result;
}
