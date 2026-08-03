import { closePool, query, queryOne, transaction } from './index.js';
import { hashPassword } from '../auth/password.js';
import { logger } from '../logger.js';
import { migrate } from './migrate.js';

/**
 * Development seed: one verified account with a home, two rooms and two
 * devices, so the app has something to render before any hardware exists.
 * Idempotent — running it twice changes nothing.
 *
 *   npm run seed
 *   login: demo@lumeniot.local / demo-password-123
 */

const EMAIL = 'demo@lumeniot.local';
const PASSWORD = 'demo-password-123';

async function seed(): Promise<void> {
  await migrate();

  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM users WHERE email_normalised = $1',
    [EMAIL],
  );
  if (existing) {
    logger.info({ email: EMAIL }, 'seed user already present, nothing to do');
    return;
  }

  await transaction(async (client) => {
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (email, email_normalised, password_hash, display_name, email_verified_at)
       VALUES ($1, $2, $3, $4, now()) RETURNING id`,
      [EMAIL, EMAIL, await hashPassword(PASSWORD), 'Demo User'],
    );
    const userId = user.rows[0]!.id;

    const home = await client.query<{ id: string }>(
      'INSERT INTO homes (name, created_by) VALUES ($1, $2) RETURNING id',
      ['Demo Home', userId],
    );
    const homeId = home.rows[0]!.id;

    await client.query(
      `INSERT INTO home_members (home_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [homeId, userId],
    );

    const rooms = await client.query<{ id: string; name: string }>(
      `INSERT INTO device_groups (home_id, name, icon, sort_order)
       VALUES ($1, 'Living room', 'tv', 0), ($1, 'Bedroom', 'bed', 1)
       RETURNING id, name`,
      [homeId],
    );

    await client.query(
      `INSERT INTO devices (home_id, group_id, device_uid, name, type)
       VALUES ($1, $2, 'demo-lamp-01', 'Corner lamp', 'light'),
              ($1, $3, 'demo-sensor-01', 'Bedroom sensor', 'sensor')`,
      [homeId, rooms.rows[0]!.id, rooms.rows[1]!.id],
    );
  });

  logger.info({ email: EMAIL, password: PASSWORD }, 'seeded demo account');
}

seed()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error({ err: error }, 'seed failed');
    process.exit(1);
  });
