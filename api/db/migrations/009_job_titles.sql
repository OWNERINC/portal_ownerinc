CREATE TABLE IF NOT EXISTS job_titles (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT job_titles_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT job_titles_name_unique UNIQUE (name)
);

CREATE UNIQUE INDEX IF NOT EXISTS job_titles_name_lower_unique ON job_titles (lower(name));

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS job_title_id UUID REFERENCES job_titles(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS users_job_title_id_idx ON users (job_title_id);

INSERT INTO job_titles (name) VALUES
  ('Analista de RH'),
  ('Assistente de RH'),
  ('Coordenador de RH'),
  ('Gerente de RH'),
  ('Recrutamento e Seleção'),
  ('Departamento Pessoal'),
  ('Analista Administrativo'),
  ('Assistente Administrativo'),
  ('Financeiro'),
  ('Marketing'),
  ('Operações'),
  ('Comercial'),
  ('Tecnologia'),
  ('Liderança'),
  ('Outro')
ON CONFLICT (name) DO NOTHING;
