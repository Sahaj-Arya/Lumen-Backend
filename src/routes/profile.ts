import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../errors.js';
import { audit } from '../services/audit.js';
import { currentUser, requireAuth } from '../auth/guard.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { query, queryOne } from '../db/index.js';
import { revokeAllSessions } from '../auth/tokens.js';

const updateBody = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  avatarUrl: z.string().url().max(500).nullable().optional(),
});

const passwordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12, 'Password must be at least 12 characters').max(200),
});

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/me', async (request) => {
    const user = currentUser(request);

    const row = await queryOne<{
      id: string;
      email: string | null;
      phone: string | null;
      display_name: string;
      avatar_url: string | null;
      email_verified_at: Date | null;
      phone_verified_at: Date | null;
      last_login_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, email, phone, display_name, avatar_url, email_verified_at,
              phone_verified_at, last_login_at, created_at
         FROM users WHERE id = $1`,
      [user.id],
    );
    if (!row) throw ApiError.notFound('User not found');

    const homes = await query<{ id: string; name: string; role: string; device_count: number }>(
      `SELECT h.id, h.name, m.role,
              (SELECT count(*) FROM devices d WHERE d.home_id = h.id)::int AS device_count
         FROM homes h
         JOIN home_members m ON m.home_id = h.id
        WHERE m.user_id = $1
        ORDER BY h.created_at`,
      [user.id],
    );

    return {
      id: row.id,
      email: row.email,
      phone: row.phone,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      emailVerified: Boolean(row.email_verified_at),
      phoneVerified: Boolean(row.phone_verified_at),
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,
      homes: homes.rows,
    };
  });

  app.patch('/me', async (request) => {
    const user = currentUser(request);
    const body = updateBody.parse(request.body);
    if (Object.keys(body).length === 0) throw ApiError.badRequest('No fields to update');

    const row = await queryOne<{ id: string; display_name: string; avatar_url: string | null }>(
      `UPDATE users
          SET display_name = COALESCE($2, display_name),
              avatar_url   = CASE WHEN $3::boolean THEN $4 ELSE avatar_url END
        WHERE id = $1
        RETURNING id, display_name, avatar_url`,
      [
        user.id,
        body.displayName ?? null,
        Object.prototype.hasOwnProperty.call(body, 'avatarUrl'),
        body.avatarUrl ?? null,
      ],
    );

    await audit({ userId: user.id, action: 'profile.update' });
    return { id: row!.id, displayName: row!.display_name, avatarUrl: row!.avatar_url };
  });

  app.post('/me/password', async (request) => {
    const user = currentUser(request);
    const body = passwordBody.parse(request.body);

    const row = await queryOne<{ password_hash: string | null }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [user.id],
    );
    // Phone-only accounts have no password to change or verify against.
    if (!row?.password_hash) {
      throw ApiError.badRequest('This account signs in by phone and has no password set');
    }
    if (!(await verifyPassword(body.currentPassword, row.password_hash))) {
      throw ApiError.unauthorized('Current password is incorrect');
    }

    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      user.id,
      await hashPassword(body.newPassword),
    ]);
    // Force every other device to sign in again with the new password.
    const revoked = await revokeAllSessions(user.id);
    await audit({ userId: user.id, action: 'profile.password_change', metadata: { revoked } });

    return { ok: true, sessionsRevoked: revoked };
  });

  app.delete('/me', async (request) => {
    const user = currentUser(request);
    const { password } = z.object({ password: z.string().min(1) }).parse(request.body);

    const row = await queryOne<{ password_hash: string | null }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [user.id],
    );
    // A phone-only account cannot confirm with a password it never had, so it
    // confirms by re-proving the number instead.
    if (!row?.password_hash) {
      throw ApiError.badRequest(
        'This account signs in by phone — confirm deletion with a fresh OTP via /api/auth/otp/request',
      );
    }
    if (!(await verifyPassword(password, row.password_hash))) {
      throw ApiError.unauthorized('Password is incorrect');
    }

    // Homes where this user is the only owner would be orphaned by the delete.
    const orphans = await query<{ id: string; name: string }>(
      `SELECT h.id, h.name
         FROM homes h
         JOIN home_members m ON m.home_id = h.id AND m.user_id = $1 AND m.role = 'owner'
        WHERE NOT EXISTS (
          SELECT 1 FROM home_members o
           WHERE o.home_id = h.id AND o.user_id <> $1 AND o.role = 'owner'
        )`,
      [user.id],
    );

    await audit({
      userId: user.id,
      action: 'profile.delete',
      metadata: { homesDeleted: orphans.rows.map((home) => home.name) },
    });
    await revokeAllSessions(user.id);
    // Homes cascade from the membership rows they own via ON DELETE CASCADE.
    for (const home of orphans.rows) {
      await query('DELETE FROM homes WHERE id = $1', [home.id]);
    }
    await query('DELETE FROM users WHERE id = $1', [user.id]);

    return { ok: true, homesDeleted: orphans.rows.length };
  });
}
