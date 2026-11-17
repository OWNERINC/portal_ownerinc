# Portal Readiness Implementation Plan

> **For agentic workers:** Use the loaded subagent-driven-development workflow
> with the Sol Advisor implementation lane: one bounded implementation worker
> for Task 1, followed by fresh read-only review. The primary session owns
> documentation, inspection, verification and acceptance.

**Goal:** corrigir os defeitos confirmados de disponibilidade e integridade do
Portal, sem confundir correção de código com homologação de 100 usuários.

**Architecture:** preservar Express/PostgreSQL/Firebase e as fronteiras atuais.
Separar orçamento agregado de identidade validada, devolver conexões antes de
nova aquisição, conservar precisão SQL e distinguir resultado incerto de rollback
confirmado. Um único pacote revisável reúne os ajustes porque os helpers de
autenticação, convite/retenção e transação são compartilhados pelos testes.

**Tech Stack:** CommonJS na API, testes `node:test` em ESM, `pg`/`pg-pool`
instalados, Nginx e PGlite externo apenas para SQL descartável.

## Global Constraints

- Especificação aprovada na página “Especificação das correções”:
  `docs/superpowers/specs/2026-11-17-portal-readiness-design.md`.
- Base `dfe991db`; branch `fix/portal-readiness`; spec commit `cee81d0`.
- Orçamentos API: 30.000/IP/15 minutos e 300/UID validado/15 minutos.
- Preservar escrita 60/UID/15 minutos, progresso 120/UID/15 minutos,
  foto 10/UID/15 minutos, cadastro/recuperação 5/IP/hora.
- Nginx API 20r/s, burst 500; uploads 60r/m, burst 20; mídia 60r/s, burst 500.
- Identidade para rate limit vem da verificação Firebase com revogação.
- Manter LF nos arquivos Linux e compatibilidade da sintaxe com Node 18.
- Sem novas dependências de runtime ou migrations.
- Sem mudanças em frontend, documento oficial de Ética, arte/PDF, capturas,
  deploy, produção, backups, A18, Brain ou ownerinc-novo-agente.
- Não iniciar Docker/serviços nem usar dados, Firebase ou SMTP reais.
- Não fazer push, merge ou deploy. Commits de código somente após checks.
- A documentação factual não altera bases legais, prazos ou recibos de retry.

## Steps

- [x] Desenho aprovado, branch preparada e baseline verificado.
- [x] Task 1: implementação e regressões do pacote.
- [x] Inspeção primária, documentação e verificações.
- [ ] Revisão independente e correções delimitadas.
- [ ] Registro de aceite e entrega da branch.

### Task 1: Correções localizadas de prontidão

**Files — implementation worker:**

- Modify: `api/index.js`, `api/middleware/security.js`,
  `api/middleware/auth.js`.
- Modify: `api/routes/users.js`, `api/services/user-invitation.js`,
  `api/services/pending-registration.js`.
- Modify (ajuste de caller confirmado): `api/routes/registrations.js`, para
  descartar o client fornecido antes de executar `afterRelease`.
- Modify: `api/routes/upload.js`, `api/routes/autocard.js`,
  `api/routes/pos-cards.js`, `api/route-utils.js`.
- Modify: `nginx/nginx.conf`.
- Create: `tests/unit/readiness-rate-limit.test.mjs`,
  `tests/unit/readiness-pool.test.mjs`,
  `tests/unit/readiness-upload.test.mjs`.
- Create: `tests/database/check-registration-retention.mjs`.
- Create if needed: `tests/helpers/readiness-harness.mjs`.
- Modify: existing affected unit tests, especially `pending-registration`,
  `user-invitation-delivery`, `api-security`, `api-routes` and auth/ethics tests.
  Changes must reflect the new contract, not delete meaningful assertions.

**Files — primary session only:**

- This plan and its progress ledger.
- `docs/product/privacy-retention.md`.
- `docs/operations/readiness-capacity.md`.
- `docs/reviews/2026-11-17-portal-readiness.md`.

**Interfaces:**

- Existing `rateLimit({windowMs, max, key})` remains middleware
  `(req, res, next)`. Rejections keep JSON and add `Retry-After`.
- `authMiddleware` still populates `req.user` only from the database;
  the UID request budget uses verified Firebase identity.
