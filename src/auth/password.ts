import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number },
) => Promise<Buffer>;

/**
 * scrypt in the same `scrypt$N$salt$hash` shape the MQTT broker uses for its
 * own principals, so one credential format covers both systems and neither
 * needs a native dependency.
 */
const COST = 16384; // N — ~16 MB, ~50-100ms per hash
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, { N: COST });
  return `scrypt$${COST}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;

  const cost = Number(parts[1]);
  const salt = Buffer.from(parts[2]!, 'hex');
  const expected = Buffer.from(parts[3]!, 'hex');
  if (!Number.isInteger(cost) || cost <= 0 || salt.length === 0 || expected.length === 0) {
    return false;
  }

  const derived = await scrypt(password, salt, expected.length, { N: cost });
  // Constant-time: a length-dependent early return would leak the key length.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** URL-safe secret for verification links and device credentials. */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
