-- Server-side automation. Rules live here and are evaluated by the backend on
-- every ingested device update, so they keep working with the app closed or
-- uninstalled — the phone is a remote control, never the control loop.

CREATE TABLE automations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id       UUID NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  enabled       BOOLEAN NOT NULL DEFAULT true,

  -- { kind: 'state' | 'status' | 'schedule', ... } — see src/automation/types.ts
  trigger       JSONB NOT NULL,
  -- Extra predicates that must all hold when the trigger fires.
  conditions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Ordered list of { kind: 'command' | 'delay' | 'webhook', ... }.
  actions       JSONB NOT NULL,

  -- Minimum gap between runs. Stops a value hovering on a threshold from
  -- machine-gunning commands at the hardware.
  cooldown_seconds INTEGER NOT NULL DEFAULT 30 CHECK (cooldown_seconds >= 0),
  -- Edge-triggered rules fire only on a false -> true transition. Level
  -- triggering (fire while true) is opt-in because it is rarely what you want.
  edge_triggered BOOLEAN NOT NULL DEFAULT true,

  last_triggered_at TIMESTAMPTZ,
  run_count     INTEGER NOT NULL DEFAULT 0,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX automations_home_idx ON automations (home_id);
CREATE INDEX automations_enabled_idx ON automations (enabled) WHERE enabled;

-- Which devices a rule watches. Denormalised from `trigger`/`conditions` on
-- write so ingest can look up candidate rules with one indexed query per
-- message instead of scanning every automation in the home.
CREATE TABLE automation_watches (
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  device_id     UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  PRIMARY KEY (automation_id, device_id)
);
CREATE INDEX automation_watches_device_idx ON automation_watches (device_id);

CREATE TABLE automation_runs (
  id            BIGSERIAL PRIMARY KEY,
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('fired', 'skipped', 'failed')),
  -- Why it did not fire: 'cooldown', 'condition', 'not_edge', 'disabled', 'depth'.
  reason        TEXT,
  trigger_value JSONB,
  actions_run   INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX automation_runs_automation_time_idx
  ON automation_runs (automation_id, created_at DESC);
-- Runs are high-volume and disposable; BRIN keeps the retention sweep cheap.
CREATE INDEX automation_runs_time_brin ON automation_runs USING BRIN (created_at);

CREATE TRIGGER automations_touch BEFORE UPDATE ON automations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
