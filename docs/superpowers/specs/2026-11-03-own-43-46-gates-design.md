# OWN-43 a OWN-46 — Especificação dos gates pós-CMS

Data: 2026-11-03
Base: `f7c03da` (`OWN-42` publicada em `8746ce2`)
Escopo: proteger o banco, remover resíduos órfãos, alinhar documentação e consolidar o aceite sem promover produção.

## Decisão aprovada

Os cenários de migration não serão executados diretamente na base de produção com o
harness mutável existente. A base de produção do Portal será usada apenas para
auditoria read-only durante a janela autorizada. Os cenários fresh e upgrade serão
executados em um banco isolado e descartável do ambiente do Portal.

Essa separação é necessária porque `scripts/test-migrations.mjs` cria fixtures,
reaplica migrations históricas em transações de teste e executa limpeza explícita.
Uma base que contém dados históricos não pode ser tratada como descartável apenas
porque a aplicação está temporariamente inutilizável.

## Restrições invariáveis

- Não iniciar Docker, reiniciar serviços, fazer deploy, rollback ou promoção.
- Não executar o harness mutável contra a base de produção.
- Não reescrever bytes das migrations `015`, `019`, `033`, `034` e `035`.
- Não executar `DROP`, `TRUNCATE` ou remoção de linhas, usuários, uploads, arquivos ou auditoria históricos.
- Não remover tabelas editoriais históricas nem seus uploads; o runtime apenas deixa de escrever nelas.
- Não imprimir, copiar para o repositório ou registrar URLs, senhas, chaves ou tokens.
- Manter `api/`, `cron/`, `public/`, `nginx/` e `tests/` como fronteiras do projeto.
- Não liberar OWN-44 antes da validação da OWN-43; OWN-45 depende de OWN-44; OWN-46 depende de todas as anteriores.

## OWN-43 — proteção de migrations e banco

### Runner e migration de compatibilidade

O runner deve manter o ledger explícito e idempotente. A migration nova, se
necessária, será `038_disable_legacy_editorial_writes.sql` e terá somente blocos
guardados por existência de relação para revogar `INSERT`, `UPDATE` e `DELETE` das
roles `portal_api` e `portal_cron` sobre `cms_documents`, `cms_revisions` e
`cms_assets`. Ela não apagará relações, linhas ou bytes.

O provisionamento final continuará revogando privilégios editoriais ativos e
concedendo apenas os privilégios dos domínios mantidos. O verificador deverá aceitar
a presença das tabelas históricas, exigir a ausência de privilégios editoriais de
runtime e também funcionar quando essas tabelas não existirem em um fresh schema.

### Fresh e upgrade

- **Fresh:** aplicar `schema.sql`, depois todas as migrations ativas em ordem, incluindo
  as migrations editoriais históricas intactas e a proteção nova.
- **Upgrade:** construir um banco vazio com o prefixo histórico até antes de
  `033_academy_learning`, inserir uma linha histórica de Academy e aplicar o restante
  do ledger sem reescrever ou remover migrations anteriores.
- **Repetição:** executar o runner duas vezes e confirmar que o ledger e os timestamps
  não mudam na segunda execução.
- **Preservação:** confirmar a linha histórica de Academy, a presença das tabelas
  editoriais históricas quando o upgrade as cria e a ausência de grants de escrita do
  runtime.
- **Ausência:** confirmar que um fresh baseado no `schema.sql` não depende de tabelas
  editoriais para iniciar ou para passar no readiness.

O harness de integração deve exigir explicitamente `MIGRATION_TEST_SETUP=bootstrap`
ou `MIGRATION_TEST_SETUP=upgrade` e `MIGRATION_TEST_DISPOSABLE=true`. A ausência do
modo de setup não deve permitir que o teste mutável seja apontado para uma base
existente. A auditoria da produção será feita por consultas read-only separadas.

### Evidências do gate

Registrar, sem dados sensíveis:

- versão do commit testado e nomes dos cenários;
- ledger esperado e observado;
- checksums dos arquivos históricos comparados antes/depois;
- contagens e existência de tabelas históricas, sem exportar conteúdo privado;
- resultado dos grants de `portal_api` e `portal_cron`;
- resultado de `npm run test:migrations`, `npm run verify` e `git diff --check`.

OWN-43 só fica liberada quando os cenários isolados passam e a auditoria read-only
da produção não exige uma alteração destrutiva.

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
grant editorial ativo, alteração de dados fora das fixtures isoladas ou referência
ambígua entre runtime e histórico bloqueia o próximo gate. O bloqueio deve ser
registrado com o comando, o resultado observado e a ação necessária; não será
contornado marcando a issue como concluída.
