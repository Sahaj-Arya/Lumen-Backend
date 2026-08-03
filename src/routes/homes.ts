import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../errors.js';
import { audit } from '../services/audit.js';
import { currentUser, requireAuth, requireHomeRole } from '../auth/guard.js';
import { query, queryOne, transaction } from '../db/index.js';

const homeBody = z.object({
  name: z.string().trim().min(1).max(80),
  timezone: z.string().trim().max(64).optional(),
});

const memberBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['admin', 'member', 'viewer']),
});

const groupBody = z.object({
  name: z.string().trim().min(1).max(60),
  icon: z.string().trim().max(40).optional(),
  sortOrder: z.number().int().optional(),
});

export async function homeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // ──────────────────────────── homes ───────────────────────────
  app.get('/', async (request) => {
    const user = currentUser(request);
    const rows = await query(
      `SELECT h.id, h.name, h.timezone, m.role, h.created_at,
              (SELECT count(*) FROM devices d WHERE d.home_id = h.id)::int AS device_count,
              (SELECT count(*) FROM device_groups g WHERE g.home_id = h.id)::int AS group_count
         FROM homes h
         JOIN home_members m ON m.home_id = h.id
        WHERE m.user_id = $1
        ORDER BY h.created_at`,
      [user.id],
    );
    return { homes: rows.rows };
  });

  app.post('/', async (request, reply) => {
    const user = currentUser(request);
    const body = homeBody.parse(request.body);

    const home = await transaction(async (client) => {
      const inserted = await client.query<{ id: string; name: string }>(
        'INSERT INTO homes (name, timezone, created_by) VALUES ($1, $2, $3) RETURNING id, name',
        [body.name, body.timezone ?? 'UTC', user.id],
      );
      await client.query(
        `INSERT INTO home_members (home_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [inserted.rows[0]!.id, user.id],
      );
      return inserted.rows[0]!;
    });

    await audit({ userId: user.id, homeId: home.id, action: 'home.create' });
    return reply.status(201).send(home);
  });

  app.patch('/:homeId', async (request) => {
    const user = currentUser(request);
    const { homeId } = z.object({ homeId: z.string().uuid() }).parse(request.params);
    const body = homeBody.partial().parse(request.body);
    await requireHomeRole(user.id, homeId, 'admin');

    const row = await queryOne(
      `UPDATE homes SET name = COALESCE($2, name), timezone = COALESCE($3, timezone)
        WHERE id = $1 RETURNING id, name, timezone`,
      [homeId, body.name ?? null, body.timezone ?? null],
    );
    await audit({ userId: user.id, homeId, action: 'home.update' });
    return row;
  });

  app.delete('/:homeId', async (request) => {
    const user = currentUser(request);
    const { homeId } = z.object({ homeId: z.string().uuid() }).parse(request.params);
    await requireHomeRole(user.id, homeId, 'owner');

    await audit({ userId: user.id, homeId, action: 'home.delete' });
    await query('DELETE FROM homes WHERE id = $1', [homeId]);
    return { ok: true };
  });

  // ─────────────────────────── members ──────────────────────────
  app.get('/:homeId/members', async (request) => {
    const user = currentUser(request);
    const { homeId } = z.object({ homeId: z.string().uuid() }).parse(request.params);
    await requireHomeRole(user.id, homeId);

    const rows = await query(
      `SELECT u.id, u.email, u.display_name, m.role, m.joined_at
         FROM home_members m JOIN users u ON u.id = m.user_id
        WHERE m.home_id = $1
        ORDER BY m.joined_at`,
      [homeId],
    );
    return { members: rows.rows };
  });

  app.post('/:homeId/members', async (request, reply) => {
    const user = currentUser(request);
    const { homeId } = z.object({ homeId: z.string().uuid() }).parse(request.params);
    const body = memberBody.parse(request.body);
    await requireHomeRole(user.id, homeId, 'admin');

    const invitee = await queryOne<{ id: string }>(
      'SELECT id FROM users WHERE email_normalised = $1',
      [body.email],
    );
    // Invitations to unregistered addresses would need an email flow with a
    // pending-invite table; for now the person signs up first.
    if (!invitee) throw ApiError.notFound('No account with that email — ask them to sign up first');

    await query(
      `INSERT INTO home_members (home_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (home_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [homeId, invitee.id, body.role],
    );
    await audit({
      userId: user.id,
      homeId,
      action: 'home.member_add',
      subject: invitee.id,
      metadata: { role: body.role },
    });
    return reply.status(201).send({ ok: true });
  });

  app.delete('/:homeId/members/:userId', async (request) => {
    const user = currentUser(request);
    const params = z
      .object({ homeId: z.string().uuid(), userId: z.string().uuid() })
      .parse(request.params);
    await requireHomeRole(user.id, params.homeId, 'admin');

    const target = await queryOne<{ role: string }>(
      'SELECT role FROM home_members WHERE home_id = $1 AND user_id = $2',
      [params.homeId, params.userId],
    );
    if (!target) throw ApiError.notFound('Member not found');

    if (target.role === 'owner') {
      const owners = await queryOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM home_members WHERE home_id = $1 AND role = 'owner'`,
        [params.homeId],
      );
      // A home with no owner can never be administered again.
      if ((owners?.count ?? 0) <= 1) throw ApiError.conflict('A home must keep at least one owner');
    }

    await query('DELETE FROM home_members WHERE home_id = $1 AND user_id = $2', [
      params.homeId,
      params.userId,
    ]);
    await audit({
      userId: user.id,
      homeId: params.homeId,
      action: 'home.member_remove',
      subject: params.userId,
    });
    return { ok: true };
  });

  // ─────────────────────── groups (rooms) ───────────────────────
  app.get('/:homeId/groups', async (request) => {
    const user = currentUser(request);
    const { homeId } = z.object({ homeId: z.string().uuid() }).parse(request.params);
    await requireHomeRole(user.id, homeId);

    const rows = await query(
      `SELECT g.id, g.name, g.icon, g.sort_order,
              (SELECT count(*) FROM devices d WHERE d.group_id = g.id)::int AS device_count
         FROM device_groups g
        WHERE g.home_id = $1
        ORDER BY g.sort_order, g.name`,
      [homeId],
    );
    return { groups: rows.rows };
  });

  app.post('/:homeId/groups', async (request, reply) => {
    const user = currentUser(request);
    const { homeId } = z.object({ homeId: z.string().uuid() }).parse(request.params);
    const body = groupBody.parse(request.body);
    await requireHomeRole(user.id, homeId, 'member');

    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM device_groups WHERE home_id = $1 AND lower(name) = lower($2)',
      [homeId, body.name],
    );
    if (existing) throw ApiError.conflict('A group with that name already exists in this home');

    const row = await queryOne(
      `INSERT INTO device_groups (home_id, name, icon, sort_order)
       VALUES ($1, $2, $3, $4) RETURNING id, name, icon, sort_order`,
      [homeId, body.name, body.icon ?? 'home', body.sortOrder ?? 0],
    );
    await audit({ userId: user.id, homeId, action: 'group.create', subject: body.name });
    return reply.status(201).send(row);
  });

  app.patch('/:homeId/groups/:groupId', async (request) => {
    const user = currentUser(request);
    const params = z
      .object({ homeId: z.string().uuid(), groupId: z.string().uuid() })
      .parse(request.params);
    const body = groupBody.partial().parse(request.body);
    await requireHomeRole(user.id, params.homeId, 'member');

    const row = await queryOne(
      `UPDATE device_groups
          SET name = COALESCE($3, name),
              icon = COALESCE($4, icon),
              sort_order = COALESCE($5, sort_order)
        WHERE id = $2 AND home_id = $1
        RETURNING id, name, icon, sort_order`,
      [params.homeId, params.groupId, body.name ?? null, body.icon ?? null, body.sortOrder ?? null],
    );
    if (!row) throw ApiError.notFound('Group not found');
    return row;
  });

  app.delete('/:homeId/groups/:groupId', async (request) => {
    const user = currentUser(request);
    const params = z
      .object({ homeId: z.string().uuid(), groupId: z.string().uuid() })
      .parse(request.params);
    await requireHomeRole(user.id, params.homeId, 'member');

    // Devices survive; their group_id is nulled by ON DELETE SET NULL.
    const result = await query('DELETE FROM device_groups WHERE id = $1 AND home_id = $2', [
      params.groupId,
      params.homeId,
    ]);
    if (result.rowCount === 0) throw ApiError.notFound('Group not found');
    await audit({ userId: user.id, homeId: params.homeId, action: 'group.delete' });
    return { ok: true };
  });
}
