import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../errors.js';
import { config } from '../config.js';
import { generateSecret, hashPassword, verifyPassword } from '../auth/password.js';
import {
  issueRefreshToken,
  revokeAllSessions,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
} from '../auth/tokens.js';
import { currentUser, requireAuth } from '../auth/guard.js';
import { formatPhone, maskPhone, normalisePhone } from '../auth/phone.js';
import { requestOtp, verifyOtp } from '../auth/otp.js';
import { query, queryOne, transaction } from '../db/index.js';
import { keys, redis } from '../redis/index.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../mail/index.js';
import { audit } from '../services/audit.js';

const EMAIL = z.string().trim().toLowerCase().email().max(254);
// Length beats composition rules: a 12-char passphrase resists guessing better
// than "P@ss1" and users do not work around it.
const PASSWORD = z.string().min(12, 'Password must be at least 12 characters').max(200);

const signupBody = z.object({
  email: EMAIL,
  password: PASSWORD,
  displayName: z.string().trim().min(1).max(80).optional(),
});

const loginBody = z.object({ email: EMAIL, password: z.string().min(1).max(200) });
const refreshBody = z.object({ refreshToken: z.string().min(1) });

const TOKEN_TTL = { email_verify: 24 * 60 * 60 * 1000, password_reset: 60 * 60 * 1000 };
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

