DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pos_card_media
    WHERE storage_key !~ '^pos-card-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
  ) THEN
    RAISE EXCEPTION 'pos_card_media contains invalid storage keys; remediate rows and files before retrying migration 018';
  END IF;
END $$;

ALTER TABLE pos_card_media
  DROP CONSTRAINT IF EXISTS pos_card_media_storage_key_check;

ALTER TABLE pos_card_media
  ADD CONSTRAINT pos_card_media_storage_key_check CHECK (
    storage_key ~ '^pos-card-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
  );
