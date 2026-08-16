import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../errors.js';
import { audit } from '../services/audit.js';
import { automationSchema, isFiring, type AutomationRow } from '../automation/types.js';
import { currentUser, requireAuth, requireHomeRole } from '../auth/guard.js';
import { query, queryOne, transaction } from '../db/index.js';
import { runNow } from '../automation/engine.js';
import { watchedDeviceIds } from '../automation/evaluate.js';

const present = (row: AutomationRow & { run_count?: number; description?: string }) => ({
  id: row.id,
  homeId: row.home_id,
  name: row.name,
  description: row.description ?? '',
  enabled: row.enabled,
  match: row.match,
  conditions: row.conditions,
  actions: row.actions,
  cooldownSeconds: row.cooldown_seconds,
  edgeTriggered: row.edge_triggered,
  lastTriggeredAt: row.last_triggered_at,
  runCount: row.run_count ?? 0,
});

/**
 * Every device a rule references must be one the author can actually reach —
 * scoped to the account, not to a single home.
 *
 * Home scoping was too narrow: someone with a house and a workshop could not
 * write 'if the workshop tank is full, stop the house pump', and a one-device
 * rule was awkward because the editor had to stay inside whichever home it
 * happened to pick first. Membership is still the boundary; it is just checked
 * across every home the user belongs to.
 */
async function assertDevicesAccessible(userId: string, deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return;
  const rows = await query<{ id: string }>(
    `SELECT d.id FROM devices d
       JOIN home_members m ON m.home_id = d.home_id AND m.user_id = $1
      WHERE d.id = ANY($2::uuid[])`,
    [userId, deviceIds],
  );
  const found = new Set(rows.rows.map((row) => row.id));
  const missing = deviceIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw ApiError.badRequest('Some referenced devices are not in your account', { missing });
  }
}

/**
 * A rule still belongs to one home for listing and grouping. It is taken from
 * the trigger device so the caller does not have to pick, and a rule spanning
 * homes files under the one that sets it off.
 */
async function homeForRule(
  input: { conditions: AutomationRow['conditions']; actions: AutomationRow['actions'] },
  fallback: string,
): Promise<string> {
  const named = input.conditions.find(
    (condition) => condition.kind === 'device' || condition.kind === 'status',
  );
  const anchor =
    named && 'deviceId' in named
      ? named.deviceId
      : input.actions.find((action) => action.kind === 'command')?.deviceId;
  if (!anchor) return fallback;
  const row = await queryOne<{ home_id: string }>('SELECT home_id FROM devices WHERE id = $1', [
    anchor,
  ]);
  return row?.home_id ?? fallback;
}

/**
 * A rule is private to the user who created it. Home membership alone is not
 * enough: sharing a home must not mean editing, disabling or firing a
 * housemate's rules. 404 rather than 403 so rule ids cannot be probed.
 */
function assertOwner(row: { owner_id?: string | null }, userId: string): void {
  if (row.owner_id !== userId) throw ApiError.notFound('Automation not found');
}

function allDeviceIds(input: {
  conditions: AutomationRow['conditions'];
  actions: AutomationRow['actions'];
}): string[] {
  const ids = new Set(watchedDeviceIds(input.conditions));
  for (const action of input.actions) {
    if (action.kind === 'command') ids.add(action.deviceId);
  }
  return [...ids];
}

/**
 * Patch shape. `automationSchema` carries a refine (a rule needs something that
 * can set it off), and a ZodEffects has no `.partial()`, so the base object is
 * partialised here and the same invariant re-checked below when conditions are
 * actually supplied.
 */
const automationPatchSchema = automationSchema.innerType().partial();

function assertHasFiringCondition(conditions: AutomationRow['conditions']): void {
  if (!conditions.some(isFiring)) {
    throw ApiError.badRequest(
      'A rule needs at least one condition that can set it off — a device reading, a device ' +
        'going online or offline, or a time of day. A time window only narrows when a rule may run.',
    );
  }
}

