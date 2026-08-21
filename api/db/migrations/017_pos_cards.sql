CREATE TABLE IF NOT EXISTS pos_card_media (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key  TEXT        NOT NULL UNIQUE,
  content_type TEXT        NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size    INTEGER     NOT NULL CHECK (byte_size BETWEEN 1 AND 3145728),
  created_by   TEXT        REFERENCES users(uid) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pos_card_media_storage_key_check CHECK (storage_key ~ '^pos-card-[0-9a-f-]+\.webp$')
);

CREATE TABLE IF NOT EXISTS pos_cards (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  template   TEXT        NOT NULL CHECK (template IN ('convite_owntime')),
  "values"  JSONB       NOT NULL CHECK (jsonb_typeof("values") = 'object'),
  media_id   UUID        REFERENCES pos_card_media(id) ON DELETE SET NULL,
  created_by TEXT        REFERENCES users(uid) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pos_cards_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS pos_cards_updated_idx ON pos_cards (updated_at DESC);
CREATE INDEX IF NOT EXISTS pos_cards_template_idx ON pos_cards (template, updated_at DESC);
