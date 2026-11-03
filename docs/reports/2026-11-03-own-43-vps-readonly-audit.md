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

## Decisão do gate

A VPS confirma que o banco original pode ser auditado read-only, mas não fornece um
alvo seguro para o harness mutável da OWN-43. Fresh, upgrade e readiness continuam
bloqueados até existir uma instância/cluster PostgreSQL separado, descartável e com
roles próprias. OWN-44, OWN-45 e OWN-46 permanecem bloqueadas.