- `enableActiveUser({pool, client?, uid, email, requestId})` keeps existing state
  results and ownership semantics. A provided client is never silently released.
- `lockPendingRegistrationIdentity` returns the existing registration fields
  plus textual `created_at_key` from locked SQL.
- `withAudit(...)` preserves successful results. Failed transaction errors may
  expose boolean `commitAmbiguous` and `rollbackAmbiguous`; those flags are
  internal and never raw responses to the client.
- Upload handlers do not delete a new file if their transaction is confirmed
  or its outcome cannot be established.

#### A. Test scaffolding and traffic

- [x] Read repository instructions, spec and actual callers.
- [x] Add executable tests using the existing isolated-module pattern
  (`new Function` plus bounded dependency overrides); preserve real middleware,
  policy and route logic. No global Firebase/DB connection initialization.
- [x] Add 100-UID same-IP, single-UID abuse, independent UID, invalid/revoked
  token, disabled/pending account, ethics, window expiry and Retry-After cases.
  Use a controlled clock restored in `finally`.

The limiter header calculation must preserve the original window:

```js
const seconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
res.setHeader('Retry-After', String(seconds));
return res.status(429).json({ error: 'Too many requests.', requestId: req.id });
```

The authenticated budget is constructed from validated identity, not token text:

```js
const requestLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  key: req => req.firebaseUser.uid,
});
```

Apply it after `verifyIdToken(..., true)` succeeds. Continue the existing SQL,
policy, account and ethics gates before exposing route access. Avoid turning
async continuation failures into unhandled promises: keep the middleware's
await/catch contract explicit.

- [x] Run the new test before the production fix; record the expected NAT failure.
- [x] Implement API budgets and headers, then update Nginx zones/bursts exactly
  as Global Constraints. Preserve all location precedence, body caps, forwarded
  headers, media isolation and LF.
- [x] Run the new tests and existing auth/security/ethics coverage.

#### B. Pool lifecycle

- [x] Adapt the external pool diagnostic into a versioned regression resolving
  modules from this worktree, not `C:/PROJETOS/_ownerinc_portal`.
- [x] Use real installed `pg-pool` with a fake EventEmitter Client. Match
  UID/email, start with `firebase_enable_pending=true`, and provide a fake
  Firebase successful enable.
- [x] Synchronize initial creation so pool-size concurrent requests exercise the
  acquisition interleaving. Require all responses and a concurrent `SELECT 1`
  to complete, with zero waiting/checked-out clients. Never add slots or release
  another owner's client to make the assertion pass.
- [x] Test pool sizes 2 and default 10, plus definite rollback, ambiguous COMMIT,
  enable error and ambiguous enable commit. Record exactly-once release/discard.
- [x] Demonstrate the old handler fails to settle before changing it.

Use explicit ownership transfer in the handler:

```js
function releaseClient(discard = false) {
  const held = client;
  client = null;
  held?.release(discard);
}
```

After confirmed creation COMMIT, call `releaseClient()` before
`enableActiveUser({pool, ...})`. In failure, finish attempted rollback and
release/discard before compensation can acquire a pool connection.

- [x] Read every `enableActiveUser` caller. In its owned-client failure path,
  avoid acquiring a fresh client while retaining an unusable one.
- [x] Prefer a safe provided/current client for pending-marker persistence.
  For an ambiguous provided client, propagate discard without taking ownership
  or reusing its connection. Preserve the already-persisted pending marker and
  fake Firebase disable compensation.
- [x] Run pool regressions and existing invitation/registration tests.

#### C. Timestamp identity and SQL

- [x] Add a unit case asserting DELETE binds the exact textual microsecond key
  and another asserting unexpected zero-row deletion increments failures.
- [x] In the locked SELECTs, retain the original Date field for consumers and
  add `created_at::text AS created_at_key`.
- [x] Bind the locked row's key in retention:

```js
[registration.id, registration.firebase_uid, registration.status,
 registration.created_at_key]
```

- [x] Treat `result.rowCount !== 1` as an error before COMMIT. Let the existing
  failure path rollback and count the failure; do not swallow it.
- [x] Build SQL regression with unmodified migrations 025/027/028, pg parser/bind
  and fake Firebase, preserving recent and referenced accounts.
