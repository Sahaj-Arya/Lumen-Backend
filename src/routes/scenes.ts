import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../errors.js';
import { audit } from '../services/audit.js';
import { currentUser, requireAuth, requireHomeRole } from '../auth/guard.js';
import { query, queryOne } from '../db/index.js';
import { runScene } from '../automation/engine.js';
import { sceneSchema, type SceneRow } from '../automation/types.js';

/**
 * Scenes are presets: one tap sets many devices at once ("Movie night",
 * "All off"). They have no trigger — that is what separates them from an
 * automation — but a rule can run one as an action, so a button and a rule
 * share a single definition instead of duplicating the device list.
 */

const present = (row: SceneRow) => ({
  id: row.id,
  homeId: row.home_id,
  name: row.name,
  icon: row.icon,
  actions: row.actions,
  sortOrder: row.sort_order,
  lastRunAt: row.last_run_at,
  runCount: row.run_count,
});

/**
 * Every device a scene touches must be reachable by its author — across the
 * whole account, not just one home, so an 'All off' scene can cover a house and
 * a workshop in a single tap.
 */
async function assertTargetsAccessible(userId: string, actions: SceneRow['actions']): Promise<void> {
  // Checked first: a scene whose only action is another scene has no device
  // ids, so an early return on an empty device list would skip this entirely.
  // The engine caps chain depth anyway, but rejecting it here gives a
  // comprehensible error instead of a silent depth-exceeded run.
  if (actions.some((action) => action.kind === 'scene')) {
    throw ApiError.badRequest('A scene cannot run another scene');
  }

  const deviceIds = [
    ...new Set(
      actions.flatMap((action) => (action.kind === 'command' ? [action.deviceId] : [])),
    ),
  ];
  if (deviceIds.length === 0) return;

  const rows = await query<{ id: string }>(
    `SELECT d.id FROM devices d
       JOIN home_members m ON m.home_id = d.home_id AND m.user_id = $1
      WHERE d.id = ANY($2::uuid[])`,
    [userId, deviceIds],
  );
  if (rows.rowCount !== deviceIds.length) {
    throw ApiError.badRequest('Some target devices are not in your account');
  }
}

/** Scenes are private to their creator, like automations. */
function assertOwner(row: { owner_id: string | null }, userId: string): void {
  if (row.owner_id !== userId) throw ApiError.notFound('Scene not found');
}

export async function sceneRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (request) => {
    const user = currentUser(request);
    const { homeId } = z.object({ homeId: z.string().uuid().optional() }).parse(request.query);
    if (homeId) await requireHomeRole(user.id, homeId);

    const rows = await query<SceneRow>(
      `SELECT s.* FROM scenes s
         JOIN home_members m ON m.home_id = s.home_id AND m.user_id = $1
        WHERE s.owner_id = $1
          AND ($2::uuid IS NULL OR s.home_id = $2)
        ORDER BY s.sort_order, s.created_at`,
      [user.id, homeId ?? null],
    );
    return { scenes: rows.rows.map(present) };
  });

  app.post('/', async (request, reply) => {
    const user = currentUser(request);
    const { homeId } = z.object({ homeId: z.string().uuid() }).parse(request.query);
    const body = sceneSchema.parse(request.body);
    await requireHomeRole(user.id, homeId, 'member');
    await assertTargetsAccessible(user.id, body.actions);

    const row = await queryOne<SceneRow>(
      `INSERT INTO scenes (home_id, owner_id, name, icon, actions, sort_order)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING *`,
      [homeId, user.id, body.name, body.icon, JSON.stringify(body.actions), body.sortOrder],
    );

    await audit({ userId: user.id, homeId, action: 'scene.create', subject: body.name });
    return reply.status(201).send(present(row!));
  });

  app.get('/:sceneId', async (request) => {
    const user = currentUser(request);
    const { sceneId } = z.object({ sceneId: z.string().uuid() }).parse(request.params);

    const row = await queryOne<SceneRow>('SELECT * FROM scenes WHERE id = $1', [sceneId]);
    if (!row) throw ApiError.notFound('Scene not found');
    assertOwner(row, user.id);
    await requireHomeRole(user.id, row.home_id);
    return present(row);
  });

  app.patch('/:sceneId', async (request) => {
    const user = currentUser(request);
    const { sceneId } = z.object({ sceneId: z.string().uuid() }).parse(request.params);
    const body = sceneSchema.partial().parse(request.body);

    const existing = await queryOne<SceneRow>('SELECT * FROM scenes WHERE id = $1', [sceneId]);
    if (!existing) throw ApiError.notFound('Scene not found');
    assertOwner(existing, user.id);
    await requireHomeRole(user.id, existing.home_id, 'member');

    if (body.actions) await assertTargetsAccessible(user.id, body.actions);

    const row = await queryOne<SceneRow>(
      `UPDATE scenes SET
         name = COALESCE($2, name),
         icon = COALESCE($3, icon),
         actions = COALESCE($4::jsonb, actions),
         sort_order = COALESCE($5, sort_order)
       WHERE id = $1 RETURNING *`,
      [
        sceneId,
        body.name ?? null,
        body.icon ?? null,
        body.actions ? JSON.stringify(body.actions) : null,
        body.sortOrder ?? null,
      ],
    );

    await audit({ userId: user.id, homeId: existing.home_id, action: 'scene.update', subject: sceneId });
    return present(row!);
  });

  app.delete('/:sceneId', async (request) => {
    const user = currentUser(request);
    const { sceneId } = z.object({ sceneId: z.string().uuid() }).parse(request.params);

    const existing = await queryOne<SceneRow>('SELECT * FROM scenes WHERE id = $1', [sceneId]);
    if (!existing) throw ApiError.notFound('Scene not found');
    assertOwner(existing, user.id);
    await requireHomeRole(user.id, existing.home_id, 'member');

    // Automations referencing this scene keep their action; the engine reports
    // 'scene no longer exists' rather than failing silently.
    await query('DELETE FROM scenes WHERE id = $1', [sceneId]);
    await audit({ userId: user.id, homeId: existing.home_id, action: 'scene.delete', subject: sceneId });
    return { ok: true };
  });

  /** Tap-to-run. */
  app.post('/:sceneId/run', async (request) => {
    const user = currentUser(request);
    const { sceneId } = z.object({ sceneId: z.string().uuid() }).parse(request.params);

    const row = await queryOne<SceneRow>('SELECT * FROM scenes WHERE id = $1', [sceneId]);
    if (!row) throw ApiError.notFound('Scene not found');
    assertOwner(row, user.id);
    // Viewers may watch but not actuate.
    await requireHomeRole(user.id, row.home_id, 'member');

    const result = await runScene(row);
    await audit({ userId: user.id, homeId: row.home_id, action: 'scene.run', subject: sceneId });
    if (result.error) throw ApiError.unavailable(result.error);
    return { ok: true, actionsRun: result.ran };
  });
}
