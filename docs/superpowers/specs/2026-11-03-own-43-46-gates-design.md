# OWN-43 a OWN-46 — Especificação dos gates pós-CMS

Data: 2026-11-03
Base: `f7c03da` (`OWN-42` publicada em `8746ce2`)
Escopo: proteger o banco, remover resíduos órfãos, alinhar documentação e consolidar o aceite sem promover produção.

## Decisão aprovada

Os cenários de migration não serão executados diretamente na base de produção com o
harness mutável existente. A base de produção do Portal será usada apenas para
auditoria read-only durante a janela autorizada. Os cenários fresh e upgrade serão
executados em uma **instância/cluster PostgreSQL separado**, com roles e credenciais
que não sejam compartilhadas com a produção. Um banco diferente dentro do mesmo
cluster de produção não é isolamento suficiente, porque o runner executa
`ALTER ROLE` ao provisionar `portal_api` e `portal_cron`.

Essa separação é necessária porque `scripts/test-migrations.mjs` cria fixtures,
reaplica migrations históricas em transações de teste e executa limpeza explícita.
Uma base que contém dados históricos não pode ser tratada como descartável apenas
porque a aplicação está temporariamente inutilizável.

Se uma instância/cluster separado, já existente e autorizado, não estiver disponível,
o gate fica bloqueado. Não será iniciado Docker ou criado um cluster temporário nesta
etapa sem autorização específica.

## Restrições invariáveis

- Não iniciar Docker, reiniciar serviços, fazer deploy, rollback ou promoção.
- Não executar o harness mutável contra a base de produção.
- Não reescrever bytes das migrations `015`, `019`, `033`, `034` e `035`.
- Não executar `DROP`, `TRUNCATE` ou remoção de linhas, usuários, uploads, arquivos ou auditoria históricos reais.
- Operações destrutivas de migrations históricas ou limpeza de fixtures só são permitidas
  dentro do banco descartável isolado e aprovado; nunca na produção ou em dados históricos.
- Não remover tabelas editoriais históricas nem seus uploads; o runtime apenas deixa de escrever nelas.
- Não imprimir, copiar para o repositório ou registrar URLs, senhas, chaves ou tokens.
- Manter `api/`, `cron/`, `public/`, `nginx/` e `tests/` como fronteiras do projeto.
- Não liberar OWN-44 antes da validação da OWN-43; OWN-45 depende de OWN-44; OWN-46 depende de todas as anteriores.

## OWN-43 — proteção de migrations e banco

### Runner e migration de compatibilidade

O runner deve manter o ledger explícito e idempotente. A migration nova, se
necessária, será `038_disable_legacy_editorial_writes.sql` e terá somente blocos
guardados por existência de relação, usando SQL dinâmico seguro, para revogar
`INSERT`, `UPDATE` e `DELETE` das roles `portal_api` e `portal_cron` sobre
`cms_documents`, `cms_revisions` e `cms_assets`. Ela não apagará relações, linhas ou
bytes. A migration 038 é uma proteção complementar; o contrato final de runtime é
estabelecido pelo provisionamento, que revoga todos os privilégios editoriais.

O provisionamento final continuará revogando privilégios editoriais ativos e
concedendo apenas os privilégios dos domínios mantidos. A matriz final exige que
`portal_api` e `portal_cron` não tenham `SELECT`, `INSERT`, `UPDATE` ou `DELETE` em
`cms_documents`, `cms_revisions`, `cms_assets`, `owner_news_home`,
`owner_news_polls`, `owner_news_poll_options` e `owner_news_poll_votes`. O verificador
deverá aceitar a presença ou ausência dessas relações históricas, sem exigir que o
runtime dependa delas; quando presentes, deve verificar os privilégios efetivos
considerando grants diretos, `PUBLIC`, herança e grants por coluna.

O provisionamento garante os grants diretos das roles dedicadas
`portal_api`/`portal_cron`. Se a auditoria encontrar acesso editorial efetivo por
`PUBLIC`, membership herdado ou grant por coluna, o candidato falha e exige
tratamento explícito no provisionamento; não serão feitas revogações amplas sobre
roles compartilhadas ou domínios mantidos automaticamente.

### Fresh e upgrade

- **Fresh estrutural:** aplicar somente `schema.sql` e confirmar que o bootstrap não
  cria relações editoriais nem depende delas. Esse cenário não é apresentado como um
  ledger completo nem como substituto do cenário de migrations.
- **Fresh com ledger:** aplicar `schema.sql`, depois todas as migrations pendentes em
  ordem, incluindo as migrations editoriais históricas intactas e a proteção nova.
  Nesse cenário, a presença das tabelas históricas é esperada porque as migrations
  015, 034 e 035 as criam.