export async function automationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (request) => {
    const user = currentUser(request);
    const { homeId } = z.object({ homeId: z.string().uuid().optional() }).parse(request.query);
    if (homeId) await requireHomeRole(user.id, homeId);

    const rows = await query<AutomationRow & { run_count: number }>(
      `SELECT a.* FROM automations a
         JOIN home_members m ON m.home_id = a.home_id AND m.user_id = $1
        WHERE a.owner_id = $1
          AND ($2::uuid IS NULL OR a.home_id = $2)
        ORDER BY a.created_at DESC`,
      [user.id, homeId ?? null],
    );
    return { automations: rows.rows.map(present) };
  });

  app.post('/', async (request, reply) => {
    const user = currentUser(request);
    const { homeId } = z.object({ homeId: z.string().uuid() }).parse(request.query);
    const body = automationSchema.parse(request.body);
    await requireHomeRole(user.id, homeId, 'member');
    await assertDevicesAccessible(user.id, allDeviceIds(body));
    const ruleHome = await homeForRule(body, homeId);
    await requireHomeRole(user.id, ruleHome, 'member');

    // A schedule lands on a minute boundary, so a sub-minute cooldown would let
    // two ticks in the same minute double-fire the rule.
    const hasSchedule = body.conditions.some((condition) => condition.kind === 'schedule');
    const cooldown = hasSchedule ? Math.max(body.cooldownSeconds, 61) : body.cooldownSeconds;

    const row = await transaction(async (client) => {
      const inserted = await client.query<AutomationRow>(
        `INSERT INTO automations
           (home_id, name, description, enabled, match, conditions, actions,
            cooldown_seconds, edge_triggered, created_by, owner_id)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$10)
         RETURNING *`,
        [
          ruleHome,
          body.name,
          body.description,
          body.enabled,
          body.match,
          JSON.stringify(body.conditions),
          JSON.stringify(body.actions),
          cooldown,
          body.edgeTriggered,
          user.id,
        ],
      );
      const automation = inserted.rows[0]!;

      for (const deviceId of watchedDeviceIds(body.conditions)) {
        await client.query(
          'INSERT INTO automation_watches (automation_id, device_id) VALUES ($1, $2)',
          [automation.id, deviceId],
        );
      }
      return automation;
    });

    await audit({ userId: user.id, homeId: ruleHome, action: 'automation.create', subject: body.name });
    return reply.status(201).send(present(row));
  });

  app.get('/:automationId', async (request) => {
    const user = currentUser(request);
    const { automationId } = z.object({ automationId: z.string().uuid() }).parse(request.params);

    const row = await queryOne<AutomationRow>('SELECT * FROM automations WHERE id = $1', [
      automationId,
    ]);
    if (!row) throw ApiError.notFound('Automation not found');
    assertOwner(row, user.id);
    await requireHomeRole(user.id, row.home_id);
    return present(row);
  });

  app.patch('/:automationId', async (request) => {
    const user = currentUser(request);
    const { automationId } = z.object({ automationId: z.string().uuid() }).parse(request.params);
    const body = automationPatchSchema.parse(request.body);

    const existing = await queryOne<AutomationRow>('SELECT * FROM automations WHERE id = $1', [
      automationId,
    ]);
    if (!existing) throw ApiError.notFound('Automation not found');
    assertOwner(existing, user.id);
    await requireHomeRole(user.id, existing.home_id, 'member');

    const merged = {
      conditions: body.conditions ?? existing.conditions,
      actions: body.actions ?? existing.actions,
    };
    if (body.conditions) assertHasFiringCondition(merged.conditions);
    await assertDevicesAccessible(user.id, allDeviceIds(merged));

    const row = await transaction(async (client) => {
      const updated = await client.query<AutomationRow>(
        `UPDATE automations SET
           name = COALESCE($2, name),
           description = COALESCE($3, description),
           enabled = COALESCE($4, enabled),
           match = COALESCE($5, match),
           conditions = COALESCE($6::jsonb, conditions),
           actions = COALESCE($7::jsonb, actions),
           cooldown_seconds = COALESCE($8, cooldown_seconds),
           edge_triggered = COALESCE($9, edge_triggered)
         WHERE id = $1 RETURNING *`,
        [
          automationId,
          body.name ?? null,
          body.description ?? null,
          body.enabled ?? null,
          body.match ?? null,
          body.conditions ? JSON.stringify(body.conditions) : null,
          body.actions ? JSON.stringify(body.actions) : null,
          body.cooldownSeconds ?? null,
          body.edgeTriggered ?? null,
        ],
      );

      // Rebuild the watch index whenever the devices a rule reads could change.
      if (body.conditions) {
        await client.query('DELETE FROM automation_watches WHERE automation_id = $1', [
          automationId,
        ]);
        for (const deviceId of watchedDeviceIds(merged.conditions)) {
          await client.query(
            'INSERT INTO automation_watches (automation_id, device_id) VALUES ($1, $2)',
            [automationId, deviceId],
          );
        }
      }
      return updated.rows[0]!;
    });

    await audit({
      userId: user.id,
      homeId: existing.home_id,
      action: 'automation.update',
      subject: automationId,
    });
    return present(row);
  });

  app.delete('/:automationId', async (request) => {
    const user = currentUser(request);
    const { automationId } = z.object({ automationId: z.string().uuid() }).parse(request.params);

    const existing = await queryOne<AutomationRow>(
      'SELECT home_id, owner_id FROM automations WHERE id = $1',
      [automationId],
    );
    if (!existing) throw ApiError.notFound('Automation not found');
    assertOwner(existing, user.id);
    await requireHomeRole(user.id, existing.home_id, 'member');

    await query('DELETE FROM automations WHERE id = $1', [automationId]);
    await audit({
      userId: user.id,
      homeId: existing.home_id,
      action: 'automation.delete',
      subject: automationId,
    });
    return { ok: true };
  });

  /** Fire the actions immediately, ignoring trigger and cooldown. */
  app.post('/:automationId/run', async (request) => {
    const user = currentUser(request);
    const { automationId } = z.object({ automationId: z.string().uuid() }).parse(request.params);

    const row = await queryOne<AutomationRow>('SELECT * FROM automations WHERE id = $1', [
      automationId,
    ]);
    if (!row) throw ApiError.notFound('Automation not found');
    assertOwner(row, user.id);
    await requireHomeRole(user.id, row.home_id, 'member');

    const result = await runNow(row);
    await audit({
      userId: user.id,
      homeId: row.home_id,
      action: 'automation.run_manual',
      subject: automationId,
    });
    if (result.error) throw ApiError.unavailable(result.error);
    return { ok: true, actionsRun: result.ran };
  });

  /** Execution history — what fired, what was skipped and why. */
  app.get('/:automationId/runs', async (request) => {
    const user = currentUser(request);
    const { automationId } = z.object({ automationId: z.string().uuid() }).parse(request.params);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query);

    const row = await queryOne<{ home_id: string; owner_id: string | null }>(
      'SELECT home_id, owner_id FROM automations WHERE id = $1',
      [automationId],
    );
    if (!row) throw ApiError.notFound('Automation not found');
    assertOwner(row, user.id);
    await requireHomeRole(user.id, row.home_id);

    const runs = await query(
      `SELECT id, status, reason, trigger_value, actions_run, error, created_at
         FROM automation_runs WHERE automation_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [automationId, limit],
    );
    return { runs: runs.rows };
  });
}
