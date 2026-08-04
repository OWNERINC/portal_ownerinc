DO $$
DECLARE
  item RECORD;
  old_id UUID;
  new_id UUID;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('Analista de RH', 'Analista de DHO'),
      ('Assistente de RH', 'Assistente de DHO'),
      ('Coordenador de RH', 'Coordenador de DHO'),
      ('Gerente de RH', 'Gerente de DHO')
    ) AS mapping(old_name, new_name)
  LOOP
    SELECT id INTO old_id FROM job_titles WHERE lower(name) = lower(item.old_name);
    IF old_id IS NULL THEN CONTINUE; END IF;

    SELECT id INTO new_id FROM job_titles WHERE lower(name) = lower(item.new_name);
    IF new_id IS NULL THEN
      UPDATE job_titles SET name = item.new_name, updated_at = NOW() WHERE id = old_id;
    ELSE
      UPDATE job_titles target
      SET active = target.active OR source.active, updated_at = NOW()
      FROM job_titles source
      WHERE target.id = new_id AND source.id = old_id;
      UPDATE users SET job_title_id = new_id WHERE job_title_id = old_id;
      DELETE FROM job_titles WHERE id = old_id;
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS autocard_media (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key  TEXT        NOT NULL UNIQUE,
  content_type TEXT        NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size    INTEGER     NOT NULL CHECK (byte_size BETWEEN 1 AND 3145728),
  created_by   TEXT        REFERENCES users(uid) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT autocard_media_storage_key_check CHECK (storage_key ~ '^autocard-[0-9a-f-]+\.webp$')
);

CREATE TABLE IF NOT EXISTS autocard_cards (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,
  template     TEXT        NOT NULL CHECK (template IN ('comunicado', 'vaga', 'aniversariante', 'novo_funcionario')),
  "values"    JSONB       NOT NULL CHECK (jsonb_typeof("values") = 'object'),
  icon         TEXT,
  illustration TEXT,
  mode         TEXT        NOT NULL DEFAULT 'light' CHECK (mode IN ('light', 'dark', 'beige')),
  variant      TEXT        NOT NULL DEFAULT 'editorial' CHECK (variant IN ('editorial', 'noir', 'beige')),
  media_size   TEXT        NOT NULL DEFAULT 'medium' CHECK (media_size IN ('small', 'medium', 'large')),
  media_id     UUID        REFERENCES autocard_media(id) ON DELETE SET NULL,
  created_by   TEXT        REFERENCES users(uid) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT autocard_cards_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT autocard_cards_icon_check CHECK (icon IS NULL OR char_length(icon) BETWEEN 1 AND 80),
  CONSTRAINT autocard_cards_illustration_check CHECK (illustration IS NULL OR char_length(illustration) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS autocard_cards_updated_idx ON autocard_cards (updated_at DESC);
CREATE INDEX IF NOT EXISTS autocard_cards_template_idx ON autocard_cards (template, updated_at DESC);
