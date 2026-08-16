-- Reshape rules to if-this-then-that, as smart-home apps present it.
--
-- Before: a rule had one `trigger` plus a separate list of `conditions`. That
-- is the engine's internal view, not the user's: apps like Tuya/SmartLife show
-- a single IF list with a "when ANY / when ALL condition is met" switch, and
-- IFTTT is the same shape with exactly one entry.
--
-- After: `conditions` holds everything, and `match` says how to combine them.
-- The old trigger becomes the first condition, so existing rules keep working
-- with identical behaviour: trigger AND conditions is exactly match = 'all'.

ALTER TABLE automations
  ADD COLUMN match TEXT NOT NULL DEFAULT 'all' CHECK (match IN ('any', 'all'));

-- Fold the trigger in as the first condition, translating its shape:
--   trigger 'state'    -> condition 'device'
--   trigger 'status'   -> condition 'status'
--   trigger 'schedule' -> condition 'schedule'
UPDATE automations
SET conditions =
  jsonb_build_array(
    CASE trigger ->> 'kind'
      WHEN 'state' THEN
        jsonb_strip_nulls(
          jsonb_build_object(
            'kind', 'device',
            'deviceId', trigger -> 'deviceId',
            'key', trigger -> 'key',
            'op', trigger -> 'op',
            'value', trigger -> 'value',
            'clearValue', trigger -> 'clearValue'
          )
        )
      WHEN 'status' THEN
        jsonb_build_object(
          'kind', 'status',
          'deviceId', trigger -> 'deviceId',
          'status', trigger -> 'status'
        )
      ELSE
        jsonb_build_object(
          'kind', 'schedule',
          'atMinute', trigger -> 'atMinute',
          'days', COALESCE(trigger -> 'days', '[]'::jsonb)
        )
    END
  ) || COALESCE(conditions, '[]'::jsonb)
WHERE trigger IS NOT NULL;

-- Older device conditions were stored without a discriminator.
UPDATE automations
SET conditions = (
  SELECT jsonb_agg(
    CASE WHEN condition ? 'kind' THEN condition
         ELSE condition || jsonb_build_object('kind', 'device') END
  )
  FROM jsonb_array_elements(conditions) AS condition
)
WHERE jsonb_array_length(conditions) > 0;

-- The trigger now lives inside conditions[0]; keeping the column would leave
-- two sources of truth for the same fact.
ALTER TABLE automations DROP COLUMN trigger;

-- A rule with nothing to set it off could never run.
ALTER TABLE automations
  ADD CONSTRAINT automations_needs_a_condition
  CHECK (jsonb_array_length(conditions) > 0);

-- ── timers removed ────────────────────────────────────────────────
-- A timed action ("on for 20 minutes") was a second, parallel way to express
-- time. Timing is now one thing only: a schedule condition inside a rule.
DROP TABLE IF EXISTS pending_reverts;
