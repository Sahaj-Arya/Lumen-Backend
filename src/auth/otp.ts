import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import { ApiError } from '../errors.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { maskPhone } from './phone.js';
import { redis } from '../redis/index.js';

/**
 * One-time-code login.
 *
 * The delivery mechanism sits behind `OtpProvider` so swapping the current
 * static code for a real SMS gateway is a new provider plus a config value —
 * no route, schema or client change. Everything else about the flow (challenge
 * storage, expiry, attempt limits, resend cooldown, single use) is already the
 * shape a production flow needs, so only delivery is stubbed.
 */

export interface OtpProvider {
  readonly name: string;
  /** Produce the code for this challenge. */
  generate(): string;
  /** Deliver it. Static provider does nothing; SMS provider calls the gateway. */
  deliver(phone: string, code: string): Promise<void>;
  /** True when the code is not secret and must not be treated as proof of anything. */
  readonly insecure: boolean;
}

/**
 * Development provider: one fixed code, accepted for every number.
 *
 * This means ANY caller can sign in as ANY phone number. It is a stand-in for
 * a real gateway, never a login mechanism — `assertProviderAllowed` refuses to
 * let it run in production without an explicit override.
 */
class StaticOtpProvider implements OtpProvider {
  readonly name = 'static';
  readonly insecure = true;

  generate(): string {
    return config.OTP_STATIC_CODE;
  }

  async deliver(phone: string, code: string): Promise<void> {
    logger.warn(
      { phone: maskPhone(phone), code },
      'static OTP provider: code is fixed and accepted for every number',
    );
  }
}

/**
 * Placeholder for the real gateway. Generates a genuine random code already, so
 * switching over is: implement `deliver`, set OTP_PROVIDER=sms.
 */
class SmsOtpProvider implements OtpProvider {
  readonly name = 'sms';
  readonly insecure = false;

  generate(): string {
    // Zero-padded so every code is the configured length.
    return String(randomInt(0, 10 ** config.OTP_CODE_LENGTH)).padStart(config.OTP_CODE_LENGTH, '0');
  }

  async deliver(phone: string, code: string): Promise<void> {
    void code;
    throw ApiError.unavailable(
      `SMS delivery is not configured yet (phone ${maskPhone(phone)}). ` +
        'Implement SmsOtpProvider.deliver or set OTP_PROVIDER=static.',
    );
  }
}

export function getProvider(): OtpProvider {
  return config.OTP_PROVIDER === 'sms' ? new SmsOtpProvider() : new StaticOtpProvider();
}

/**
 * Refuses to boot a production deployment on the fixed-code provider unless
 * someone has explicitly said so, because it authenticates nobody.
 */
export function assertProviderAllowed(): void {
  const provider = getProvider();
  if (provider.insecure && config.isProduction && !config.OTP_ALLOW_INSECURE_IN_PRODUCTION) {
    throw new Error(
      'OTP_PROVIDER=static accepts one fixed code for every phone number and cannot be used in ' +
        'production. Configure a real provider, or set OTP_ALLOW_INSECURE_IN_PRODUCTION=true to override.',
    );
  }
  if (provider.insecure) {
    logger.warn(
      { code: config.OTP_STATIC_CODE },
      'OTP is running on the static provider — any caller can sign in as any number',
    );
  }
}

// ── challenge storage ───────────────────────────────────────────────

interface Challenge {
  phone: string;
  codeHash: string;
  attempts: number;
  createdAt: number;
}

const challengeKey = (id: string) => `otp:challenge:${id}`;
const cooldownKey = (phone: string) => `otp:cooldown:${phone}`;
const requestCountKey = (phone: string) => `otp:requests:${phone}`;

// Codes are short and low-entropy, so the store holds only a hash. It costs
// nothing and means a Redis dump never yields a usable credential.
const hashCode = (phone: string, code: string) =>
  createHash('sha256').update(`${phone}:${code}`).digest('hex');

export interface OtpRequestResult {
  requestId: string;
  expiresInSeconds: number;
  /** Present only on the insecure provider, so a dev client can auto-fill. */
  debugCode?: string;
}

export async function requestOtp(phone: string): Promise<OtpRequestResult> {
  const provider = getProvider();

  // Resend cooldown: stops a caller pumping SMS at someone else's phone.
  const cooling = await redis.set(
    cooldownKey(phone),
    '1',
    'EX',
    config.OTP_RESEND_COOLDOWN_SECONDS,
    'NX',
  );
  if (cooling === null) {
    const wait = await redis.ttl(cooldownKey(phone));
    throw ApiError.tooMany(`Wait ${Math.max(wait, 1)}s before requesting another code`);
  }

  // Hourly ceiling per number, on top of the per-request cooldown.
  const count = await redis.incr(requestCountKey(phone));
  if (count === 1) await redis.expire(requestCountKey(phone), 3600);
  if (count > config.OTP_MAX_REQUESTS_PER_HOUR) {
    throw ApiError.tooMany('Too many codes requested for this number, try again later');
  }

  const code = provider.generate();
  const requestId = randomUUID();
  const challenge: Challenge = {
    phone,
    codeHash: hashCode(phone, code),
    attempts: 0,
    createdAt: Date.now(),
  };

  await redis.set(
    challengeKey(requestId),
    JSON.stringify(challenge),
    'EX',
    config.OTP_TTL_SECONDS,
  );
  await provider.deliver(phone, code);

  return {
    requestId,
    expiresInSeconds: config.OTP_TTL_SECONDS,
    // Returned only because the code is already public knowledge on this
    // provider; a real provider must never echo it.
    ...(provider.insecure ? { debugCode: code } : {}),
  };
}

/**
 * Consumes a challenge. Returns the phone it belongs to.
 *
 * Single use: the challenge is deleted on success, so a captured code cannot be
 * replayed. Wrong guesses burn an attempt and the challenge dies at the limit
 * rather than allowing an unbounded brute force against a 6-digit code.
 */
export async function verifyOtp(requestId: string, code: string): Promise<string> {
  const key = challengeKey(requestId);
  const raw = await redis.get(key);
  if (!raw) throw ApiError.badRequest('That code has expired — request a new one');

  const challenge = JSON.parse(raw) as Challenge;

  const expected = Buffer.from(challenge.codeHash, 'hex');
  const actual = Buffer.from(hashCode(challenge.phone, String(code).trim()), 'hex');
  const matches = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!matches) {
    challenge.attempts += 1;
    if (challenge.attempts >= config.OTP_MAX_ATTEMPTS) {
      await redis.del(key);
      throw ApiError.badRequest('Too many incorrect attempts — request a new code');
    }
    // Preserve the original expiry rather than extending it on a wrong guess.
    const ttl = await redis.ttl(key);
    await redis.set(key, JSON.stringify(challenge), 'EX', Math.max(ttl, 1));
    throw ApiError.badRequest('That code is not correct');
  }

  await redis.del(key);
  await redis.del(cooldownKey(challenge.phone));
  return challenge.phone;
}
