-- Scenes, and the state needed for timed actions.
--
-- A scene is a preset: one tap sets many devices at once ("Movie night",
-- "All off"). It has no trigger — that is what separates it from an automation
-- — but an automation may run one as an action, so a rule and a button can
-- share the same definition instead of duplicating it.

CREATE TABLE scenes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id     UUID NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  owner_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT 'sparkles',
  -- Same action shape automations use, so the engine runs both with one path.
  actions     JSONB NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  run_count   INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scenes_home_idx ON scenes (home_id);
CREATE INDEX scenes_owner_idx ON scenes (owner_id);

CREATE TRIGGER scenes_touch BEFORE UPDATE ON scenes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- "Turn the bath fan on for 20 minutes" is one action, so the revert has to
-- outlive the request that scheduled it. Holding it in memory would lose every
-- pending revert on deploy or crash — leaving a pump running indefinitely —
-- so it is durable and swept by the scheduler.
CREATE TABLE pending_reverts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  -- The patch to publish when the timer runs out.
  patch         JSONB NOT NULL,
  due_at        TIMESTAMPTZ NOT NULL,
  -- Provenance, for the run log. Null when a scene scheduled it.
  automation_id UUID REFERENCES automations(id) ON DELETE CASCADE,
  scene_id      UUID REFERENCES scenes(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pending_reverts_due_idx ON pending_reverts (due_at);
-- One outstanding revert per device: re-triggering "on for 20 min" should
-- extend the window, not queue a second switch-off behind the first.
CREATE UNIQUE INDEX pending_reverts_device_key ON pending_reverts (device_id);

-- Scene runs share the automation run log so history is in one place.
ALTER TABLE automation_runs ADD COLUMN scene_id UUID REFERENCES scenes(id) ON DELETE CASCADE;
ALTER TABLE automation_runs ALTER COLUMN automation_id DROP NOT NULL;
ALTER TABLE automation_runs
  ADD CONSTRAINT automation_runs_has_a_source
  CHECK (automation_id IS NOT NULL OR scene_id IS NOT NULL);
CREATE INDEX automation_runs_scene_time_idx ON automation_runs (scene_id, created_at DESC);
