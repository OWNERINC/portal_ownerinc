WITH desired(name) AS (VALUES
  ('Analista Administrativo'), ('Analista de Cobrança'), ('Analista de Engenharia'),
  ('Analista de Pós-Vendas'), ('Analista de RH Sênior'),
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
  ('Gerente de RH'), ('Jovem Aprendiz'), ('Líder de Promoção'), ('Motorista'),
  ('Promotor de Vendas'), ('Recepcionista'), ('Redator'), ('SDR'), ('Social Media')
)
INSERT INTO job_titles (name, active)
SELECT name, TRUE FROM desired
ON CONFLICT DO UPDATE SET name = EXCLUDED.name, active = TRUE, updated_at = NOW();

WITH mapping(old_name, new_name) AS (VALUES
  ('Analista de DHO', 'Analista de RH Sênior'),
  ('Gerente de DHO', 'Gerente de RH')
)
UPDATE users
SET job_title_id = target.id
FROM job_titles source
JOIN mapping ON lower(source.name) = lower(mapping.old_name)
JOIN job_titles target ON lower(target.name) = lower(mapping.new_name)
WHERE users.job_title_id = source.id;

WITH desired(name) AS (VALUES
  ('Analista Administrativo'), ('Analista de Cobrança'), ('Analista de Engenharia'),
  ('Analista de Pós-Vendas'), ('Analista de RH Sênior'),
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
  ('Gerente de RH'), ('Jovem Aprendiz'), ('Líder de Promoção'), ('Motorista'),
  ('Promotor de Vendas'), ('Recepcionista'), ('Redator'), ('SDR'), ('Social Media')
)
UPDATE job_titles
SET active = FALSE, updated_at = NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM desired WHERE lower(desired.name) = lower(job_titles.name)
);
