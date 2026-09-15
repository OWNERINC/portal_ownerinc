DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM autocard_media
    WHERE storage_key !~ '^autocard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
  ) THEN
    RAISE EXCEPTION 'autocard_media contains invalid storage keys; remediate rows and files before retrying migration 029';
  END IF;
END $$;

UPDATE autocard_cards
SET icon = NULL
WHERE icon IS NOT NULL AND icon !~ '^[a-z0-9]+(-[a-z0-9]+)*$';

UPDATE autocard_cards
SET illustration = NULL
WHERE illustration IS NOT NULL AND illustration !~ '^[a-z0-9]+(-[a-z0-9]+)*$';

UPDATE users
SET photo_crop = '{"x":0.5,"y":0.5,"zoom":1}'::jsonb
WHERE NOT jsonb_path_exists(
  photo_crop,
  '$ ? (@.x.type() == "number" && @.x >= 0 && @.x <= 1 && @.y.type() == "number" && @.y >= 0 && @.y <= 1 && @.zoom.type() == "number" && @.zoom >= 1 && @.zoom <= 3)'
);

UPDATE autocard_cards
SET media_crop = '{"x":0.5,"y":0.5,"zoom":1}'::jsonb
WHERE NOT jsonb_path_exists(
  media_crop,
  '$ ? (@.x.type() == "number" && @.x >= 0 && @.x <= 1 && @.y.type() == "number" && @.y >= 0 && @.y <= 1 && @.zoom.type() == "number" && @.zoom >= 1 && @.zoom <= 3)'
);

ALTER TABLE autocard_media
  DROP CONSTRAINT IF EXISTS autocard_media_storage_key_check;

ALTER TABLE autocard_media
  ADD CONSTRAINT autocard_media_storage_key_check CHECK (
    storage_key ~ '^autocard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
  );

ALTER TABLE autocard_cards
  DROP CONSTRAINT IF EXISTS autocard_cards_icon_check,
  DROP CONSTRAINT IF EXISTS autocard_cards_illustration_check,
  DROP CONSTRAINT IF EXISTS autocard_cards_media_crop_check;

ALTER TABLE autocard_cards
  ADD CONSTRAINT autocard_cards_icon_check CHECK (
    icon IS NULL OR (char_length(icon) BETWEEN 1 AND 80 AND icon ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
  ),
  ADD CONSTRAINT autocard_cards_illustration_check CHECK (
    illustration IS NULL OR (char_length(illustration) BETWEEN 1 AND 80 AND illustration ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
  ),
  ADD CONSTRAINT autocard_cards_media_crop_check CHECK (
    jsonb_typeof(media_crop) = 'object'
    AND jsonb_typeof(media_crop->'x') = 'number'
    AND jsonb_typeof(media_crop->'y') = 'number'
    AND jsonb_typeof(media_crop->'zoom') = 'number'
    AND jsonb_path_exists(media_crop, '$ ? (@.x >= 0 && @.x <= 1 && @.y >= 0 && @.y <= 1 && @.zoom >= 1 && @.zoom <= 3)')
  );

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_photo_crop_check;

ALTER TABLE users
  ADD CONSTRAINT users_photo_crop_check CHECK (
    jsonb_typeof(photo_crop) = 'object'
    AND jsonb_typeof(photo_crop->'x') = 'number'
    AND jsonb_typeof(photo_crop->'y') = 'number'
    AND jsonb_typeof(photo_crop->'zoom') = 'number'
    AND jsonb_path_exists(photo_crop, '$ ? (@.x >= 0 && @.x <= 1 && @.y >= 0 && @.y <= 1 && @.zoom >= 1 && @.zoom <= 3)')
  );