- **Upgrade:** construir um banco vazio com o prefixo histórico até antes de
  `033_academy_learning`, inserir uma linha histórica de Academy e aplicar o restante
  do ledger sem reescrever ou remover migrations anteriores.
- **Repetição:** executar o runner duas vezes e confirmar que o ledger e os timestamps
  não mudam na segunda execução.
- **Preservação:** confirmar a linha histórica de Academy, a presença das tabelas
  editoriais históricas quando o upgrade as cria e a ausência de grants de escrita do
  runtime.
- **Ausência/readiness:** testar separadamente o verificador/readiness contra uma
  fixture isolada sem relações editoriais, sem apagar tabelas históricas de uma base
  real e sem apresentar essa fixture como um fluxo normal de upgrade.

  Essa fixture será construída somente para o teste: aplicar `schema.sql` e as
  migrations não editoriais necessárias, registrar em um ledger sintético local as
  versões editoriais omitidas para satisfazer o contrato de leitura do verificador e
  executar `verifyMigrations()` em modo read-only. O ledger sintético não representa
  um upgrade real, não será usado pelo runner e nunca será aplicado a uma base real.

O harness de integração deve exigir, antes de abrir pool ou chamar o runner,
`MIGRATION_TEST_SETUP=bootstrap` ou `MIGRATION_TEST_SETUP=upgrade`,
`MIGRATION_TEST_DISPOSABLE=true` e `MIGRATION_TEST_CLUSTER_ID` igual ao
`system_identifier` do cluster PostgreSQL descartável aprovado. A ausência do modo
de setup, uma URL sem isolamento aprovado, uma identidade de cluster divergente ou
um banco não vazio devem falhar sem efeitos colaterais. A auditoria da produção
será feita por consultas read-only separadas. O harness deve testar a rejeição de
modo ausente/inválido, identidade ausente/divergente e banco não vazio, além dos
cenários verdes.

As expectativas antigas de grants CMS/Owner News no harness devem ser removidas e
substituídas pela matriz negada acima. As fixtures que verificam estrutura histórica
continuam permitidas no ambiente isolado, mas não autorizam a execução em produção.

### Evidências do gate

Registrar, sem dados sensíveis:

- versão do commit testado e nomes dos cenários;
- ledger esperado e observado;
- checksums dos arquivos históricos comparados com uma referência Git confiável, como
  `8746ce2`, antes/depois; o ledger não armazena checksums próprios;
- contagens e existência de tabelas históricas, sem exportar conteúdo privado;
- campos de fixtures históricas sintéticas comparados antes/depois, além da linha de
  Academy preservada;
- resultado dos grants de `portal_api` e `portal_cron`;
- resultado de `npm run test:migrations`, `npm run verify` e `git diff --check`.

OWN-43 só fica liberada para o próximo gate quando os cenários isolados passam e a
auditoria read-only da produção não exige uma alteração destrutiva. Nos cenários
isolados do candidato, qualquer grant editorial efetivo inesperado bloqueia o gate.
Se a produção
ainda estiver na release anterior à OWN-42 e mantiver grants editoriais compatíveis
com esse runtime antigo, isso será registrado como **PENDENTE externo de promoção**;
não será revogado nesta etapa read-only e não será apresentado como limpeza produtiva
concluída.

## OWN-44 — resíduos órfãos

Depois do gate 43, inventariar referências a CMS, Owner News, Payload e URLs antigas.
Remover somente testes, helpers, scripts ou dependências sem consumidores ativos.
Migrations, tabelas, uploads, documentação histórica e contratos compartilhados não
serão classificados como órfãos sem uma prova nominal de que não são consumidores do
runtime mantido.

## OWN-45 — documentação

Depois do gate 44, atualizar o escopo ativo para o Portal sem CMS/Owner News no
runtime e documentar explicitamente que migrations, tabelas e bytes históricos são
preservados sem consumidor editorial. Cada ocorrência restante deverá ser marcada
como runtime ativo, histórico preservado ou referência operacional válida.

## OWN-46 — aceite e promoção

Depois dos gates anteriores, consolidar a matriz de aceite, separar PASS local de
PENDENTE externo e obter revisão fresca do diff completo. O gate não promove
produção, altera a default branch nem executa deploy. Qualquer promoção continua
dependente de autorização humana posterior.

## Critério de falha

Qualquer falha de conexão, divergência no ledger, alteração de checksum histórico,
grant editorial efetivo inesperado no candidato isolado, alteração de dados fora das
fixtures isoladas ou referência ambígua entre runtime e histórico bloqueia o próximo
gate. Grants editoriais observados na produção antiga seguem exclusivamente a exceção
de **PENDENTE externo de promoção** descrita acima e não são alterados por esta etapa.
O bloqueio deve ser
registrado com o comando, o resultado observado e a ação necessária; não será
contornado marcando a issue como concluída.
