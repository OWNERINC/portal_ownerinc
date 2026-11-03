# OWN-43 — Auditoria read-only da VPS

Data: 2026-11-03
Escopo: inspeção read-only via SSH `ownerinc`; nenhuma migration, fixture, criação
de banco, alteração de role, `DROP`, `TRUNCATE` ou limpeza foi executada.

## Resultado

### Produção

- Container PostgreSQL observado: `ownerinc-portal-prod-postgres-1`.
- Banco observado: `portal`.
- Servidor não está em recovery.
- O ledger está aplicado até `037_owner_news_cutover`.
- Foram observadas 108 relações de usuário.
- As sete relações editoriais estão presentes:
  `cms_documents`, `cms_revisions`, `cms_assets`, `owner_news_home`,
  `owner_news_polls`, `owner_news_poll_options` e `owner_news_poll_votes`.
- A auditoria de privilégios efetivos confirmou acesso editorial residual para
  `portal_api`, incluindo escrita nas tabelas CMS e Owner News. Também há acesso
  residual de leitura/escrita parcial para `portal_cron` em tabelas CMS.

Esse estado é compatível com a release produtiva anterior ao gate de proteção.
Ele é **PENDENTE externo de promoção**, não um alvo autorizado para o harness
mutável. Nenhuma revogação foi feita.

### Staging existente

- Container PostgreSQL observado: `ownerinc-portal-staging-postgres-1`.
- Banco observado: `portal_staging`.
- O container é separado da produção, mas não é descartável: possui relações
  existentes, ledger parcial e estado operacional próprio.
- O staging usa roles ativas do Portal; alterar senhas ou grants por meio do
  runner poderia afetar o serviço de staging.

Por isso, o staging também não foi usado para fresh/upgrade/readiness.

### Outros containers pre-auth

Os containers pre-auth inspecionados também possuem relações editoriais e ledger
completo até `037_owner_news_cutover`. Não foram tratados como bancos descartáveis
nem sofreram qualquer mutação.

### Instância descartável da OWN-43

Após a auditoria, foi provisionada uma instância PostgreSQL separada e exclusiva
para o harness mutável da OWN-43:

- Container: `ownerinc-portal-own43-postgres`.
- Imagem: `postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777`.
- Volume: `ownerinc-portal-own43-postgres-data`, distinto dos volumes de produção,
  staging e pre-auth.
- Bind: `127.0.0.1:25432:5432`; não há publicação em interface pública.
- Restart policy: `no`; healthcheck observado como `healthy`.
- Database e roles administrativas/runtime possuem nomes, credenciais e escopo
  próprios da fixture; nenhum segredo foi registrado neste relatório.
- Databases de cenário: `portal_own43_bootstrap`, `portal_own43_upgrade` e
  `portal_own43_readiness`.

O fresh/bootstrap e o upgrade passaram o runner duas vezes, preservaram a linha
histórica sintética da Academy, confirmaram o ledger completo de 35 versões e
confirmaram as sete relações editoriais históricas sem privilégios efetivos de
tabela ou coluna para `portal_api`/`portal_cron`. O readiness aceitou o ledger
sintético com 35 versões e confirmou zero relações editoriais.

O primeiro ensaio fresh revelou uma expectativa residual do harness que ainda
esperava `SELECT` de `portal_api` em Owner News. A expectativa foi corrigida para
negar todos os privilégios editoriais, as bases descartáveis foram recriadas e os
três cenários passaram integralmente. Isso não alterou produção, staging ou
qualquer volume histórico.

## Evidência do gate

- `npm run test:migrations` — fresh/bootstrap: PASS; upgrade: PASS; repetição
  idempotente incluída nos dois cenários.
- `npm run test:migration-readiness` — PASS, sem relações editoriais.
- `npm run verify` — 804 PASS, 2 skips esperados por plataforma.
- `git diff --check` — PASS.
- Checksums e bytes das migrations históricas `015`, `019`, `033`, `034` e `035`
  permanecem preservados; a alteração desta etapa ficou limitada às expectativas
  do harness e à exclusão explícita da fixture de readiness na varredura de
  superfície ativa.

## Decisão do gate

A auditoria read-only confirma que produção, staging e pre-auth não eram alvos
seguros para o harness mutável. A instância separada e descartável agora existe e
os cenários fresh, upgrade e readiness passaram nela. A OWN-43 fica em revisão com
produção ainda marcada como **PENDENTE externo de promoção**; OWN-44, OWN-45 e OWN-46
permanecem bloqueadas até aprovação explícita deste gate.
