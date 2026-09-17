-- legacy-job-title-migration:start
-- Legacy migration input: RH is intentionally matched and replaced here.
DO $$
DECLARE
  item RECORD;
  migrated_name TEXT;
  replaced_name TEXT;
BEGIN
  FOR item IN
    SELECT id, name
    FROM job_titles
    WHERE btrim(name) ~* '(^|[^[:alnum:]_])RH([^[:alnum:]_]|$)'
    ORDER BY id
  LOOP
    migrated_name := btrim(item.name);
    LOOP
      replaced_name := regexp_replace(
        migrated_name,
        '(^|[^[:alnum:]_])RH([^[:alnum:]_]|$)',
        E'\\1DHO\\2',
        'i'
      );
      EXIT WHEN replaced_name = migrated_name;
      migrated_name := replaced_name;
    END LOOP;
    migrated_name := btrim(migrated_name);

    IF char_length(migrated_name) > 120 THEN
      RAISE EXCEPTION 'DHO job title migration aborted before mutation: "%" (%) becomes "%" with % characters; maximum is 120',
        item.name, item.id, migrated_name, char_length(migrated_name);
    END IF;
  END LOOP;
END $$;

DROP INDEX IF EXISTS job_titles_name_lower_unique;
ALTER TABLE job_titles DROP CONSTRAINT IF EXISTS job_titles_name_no_legacy_rh_check;
ALTER TABLE job_titles DROP CONSTRAINT IF EXISTS job_titles_name_unique;

DO $$
DECLARE
  item RECORD;
  migrated_name TEXT;
  replaced_name TEXT;
  target_id UUID;
  source_id UUID;
BEGIN
  -- Rename legacy RH names first, merging into an existing DHO name when needed.
  FOR item IN
    SELECT id, name
    FROM job_titles
    WHERE btrim(name) ~* '(^|[^[:alnum:]_])RH([^[:alnum:]_]|$)'
    ORDER BY id
  LOOP
    migrated_name := btrim(item.name);
    LOOP
      replaced_name := regexp_replace(
        migrated_name,
        '(^|[^[:alnum:]_])RH([^[:alnum:]_]|$)',
        E'\\1DHO\\2',
        'i'
      );
      EXIT WHEN replaced_name = migrated_name;
      migrated_name := replaced_name;
    END LOOP;
    migrated_name := btrim(migrated_name);

    IF char_length(migrated_name) > 120 THEN
      RAISE EXCEPTION 'DHO job title migration aborted: "%" (%) becomes "%" with % characters; maximum is 120',
        item.name, item.id, migrated_name, char_length(migrated_name);
    END IF;

    target_id := NULL;
    SELECT id INTO target_id
    FROM job_titles
    WHERE id <> item.id AND btrim(lower(name)) = btrim(lower(migrated_name))
    ORDER BY created_at, id
    LIMIT 1;

    IF target_id IS NULL THEN
      UPDATE job_titles
      SET name = migrated_name, updated_at = NOW()
      WHERE id = item.id;
    ELSE
      UPDATE job_titles AS target
      SET name = btrim(target.name),
          active = target.active OR source.active,
          page_access = (target.page_access || source.page_access) || jsonb_build_object(
            'autocard', COALESCE((target.page_access->>'autocard') = 'true', FALSE)
              OR COALESCE((source.page_access->>'autocard') = 'true', FALSE),
            'posCards', COALESCE((target.page_access->>'posCards') = 'true', FALSE)
              OR COALESCE((source.page_access->>'posCards') = 'true', FALSE)
          ),
          updated_at = NOW()
      FROM job_titles AS source
      WHERE target.id = target_id AND source.id = item.id;

      UPDATE users SET job_title_id = target_id WHERE job_title_id = item.id;
      DELETE FROM job_titles WHERE id = item.id;
    END IF;
  END LOOP;

  -- Also consolidate any case-insensitive duplicates left by old catalog data.
  LOOP
    target_id := NULL;
    source_id := NULL;
    SELECT target.id, source.id INTO target_id, source_id
    FROM job_titles AS target
    JOIN job_titles AS source
      ON btrim(lower(target.name)) = btrim(lower(source.name)) AND target.id <> source.id
    ORDER BY btrim(lower(target.name)), target.created_at, target.id, source.created_at, source.id
    LIMIT 1;
    EXIT WHEN target_id IS NULL;

    UPDATE job_titles AS target
    SET name = btrim(target.name),
        active = target.active OR source.active,
        page_access = (target.page_access || source.page_access) || jsonb_build_object(
          'autocard', COALESCE((target.page_access->>'autocard') = 'true', FALSE)
            OR COALESCE((source.page_access->>'autocard') = 'true', FALSE),
          'posCards', COALESCE((target.page_access->>'posCards') = 'true', FALSE)
            OR COALESCE((source.page_access->>'posCards') = 'true', FALSE)
        ),
        updated_at = NOW()
    FROM job_titles AS source
    WHERE target.id = target_id AND source.id = source_id;

    UPDATE users SET job_title_id = target_id WHERE job_title_id = source_id;
    DELETE FROM job_titles WHERE id = source_id;
  END LOOP;

  UPDATE job_titles
  SET name = btrim(name), updated_at = NOW()
  WHERE name <> btrim(name);
