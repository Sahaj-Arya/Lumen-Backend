import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

/**
 * The interesting OTP behaviour lives in its interaction with the challenge
 * store — single use, attempt limits, expiry that a wrong guess must not
 * extend. Those cannot be tested purely, so Redis is replaced with an
 * in-memory stand-in that implements the handful of commands used.
 *
 * Imports the built output rather than src: module mocking bypasses Node's
 * .js -> .ts resolution, and this also exercises the artifact that ships.
 * `pretest` builds first.
 */

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_SECRET ??= 'test-secret-that-is-definitely-long-enough-32';
process.env.LOG_LEVEL ??= 'silent';
process.env.OTP_PROVIDER ??= 'static';
process.env.OTP_STATIC_CODE ??= '111111';
process.env.OTP_MAX_ATTEMPTS ??= '3';
process.env.OTP_RESEND_COOLDOWN_SECONDS ??= '30';

/** Minimal in-memory Redis: only the commands otp.ts actually issues. */
class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  private live(key: string) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async get(key: string) {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]) {
    const flags = args.map(String);
    const exIndex = flags.findIndex((flag) => flag.toUpperCase() === 'EX');
    const ttl = exIndex >= 0 ? Number(flags[exIndex + 1]) : null;
    const nx = flags.some((flag) => flag.toUpperCase() === 'NX');

    if (nx && this.live(key)) return null;
    this.store.set(key, { value, expiresAt: ttl === null ? null : Date.now() + ttl * 1000 });
    return 'OK';
  }

  async del(...keys: string[]) {
    let removed = 0;
    for (const key of keys) if (this.store.delete(key)) removed += 1;
    return removed;
  }

  async ttl(key: string) {
    const entry = this.live(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.ceil((entry.expiresAt - Date.now()) / 1000);
  }

  async incr(key: string) {
    const next = Number((await this.get(key)) ?? 0) + 1;
    const existing = this.live(key);
    this.store.set(key, { value: String(next), expiresAt: existing?.expiresAt ?? null });
    return next;
  }

  async expire(key: string, seconds: number) {
    const entry = this.live(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  /** Test helper: drop the resend cooldown so a case can request again. */
  clearCooldowns() {
    for (const key of [...this.store.keys()]) {
      if (key.startsWith('otp:cooldown:') || key.startsWith('otp:requests:')) {
        this.store.delete(key);
      }
    }
  }

  /** Test helper: force a key to look expired. */
  expireNow(prefix: string) {
    for (const [key, entry] of this.store) {
      if (key.startsWith(prefix)) entry.expiresAt = Date.now() - 1;
    }
  }
}

const fake = new FakeRedis();

// Top-level await, not a before() hook: the mock has to be installed before the
// module under test is ever imported, and hooks run after imports resolve.
mock.module('../dist/redis/index.js', {
  namedExports: {
    redis: fake,
    publisher: fake,
    subscriber: fake,
    CHANNEL_DEVICE_UPDATE: 'test',
    keys: {},
    closeRedis: async () => {},
  },
});

const { requestOtp, verifyOtp } = await import('../dist/auth/otp.js');

const PHONE = '919876543210';

describe('OTP challenge flow', () => {
  it('issues a challenge and accepts the static code', async () => {
    fake.clearCooldowns();
    const challenge = await requestOtp(PHONE);

    assert.ok(challenge.requestId);
    assert.equal(challenge.debugCode, '111111'); // echoed only on the insecure provider
    assert.equal(await verifyOtp(challenge.requestId, '111111'), PHONE);
  });

  it('is single use — a captured code cannot be replayed', async () => {
    fake.clearCooldowns();
    const challenge = await requestOtp(PHONE);
    await verifyOtp(challenge.requestId, '111111');

    await assert.rejects(
      () => verifyOtp(challenge.requestId, '111111'),
      /expired/i,
      'a consumed challenge must not verify twice',
    );
  });

  it('rejects a wrong code without consuming the challenge', async () => {
    fake.clearCooldowns();
    const challenge = await requestOtp(PHONE);

    await assert.rejects(() => verifyOtp(challenge.requestId, '000000'), /not correct/i);
    // The real code still works after one wrong guess.
    assert.equal(await verifyOtp(challenge.requestId, '111111'), PHONE);
  });

  it('kills the challenge after the attempt limit', async () => {
    fake.clearCooldowns();
    const challenge = await requestOtp(PHONE);

    // OTP_MAX_ATTEMPTS=3: two rejections, the third ends it.
    await assert.rejects(() => verifyOtp(challenge.requestId, '000000'), /not correct/i);
    await assert.rejects(() => verifyOtp(challenge.requestId, '000001'), /not correct/i);
    await assert.rejects(() => verifyOtp(challenge.requestId, '000002'), /Too many/i);

    // Even the correct code is dead now — no unbounded brute force.
    await assert.rejects(() => verifyOtp(challenge.requestId, '111111'), /expired/i);
  });

  it('does not extend the expiry on a wrong guess', async () => {
    fake.clearCooldowns();
    const challenge = await requestOtp(PHONE);
    const before = await fake.ttl(`otp:challenge:${challenge.requestId}`);

    await assert.rejects(() => verifyOtp(challenge.requestId, '000000'), /not correct/i);
    const after = await fake.ttl(`otp:challenge:${challenge.requestId}`);

    assert.ok(after <= before, `ttl grew from ${before} to ${after}`);
  });

  it('rejects an expired challenge', async () => {
    fake.clearCooldowns();
    const challenge = await requestOtp(PHONE);
    fake.expireNow('otp:challenge:');

    await assert.rejects(() => verifyOtp(challenge.requestId, '111111'), /expired/i);
  });

  it('rejects an unknown request id', async () => {
    await assert.rejects(
      () => verifyOtp('00000000-0000-0000-0000-000000000000', '111111'),
      /expired/i,
    );
  });

  it('enforces the resend cooldown', async () => {
    fake.clearCooldowns();
    await requestOtp(PHONE);
    // Second request inside the window must be refused, so nobody can pump
    // messages at someone else's phone.
    await assert.rejects(() => requestOtp(PHONE), /Wait/i);
  });
});
