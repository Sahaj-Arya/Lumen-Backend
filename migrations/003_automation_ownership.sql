-- Automations belong to the user who created them, not to the home.
--
-- Before this, `created_by` was recorded but never enforced: any member of a
-- shared home could read, edit, disable or delete another member's rules, and
-- — the sharper problem — a rule kept firing at a home's devices forever after
-- its creator was removed from that home, because nothing re-checked
-- membership at execution time.

ALTER TABLE automations ADD COLUMN owner_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Backfill from the audit column that already existed.
UPDATE automations SET owner_id = created_by WHERE owner_id IS NULL;

-- Any rule whose creator is already gone has no owner to authorise it, so it
-- must not keep running. Disable rather than delete: a human should decide.
UPDATE automations SET enabled = false, owner_id = NULL WHERE owner_id IS NULL;

CREATE INDEX automations_owner_idx ON automations (owner_id);

-- An enabled rule must have an owner whose access can be verified.
ALTER TABLE automations
  ADD CONSTRAINT automations_enabled_needs_owner
  CHECK (owner_id IS NOT NULL OR enabled = false);
