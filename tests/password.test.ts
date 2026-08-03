import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateSecret, hashPassword, verifyPassword } from '../src/auth/password.ts';

describe('password hashing', () => {
  it('round-trips a password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.ok(await verifyPassword('correct horse battery staple', hash));
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('Correct horse battery staple', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });

  it('salts, so equal passwords hash differently', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')]);
    assert.notEqual(a, b);
    assert.ok(await verifyPassword('same-password', a));
    assert.ok(await verifyPassword('same-password', b));
  });

  it('uses the broker’s scrypt$N$salt$hash format', async () => {
    // One credential format across the API and the MQTT broker's users.json.
    const hash = await hashPassword('whatever');
    const parts = hash.split('$');
    assert.equal(parts.length, 4);
    assert.equal(parts[0], 'scrypt');
    assert.equal(Number(parts[1]), 16384);
  });

  it('refuses malformed stored hashes instead of throwing', async () => {
    for (const bad of ['', 'garbage', 'scrypt$16384$onlythree', 'bcrypt$1$2$3']) {
      assert.equal(await verifyPassword('x', bad), false, bad);
    }
  });
});

describe('generateSecret', () => {
  it('is url-safe and unique', () => {
    const a = generateSecret(18);
    const b = generateSecret(18);
    assert.notEqual(a, b);
    assert.match(a, /^[A-Za-z0-9_-]+$/);
  });
});
