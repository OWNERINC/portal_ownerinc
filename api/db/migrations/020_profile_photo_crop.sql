ALTER TABLE users
  ADD COLUMN IF NOT EXISTS photo_crop JSONB;

UPDATE users
SET photo_crop = '{"x":0.5,"y":0.5,"zoom":1}'::jsonb
WHERE photo_crop IS NULL;

ALTER TABLE users
  ALTER COLUMN photo_crop SET DEFAULT '{"x":0.5,"y":0.5,"zoom":1}'::jsonb,
  ALTER COLUMN photo_crop SET NOT NULL;

ALTER TABLE users
  ADD CONSTRAINT users_photo_crop_check CHECK (
    jsonb_typeof(photo_crop) = 'object'
    AND jsonb_typeof(photo_crop->'x') = 'number'
    AND jsonb_typeof(photo_crop->'y') = 'number'
    AND jsonb_typeof(photo_crop->'zoom') = 'number'
  );
