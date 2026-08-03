import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../errors.js';
import { audit } from '../services/audit.js';
import { automationSchema, type AutomationRow } from '../automation/types.js';
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
  trigger: row.trigger,
  conditions: row.conditions,
  actions: row.actions,
  cooldownSeconds: row.cooldown_seconds,
  edgeTriggered: row.edge_triggered,
  lastTriggeredAt: row.last_triggered_at,
  runCount: row.run_count ?? 0,
});

/**
 * Every device a rule references must belong to the rule's home. Without this
 * a member of one home could name a device id from another and drive it.
 */
async function assertDevicesInHome(homeId: string, deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return;
  const rows = await query<{ id: string }>(
    'SELECT id FROM devices WHERE home_id = $1 AND id = ANY($2::uuid[])',
    [homeId, deviceIds],
  );
  const found = new Set(rows.rows.map((row) => row.id));
  const missing = deviceIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw ApiError.badRequest('Some referenced devices are not in this home', { missing });
  }
}

/**
 * A rule is private to the user who created it. Home membership alone is not
 * enough: sharing a home must not mean editing, disabling or firing a
 * housemate's rules. 404 rather than 403 so rule ids cannot be probed.
 */
function assertOwner(row: { owner_id?: string | null }, userId: string): void {
  if (row.owner_id !== userId) throw ApiError.notFound('Automation not found');
}

function allDeviceIds(input: z.infer<typeof automationSchema>): string[] {
  const ids = new Set(watchedDeviceIds(input.trigger, input.conditions));
  for (const action of input.actions) {
    if (action.kind === 'command') ids.add(action.deviceId);
  }
  return [...ids];
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
    await assertDevicesInHome(homeId, allDeviceIds(body));

    // A schedule fires on a minute boundary, so a sub-minute cooldown would let
    // two ticks in the same minute double-fire it.
    const cooldown =
      body.trigger.kind === 'schedule' ? Math.max(body.cooldownSeconds, 61) : body.cooldownSeconds;

    const row = await transaction(async (client) => {
      const inserted = await client.query<AutomationRow>(
        `INSERT INTO automations
           (home_id, name, description, enabled, trigger, conditions, actions,
            cooldown_seconds, edge_triggered, created_by, owner_id)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$10)
         RETURNING *`,
        [
          homeId,
          body.name,
          body.description,
          body.enabled,
          JSON.stringify(body.trigger),
          JSON.stringify(body.conditions),
          JSON.stringify(body.actions),
          cooldown,
          body.edgeTriggered,
          user.id,
        ],
      );
      const automation = inserted.rows[0]!;

      for (const deviceId of watchedDeviceIds(body.trigger, body.conditions)) {
        await client.query(
          'INSERT INTO automation_watches (automation_id, device_id) VALUES ($1, $2)',
          [automation.id, deviceId],
        );
      }
      return automation;
    });

    await audit({ userId: user.id, homeId, action: 'automation.create', subject: body.name });
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
    const body = automationSchema.partial().parse(request.body);

    const existing = await queryOne<AutomationRow>('SELECT * FROM automations WHERE id = $1', [
      automationId,
    ]);
    if (!existing) throw ApiError.notFound('Automation not found');
    assertOwner(existing, user.id);
    await requireHomeRole(user.id, existing.home_id, 'member');

    const merged = {
      ...existing,
      trigger: body.trigger ?? existing.trigger,
      conditions: body.conditions ?? existing.conditions,
      actions: body.actions ?? existing.actions,
    };
    await assertDevicesInHome(
      existing.home_id,
      allDeviceIds({
        trigger: merged.trigger,
        conditions: merged.conditions,
        actions: merged.actions,
      } as z.infer<typeof automationSchema>),
    );

    const row = await transaction(async (client) => {
      const updated = await client.query<AutomationRow>(
        `UPDATE automations SET
           name = COALESCE($2, name),
           description = COALESCE($3, description),
           enabled = COALESCE($4, enabled),
           trigger = COALESCE($5::jsonb, trigger),
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
          body.trigger ? JSON.stringify(body.trigger) : null,
          body.conditions ? JSON.stringify(body.conditions) : null,
          body.actions ? JSON.stringify(body.actions) : null,
          body.cooldownSeconds ?? null,
          body.edgeTriggered ?? null,
        ],
      );

      // Rebuild the watch index whenever the devices a rule reads could change.
      if (body.trigger || body.conditions) {
        await client.query('DELETE FROM automation_watches WHERE automation_id = $1', [
          automationId,
        ]);
        for (const deviceId of watchedDeviceIds(merged.trigger, merged.conditions)) {
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
