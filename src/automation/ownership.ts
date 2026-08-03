import { query, queryOne } from '../db/index.js';

/**
 * An automation acts on hardware on its owner's behalf, so the owner's access
 * is re-checked every time it fires — not only when the rule was written.
 *
 * Membership changes after a rule is created: someone leaves a shared home, or
 * is demoted to viewer. A rule authored while they had access must stop acting
 * at that moment, otherwise a removed housemate keeps commanding the lights.
 */

export type HomeRole = 'owner' | 'admin' | 'member' | 'viewer';

const RANK: Record<HomeRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export type OwnerCheck =
  | { ok: true }
  | { ok: false; reason: 'no_owner' | 'owner_left_home' | 'owner_read_only' | 'device_not_owned' };

/**
 * May this rule still act?
 *
 * @param ownerId    the rule's owner, null once their account is deleted
 * @param homeId     the home the rule belongs to
 * @param deviceIds  every device the rule commands
 */
export async function ownerMayActuate(
  ownerId: string | null,
  homeId: string,
  deviceIds: string[],
): Promise<OwnerCheck> {
  if (!ownerId) return { ok: false, reason: 'no_owner' };

  const membership = await queryOne<{ role: HomeRole }>(
    'SELECT role FROM home_members WHERE home_id = $1 AND user_id = $2',
    [homeId, ownerId],
  );
  if (!membership) return { ok: false, reason: 'owner_left_home' };
  // Viewers may watch but never actuate — the same rule the API enforces for a
  // manual command, applied to the automated path.
  if (RANK[membership.role] < RANK.member) return { ok: false, reason: 'owner_read_only' };

  if (deviceIds.length === 0) return { ok: true };

  // Every target must sit in a home the owner is still a member of. Checking
  // against the rule's own home is not enough on its own, but it is the cheap
  // common case and this generalises it.
  const reachable = await query<{ id: string }>(
    `SELECT d.id FROM devices d
       JOIN home_members m ON m.home_id = d.home_id AND m.user_id = $1
      WHERE d.id = ANY($2::uuid[])`,
    [ownerId, deviceIds],
  );
  if (reachable.rowCount !== new Set(deviceIds).size) {
    return { ok: false, reason: 'device_not_owned' };
  }

  return { ok: true };
}
