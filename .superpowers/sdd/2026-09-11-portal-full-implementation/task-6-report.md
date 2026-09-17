# Task 6 — Lembretes e cron

## Status

Implementado e corrigido após o fix round no worktree `feature/task-6-cron-gates`,
revisado com `PASS` e integrado à `main` no checkpoint `512d115`. Nenhum
serviço Docker ou externo foi iniciado.

## Entregas

- Datas civis usam `America/Sao_Paulo` no cron, API, dashboard e histórico;
  datas `DATE` usadas pelo cron e pela API são convertidas explicitamente para
  texto antes de atravessar a fronteira JavaScript.
- Ocorrências não são processadas antes do instante de criação do lembrete;
  catch-up continua limitado a sete datas concluídas.
- O ledger grava `sending` antes do envio, mantém `attempt_count` entre
  reinícios, permite até três tentativas para falhas transitórias conhecidas e
  mantém uma ocorrência por lembrete, usuário, data civil e canal.
- Resultado SMTP sem evidência de aceite é `unknown`/ambíguo; códigos 4xx
  transitórios podem voltar a `pending`, códigos 5xx encerram como `failed`,
  estados contraditórios do mesmo destinatário em `accepted`/`rejected`/`pending`
  também são `unknown`, e o mailer não registra sucesso antes da resposta do
  transporte.
- Antes do SMTP, o cron valida o lembrete/CMS e então relê o usuário por UID,
  mantém sua linha bloqueada com `FOR UPDATE` até o commit da decisão e usa
  email/nome atuais; usuário removido/desativado, com
  `firebase_enable_pending`, sem email ou fora da audiência corrente encerra a
  ocorrência como `skipped` e não usa o snapshot obsoleto. Booleano e string
  `'true'` de `permissions.accountDisabled` seguem o mesmo gate do auth.
- Heartbeat, resultado da execução e resultado de entrega ficam separados;
  `/api/reminders/cron-status` expõe `execution_status` e `delivery_status`;
  erros operacionais propagam para o estado de execução e não atualizam
  `last_success_at`; o healthcheck modela `running` e só envia recovery após
  execução concluída sem erro.
- O reaper encerra `sending` e `pending` órfãos deixados por `ON DELETE SET NULL`
  como `skipped`, com motivo `reminder_removed`/`recipient_removed` antes do
  timeout genérico, e inclui ocorrências recuperadas nos totais da execução.
- O provisionamento concede ao `portal_cron` somente `SELECT, UPDATE` em
  `users`/`reminders`, necessários aos `FOR UPDATE`; verificadores e o teste de
  migrations confirmam o privilégio sem ampliar INSERT/DELETE.
- Motivos de skip são preservados no `notifications_log.last_error` (por
  exemplo, `reminder_removed`, `recipient_disabled` e
  `content_not_published`) e aparecem como `reason` somente no histórico
  administrativo autenticado.
- Audiência vazia, UIDs inválidos/duplicados e acima de 500 são rejeitados.
  Novos writes aceitam somente `email`; `whatsapp`/`both` permanecem apenas
  como histórico ou estado legado, sem envio real.
- O conteúdo enviado inclui link absoluto para
  `/reminders.html#reminder-<uuid>`, com UUID validado e
  `PORTAL_PUBLIC_URL` configurável. `GET /api/reminders/:id` aplica auth,
  audiência, `active` e publicação CMS; a página busca e renderiza o detalhe
  pelo fragmento sem alterar a paginação atual.
- O histórico administrativo mostra lembrete, destinatário, motivo, número
  de tentativas, filtros e paginação server-side.
- Foram cobertos idempotência, falha isolada, retry transitório, restart,
  retry por resultado SMTP, resultado SMTP ambíguo/contraditório, propagação de
  erro de finalização, motivos distintos de skip, recovery de `sending` órfão
  antes/depois do timeout, catch-up, vigência e execução sem candidatos.

## Arquivos alterados

- `api/cms/blocks.js`
- `api/db/provision.js`
- `api/db/verify-migrations.js`
- `api/route-utils.js`
- `api/routes/reminders.js`
- `cron/checkReminders.js`
- `cron/health.js`
- `cron/mailTransport.js`
- `cron/scheduling.js`
- `cron/sendEmail.js`
- `tests/unit/cron-mail-transport.test.mjs`
- `docker-compose.yml`
- `docs/architecture/data-flow.md`
- `docs/operations/deployment.md`
- `docs/product/feature-inventory.md`
- `public/js/dashboard.js`
- `public/js/reminders.js`
- `public/reminders.html`
- `scripts/test-migrations.mjs`
- `tests/unit/api-routes.test.mjs`
- `tests/unit/cron.test.mjs`
- `tests/unit/frontend-invariants.test.mjs`
- `tests/unit/notification-scheduling.test.mjs`
- `tests/unit/operations-invariants.test.mjs`
- `tests/unit/schema-invariants.test.mjs`

Nenhuma migration nova foi necessária: `notifications_log`, `cron_status`,
`attempt_count`, `claimed_at`, `finished_at` e o estado `sending` já existem no
schema fresh e nas migrations aplicadas.

## Verificação

Executado no worktree:

```text
git diff --check
node scripts/verify.mjs syntax
node scripts/generate-public-shell.mjs --check
node --test tests/unit/cron.test.mjs tests/unit/notification-scheduling.test.mjs tests/unit/api-routes.test.mjs tests/unit/cms-blocks.test.mjs tests/unit/cms-contracts.test.mjs tests/unit/cms-frontend.test.mjs tests/unit/frontend-invariants.test.mjs tests/unit/cron-mail-transport.test.mjs tests/unit/operations-invariants.test.mjs tests/unit/schema-invariants.test.mjs
```

Resultados:

- `git diff --check`: passou.
- `node scripts/verify.mjs syntax`: `verify: ok`.
- `node scripts/generate-public-shell.mjs --check`: passou sem saída.
- Suíte focada: **169 testes pass, 0 falhas, 0 cancelados, 0 skipped**.
- Após o checkpoint `512d115`, `npm run verify` passou: suíte completa com
  **351 testes pass, 0 falhas, 0 cancelados, 0 skipped**, além de syntax,
  security e compose checks.

## Limitações conhecidas

- A recuperação de `sending` com mais de uma hora marca a ocorrência como
  `failed` e não reenvia, pois o resultado do provedor é ambíguo após uma
  interrupção. Outbox ou idempotência no provedor seriam necessários para
  garantia de entrega sem duplicidade.
- Não houve homologação contra PostgreSQL real, SMTP real ou navegador; a
  validação foi unitária/estática e não substitui a aceitação operacional.
- `whatsapp` não é implementado; ocorrências históricas desse canal continuam
  podendo aparecer como `skipped` no ledger/histórico.
