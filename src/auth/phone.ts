/**
 * Phone number handling, kept pure and separate so it is testable and so the
 * normalisation rule lives in exactly one place — a number stored two ways is
 * two accounts for the same person.
 */

export class InvalidPhoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPhoneError';
  }
}

/**
 * Reduces user input to digits-only E.164 (no '+', no separators).
 *
 * Deliberately does not guess a country: "9876543210" could be from anywhere,
 * and silently prefixing a default dial code would let two different people
 * collide on one account. Callers that need a default should apply it before
 * calling this.
 */
export function normalisePhone(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) throw new InvalidPhoneError('Phone number is required');

  // Keep a leading + only to detect it; strip everything non-numeric after.
  const hadPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');

  if (digits.length < 6) throw new InvalidPhoneError('Phone number is too short');
  if (digits.length > 15) throw new InvalidPhoneError('Phone number is too long'); // E.164 max

  // A leading 00 is the international prefix; E.164 does not carry it.
  const trimmed = !hadPlus && digits.startsWith('00') ? digits.slice(2) : digits;
  if (trimmed.length < 6) throw new InvalidPhoneError('Phone number is too short');

  return trimmed;
}

/** Display form: +<digits>. */
export function formatPhone(normalised: string): string {
  return `+${normalised}`;
}

/** Masked for logs and responses — never echo a full number back. */
export function maskPhone(normalised: string): string {
  if (normalised.length <= 4) return '*'.repeat(normalised.length);
  return `${'*'.repeat(normalised.length - 4)}${normalised.slice(-4)}`;
}
