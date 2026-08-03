import type { FastifyReply, FastifyRequest } from 'fastify';

import { ApiError } from '../errors.js';
import { queryOne } from '../db/index.js';
import { verifyAccessToken } from './tokens.js';

export interface AuthUser {
  id: string;
  /** Null on phone-only accounts. */
  email: string | null;
  displayName: string;
  emailVerifiedAt: Date | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

function bearer(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw ApiError.unauthorized();
  return header.slice('Bearer '.length).trim();
}

/**
 * Verifies the access token and reloads the user, so a disabled account stops
 * working immediately rather than at token expiry.
 */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const claims = await verifyAccessToken(bearer(request));

  const user = await queryOne<{
    id: string;
    email: string | null;
    display_name: string;
    email_verified_at: Date | null;
    disabled_at: Date | null;
  }>(
    `SELECT id, email, display_name, email_verified_at, disabled_at
       FROM users WHERE id = $1`,
    [claims.sub],
  );

  if (!user) throw ApiError.unauthorized('Account no longer exists');
  if (user.disabled_at) throw ApiError.forbidden('Account is disabled');

  request.user = {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    emailVerifiedAt: user.email_verified_at,
  };
}

export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw ApiError.unauthorized();
  return request.user;
}

export type HomeRole = 'owner' | 'admin' | 'member' | 'viewer';

// Ascending privilege. A check passes when the member's rank is at least the
// required one.
const RANK: Record<HomeRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/**
 * Every authorisation decision in the app funnels through here: a row is
 * reachable only via the home that owns it.
 */
export async function requireHomeRole(
  userId: string,
  homeId: string,
  minimum: HomeRole = 'viewer',
): Promise<HomeRole> {
  const row = await queryOne<{ role: HomeRole }>(
    'SELECT role FROM home_members WHERE home_id = $1 AND user_id = $2',
    [homeId, userId],
  );
  // 404 rather than 403 for non-members: a stranger should not be able to probe
  // which home ids exist.
  if (!row) throw ApiError.notFound('Home not found');
  if (RANK[row.role] < RANK[minimum]) {
    throw ApiError.forbidden(`This action requires the ${minimum} role`);
  }
  return row.role;
}

/** Resolves a device the user may see, with the caller's role on its home. */
export async function requireDeviceAccess(
  userId: string,
  deviceId: string,
  minimum: HomeRole = 'viewer',
): Promise<{ deviceUid: string; homeId: string; role: HomeRole }> {
  const device = await queryOne<{ id: string; device_uid: string; home_id: string }>(
    'SELECT id, device_uid, home_id FROM devices WHERE id = $1',
    [deviceId],
  );
  if (!device) throw ApiError.notFound('Device not found');
  const role = await requireHomeRole(userId, device.home_id, minimum);
  return { deviceUid: device.device_uid, homeId: device.home_id, role };
}
