import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { currentUser, requireAuth, requireHomeRole } from '../auth/guard.js';
import { query } from '../db/index.js';

/**
 * A single "what has been happening" feed across the caller's homes.
 *
 * The app used to build this from its own MQTT message log, which only covered
 * whatever arrived while the app happened to be open. The backend has the
 * durable record — commands it published and rules it ran — so the feed is the
 * same whether the phone was awake or not.
 */
export async function activityRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (request) => {
    const user = currentUser(request);
    const { homeId, limit } = z
      .object({
        homeId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query);

    if (homeId) await requireHomeRole(user.id, homeId);

    // Commands the API published, joined to the device they went to.
    const commands = await query<{
      id: string;
      at: Date;
      device_name: string;
      device_id: string;
      payload: unknown;
      status: string;
      error: string | null;
      issued_by_email: string | null;
    }>(
      `SELECT c.id::text, c.created_at AS at, d.name AS device_name, d.id::text AS device_id,
              c.payload, c.status, c.error, u.email AS issued_by_email
         FROM device_commands c
         JOIN devices d ON d.id = c.device_id
         JOIN home_members m ON m.home_id = d.home_id AND m.user_id = $1
         LEFT JOIN users u ON u.id = c.issued_by
        WHERE ($2::uuid IS NULL OR d.home_id = $2)
        ORDER BY c.created_at DESC
        LIMIT $3`,
      [user.id, homeId ?? null, limit],
    );

    // Rule and scene executions, including the ones that were skipped and why.
    const runs = await query<{
      id: string;
      at: Date;
      name: string;
      status: string;
      reason: string | null;
      actions_run: number;
      error: string | null;
    }>(
      `SELECT r.id::text, r.created_at AS at,
              COALESCE(a.name, s.name) AS name,
              r.status, r.reason, r.actions_run, r.error
         FROM automation_runs r
         LEFT JOIN automations a ON a.id = r.automation_id
         LEFT JOIN scenes s ON s.id = r.scene_id
         JOIN home_members m
           ON m.home_id = COALESCE(a.home_id, s.home_id) AND m.user_id = $1
        WHERE ($2::uuid IS NULL OR COALESCE(a.home_id, s.home_id) = $2)
        ORDER BY r.created_at DESC
        LIMIT $3`,
      [user.id, homeId ?? null, limit],
    );

    // Merged into one timeline so the client does not have to interleave.
    const events = [
      ...commands.rows.map((row) => ({
        kind: 'command' as const,
        id: `command:${row.id}`,
        at: row.at,
        title: row.device_name,
        detail: JSON.stringify(row.payload),
        status: row.status,
        error: row.error,
        deviceId: row.device_id,
        actor: row.issued_by_email,
      })),
      ...runs.rows.map((row) => ({
        kind: 'automation' as const,
        id: `run:${row.id}`,
        at: row.at,
        title: row.name ?? 'Deleted rule',
        detail:
          row.status === 'fired'
            ? `${row.actions_run} action${row.actions_run === 1 ? '' : 's'}`
            : (row.reason ?? row.status),
        status: row.status,
        error: row.error,
        deviceId: null,
        actor: null,
      })),
    ]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, limit);

    return { events };
  });
}
