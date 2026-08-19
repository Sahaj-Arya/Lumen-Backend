-- A board is not a device. It is a group of them.
--
-- An ESP with a light on one pin and a fan on another is two things a person
-- switches, and modelling it as one device with a pile of sub-values makes the
-- app, automations and scenes all special-case it. So each configured pin
-- becomes its own device row, and the board becomes a device_group.
--
-- What a pin needs beyond a normal device is where to send its commands: the
-- board owns the MQTT principal, and the pin is a segment under it.
--
--   devices/<parent_uid>/<channel>/state
--   devices/<parent_uid>/<channel>/set
--
-- `device_uid` stays unique and stays the identity the rest of the system
-- keys on; for a pin it is <parent>_<channel>, which is also what the
-- device's own discovery config uses as its unique_id.

ALTER TABLE devices
  -- The board's MQTT principal. Null for a device that is its own board.
  ADD COLUMN parent_uid TEXT,
  -- The segment under it: `gpio5`. Null for the same reason.
  ADD COLUMN channel    TEXT;

-- One row per pin per board. Without this a repeated claim of the same board
-- would quietly create a second copy of every one of its pins.
CREATE UNIQUE INDEX devices_parent_channel_key
  ON devices (parent_uid, channel)
  WHERE parent_uid IS NOT NULL;

-- Presence and ingest both look devices up by the board that published, so
-- this is on the hot path for every message such a board sends.
CREATE INDEX devices_parent_uid_idx ON devices (parent_uid) WHERE parent_uid IS NOT NULL;

-- Both are set together or neither is: a channel with no parent has nowhere to
-- publish, and a parent with no channel addresses the whole board.
ALTER TABLE devices
  ADD CONSTRAINT devices_channel_pairing
  CHECK ((parent_uid IS NULL) = (channel IS NULL));
