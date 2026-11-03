# OWN-44 — Inventário de resíduos órfãos

Data: 2026-11-03
Gate anterior: OWN-43 aprovada por revisão Astra medium (`ship`), com código
executável validado em `6cb537f` e cabeça documental atual posterior.

## Regra aplicada

Este inventário remove somente arquivos sem consumidor ativo comprovado. Migrations,
tabelas, uploads, bytes históricos e documentação histórica não são resíduos órfãos.
Testes que protegem o Portal mantido ou a ausência controlada de superfícies antigas
continuam sendo contratos ativos.

## Buscas executadas

```text
git ls-files | Select-String -Pattern '(^|/)(cms|owner-news)|payload|announcements'
git grep -n -i -E "Payload|/api/cms|cms\.html|owner-news|announcements\.html" -- package.json scripts tests api cron public nginx .github README.md docs/product docs/architecture docs/operations
git grep -n -E "cms-harness|cms-editor-values|cms-frontend|cms-removal-contract|knowledge-editorial-harness|reminder-delivery-ui"
git grep -n -E "normalizeEditorBlocks|cms-editor-values|editor-values"
```

Lockfiles foram excluídos das buscas nominais de runtime quando a ocorrência era
apenas metadado de dependência; nenhum manifesto (`package.json`, `api/package.json`
ou `cron/package.json`) contém dependência Payload, CMS ou Owner News.

## Classificação nominal

| Ocorrência | Classificação | Decisão | Prova/consumidores |
| --- | --- | --- | --- |
| `public/js/cms-editor-values.js` | `DELETE` | Removido | Nenhum import ou referência nominal; a única menção a `normalizeEditorBlocks` está em documentação histórica. |
| `tests/helpers/cms-harness.mjs` | `SHARED_RENAME` | Renomeado para `tests/helpers/maintained-page-harness.mjs` | `tests/helpers/knowledge-editorial-harness.mjs` e `tests/unit/reminder-delivery-ui.test.mjs` importam o helper; o helper monta páginas mantidas e bloqueia chamadas CMS como guarda negativa. |
| `tests/unit/cms-frontend.test.mjs` | `SHARED_RENAME` | Renomeado para `tests/unit/maintained-frontend-contract.test.mjs` | Testa Knowledge, Academy, Benefits, Reminders e Dashboard mantidos; não importa nem executa runtime CMS. |
| `tests/unit/cms-removal-contract.test.mjs` | `ACTIVE_CONTRACT` | Preservado | Verifica ausência de arquivos/rotas CMS, 404 controlado, ausência de grants e inacessibilidade histórica de uploads. |
| `tests/unit/portal-without-editorial.test.mjs` | `ACTIVE_CONTRACT` | Preservado | Verifica ausência do runtime Owner News, URLs antigas e respostas 404 sem SQL. |
| `api/db/migrations/015*`, `019*`, `033*`, `034*`, `035*` | `HISTORICAL_MIGRATION` | Preservadas | Ledger, checksums e compatibilidade foram aprovados no OWN-43. |
| `docs/architecture/owner-news-api.md`, `docs/operations/owner-news-*.md` e relatórios anteriores | `HISTORICAL_DOCUMENTATION` | Preservados | Registram decisões, importações e aceites passados; não são consumidores do runtime. |
| ocorrências de `Payload` em validação HTTP/Sólides/AutoCard | `ACTIVE_RUNTIME_TERM` | Preservadas | Referem payloads genéricos de APIs mantidas, não Payload CMS. |

## Alterações da OWN-44

- Removido somente `public/js/cms-editor-values.js`, sem consumidor ativo.
- Renomeado o helper compartilhado para retirar o nome enganoso de CMS; imports
  ativos foram atualizados nominalmente.
- Renomeado o teste compartilhado de frontend para refletir as áreas mantidas.
- Nenhuma dependência, lockfile, migration, tabela, upload, rota, dado histórico ou
  arquivo operacional com consumidor de produção foi removido; o único arquivo
  frontend distribuído excluído não tinha consumidor runtime ativo.

## Verificação pendente do gate

- Suíte afetada: `node --test tests/unit/maintained-frontend-contract.test.mjs
  tests/unit/editorial-guidance.test.mjs tests/unit/reminder-delivery-ui.test.mjs
  tests/unit/cms-removal-contract.test.mjs tests/unit/portal-without-editorial.test.mjs`
  — 48 testes, 48 PASS, 0 falhas.
- `npm run verify` — 808 testes: 806 PASS, 0 falhas e 2 skips de plataforma;
  `verify: security`, `verify: compose` e `verify: ok`.
- `git diff --check` — PASS.
- Nenhum import residual de `cms-harness`, `cms-editor-values` ou
  `cms-frontend.test` fora de documentação histórica foi encontrado após o
  rename/delete.

OWN-44 permanece em revisão até uma revisão Astra medium; OWN-45 só será iniciada
após `ship` explícito.
