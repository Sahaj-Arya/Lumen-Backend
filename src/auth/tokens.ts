import { createHash, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

import { config } from '../config.js';
import { ApiError } from '../errors.js';
import { keys, redis } from '../redis/index.js';

/**
 * Access tokens are stateless JWTs with a short TTL. Refresh tokens are opaque
 * random strings held in Redis and rotated on every use — so a stolen refresh
 * token is usable at most once, and reuse of an already-rotated token revokes
 * the whole family.
 */

const secret = new TextEncoder().encode(config.JWT_SECRET);
const ISSUER = 'lumen-iot';

export interface AccessClaims {
  sub: string;
  email: string;
  jti: string;
}

export async function signAccessToken(userId: string, email: string): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setJti(randomUUID())
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, audience: ISSUER });
    if (!payload.sub) throw new Error('missing subject');
    return { sub: payload.sub, email: String(payload.email ?? ''), jti: String(payload.jti ?? '') };
  } catch {
    throw ApiError.unauthorized('Access token is invalid or expired');
  }
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface RefreshRecord {
  userId: string;
  family: string;
  issuedAt: number;
}

/**
 * @param family groups the tokens descended from one login, so reuse detection
 *               can revoke every descendant at once.
 */
export async function issueRefreshToken(userId: string, family: string = randomUUID()): Promise<string> {
  const token = `${family}.${randomUUID()}`;
  const record: RefreshRecord = { userId, family, issuedAt: Date.now() };

  const key = keys.refreshToken(hashToken(token));
  await redis
    .multi()
    .set(key, JSON.stringify(record), 'EX', config.REFRESH_TOKEN_TTL_SECONDS)
    // Index by user so "log out everywhere" and account disable can sweep them.
    .sadd(keys.userSessions(userId), hashToken(token))
    .expire(keys.userSessions(userId), config.REFRESH_TOKEN_TTL_SECONDS)
    .exec();

  return token;
}

/** Consumes a refresh token and returns its replacement. */
export async function rotateRefreshToken(
  token: string,
): Promise<{ userId: string; refreshToken: string }> {
  const hashed = hashToken(token);
  const key = keys.refreshToken(hashed);
  const raw = await redis.get(key);

  if (!raw) {
    // Unknown or already-used token. If it parses as one of ours, treat it as
    // theft of a rotated token and drop the whole family.
    const family = token.split('.')[0];
    if (family) await revokeFamily(family);
    throw ApiError.unauthorized('Refresh token is invalid or has already been used');
  }

  const record = JSON.parse(raw) as RefreshRecord;
  await redis.multi().del(key).srem(keys.userSessions(record.userId), hashed).exec();

  const refreshToken = await issueRefreshToken(record.userId, record.family);
  return { userId: record.userId, refreshToken };
}

export async function revokeRefreshToken(token: string): Promise<void> {
  const hashed = hashToken(token);
  const raw = await redis.get(keys.refreshToken(hashed));
  await redis.del(keys.refreshToken(hashed));
  if (raw) {
    const record = JSON.parse(raw) as RefreshRecord;
    await redis.srem(keys.userSessions(record.userId), hashed);
  }
}

/** Revoke every session for a user (password change, disable, log out all). */
export async function revokeAllSessions(userId: string): Promise<number> {
  const setKey = keys.userSessions(userId);
  const hashes = await redis.smembers(setKey);
  if (hashes.length === 0) return 0;
  await redis.del(...hashes.map(keys.refreshToken), setKey);
  return hashes.length;
}

async function revokeFamily(family: string): Promise<void> {
  // Families are small; a targeted scan beats keeping another index.
  const stream = redis.scanStream({ match: keys.refreshToken('*'), count: 200 });
  const doomed: string[] = [];
  for await (const batch of stream) {
    for (const key of batch as string[]) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const record = JSON.parse(raw) as RefreshRecord;
      if (record.family === family) doomed.push(key);
    }
  }
  if (doomed.length) await redis.del(...doomed);
}
