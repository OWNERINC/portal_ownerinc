ALTER TABLE autocard_cards
  ADD COLUMN IF NOT EXISTS media_crop JSONB;

UPDATE autocard_cards
SET media_crop = '{"x":0.5,"y":0.5,"zoom":1}'::jsonb
WHERE media_crop IS NULL;

ALTER TABLE autocard_cards
  ALTER COLUMN media_crop SET DEFAULT '{"x":0.5,"y":0.5,"zoom":1}'::jsonb,
  ALTER COLUMN media_crop SET NOT NULL;

ALTER TABLE autocard_cards
  ADD CONSTRAINT autocard_cards_media_crop_check CHECK (
    jsonb_typeof(media_crop) = 'object'
    AND jsonb_typeof(media_crop->'x') = 'number'
    AND jsonb_typeof(media_crop->'y') = 'number'
    AND jsonb_typeof(media_crop->'zoom') = 'number'
  );
