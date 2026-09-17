# Task 4 Findings Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir os cinco findings confirmados da Task 4 e cobrir cada contrato com testes de regressao.

**Architecture:** Manter a API Express, o frontend estatico e os servicos atuais. Reutilizar os advisory locks e os fluxos de compensacao existentes, adicionando apenas guards locais, referencias por UID exato, o marcador de reativacao e o tratamento central de respostas autenticadas.

**Tech Stack:** Node 24, Express, Firebase Admin mockado nos testes, PostgreSQL query mocks, JavaScript estatico e `node:test`.

## Global Constraints

- Nao iniciar Docker, PostgreSQL, Firebase ou qualquer servico externo.
- Nao criar migration, dependencia ou servico novo.
- Nao alterar Tasks 5+.
- Nao criar commit.
- Preservar resposta publica 202 anti-enumeracao.
- Rodar `npm run verify` e `git diff --check` antes do relatorio.

---

### Task 1: Allowlist de razao 503

**Files:**
- Modify: `api/middleware/security.js:40-51`
- Test: `tests/unit/api-security.test.mjs`

**Interfaces:**
- Produces: respostas 5xx genericas, exceto `reason: 'firebase_identity_indeterminate'`, que permanece disponivel para a UI administrativa.

- [x] **Step 1: Escrever o teste de falha**

  Exercitar `safeResponses` com status 503 e verificar que a razao Firebase permitida permanece, enquanto uma razao arbitraria e removida.

- [x] **Step 2: Executar o teste isolado**

  Run: `node --test tests/unit/api-security.test.mjs`
  Expected: FAIL antes da implementacao porque `safeResponses` remove todos os campos alem de `error` e `requestId` em 5xx.

- [x] **Step 3: Implementar a allowlist minima**

  Em `safeResponses`, preservar somente a razao literal `firebase_identity_indeterminate` ao montar o corpo generico de 5xx; nao repassar mensagem, UID ou qualquer outro campo.

- [x] **Step 4: Executar o teste novamente**

  Run: `node --test tests/unit/api-security.test.mjs`
  Expected: PASS.

### Task 2: Duplicidade local e cleanup por UID

**Files:**
- Modify: `api/services/pending-registration.js:87-106,193-219`
- Modify: `api/services/user-invitation.js:190-217,601-641`
- Test: `tests/unit/pending-registration.test.mjs`
- Test: `tests/unit/user-invitation-delivery.test.mjs`

**Interfaces:**
- Consumes: o lock de e-mail de `lockFirebaseIdentity` e os parametros atuais `uid`, `email` e `pendingRegistrationId`.
- Produces: nenhum `firebaseAuth.createUser` quando `users` ja possui o e-mail; cleanup que protege apenas referencias do UID solicitado.

- [x] **Step 1: Adicionar regressao para cadastro pendente**

  Mockar `SELECT 1 FROM users` com uma linha depois do lock de e-mail e verificar que `createPendingRegistration` rejeita sem chamar `firebaseAuth.createUser`.

- [x] **Step 2: Adicionar regressao para recuperacao**

  Mockar `getUserByEmail` como ausente e `SELECT 1 FROM users` como existente; verificar que `recoverPendingRegistration` retorna `false` e nao cria Firebase.

- [x] **Step 3: Adicionar regressao para convite**

  Mockar `SELECT 1 FROM users` como existente antes de `createInvitedUser`; verificar que a criacao Firebase nao e chamada e o erro segue o caminho de duplicidade existente.

- [x] **Step 4: Adicionar regressao para cleanup com e-mail compartilhado**

  Fazer Firebase retornar a identidade nova e `users` retornar somente outro UID com o mesmo e-mail; verificar que `deleteUser(novoUid)` e chamado. Em outro caso, retornar o UID solicitado e verificar que ele e preservado.

- [x] **Step 5: Executar os testes de servico antes da implementacao**

  Run: `node --test tests/unit/pending-registration.test.mjs tests/unit/user-invitation-delivery.test.mjs`
  Expected: FAIL nos novos cenarios.