END $$;

ALTER TABLE job_titles
  ADD CONSTRAINT job_titles_name_no_legacy_rh_check CHECK (
    name !~* '(^|[^[:alnum:]_])RH([^[:alnum:]_]|$)'
  );
-- legacy-job-title-migration:end

-- canonical-job-titles:start
WITH canonical(name) AS (VALUES
  ('Analista Administrativo'), ('Analista de Cobrança'), ('Analista de Engenharia'),
  ('Analista de Pós-Vendas'), ('Analista de DHO Sênior'),
  ('Analista de Departamento Pessoal'), ('Analista Financeiro'),
  ('Analista Financeiro Sênior'), ('Assistente Administrativo'),
  ('Auxiliar de Limpeza'), ('CEO'), ('Consultor de Vendas'),
  ('Consultora de Pós-Vendas'), ('Consultora de Pós-Vendas Júnior'),
  ('Consultora de Pós-Vendas Pleno'), ('Coordenador Central de Férias'),
  ('Coordenador de Compras'), ('Coordenador de Contratos'), ('Coordenador de Sala'),
  ('Coordenador Financeiro'), ('Coordenador de Pós-Vendas'),
  ('Coordenadora Administrativa'), ('Coordenadora de Planejamento'),
  ('Coordenadora de Projetos'), ('Coordenadora de Vendas'), ('Design'),
  ('Diretor Comercial'), ('Diretor de Incorporação'), ('Diretor de Marketing'),
  ('Engenheiro Civil'), ('Especialista de Controladoria'),
  ('Especialista de Marketing'), ('Garçom'), ('Garçom Sênior'), ('Garçonete'),
  ('Gerente Administrativo'), ('Gerente Comercial'), ('Gerente de Marketing'),
  ('Gerente de Obra'), ('Gerente de Pós-Vendas'), ('Gerente de Promoção'),
  ('Gerente de DHO'), ('Jovem Aprendiz'), ('Líder de Promoção'), ('Motorista'),
  ('Promotor de Vendas'), ('Recepcionista'), ('Redator'), ('SDR'), ('Social Media')
)
INSERT INTO job_titles (name, active, page_access)
SELECT btrim(name), TRUE,
  CASE WHEN btrim(lower(name)) IN ('analista de dho sênior', 'gerente de dho')
    THEN '{"autocard":true,"posCards":true}'::jsonb
    ELSE '{"autocard":false,"posCards":false}'::jsonb
  END
FROM canonical
WHERE NOT EXISTS (
  SELECT 1 FROM job_titles existing WHERE btrim(lower(existing.name)) = btrim(lower(canonical.name))
);