- [x] Assert micros `.123456`, aligned `.123000`, pending/rejected/approved,
  cleanup retry and a 101-row fixture. Two runs must reach the later record.
- [x] Run unit and SQL regressions. SQL runner requires `PGLITE_MODULE_PATH`,
  creates only disposable memory state and prints that it is not native PG16.

#### D. Upload transaction outcome

- [x] Add executable route tests for each of profile/AutoCard/Cards Pós using
  real handlers and real `withAudit`, with in-memory filesystem/SQL.
- [x] Cover success, failure before COMMIT with confirmed rollback, rollback
  failure, COMMIT persisted then ACK lost, and response failure after confirmed
  COMMIT. Assert reference/bytes consistency and release/discard once.
- [x] Observe the old ACK-lost cases fail the preservation assertion.
- [x] Track COMMIT attempt/completion explicitly in `withAudit` and the photo
  transaction. Tag ambiguity and discard on uncertain outcome. Do not treat
  ROLLBACK after a sent COMMIT as proof the transaction did not persist.
- [x] Track completion in media routes before constructing the response:

```js
let committed = false;
// After withAudit resolves:
committed = true;
// Catch cleanup condition:
if (storageKey && !committed && !error.commitAmbiguous && !error.rollbackAmbiguous) {
  await fs.unlink(path.join(uploadDirectory, storageKey)).catch(() => {});
}
```

- [x] In the photo path, preserve both new and prior file after ambiguous COMMIT;
  remove the prior only after success. Preserve new bytes on response failure.
- [x] Run the new upload tests and all existing `withAudit`/cards regressions.

#### E. Full verification and handoff

- [x] Run targeted tests and `npm run verify`; fix only affected-contract failures.
- [x] Run `npm run check:pages-build` and `git diff --check`.
- [x] Use an available non-service Nginx validator; if unavailable, document
  static checks and leave native Nginx validation pending rather than starting
  Docker or reporting an unexecuted check.
- [x] Self-review runtime diffs against spec, inspect new tests for real failures
  and confirm no secrets, generated artifacts or unrelated files.
- [x] Commit only owned code/tests/config after required checks pass. Do not
  stage primary-session documentation or scratch reports.
- [x] Write an implementation report with changed paths, commands, exact
  results, pre-fix failures, residual limitations and commit SHAs.

## Primary acceptance and documentation

- [x] Inspect the actual diff, rerun targeted checks and required full verify.
- [x] Update privacy text with factual exceptions; add traffic/recovery operator
  guidance and acceptance evidence, distinguishing local PASS from native/
  production/hardware checks not executed.
- [ ] Generate a diff package from `dfe991db` through the implemented revision.
- [ ] Fresh reviewer checks spec compliance and quality, returns `ship`,
  `fix-first` or `rethink`. Corrections go to the same implementation worker.
- [ ] Record the review, accepted outcome and remaining capacity gates.

## Diagnostic references

Implementação entregue em `dc2f979`. Verificação primária: 1264 PASS/4 SKIP/0 FAIL
com Compose config, 112 testes direcionados PASS, SQL de retenção PASS, SQL Pages
3 PASS, SQL Ética PASS, build Pages e diff check PASS. Nginx nativo indisponível.
Evidência detalhada e limites no
[`registro de aceite`](../../reviews/2026-11-17-portal-readiness.md).

Read the scripts/results under:

`C:/Users/Criação/AppData/Local/Temp/opencode/portal-recheck-20261117-95645d19-a43c-44cc-b222-5f461b33aab3/`

Files: `availability.cjs`, `uploads.cjs`, `retention.cjs`, `erasure.cjs` and JSONs.
They reproduce the old bugs and hardcode the old main checkout. Adapt their
method, not their paths, and invert defect assertions into corrected invariants.

External PGlite module already installed:

`C:/Users/Criação/AppData/Local/Temp/opencode/consent-db-tools/node_modules/@electric-sql/pglite/dist/index.js`

Baseline on this branch: 1220 PASS, 4 SKIP, 0 FAIL, log
`portal-readiness-baseline-92d4fc92-3f2b-4432-99d4-d797feef0acd.log` in Temp/opencode.
