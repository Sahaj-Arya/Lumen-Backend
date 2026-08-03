import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InvalidPhoneError, formatPhone, maskPhone, normalisePhone } from '../src/auth/phone.ts';

describe('normalisePhone', () => {
  it('reduces every written form of one number to the same key', () => {
    // All of these are the same phone; storing them differently would create
    // several accounts for one person.
    const forms = ['+91 98765 43210', '+919876543210', '+91-98765-43210', '0091 9876543210'];
    const normalised = forms.map(normalisePhone);
    assert.equal(new Set(normalised).size, 1, JSON.stringify(normalised));
    assert.equal(normalised[0], '919876543210');
  });

  it('keeps a plain national number as typed', () => {
    // No country is guessed: prefixing a default dial code would let two
    // different people collide on one account.
    assert.equal(normalisePhone('9876543210'), '9876543210');
  });

  it('strips the 00 international prefix only when there is no +', () => {
    assert.equal(normalisePhone('00919876543210'), '919876543210');
    // A leading + means the digits are already E.164; 00 there would be data.
    assert.equal(normalisePhone('+00919876543210'), '00919876543210');
  });

  it('rejects input that cannot be a phone number', () => {
    for (const bad of ['', '   ', '12345', 'abcdef', '1234567890123456']) {
      assert.throws(() => normalisePhone(bad), InvalidPhoneError, bad);
    }
  });

  it('accepts the E.164 length boundaries', () => {
    assert.equal(normalisePhone('123456').length, 6); // min
    assert.equal(normalisePhone('123456789012345').length, 15); // max
  });
});

describe('formatPhone / maskPhone', () => {
  it('formats for display', () => {
    assert.equal(formatPhone('919876543210'), '+919876543210');
  });

  it('masks all but the last four digits', () => {
    // Logs and API responses must never echo a full number back.
    assert.equal(maskPhone('919876543210'), '********3210');
    assert.equal(maskPhone('1234'), '****');
  });
});