- [x] **Step 6: Implementar os guards e a consulta exata**

  Consultar `users` por `lower(email)` apos o lock e antes de `createUser`; em recovery, executar a consulta mesmo quando `firebaseUser` for nulo; em cleanup, usar `uid = $1` para usuarios e `firebase_uid = $1` para registros, mantendo a exclusao da propria `pendingRegistrationId`.

- [x] **Step 7: Executar os testes de servico novamente**

  Run: `node --test tests/unit/pending-registration.test.mjs tests/unit/user-invitation-delivery.test.mjs`
  Expected: PASS.

### Task 3: Reativacao limpa o marcador

**Files:**
- Modify: `api/routes/users.js:296-302`
- Test: `tests/unit/governance-routes.test.mjs`

**Interfaces:**
- Produces: uma reativacao bem-sucedida deixa `permissions.accountDisabled` removido e `firebase_enable_pending = FALSE` no mesmo UPDATE.

- [x] **Step 1: Adicionar assercao de contrato**

  Restringir o trecho da rota `/:uid/reactivate` e verificar que o UPDATE inclui `firebase_enable_pending = FALSE` junto da remocao de `accountDisabled`.

- [x] **Step 2: Implementar o UPDATE combinado**

  Alterar somente o SET do UPDATE de reativacao; manter a ordem externa Firebase, update local, auditoria e commit.

- [x] **Step 3: Executar o teste**

  Run: `node --test tests/unit/governance-routes.test.mjs`
  Expected: PASS.

### Task 4: Redirecionamento central de sessao

**Files:**
- Modify: `public/js/auth.js:108-132,184-207`
- Test: `tests/unit/frontend-invariants.test.mjs`

**Interfaces:**
- Produces: qualquer `authenticatedFetch` que receba 401 ou um 403 de estado de autenticacao limpa estado, executa sign-out e chama `redirectToLogin` com a razao normalizada e o destino atual; 403 de permissao comum nao encerra a sessao; `requireAuth` apenas retorna apos o redirect.

- [x] **Step 1: Adicionar assercoes do contrato**

  Verificar que o tratamento de 401 e dos 403 de autenticacao esta em `authenticatedFetch`, que chama `clearVerifiedRole`, `signOut` e `redirectToLogin`, e que `requireAuth` nao contem um segundo redirect para a mesma resposta.

- [x] **Step 2: Implementar o handler compartilhado**

  Ler o corpo via `response.clone()`, normalizar as razoes existentes (`email`, `pending-approval`, `enable-pending`, `account-disabled`, `access`, `session`), considerar 403 sem razao somente em `/api/users/me`, limpar o estado, fazer sign-out tolerante a falha e redirecionar preservando `next`.

- [x] **Step 3: Manter erros de rede no fluxo atual**

  Nao redirecionar falhas sem resposta HTTP; deixar `requireAuth` renderizar `renderAuthUnavailable` para indisponibilidade da API.

- [x] **Step 4: Executar os testes frontend**

  Run: `node --test tests/unit/frontend-invariants.test.mjs`
  Expected: PASS.

### Task 5: Verificacao final

**Files:**
- Test: todos os arquivos alterados acima.

- [x] **Step 1: Rodar todos os testes**

  Run: `node --test tests/unit/*.test.mjs`
  Expected: todos os testes PASS.

- [x] **Step 2: Rodar verificacao do repositorio**

  Run: `npm run verify`
  Expected: `syntax`, `tests`, `security` e `compose` PASS sem iniciar servicos.

- [x] **Step 3: Validar whitespace**

  Run: `git diff --check`
  Expected: nenhuma saida e status 0.

- [x] **Step 4: Revisar escopo**

  Confirmar que nao foram adicionadas migrations, dependencias, alteracoes de Tasks 5+ ou commit; registrar no relatorio os testes executados e os riscos de integracao externa restantes.
