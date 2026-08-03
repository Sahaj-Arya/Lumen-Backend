-- Phone + OTP as a first-class identity alongside email + password.
--
-- A user now needs at least one of the two identities, not both: someone who
-- signs in by phone has no email and no password hash, and someone who signed
-- up by email has no phone. Either may later add the other.

ALTER TABLE users ADD COLUMN phone TEXT;
-- Digits-only E.164 form (no '+', no spaces) so lookups are exact.
ALTER TABLE users ADD COLUMN phone_normalised TEXT;
ALTER TABLE users ADD COLUMN phone_verified_at TIMESTAMPTZ;

-- Postgres allows many NULLs in a unique index, so this stays correct for the
-- email-only users that already exist.
CREATE UNIQUE INDEX users_phone_normalised_key ON users (phone_normalised);

-- Email and password become optional; a phone-only account has neither.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN email_normalised DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- ...but an account with no identity at all could never be signed into again.
ALTER TABLE users
  ADD CONSTRAINT users_needs_an_identity
  CHECK (email_normalised IS NOT NULL OR phone_normalised IS NOT NULL);

-- An email login needs a password to check; a phone login does not.
ALTER TABLE users
  ADD CONSTRAINT users_email_login_needs_password
  CHECK (email_normalised IS NULL OR password_hash IS NOT NULL);