async function issueUserToken(
  userId: string,
  purpose: 'email_verify' | 'password_reset',
): Promise<string> {
  const token = generateSecret(32);
  // One live token per purpose: issuing a new one invalidates the last.
  await query('DELETE FROM user_tokens WHERE user_id = $1 AND purpose = $2', [userId, purpose]);
  await query(
    `INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, purpose, hashToken(token), new Date(Date.now() + TOKEN_TTL[purpose])],
  );
  return token;
}

/** Throttle by key; throws 429 past the limit. */
async function throttle(key: string, limit: number, windowSeconds: number): Promise<void> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  if (count > limit) throw ApiError.tooMany();
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ─────────────────────────── signup ───────────────────────────
  app.post('/signup', async (request, reply) => {
    const body = signupBody.parse(request.body);
    await throttle(keys.signupAttempts(request.ip), 10, 3600);

    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM users WHERE email_normalised = $1',
      [body.email],
    );
    // Deliberately explicit: hiding this only pushes the disclosure into the
    // login and reset flows, and the friction of a confusing signup is worse.
    if (existing) throw ApiError.conflict('An account with that email already exists');

    const passwordHash = await hashPassword(body.password);

    const user = await transaction(async (client) => {
      const inserted = await client.query<{ id: string; email: string }>(
        `INSERT INTO users (email, email_normalised, password_hash, display_name)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email`,
        [body.email, body.email, passwordHash, body.displayName ?? body.email.split('@')[0]],
      );
      const row = inserted.rows[0]!;

      // Every account starts with a home, so the app never has to handle a
      // "you belong to nothing" state.
      const home = await client.query<{ id: string }>(
        'INSERT INTO homes (name, created_by) VALUES ($1, $2) RETURNING id',
        ['My Home', row.id],
      );
      await client.query(
        `INSERT INTO home_members (home_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [home.rows[0]!.id, row.id],
      );
      return row;
    });

    const token = await issueUserToken(user.id, 'email_verify');
    await sendVerificationEmail(user.email, token);
    await audit({ userId: user.id, action: 'auth.signup', ip: request.ip });

    return reply.status(201).send({
      user: { id: user.id, email: user.email },
      emailVerificationRequired: config.REQUIRE_EMAIL_VERIFICATION,
      message: 'Account created. Check your email to verify the address.',
    });
  });

  // ──────────────────────── verify email ────────────────────────
  const verify = async (token: string) => {
    const row = await queryOne<{ id: string; user_id: string; expires_at: Date; consumed_at: Date | null }>(
      `SELECT id, user_id, expires_at, consumed_at
         FROM user_tokens
        WHERE token_hash = $1 AND purpose = 'email_verify'`,
      [hashToken(token)],
    );
    if (!row || row.consumed_at || row.expires_at < new Date()) {
      throw ApiError.badRequest('Verification link is invalid or expired');
    }
    await query('UPDATE user_tokens SET consumed_at = now() WHERE id = $1', [row.id]);
    await query('UPDATE users SET email_verified_at = now() WHERE id = $1', [row.user_id]);
    await audit({ userId: row.user_id, action: 'auth.email_verified' });
  };

  // GET so the link in the email is clickable; POST for the app to call.
  app.get('/verify-email', async (request, reply) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(request.query);
    await verify(token);
    return reply.type('text/html').send(
      '<!doctype html><meta charset="utf-8"><title>Email verified</title>' +
        '<body style="font-family:system-ui;padding:3rem;text-align:center">' +
        '<h1>Email verified</h1><p>You can close this tab and sign in.</p>',
    );
  });

  app.post('/verify-email', async (request) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(request.body);
    await verify(token);
    return { verified: true };
  });

  app.post('/resend-verification', { preHandler: requireAuth }, async (request) => {
    const user = currentUser(request);
    if (!user.email) return { sent: false, reason: 'no_email_on_account' };
    if (user.emailVerifiedAt) return { sent: false, reason: 'already_verified' };

    await throttle(keys.verifyResend(user.id), 3, 3600);
    const token = await issueUserToken(user.id, 'email_verify');
    await sendVerificationEmail(user.email, token);
    return { sent: true };
  });

  // ──────────────────────────── login ───────────────────────────
  app.post('/login', async (request) => {
    const body = loginBody.parse(request.body);
    // Per-account throttle, so one target cannot be sprayed from many IPs.
    await throttle(keys.loginAttempts(body.email), 10, 900);

    const user = await queryOne<{
      id: string;
      email: string;
      password_hash: string;
      display_name: string;
      email_verified_at: Date | null;
      disabled_at: Date | null;
    }>(
      `SELECT id, email, password_hash, display_name, email_verified_at, disabled_at
         FROM users WHERE email_normalised = $1`,
      [body.email],
    );

    // Same message and comparable timing whether the account exists or the
    // password is wrong, so login cannot be used to enumerate addresses.
    const ok = user ? await verifyPassword(body.password, user.password_hash) : false;
    if (!user || !ok) {
      if (!user) await hashPassword(body.password); // burn equivalent time
      throw ApiError.unauthorized('Email or password is incorrect');
    }
    if (user.disabled_at) throw ApiError.forbidden('Account is disabled');
    if (config.REQUIRE_EMAIL_VERIFICATION && !user.email_verified_at) {
      throw new ApiError(403, 'email_unverified', 'Verify your email address before signing in');
    }

    await redis.del(keys.loginAttempts(body.email));
    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    await audit({ userId: user.id, action: 'auth.login', ip: request.ip });

    return {
      accessToken: await signAccessToken(user.id, user.email),
      refreshToken: await issueRefreshToken(user.id),
      expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        emailVerified: Boolean(user.email_verified_at),
      },
    };
  });

  // ─────────────────────────── refresh ──────────────────────────
  app.post('/refresh', async (request) => {
    const { refreshToken } = refreshBody.parse(request.body);
    const rotated = await rotateRefreshToken(refreshToken);

    const user = await queryOne<{ id: string; email: string; disabled_at: Date | null }>(
      'SELECT id, email, disabled_at FROM users WHERE id = $1',
      [rotated.userId],
    );
    if (!user || user.disabled_at) throw ApiError.unauthorized('Account is not active');

    return {
      accessToken: await signAccessToken(user.id, user.email),
      refreshToken: rotated.refreshToken,
      expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
    };
  });

  // ─────────────────────────── logout ───────────────────────────
  app.post('/logout', async (request) => {
    const { refreshToken } = refreshBody.parse(request.body);
    await revokeRefreshToken(refreshToken);
    return { ok: true };
  });

  app.post('/logout-all', { preHandler: requireAuth }, async (request) => {
    const user = currentUser(request);
    const revoked = await revokeAllSessions(user.id);
    await audit({ userId: user.id, action: 'auth.logout_all', metadata: { revoked } });
    return { ok: true, revoked };
  });

  // ────────────────────────── otp login ─────────────────────────
  /**
   * Step 1: ask for a code. Always answers the same way whether or not the
   * number has an account, so this cannot be used to test who is registered.
   */
  app.post('/otp/request', async (request) => {
    const body = z.object({ phone: z.string().min(1).max(32) }).parse(request.body);

    // Validate before the throttle: rejecting junk should not cost a Redis
    // round-trip, and a store outage should not turn a 400 into a 500.
    let phone: string;
    try {
      phone = normalisePhone(body.phone);
    } catch (error) {
      throw ApiError.badRequest((error as Error).message);
    }

    await throttle(keys.signupAttempts(request.ip), 20, 3600);
    const result = await requestOtp(phone);
    return {
      requestId: result.requestId,
      phone: maskPhone(phone),
      expiresInSeconds: result.expiresInSeconds,
      ...(result.debugCode ? { debugCode: result.debugCode } : {}),
    };
  });

  /**
   * Step 2: exchange the code for tokens. First sign-in creates the account and
   * its first home, so there is no separate phone signup route — possession of
   * the number is the whole registration.
   */
  app.post('/otp/verify', async (request) => {
    const body = z
      .object({ requestId: z.string().uuid(), code: z.string().min(4).max(8) })
      .parse(request.body);

    const phone = await verifyOtp(body.requestId, body.code);

    let user = await queryOne<{ id: string; email: string | null; disabled_at: Date | null }>(
      'SELECT id, email, disabled_at FROM users WHERE phone_normalised = $1',
      [phone],
    );
    let created = false;

    if (!user) {
      created = true;
      user = await transaction(async (client) => {
        const inserted = await client.query<{
          id: string;
          email: string | null;
          disabled_at: Date | null;
        }>(
          `INSERT INTO users (phone, phone_normalised, phone_verified_at, display_name)
           VALUES ($1, $2, now(), $3)
           RETURNING id, email, disabled_at`,
          [formatPhone(phone), phone, formatPhone(phone)],
        );
        const row = inserted.rows[0]!;

        // Same as email signup: never leave an account with no home.
        const home = await client.query<{ id: string }>(
          'INSERT INTO homes (name, created_by) VALUES ($1, $2) RETURNING id',
          ['My Home', row.id],
        );
        await client.query(
          `INSERT INTO home_members (home_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [home.rows[0]!.id, row.id],
        );
        return row;
      });
    }

    if (user.disabled_at) throw ApiError.forbidden('Account is disabled');

    await query(
      'UPDATE users SET last_login_at = now(), phone_verified_at = COALESCE(phone_verified_at, now()) WHERE id = $1',
      [user.id],
    );
    await audit({
      userId: user.id,
      action: created ? 'auth.otp_signup' : 'auth.otp_login',
      ip: request.ip,
    });

    return {
      accessToken: await signAccessToken(user.id, user.email ?? formatPhone(phone)),
      refreshToken: await issueRefreshToken(user.id),
      expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
      created,
      user: { id: user.id, phone: formatPhone(phone), email: user.email },
    };
  });

  // ─────────────────────── password reset ───────────────────────
  app.post('/forgot-password', async (request) => {
    const { email } = z.object({ email: EMAIL }).parse(request.body);
    const user = await queryOne<{ id: string; email: string }>(
      'SELECT id, email FROM users WHERE email_normalised = $1',
      [email],
    );
    if (user) {
      const token = await issueUserToken(user.id, 'password_reset');
      await sendPasswordResetEmail(user.email, token);
    }
    // Always the same answer: this endpoint is unauthenticated, so it must not
    // reveal whether an address is registered.
    return { ok: true, message: 'If that address has an account, a reset link is on its way.' };
  });

  app.post('/reset-password', async (request) => {
    const body = z
      .object({ token: z.string().min(1), password: PASSWORD })
      .parse(request.body);

    const row = await queryOne<{ id: string; user_id: string; expires_at: Date; consumed_at: Date | null }>(
      `SELECT id, user_id, expires_at, consumed_at
         FROM user_tokens WHERE token_hash = $1 AND purpose = 'password_reset'`,
      [hashToken(body.token)],
    );
    if (!row || row.consumed_at || row.expires_at < new Date()) {
      throw ApiError.badRequest('Reset link is invalid or expired');
    }

    await query('UPDATE user_tokens SET consumed_at = now() WHERE id = $1', [row.id]);
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      row.user_id,
      await hashPassword(body.password),
    ]);
    // A reset usually follows a compromise, so every existing session dies.
    await revokeAllSessions(row.user_id);
    await audit({ userId: row.user_id, action: 'auth.password_reset', ip: request.ip });

    return { ok: true };
  });
}