WITH canonical(name) AS (VALUES
  ('Analista Administrativo'), ('Analista de Cobrança'), ('Analista de Engenharia'),
  ('Analista de Pós-Vendas'), ('Analista de DHO Sênior'),
  ('Analista de Departamento Pessoal'), ('Analista Financeiro'),
  ('Analista Financeiro Sênior'), ('Assistente Administrativo'),
  ('Auxiliar de Limpeza'), ('CEO'), ('Consultor de Vendas'),
  ('Consultora de Pós-Vendas'), ('Consultora de Pós-Vendas Júnior'),
  ('Consultora de Pós-Vendas Pleno'), ('Coordenador Central de Férias'),
  ('Coordenador de Compras'), ('Coordenador de Contratos'), ('Coordenador de Sala'),
  ('Coordenador Financeiro'), ('Coordenador de Pós-Vendas'),
  ('Coordenadora Administrativa'), ('Coordenadora de Planejamento'),
  ('Coordenadora de Projetos'), ('Coordenadora de Vendas'), ('Design'),
  ('Diretor Comercial'), ('Diretor de Incorporação'), ('Diretor de Marketing'),
  ('Engenheiro Civil'), ('Especialista de Controladoria'),
  ('Especialista de Marketing'), ('Garçom'), ('Garçom Sênior'), ('Garçonete'),
  ('Gerente Administrativo'), ('Gerente Comercial'), ('Gerente de Marketing'),
  ('Gerente de Obra'), ('Gerente de Pós-Vendas'), ('Gerente de Promoção'),
  ('Gerente de DHO'), ('Jovem Aprendiz'), ('Líder de Promoção'), ('Motorista'),
  ('Promotor de Vendas'), ('Recepcionista'), ('Redator'), ('SDR'), ('Social Media')
)
UPDATE job_titles AS existing
SET name = btrim(canonical.name),
    active = TRUE,
    page_access = CASE
      WHEN btrim(lower(canonical.name)) IN ('analista de dho sênior', 'gerente de dho')
        THEN existing.page_access || '{"autocard":true,"posCards":true}'::jsonb
      ELSE existing.page_access
    END,
    updated_at = NOW()
FROM canonical
WHERE btrim(lower(existing.name)) = btrim(lower(canonical.name));

WITH canonical(name) AS (VALUES
  ('Analista Administrativo'), ('Analista de Cobrança'), ('Analista de Engenharia'),
  ('Analista de Pós-Vendas'), ('Analista de DHO Sênior'),
  ('Analista de Departamento Pessoal'), ('Analista Financeiro'),
  ('Analista Financeiro Sênior'), ('Assistente Administrativo'),
  ('Auxiliar de Limpeza'), ('CEO'), ('Consultor de Vendas'),
  ('Consultora de Pós-Vendas'), ('Consultora de Pós-Vendas Júnior'),
  ('Consultora de Pós-Vendas Pleno'), ('Coordenador Central de Férias'),
  ('Coordenador de Compras'), ('Coordenador de Contratos'), ('Coordenador de Sala'),
  ('Coordenador Financeiro'), ('Coordenador de Pós-Vendas'),
  ('Coordenadora Administrativa'), ('Coordenadora de Planejamento'),
  ('Coordenadora de Projetos'), ('Coordenadora de Vendas'), ('Design'),
  ('Diretor Comercial'), ('Diretor de Incorporação'), ('Diretor de Marketing'),
  ('Engenheiro Civil'), ('Especialista de Controladoria'),
  ('Especialista de Marketing'), ('Garçom'), ('Garçom Sênior'), ('Garçonete'),
  ('Gerente Administrativo'), ('Gerente Comercial'), ('Gerente de Marketing'),
  ('Gerente de Obra'), ('Gerente de Pós-Vendas'), ('Gerente de Promoção'),
  ('Gerente de DHO'), ('Jovem Aprendiz'), ('Líder de Promoção'), ('Motorista'),
  ('Promotor de Vendas'), ('Recepcionista'), ('Redator'), ('SDR'), ('Social Media')
)
UPDATE job_titles AS existing
SET active = FALSE, updated_at = NOW()
WHERE existing.active IS DISTINCT FROM FALSE
  AND NOT EXISTS (
    SELECT 1 FROM canonical WHERE btrim(lower(canonical.name)) = btrim(lower(existing.name))
  );
-- canonical-job-titles:end

ALTER TABLE job_titles ADD CONSTRAINT job_titles_name_unique UNIQUE (name);
CREATE UNIQUE INDEX IF NOT EXISTS job_titles_name_lower_unique ON job_titles (btrim(lower(name)));
