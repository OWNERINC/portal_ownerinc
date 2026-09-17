ALTER TABLE user_import_rows ADD COLUMN IF NOT EXISTS firebase_uid TEXT;
ALTER TABLE user_import_rows DROP CONSTRAINT IF EXISTS user_import_rows_firebase_uid_check;
ALTER TABLE user_import_rows ADD CONSTRAINT user_import_rows_firebase_uid_check
  CHECK (firebase_uid IS NULL OR btrim(firebase_uid) <> '');
