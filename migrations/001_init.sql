-- Core identity, tenancy and device model.
--
-- Tenancy shape: a user owns or belongs to homes; a home holds groups (rooms)
-- and devices. Every authorisation check resolves to "is this user a member of
-- the home that owns this row", which keeps the rules in one place.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────── users ───────────────────────────────
CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT NOT NULL,
  -- Case-insensitive uniqueness without depending on the citext extension.
  email_normalised  TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  display_name      TEXT NOT NULL DEFAULT '',
  avatar_url        TEXT,
  email_verified_at TIMESTAMPTZ,
  last_login_at     TIMESTAMPTZ,
  disabled_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_normalised_key ON users (email_normalised);

-- Single-use tokens for email verification and password reset. Only the hash
-- is stored, so a database leak cannot be replayed against the endpoints.
CREATE TABLE user_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('email_verify', 'password_reset')),
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_tokens_hash_key ON user_tokens (token_hash);
CREATE INDEX user_tokens_user_purpose_idx ON user_tokens (user_id, purpose);

-- ─────────────────────────────── homes ───────────────────────────────
CREATE TABLE homes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  timezone   TEXT NOT NULL DEFAULT 'UTC',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE home_members (
  home_id   UUID NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (home_id, user_id)
);
CREATE INDEX home_members_user_idx ON home_members (user_id);

-- ─────────────────────────── groups (rooms) ──────────────────────────
CREATE TABLE device_groups (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id    UUID NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  icon       TEXT NOT NULL DEFAULT 'home',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX device_groups_home_idx ON device_groups (home_id);
CREATE UNIQUE INDEX device_groups_home_name_key ON device_groups (home_id, lower(name));

-- ────────────────────────────── devices ──────────────────────────────
-- `device_uid` is the MQTT principal id — the <id> in devices/<id>/… — so it
-- is unique platform-wide, not per home.
CREATE TABLE devices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id        UUID NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  group_id       UUID REFERENCES device_groups(id) ON DELETE SET NULL,
  device_uid     TEXT NOT NULL,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'generic',
  manufacturer   TEXT NOT NULL DEFAULT '',
  model          TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',
  favourite      BOOLEAN NOT NULL DEFAULT false,
  -- Credential issued for the device's own broker principal. Only the scrypt
  -- hash is kept; the plaintext is shown once at provisioning time.
  mqtt_password_hash TEXT,
  credential_issued_at TIMESTAMPTZ,
  -- Last known presence, maintained by the MQTT bridge.
  status         TEXT NOT NULL DEFAULT 'unknown'
                 CHECK (status IN ('online', 'offline', 'stale', 'unknown')),
  status_source  TEXT NOT NULL DEFAULT 'unknown'
                 CHECK (status_source IN ('status_topic', 'inferred', 'unknown')),
  last_seen_at   TIMESTAMPTZ,
  last_live_at   TIMESTAMPTZ,
  -- Capabilities the device advertises on devices/<id>/meta.
  capabilities   JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX devices_uid_key ON devices (device_uid);
CREATE INDEX devices_home_idx ON devices (home_id);
CREATE INDEX devices_group_idx ON devices (group_id);

-- Latest value per reading key. Postgres holds the durable copy; Redis caches
-- it for reads. One row per (device, key) — history lives in device_readings.
CREATE TABLE device_state (
  device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  retained    BOOLEAN NOT NULL DEFAULT false,
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (device_id, key)
);

-- Append-only history. BRIN suits a table written in timestamp order and keeps
-- the index tiny compared with a btree at telemetry volumes.
CREATE TABLE device_readings (
  device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  numeric_value DOUBLE PRECISION,
  recorded_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX device_readings_time_brin ON device_readings USING BRIN (recorded_at);
CREATE INDEX device_readings_device_key_time_idx
  ON device_readings (device_id, key, recorded_at DESC);

-- Commands the API published, with the outcome. Audit trail for "who turned
-- the lights off at 3am".
CREATE TABLE device_commands (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  issued_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  payload     JSONB NOT NULL,
  topic       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX device_commands_device_time_idx ON device_commands (device_id, created_at DESC);

-- ─────────────────────────────── audit ───────────────────────────────
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  home_id     UUID REFERENCES homes(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  subject     TEXT,
  metadata    JSONB,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_user_time_idx ON audit_log (user_id, created_at DESC);
CREATE INDEX audit_log_home_time_idx ON audit_log (home_id, created_at DESC);

-- ────────────────────────── updated_at trigger ───────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER homes_touch BEFORE UPDATE ON homes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER device_groups_touch BEFORE UPDATE ON device_groups
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER devices_touch BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
