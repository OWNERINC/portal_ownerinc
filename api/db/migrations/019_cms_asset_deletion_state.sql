ALTER TABLE cms_assets
  ADD COLUMN IF NOT EXISTS deleting_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS cms_assets_deleting_idx
  ON cms_assets (deleting_at)
  WHERE deleting_at IS NOT NULL;
