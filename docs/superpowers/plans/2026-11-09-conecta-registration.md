# Conecta — plano de implementação do novo cadastro

## Steps

- [ ] Proteger logs de autenticação e estabelecer o harness HTTP de regressão.
- [ ] Aceitar a senha inicial e tornar repetição/reconstrução de cadastro seguras.
- [ ] Unificar recuperação de senha para contas ativas e cadastros pendentes.
- [ ] Atualizar formulário, mensagens e comportamento assíncrono do login.
- [ ] Comprovar aprovação, bloqueios de acesso e compatibilidade por regressões.
- [ ] Atualizar documentação e concluir o aceite automatizado local.
- [ ] Homologar a jornada externa somente com autorização e contas de teste.

> **For agentic workers:** executar tarefa por tarefa, usando os checkboxes deste
> plano. A sessão principal mantém a responsabilidade pelo diff e pelos gates.
> Se o usuário escolher execução delegada, usar a skill disponível
> `subagent-driven-development`; não iniciar subagentes só por abrir este plano.
> Não executar este documento durante sua redação/revisão.

**Goal:** permitir nome/e-mail/senha no cadastro, confirmação por e-mail e
aprovação administrativa antes do primeiro login, preservando a senha escolhida.

**Architecture:** manter o provisionamento no Express com Firebase Admin, sem
autenticar o navegador durante o cadastro. Firebase permanece desabilitado até a
aprovação persistida; PostgreSQL guarda apenas metadados e decisões. Reutilizar
locks, compensação, recuperação por e-mail e reconciliação existentes, com
alterações localizadas em vez de um novo subsistema de autenticação.

**Tech Stack:** JavaScript CommonJS no Express, Firebase Admin, PostgreSQL via
`pg`, Nodemailer/SMTP, frontend HTML/CSS/ES modules, `node:test` e Supertest já
presente em `api/devDependencies`. Nenhuma dependência nova.

**Fonte normativa:**
[`2026-11-09-conecta-registration-design.md`](../specs/2026-11-09-conecta-registration-design.md),
commit `5887714`. Pedido de redação do plano recebido após a apresentação dessa
especificação. As tarefas abaixo ainda não foram executadas.

## Global Constraints

- Sem acesso até aprovação; não criar sessão de acompanhamento, tela autenticada
  de status nem acesso parcial ao Portal. O e-mail é o login.
- Senha inicial entre 12 e 128 unidades UTF-16, sem trim/normalização, permitindo
  espaços/Unicode e rejeitando valor composto apenas por espaços em branco.
- Senha e confirmação usam `autocomplete="new-password"`; confirmação fica no
  navegador. Não bloquear colagem nem gerenciador de senhas.
- Senhas não vão a SQL, logs, auditoria, URLs, storage, e-mails, respostas ou filas.
- Manter `emailVerified: false` e `disabled: true` na criação da identidade.
- Manter HTTP 202 `{ status: 'accepted', state: 'received' }` no cadastro aceito e
  em duplicidades tratadas; campos inválidos retornam 400, limites 429 e falhas
  operacionais 503. Middleware global pode normalizar o texto de erros 5xx.
- Cadastro sem senha de cliente antigo passa a retornar 400; solicitações antigas
  persistidas continuam válidas. Repetir cadastro não redefine senha.
- Aprovação exige `manageUsers`, e-mail confirmado, cargo ativo e contrato válido;
  cria somente `viewer`. Preservar `firebase_enable_pending` e não reativar
  desativação administrativa.
- Preservar `/api/auth/registration-password`, convites, CSV, rejeição, retenção,
  privilégios, bootstrap e separação `api/`, `cron/`, `public/`, `nginx/`.
- Sem migration, coluna de senha, novo marcador, aviso automático de aprovação,
  MFA/login social, username separado ou mudança em deploy.
- Não introduzir APIs/sintaxe que exijam mais que Node 18 nas mudanças de runtime;
  não alterar os `engines`/lockfiles atuais (o manifesto da API declara Node 24).
  Executar os checks com o ambiente suportado já preparado no checkout.
- Ler `README.md`, `docs/product/brief.md` e a especificação antes de implementar.
  Preservar trabalho alheio; não usar `git add .`, reset ou checkout destrutivo.
- Não iniciar Docker, serviços locais/produção, nem reiniciar a prévia cancelada
  na porta 4180. Testes HTTP em loopback efêmero não são um deploy/stack local.
- As tarefas 1–6 formam um candidato local completo. Não publicar commits
  intermediários com backend e formulário em contratos diferentes.
- `npm run verify` e `git diff --check` são gates de conclusão; mocks não comprovam
  entrega SMTP, verificação no Firebase ou primeiro login real.

## Mapa de arquivos e responsabilidades

| Arquivo | Ação e responsabilidade |
| --- | --- |
| `api/middleware/security.js` | Redigir logs das rotas públicas de autenticação, inclusive JSON inválido, preservando status e request ID. |
| `api/middleware/validation.js` | Validar exatamente nome/e-mail/senha e os limites da senha. |
| `api/routes/auth.js` | Transportar senha somente até criação, preservar contratos e despachar recuperação ativa/pendente. |
| `api/services/pending-registration.js` | Criação com senha escolhida, repetição sem mutar credenciais/decisões e reconstrução controlada de identidade ausente. |
| `api/services/user-invitation.js` | Apenas saneamento de logs/last_error nos helpers compartilhados de limpeza/habilitação alcançados pelo cadastro; manter regras de convite e locks. |
| `api/integrations/password-reset-email.js` | Instruções de confirmação e recuperação pendente, com escape e sem promessa de liberação. |
| `public/login.html`, `public/js/login.js` | Cadastro com senha/confirmar, recuperação única e guardas de envio/limpeza. |
| `public/css/login.css` | Reaproveitar os estilos e remover apenas seletores exclusivos do formulário legado retirado. |
| `tests/helpers/registration-api-harness.mjs` | Novo harness que executa fontes reais com transportes externos injetados. |
| `tests/helpers/login-harness.mjs` | Novo harness para HTML/JS reais do login com DOM e Firebase simulados. |
| `tests/unit/registration-api.test.mjs` | Novo conjunto HTTP/validação/logs/recuperação. |
| `tests/unit/registration-recovery.test.mjs` | Novo conjunto comportamental de repetição/reconstrução e compensação. |
| `tests/unit/login-registration.test.mjs` | Novo conjunto comportamental do formulário e navegação. |
| `tests/unit/registration-access.test.mjs` | Novo conjunto de gates reais de autorização com dependências externas simuladas. |
| `tests/unit/pending-registration.test.mjs` | Atualizar expectativas antigas; conservar regressões de aprovação/rejeição/limpeza. |
| `tests/unit/password-reset-email.test.mjs`, `tests/unit/frontend-invariants.test.mjs` | Atualizar contratos de mensagem/UI quando existentes exigirem o caminho antigo. |
| `docs/product/feature-inventory.md`, `docs/architecture/overview.md` | Documentar o contrato efetivamente implementado, sem chamar mocks de homologação externa. |
| `docs/operations/registration.md` | Novo guia de admissão, recuperação e comunicação da liberação. |
| `docs/reviews/2026-11-09-conecta-registration.md` | Novo registro de resultados, limitações e gate externo. |

`api/middleware/auth.js`, `api/routes/registrations.js`, `public/js/admin.js`,
`api/services/bulk-user-import.js` e os testes de convite/importação são referências
de regressão. Não reescrever esses componentes sem um teste que demonstre necessidade.

---

## Tarefa 1 — Logs seguros e harness HTTP isolado

**Entrega:** executar os endpoints reais sem PostgreSQL/Firebase/SMTP e provar que
credenciais não escapam pelo parser JSON, erros do provedor ou compensação.

**Arquivos:** criar `tests/helpers/registration-api-harness.mjs` e
`tests/unit/registration-api.test.mjs`; modificar `api/middleware/security.js` e
os pontos de log/`last_error` em `api/routes/auth.js`,
`api/services/pending-registration.js`, `api/services/user-invitation.js`.

**Interfaces:** o helper exporta
`createRegistrationApiHarness(t, { query, firebase, serviceOverrides } = {})`.
Retorna `{ request, app, pool, auth, registrations, sql, logs, messages, releases }`.
`request` é Supertest do app real; `registrations` são exports reais do serviço;
`sql` contém `{ sql, params }`; `logs` contém strings; `messages` contém mensagens
capturadas pelo Nodemailer simulado; `releases` registra descarte de conexões.
`query(sql, params)` retorna `{ rows, rowCount }`; `firebase` fornece os métodos
chamados naquele caso. Método externo não configurado deve lançar erro, nunca
usar credenciais da máquina. `serviceOverrides` substitui somente funções
específicas em testes de erro/limites, não o serviço inteiro nos testes de jornada.

- [ ] **1.1 Registrar o baseline e conferir o checkout.**

  Rodar separadamente `git status --short`, `git log -4 --oneline`,
  `npm run verify` e `git diff --check`. O último baseline registrado foi
  826 PASS, zero FAIL e 2 SKIP Linux; não assumir que essa contagem permanece
  idêntica. Preservar PodFalar no login e os arquivos WIP de fixtures/mídia.
  Se a branch mudar ou houver edição concorrente nos arquivos-alvo, interromper
  para reconciliar o destino, sem mover a sessão para outra árvore sem acordo.

- [ ] **1.2 Criar o helper sem copiar lógica de autenticação.**

  Usar a abordagem de fonte CommonJS integral de
  `tests/helpers/api-dependency-harness.mjs`. Núcleo do carregador:

  ```js
  import { readFile } from 'node:fs/promises';
  import { createRequire } from 'node:module';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';

  const root = fileURLToPath(new URL('../../api/', import.meta.url));
  async function load(relative, dependencies, env, testConsole) {
    const filename = path.join(root, relative);
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    const injectedRequire = name => dependencies.has(name)
      ? dependencies.get(name) : localRequire(name);
    const source = await readFile(filename, 'utf8');
    new Function('require', 'module', 'exports', '__filename', '__dirname',
      'process', 'console', source)(injectedRequire, module, module.exports,
      filename, path.dirname(filename), { env }, testConsole);
    return module.exports;
  }
  ```

  Carregar nessa ordem: security real; auth real com `firebase-admin/app` fake
  (`getApps: () => [{}]`) e `getAuth: () => firebase`; mailer real com Nodemailer
  fake; user-invitation real; pending-registration real; routes/auth real;
  routes/registrations real. Injetar `pool` nos caminhos relativos exatos de cada
  módulo. `cert`/`initializeApp` fake lançam se chamados. Console fake captura
  `log/error/warn` sem imprimir as entradas sensíveis do teste.

  Montar `api/index.js` real com os três routers reais e os demais inertes,
  incluindo o formato `{ router, internalRouter }` de user-imports. Injetar
  dotenv vazio e apenas `validateEnvironment`/origens externas de teste; manter
  parser JSON, rateLimit, requestContext, safeResponses e errorHandler reais.
  Usar `PORTAL_PUBLIC_URL=https://portal.example.test` e remetente/SMTP fictícios
  somente dentro de `process` injetado. Não mudar `process.env` global.
  Supertest abre apenas portas efêmeras; fechar qualquer server explícito em
  `t.after`. Não mexer no cache global do Firebase.

- [ ] **1.3 Escrever testes RED de credenciais nos erros.**

  Em `registration-api.test.mjs`, importar `test`, `assert` e o novo helper.
  Teste central executável:

  ```js
  test('invalid registration JSON never appears in logs', async t => {
    const h = await createRegistrationApiHarness(t);
    const secret = 'TEST_ONLY_credential_123';
    const response = await h.request.post('/api/auth/register')
      .set('Content-Type', 'application/json')
      .send(`{"password":"${secret}",}`);
    assert.equal(response.status, 400);
    assert.ok(response.body.requestId);
    assert.equal(h.logs.join('\n').includes(secret), false);
    assert.equal(h.sql.length, 0);
  });
  ```

  Acrescentar: erro Firebase com `message` e `code` contendo a sentinela; falha
  SMTP; falha ao enfileirar compensação; erro de cleanup; provider response em
  `last_error`. A sentinela não aparece em logs/SQL/response, embora o fake de
  `createUser` a receba no teste de criação da tarefa 2. Entradas aqui são
  credenciais fictícias de teste, nunca valores reais do usuário. Até a tarefa 2,
  os casos não relacionados ao parser usam o payload válido atual `{ name, email }`
  e injetam a sentinela na exceção externa; na tarefa 2, passam a incluir também
  uma senha válida no payload. Não esperar que o contrato antigo aceite senha.

  Rodar `node --test tests/unit/registration-api.test.mjs`; esperar falha por
  conteúdo sensível no log do parser atual, não por import/harness quebrado.

- [ ] **1.4 Redigir logs sem mudar regras de autenticação.**

  Em security.js, identificar apenas as três rotas públicas, sem query string:

  ```js
  function isPublicAuthRequest(req) {
    const pathname = String(req.originalUrl || req.url || '').split('?')[0];
    return /^\/api\/auth\/(register|password-reset|registration-password)\/?$/
      .test(pathname);
  }
  ```

  Em `errorHandler` e `safeResponses`, nesses caminhos, usar motivos fixos como
  `auth_request_error`/`auth_handled_error`, junto de status e requestId, em vez
  de `err.message`/`body.error`. Preservar classificação JSON=400, excesso=413 e
  erro interno=500, e os contratos das outras rotas. Não logar body/URL completa.
  Nos catchs alcançados do cadastro, remover `error.message` e códigos externos
  não classificados; manter os nomes de evento fixos. No helper compartilhado de
  cleanup, substituir `last_error` externo por motivo fixo da operação, por
  exemplo `firebase_cleanup_delete_failed`, conservando fila, motivo e retries.
  Aplicar o mesmo saneamento aos caminhos de reconciliação alcançados; não
  alterar regras ou resposta de convite/importação.

- [ ] **1.5 Reexecutar e criar checkpoint de segurança.**

  Rodar `node --test tests/unit/registration-api.test.mjs tests/unit/user-invitation-delivery.test.mjs`.
  Esperado: PASS; falhas de erro persistem como falhas, só o diagnóstico fica
  limitado. Executar `git diff --check`. Commit sugerido:
  `test/security: prevent credential leakage in registration failures`.
  Staging explícito somente dos arquivos desta tarefa.

## Tarefa 2 — Senha inicial e repetição segura

**Entrega:** cadastro novo usa exatamente a senha informada; duplicidades nunca
alteram credenciais, data, nome ou decisão. Identidade ausente só é reconstruída
para uma solicitação pendente comprovada.

**Arquivos:** modificar `api/middleware/validation.js`, `api/routes/auth.js`,
`api/services/pending-registration.js`, `tests/unit/pending-registration.test.mjs`,
`tests/unit/registration-api.test.mjs`; criar `tests/unit/registration-recovery.test.mjs`.

**Interfaces:** manter
`validateRegistration(body): boolean`,
`createPendingRegistration({ client, data, requestId }): Promise<{ uid: string }>` e
`recoverPendingRegistration({ pool, data, requestId }): Promise<boolean>`.
`data` passa a ser `{ name: string, email: string, password: string }` validado.
`error.firebaseUid` continua identificando apenas identidade criada pela
operação para compensação. Não colocar `data` no objeto de erro.
Novo código interno `REGISTRATION_ALREADY_PENDING` leva a rota ao mesmo ramo
de recuperação/HTTP 202 das duplicidades Firebase/SQL; não é retornado ao cliente.

- [ ] **2.1 Escrever a matriz RED de validação e criação.**

  Exemplo para o validator real, usando `createRequire` do arquivo de teste:

  ```js
  const { validateRegistration } = require('../../api/middleware/validation');
  test('registration requires a bounded unmodified password', () => {
    const base = { name: 'Ana Silva', email: 'ana@example.test' };
    for (const password of [undefined, null, 123, {}, 'x'.repeat(11),
      'x'.repeat(129), ' '.repeat(12)]) {
      assert.equal(validateRegistration({ ...base, password }), false);
    }
    for (const password of ['x'.repeat(12), 'x'.repeat(128),
      '  senha Unicode á 😀  ']) {
      assert.equal(validateRegistration({ ...base, password }), true);
    }
    assert.equal(validateRegistration({ ...base, password: 'x'.repeat(12),
      role: 'admin' }), false);
  });
  ```

  Testar também arrays, nomes/e-mails inválidos, `confirmPassword`/`permissions`
  extras, senha vazia, tab/newline somente e Unicode nos limites UTF-16.
  Reaproveitar o teste de criação existente trocando a expectativa aleatória:

  ```js
  const password = '  senha Unicode á 😀  ';
  const result = await createPendingRegistration({ client,
    data: { name: 'Ana Silva', email: 'ana@example.test', password } });
  assert.deepEqual(result, { uid: 'pending-uid' });
  assert.equal(created.password, password);
  assert.equal(created.emailVerified, false);
  assert.equal(created.disabled, true);
  assert.equal(JSON.stringify(calls).includes(password), false);
  ```

  `created` é a chamada capturada ao Firebase; `calls` contém somente SQL e
  SMTP, como no teste existente. Exercitar também a rota HTTP inteira para
  confirmar normalização de nome/e-mail sem modificar senha e status 202 exato.
  Rodar `node --test tests/unit/registration-api.test.mjs tests/unit/pending-registration.test.mjs`.
  Esperado RED: validator rejeita senha ou criação ainda usa aleatória.

- [ ] **2.2 Implementar o contrato mínimo de entrada/criação.**

  Núcleo do validator:

  ```js
  const password = body.password;
  const validPassword = typeof password === 'string'
    && password.length >= 12 && password.length <= 128
    && /\S/u.test(password);
  ```

  Aceitar somente as próprias chaves `name`, `email`, `password`; exigir os três
  campos próprios. Preservar as verificações existentes do nome/e-mail e
  rejeitar estruturas/protótipos inesperados. Na rota, acrescentar
  `password: req.body.password` ao objeto transitório; no createUser usar
  `password: data.password`. SQL continua com UID, e-mail e nome. Remover
  `temporaryPassword` e `randomBytes` deste serviço quando a reconstrução
  também passar a usar senha validada; não remover gerador de convite.

  **Antes de criar Firebase**, consultar/prender a solicitação pelo helper
  `lockPendingRegistrationIdentity` dentro da transação de criação. Se houver
  qualquer pending correspondente, lançar `REGISTRATION_ALREADY_PENDING` sem
  criar identidade nem reservar novo cadastro. Se `identity.changed`, tratar
  como falha operacional controlada, não como permissão para criar.
  O helper já toma o lock de e-mail: não criar outra ordem de locks.

  ```js
  const identity = await lockPendingRegistrationIdentity(client,
    { email: data.email });
  if (identity.changed) throw serviceError('REGISTRATION_IDENTITY_CHANGED',
    'Registration identity changed.');
  if (identity.registration) throw serviceError('REGISTRATION_ALREADY_PENDING',
    'A registration already owns this email.');
  ```

  A rota inclui esse novo código junto de `auth/email-already-exists`/`23505`,
  faz rollback, libera a conexão original e só então chama recuperação na nova
  conexão. Preservar `REGISTRATION_ALREADY_EXISTS` para usuário local ativo e
  sua resposta genérica, sem recuperação mutante. Essa pré-checagem impede
  criar/compensar uma identidade intermediária quando o pending existe, mas seu
  UID Firebase desapareceu; a reconstrução deve ocorrer uma única vez no ramo
  próprio, não falhar em unique constraint e deixar um novo órfão para trás.

- [ ] **2.3 Escrever RED da repetição usando o serviço real.**

  No novo arquivo, usar o helper da tarefa 1 e query doubles estritos que
  retornem a mesma linha nos três reads de `lockPendingRegistrationIdentity`.
  Estado inicial: `status=pending`, UID fixo, nome original, data há duas horas,
  sem limpeza, Firebase desabilitado. Chamar o serviço com nome/senha diferentes:

  ```js
  const before = structuredClone(registration);
  const result = await h.registrations.recoverPendingRegistration({
    pool, data: { name: 'Outro nome', email: registration.email,
      password: 'Outra senha 12345' }, requestId: 'test-repeat',
  });
  assert.equal(result, true);
  assert.deepEqual(registration, before);
  assert.equal(firebaseWrites.length, 0);
  assert.equal(h.sql.some(({ sql }) =>
    /(?:UPDATE|INSERT INTO) pending_registrations/.test(sql)), false);
  ```

  Aqui `pool` é `h.pool`, `registration` é a linha
  devolvida por esse double e `firebaseWrites` captura create/update/delete.
  Declarar `const pool = h.pool` no teste; o retorno foi definido na tarefa 1.
  Não reimplementar o serviço no teste.

  Cobrir também confirmado, janela inferior a uma hora, rejected/approved com ou
  sem identidade, limpeza em andamento, conflito UID/e-mail, fila de cleanup,
  usuário local já existente e órfão sem pending. Trocar o teste antigo que
  autoriza adoção de órfão por uma asserção negativa; não apenas apagá-lo.
  Rodar `node --test tests/unit/registration-recovery.test.mjs`; esperar RED por
  update de nome/data ou adoção automática no código atual.

- [ ] **2.4 Implementar a árvore de repetição sem reset de senha.**

  Dentro da transação/locks existentes, usar esta ordem de decisão:

  ```js
  const identity = await lockPendingRegistrationIdentity(client,
    { email: data.email });
  const pending = identity.registration;
  if (identity.changed || !pending || pending.status !== 'pending'
      || pending.firebase_cleanup_pending) return false;
  ```

  Depois revalidar ausência de usuário local por UID/e-mail, ausência de fila
  de cleanup e correspondência Firebase UID/e-mail. Se identidade existe,
  exigir `disabled === true`; manter todos os campos. Antes de uma hora não
  reenviar mensagem. Depois de uma hora, aplicar `reserveRegistrationWindow`,
  gerar verificação apenas se `emailVerified !== true`, enviá-la e concluir a
  transação sem UPDATE/INSERT de pending. Não renovar `created_at` para limitar
  envio: rate limit por IP continua 5/h e o teto global/limite concorrente
  permanecem. A janela histórica suprime reenvio inicial; após ela o teto de
  solicitações por IP continua sendo a limitação de reenvio, não um cooldown
  persistido novo. Não afirmar proteção distribuída adicional inexistente.

  Se a identidade do pending desapareceu, primeiro consultar por e-mail no
  Firebase: identidade diferente existente é conflito, não candidata a adoção.
  Somente se não existir, reservar janela, criar identidade com senha atual,
  não verificada/desabilitada, prender novo UID e revalidar a linha. Atualizar
  somente `firebase_uid` com CAS `id + UID antigo + status pending`; preservar
  nome/data/decisões. Usar `pending.name` no displayName e na mensagem. Verificação
  é sempre nova nessa reconstrução. Se o CAS não afetar uma linha, abortar e
  compensar somente o UID recém-criado, pelas rotinas existentes.

  Não criar pending para órfão Firebase sem solicitação. Resposta HTTP de
  duplicidade continua genérica. Pending approved/rejected não é reaberto.
  Comentários do código devem explicar essas fronteiras, não incluir dados reais.

- [ ] **2.5 Testar reconstrução, falhas e isolamento de credenciais.**

  Testar createUser desaparecido, conflito no CAS, Firebase timeout, SMTP rejeitado,
  perda de conexão antes/depois de COMMIT, rollback que falha e cleanup que encontra
  nova referência local. Incluir query double que lança se `params` contiver senha
  e Firebase fake que lança em `updateUser(..., { password })`.
  Exercitar via HTTP pending com UID ausente: a pré-checagem devolve o código
  interno antes de createUser; após rollback e nova conexão, recuperação cria
  exatamente um novo UID, sem delete intermediário nem entrada órfã de cleanup.
  Asserções: conexão ambígua descartada, UID conhecido não apagado, fila contém
  somente UID/motivo e nenhuma senha é retornada/logada/enfileirada.
  Preservar testes reais de ordem dos locks; query doubles não comprovam locking
  PostgreSQL de verdade. Não mudar transações/cron para contornar um teste.

- [ ] **2.6 Rodar regressões e checkpoint de backend.**

  Rodar `node --test tests/unit/registration-api.test.mjs tests/unit/registration-recovery.test.mjs tests/unit/pending-registration.test.mjs tests/unit/user-invitation-delivery.test.mjs tests/unit/user-import-worker.test.mjs tests/unit/bulk-user-import.test.mjs`.
  Atualizar todas as chamadas de teste a criação/reconstrução para fornecer senha
  fictícia válida; cenários de rejeição podem falhar antes de consumi-la, mas
  nenhum teste deve depender da antiga geração aleatória. Esperado PASS.
  `git diff --check`; commit sugerido `feat: register pending accounts with chosen password`.
  Backend ainda não deve ser publicado isoladamente do formulário novo.

## Tarefa 3 — Recuperação única e mensagens de e-mail

**Entrega:** opção de recuperação atende pendentes confirmados e contas ativas,
sem liberar acesso; endpoint legado continua disponível.

**Arquivos:** modificar `api/routes/auth.js`,
`api/integrations/password-reset-email.js`, `tests/unit/registration-api.test.mjs`,
`tests/unit/password-reset-email.test.mjs`; ampliar testes do serviço pendente.

**Interfaces:** preservar
`requestPendingRegistrationPassword({ pool, email }): Promise<boolean>`,
`sendRegistrationPassword({ to, link })`, `sendPasswordReset({ to, link })` e
HTTP 202 `{ status: 'accepted' }`. Nenhum campo público identifica a modalidade.

- [ ] **3.1 Escrever RED da matriz de recuperação HTTP.**

  Exercitar `/api/auth/password-reset`: ativo/verificado/local habilitado envia
  reset normal; pending/verificado/desabilitado/sem cleanup envia link pendente;
  pending não confirmado, UID/e-mail divergente, inexistente, rejeitado, aprovado
  ainda em enable, desativado localmente ou marcado para cleanup não enviam.
  Para cada estado não operacional, resposta é o mesmo status/body 202. Fixture
  `query` deve distinguir leitura de users, pending e fila de cleanup.

  ```js
  assert.equal(response.status, 202);
  assert.deepEqual(response.body, { status: 'accepted' });
  assert.equal(firebaseWrites.some(call =>
    call.method === 'updateUser' || call.method === 'createUser'), false);
  assert.equal(h.sql.some(({ sql }) => /INSERT INTO users/.test(sql)), false);
  ```

  Adicionar teste do endpoint legado com a mesma matriz e sexto pedido de cada
  endpoint retornando 429 antes de trabalho externo. Saturação dos dois slots de
  `withRegistrationOperation` mantém 503 na rota legada como hoje; na recuperação
  unificada responder genericamente 202 sem expor estado ou prometer envio.
  Rodar testes; RED esperado no pending que hoje é descartado logo por disabled.

- [ ] **3.2 Despachar sem furar a fronteira disabled.**

  Na rota normal, após encontrar Firebase pelo e-mail e confirmar `emailVerified`,
  tratar o ramo desabilitado assim:

  ```js
  if (firebaseUser.disabled) {
    await withRegistrationOperation(() =>
      requestPendingRegistrationPassword({ pool, email }));
    return res.status(202).json(accepted);
  }
  ```

  O helper precisa provar pending sob locks, ausência de usuário local conflitante
  por UID/e-mail e e-mail Firebase correspondente. Caso a leitura apresente
  aprovação concorrente, não enviar como pending nem tentar habilitar; o usuário
  pode repetir pela recuperação de conta ativa. Preservar o ramo ativo e seus
  filtros `accountDisabled`/`firebase_enable_pending`, sem lookup público de status.
  Manter os catchs genéricos/redigidos e limites existentes dos dois endpoints.

- [ ] **3.3 Ajustar os templates com testes RED/GREEN.**

  Acrescentar `registrationPasswordMessage` aos imports do teste de mailer:

  ```js
  test('pending password mail never claims access is ready', () => {
    const message = registrationPasswordMessage({
      to: 'ana@example.test', link: 'https://example.test/reset?a=1&b=2', env,
    });
    assert.match(message.text, /crie ou redefina/i);
    assert.match(message.text, /aguarde a aprovação/i);
    assert.doesNotMatch(message.text, /acesso.*(?:pronto|liberado)/i);
    assert.match(message.html, /a=1&amp;b=2/);
  });
  ```

  Texto de pending: “Seu e-mail está confirmado. Crie ou redefina a senha do seu
  cadastro pelo link. Essa ação não libera o acesso: aguarde a aprovação do
  administrador.” Atualizar assunto/botão sem modificar a assinatura do mailer.
  Verificação: confirmar endereço, aguardar aprovação e depois entrar com senha
  escolhida; em cadastro antigo sem senha, usar recuperação. Preservar o assunto
  de confirmação, escape do nome/link e instruções próprias dos convites.
  Não reutilizar `passwordResetMessage`, que afirma acesso pronto, para pending.

- [ ] **3.4 Rodar os testes e checkpoint.**

  `node --test tests/unit/registration-api.test.mjs tests/unit/pending-registration.test.mjs tests/unit/password-reset-email.test.mjs tests/unit/user-invitation-delivery.test.mjs`.
  Esperado PASS; verificar contagem de mensagens, não apenas status HTTP.
  `git diff --check`; commit sugerido `feat: recover passwords for confirmed pending registrations`.

## Tarefa 4 — Formulário e ciclo de vida das credenciais

**Entrega:** pessoa escolhe senha no cadastro, confirma-a localmente e recebe
instruções corretas; formulário antigo some sem quebrar login/recuperação.

**Arquivos:** modificar `public/login.html`, `public/js/login.js`,
`public/css/login.css`, contratos UI em `tests/unit/pending-registration.test.mjs`
e `tests/unit/frontend-invariants.test.mjs`; criar `tests/helpers/login-harness.mjs` e
`tests/unit/login-registration.test.mjs`.

**Interfaces:** DOM novo com `register-password`, `register-confirm-password`,
`register-password-help`, `register-toggle-password` e
`register-toggle-confirm-password`. Rede envia somente `{ name, email, password }`.
`requireAcceptedRegistration(response)` permanece com contrato exato, sem trocar
por `response.ok`. Helpers locais sem exports de produção obrigatórios:
`clearRegistrationPasswords(): void`, `setRegistrationBusy(busy): void`,
`setLoginView(view): void`, onde `view` é `login | register | reset`.

- [ ] **4.1 Criar o harness e testes RED do formulário real.**

  Reutilizar `FixtureNode`, `parseInto`, `TestEvent`, `deferred`, `drain` de
  `tests/helpers/frontend-feedback-harness.mjs`. Ler HTML real e executar todo
  login.js numa função async no VM, removendo somente imports de transporte:

  ```js
  const source = (await readFile('public/js/login.js', 'utf8'))
    .replace(/^import[\s\S]*?;\s*/gm, '');
  await vm.runInContext(`(async () => { ${source}\n})()`, context);
  ```

  Injetar authStateReady resolvido, Firebase fake sem sessão inicial, fetch
  deferred, location.replace capturado, storage fake que lança ao gravar senha.
  DOM fake implementa `reportValidity`/`setCustomValidity`/`reset` e os estados de
  formulário necessários; teste em navegador permanece responsável por validade
  nativa/reflow. Não usar o loader de página autenticada que pressupõe `mount`.
  Export de teste: `createLoginHarness()` retorna
  `{ node, requests, redirects, authCalls, input, submit, window, drain }`;
  `submit(id)` dispara evento real, `input(id,value)` inclui evento de input.

  ```js
  test('registration clears secrets and submits once', async () => {
    const h = await createLoginHarness();
    h.node('register-link').click();
    h.input('register-name', ' Ana Silva ');
    h.input('register-email', ' ana@example.test ');
    h.input('register-password', '  Senha teste 123  ');
    h.input('register-confirm-password', '  Senha teste 123  ');
    h.submit('register-section');
    h.submit('register-section');
    h.node('register-back-link').click();
    assert.equal(h.requests.length, 1);
    assert.deepEqual(JSON.parse(h.requests[0].options.body), {
      name: 'Ana Silva', email: 'ana@example.test', password: '  Senha teste 123  ',
    });
    assert.equal(h.node('register-section').classList.contains('active'), true);
    h.requests[0].resolve(new Response(JSON.stringify({
      status: 'accepted', state: 'received',
    }), { status: 202 }));
    await h.drain();
    assert.equal(h.node('register-password').value, '');
    assert.equal(h.node('register-confirm-password').value, '');
    assert.equal(h.authCalls.length, 0);
    assert.equal(h.redirects.length, 0);
  });
  ```

  Outros casos: divergência não faz fetch; limites 11/12/128/129 e espaços; resposta
  200 ou 202 com corpo errado não mostra sucesso; rejeição de rede limpa senha e
  conserva nome/e-mail; todos os botões recuperam estado; voltar/alternar vista
  limpa senha e tipo visível; submit sintético durante envio é ignorado. Disparar
  `pagehide` com request em andamento e garantir que retorno tardio não repinte
  formulário reaberto; `pageshow` persistido não restaura segredos/estado preso.
  Testar login válido, erro disabled, recuperação, destinos `next` seguros e link
  PodFalar preservado. Rodar `node --test tests/unit/login-registration.test.mjs`;
  RED esperado porque os campos/contrato novo ainda não existem.

- [ ] **4.2 Inserir campos e remover a etapa separada.**

  Modelo de um campo; adicionar confirmação com os IDs da interface acima:

  ```html
  <div class="form-group">
    <label class="form-label" for="register-password">Senha</label>
    <div class="password-wrap">
      <input class="form-input" type="password" id="register-password"
        name="password" autocomplete="new-password" minlength="12" maxlength="128"
        aria-describedby="register-password-help register-error" required>
      <button type="button" class="toggle-pw" id="register-toggle-password"
        aria-label="Mostrar senha do cadastro" aria-pressed="false">
        <svg class="icon" aria-hidden="true"><use href="./assets/icons.svg#eye"></use></svg>
      </button>
    </div>
  </div>
  ```

  Ajuda: “Use de 12 a 128 caracteres. Seu e-mail será o login. Confirme o e-mail
  recebido e aguarde a aprovação do administrador.” Remover `registration-password`
  form, link, variável, handlers e seletores CSS exclusivos. Não remover a rota
  backend nem o mailer legado. Recuperação ganha título “Criar ou redefinir senha”
  e ajuda para cadastro antigo; resposta neutra: “Se houver uma conta ou cadastro
  elegível, você receberá um link. Criar ou redefinir a senha não libera um cadastro
  pendente. Verifique também a pasta de spam.” Preservar PodFalar e suporte.

- [ ] **4.3 Implementar validação, busy e limpeza.**

  Guardar o estado antes de qualquer await; validação não usa trim na senha:

  ```js
  let registrationBusy = false;
  let registrationGeneration = 0;
  function clearRegistrationPasswords() {
    for (const id of ['register-password', 'register-confirm-password']) {
      const input = document.getElementById(id);
      if (!input) continue;
      input.value = '';
      input.type = 'password';
      input.setCustomValidity('');
    }
  }
  ```

  Sincronizar também ícones/aria dos toggles. `setRegistrationBusy` controla inputs,
  toggles, submit e navegação entre as três vistas, com `aria-busy` no form.
  `setLoginView` recusa mudança quando busy; ao sair limpa senhas e feedback
  antigo, atualiza h1 e foco. Não colocar toda a página em inert (suporte público
  deve continuar acessível). O próprio handler de submit tem guarda, não depende
  só de botão disabled. Validar senha e confirmação antes de `reportValidity` e
  limpar customValidity no input para permitir correção.

  Capturar o payload em escopo transitório e não armazená-lo em estado global.
  Fetch leva nome/e-mail aparados e password literal, sem confirmação. Em finally,
  limpar segredos em sucesso/falha e soltar busy. Nome/e-mail só são resetados no
  sucesso confirmado; falha orienta redigitar senha. Mensagem de sucesso é a
  especificada no design, sem recomendar um segundo link obrigatório.

  Em `pagehide`, incrementar geração, abortar fetch via AbortController e limpar
  senhas. Abort não cancela necessariamente o cadastro no servidor: não fazer
  retry automático. No retorno da promise, ignorar geração antiga; `pageshow`
  limpa campos e restaura controles sem anunciar sucesso inexistente. Esse
  mecanismo não armazena senha e evita feedback tardio no BFCache.

  Mensagem disabled: “A conta ainda não está habilitada ou foi desativada. Se
  você acabou de se cadastrar, confirme seu e-mail e aguarde a aprovação do
  administrador. Se já tinha acesso, contate o suporte.” Sem consulta pública de
  status ou navegação privada durante cadastro.

- [ ] **4.4 Atualizar contratos antigos e rodar GREEN.**

  Substituir expectativas da seção “Primeiro acesso” em
  `pending-registration.test.mjs` por presença de senha/confirmar, ausência do
  formulário legado e endpoint backend preservado. Manter teste do contrato 202
  e testes de login/PódFalar. Rodar
  `node --test tests/unit/login-registration.test.mjs tests/unit/pending-registration.test.mjs tests/unit/frontend-invariants.test.mjs tests/unit/password-reset-email.test.mjs`.
  Esperado PASS. `git diff --check`; commit sugerido
  `feat: collect and confirm password in public registration`.

## Tarefa 5 — Gates de aprovação e regressões cruzadas

**Entrega:** comprovar que o novo cadastro não enfraquece admissão, autorização,
desativação, convite, importação, retenção ou reconciliação.

**Arquivos:** criar `tests/unit/registration-access.test.mjs`; ampliar
`tests/helpers/registration-api-harness.mjs` e os testes de serviço relevantes.
Referências: `api/middleware/auth.js`, `api/routes/registrations.js`,
`api/services/pending-registration.js`, `public/js/admin.js`.

**Interfaces:** usar middleware/routers reais do harness; adicionar somente uma
rota de prova `GET /__test/private` após `auth.authMiddleware` no app de teste,
retornando `{ uid: req.user.uid }`. Não adicionar rota de teste ao runtime.

- [ ] **5.1 Escrever a matriz de autorização e aprovação.**

  Para a rota de prova, obter `response` com token fictício cujo verifyIdToken
  está injetado e usar asserções reais:

  ```js
  assert.equal(response.status, 403);
  assert.equal(response.body.reason, 'pending-approval');
  assert.equal(verifyCalls[0].checkRevoked, true);
  ```

  Cobrir sem token=401, token inválido=401, email não verificado=403 antes de SQL,
  verificado sem user e pending=403, user desativado=403, enable pending=403,
  user ativo/habilitado=200. Não simular autorização retornando um status pronto;
  simular apenas token/linhas que levam o middleware real à decisão.

  POST de aprovação: sem manageUsers=403, email não confirmado=422 sem enable,
  cargo inativo=400 sem user, CLT válido e PJ/dia válido=viewer; contrato/dia
  inválido=400. Usar um UUID válido para o ID de cadastro nesses testes HTTP.
  Duas decisões sobre o mesmo pending: segunda não reaproveita senha ou reabilita
  conta. Registrar chamadas `updateUser` e testar:

  ```js
  assert.equal(firebaseUpdates.some(({ data }) =>
    Object.prototype.hasOwnProperty.call(data, 'password')), false);
  assert.ok(insertUser.params.includes('viewer') || /'viewer'/.test(insertUser.sql));
  assert.equal(firebaseUpdates.some(({ uid }) => uid !== registration.firebase_uid), false);
  ```

  COMMIT ambíguo, falha de enable e desativação concorrente mantêm acesso negado;
  conservar as regressões existentes que examinam `discardClient` e os locks.

- [ ] **5.2 Executar os testes e corrigir apenas divergências demonstradas.**

  Rodar `node --test tests/unit/registration-access.test.mjs tests/unit/registration-api.test.mjs tests/unit/registration-recovery.test.mjs tests/unit/pending-registration.test.mjs tests/unit/auth-stability.test.mjs tests/unit/user-invitation-delivery.test.mjs tests/unit/user-import-worker.test.mjs tests/unit/bulk-user-import.test.mjs`.
  Testes de fronteira existentes podem passar desde o início: isso é esperado,
  não inventar uma mudança para produzir RED. Se um caso novo falhar, reproduzir
  no componente correspondente antes da correção mínima. Nunca remover verificação
  de e-mail/local/disabled/enable para fazer a jornada passar.

- [ ] **5.3 Revisar o diff de segurança e checkpoint.**

  Conferir senha só no input/POST/createUser, nenhum novo SQL de credencial,
  nenhum `updateUser` com password, nenhum reset automático na duplicidade,
  nenhum convite aceito automaticamente pela rota pública. Confirmar que
  `firebase_cleanup_queue.last_error` contém motivo seguro, não erro externo.
  `git diff --check`; commit sugerido
  `test: enforce verified and approved registration access`.

## Tarefa 6 — Documentação e aceite local reproduzível

**Entrega:** candidato local completo, documentação verdadeira e evidências que
distinguem implementação/testes de homologação externa pendente.

**Arquivos:** modificar `docs/product/feature-inventory.md`,
`docs/architecture/overview.md`; criar `docs/operations/registration.md` e
`docs/reviews/2026-11-09-conecta-registration.md`.

**Interfaces:** documentação aponta para os contratos implementados; relatório
lista revisão/commit testado, comandos, resultados, skips e limites. Não inserir
credenciais, links com códigos de ação ou dados pessoais reais em evidências.

- [ ] **6.1 Atualizar os documentos do fluxo.**

  No inventário, substituir a descrição que diz “sem aceitar senha inicial” e a
  exigência de primeiro acesso. Em arquitetura, descrever separadamente Firebase
  desabilitado, pending no PostgreSQL, aprovação e enable reconciliável. No guia
  operacional, incluir estas instruções concretas:

  - Novo cadastro: nome/e-mail/senha, confirmar endereço, aguardar decisão e entrar.
  - Cadastro antigo pendente: confirmar endereço e usar “Criar ou redefinir senha”.
  - Cadastro aprovado sem senha conhecida: recuperação da conta ativa.
  - Repetir cadastro não altera senha; link de verificação expirado pode ser
    reenviado respeitando os limites; dúvida sobre órfão exige suporte, não exclusão
    manual ou redefinição por POST público.
  - Admin informa cargo/contrato, só aprova confirmado, comunica liberação fora do
    sistema e não anuncia acesso pronto quando houver enable pendente.
  - Convite/CSV continuam usando criação de senha pelo link próprio.
  - Atualização exige frontend/backend no mesmo candidato; cliente antigo sem
    password deve recarregar. Não mudar scripts de deploy para isso.

- [ ] **6.2 Rodar gates locais finais.**

  Executar separadamente:

  ```text
  node --test tests/unit/registration-api.test.mjs tests/unit/registration-recovery.test.mjs tests/unit/login-registration.test.mjs tests/unit/registration-access.test.mjs tests/unit/pending-registration.test.mjs tests/unit/password-reset-email.test.mjs tests/unit/auth-stability.test.mjs tests/unit/user-invitation-delivery.test.mjs tests/unit/user-import-worker.test.mjs tests/unit/bulk-user-import.test.mjs
  npm run verify
  git diff --check
  git status --short
  ```

  Esperado zero FAIL. Registrar SKIP e warnings sem transformá-los em PASS.
  Não reiniciar 4180 para obter screenshot; pedir aprovação para prévia de
  navegador quando necessária. Na futura prévia autorizada: 360/402/768/1366 px,
  zoom 200%, teclado/foco, labels/toggles, erro/sucesso, rolagem sem overflow e
  ausência de envio por alternância de formulário. Sem e-mail real nessa prévia.

- [ ] **6.3 Registrar evidências e entregar para revisão.**

  Relatório contém seções `Implementado`, `Verificado localmente`, `Limitações` e
  `Homologação externa pendente`. Citar nomes dos testes, status e commit; não
  confundir mocks com confirmação efetiva ou recebimento na caixa de entrada.
  Revisar spec versus diff, incluindo casos de falha e compatibilidade antiga.
  Commit sugerido `docs: document registration approval and recovery journey`.
  Antes de cada commit, staging explícito só dos arquivos pertinentes. Não
  incluir os WIP de conteúdo/mídia listados no baseline nem publicar por conta
  própria. Marcar as seis primeiras etapas coarse somente após seus gates.

## Tarefa 7 — Gate externo posterior, sob autorização

**Entrega:** evidência da jornada real; não é condição para escrever código local,
mas é condição para afirmar que o novo fluxo foi homologado no provedor e inbox.

**Arquivos:** atualizar apenas o relatório de aceite após execução autorizada.
Não mudar credenciais, produção, infraestrutura ou configuração Firebase nesta
tarefa sem autorização específica; bloqueio do provedor interrompe a liberação.

**Interfaces:** ambiente isolado autorizado, URL de teste, administrador de teste
com manageUsers e caixas de e-mail controladas. Segredos entram por mecanismo
privado; o relatório contém apenas identificadores não sensíveis e timestamps.

- [ ] **7.1 Obter autorização e confirmar ambiente/contas.**

  Confirmar URL, projeto Firebase, base isolada e caixas de teste permitidas.
  Não criar usuários fictícios de produção. Serviços/Docker só com permissão.
  Sem autorização, marcar o gate como NÃO EXECUTADO com motivo e parar; não
  declarar esta etapa concluída nem alterar o desenho silenciosamente.

- [ ] **7.2 Executar a sequência de verificação real.**

  1. Cadastrar conta A com senha única de teste; confirmar pending no Admin e
     identidade disabled/nonverified sem imprimir a senha.
  2. Antes da confirmação e antes da aprovação, login e APIs privadas bloqueados.
  3. Confirmar pelo e-mail recebido mantendo a identidade desabilitada. Conferir
     que Admin mostra confirmado, mas login segue bloqueado.
  4. Tentar aprovar conta B ainda não confirmada: operação recusada, sem acesso.
  5. Aprovar A com cargo/contrato e conferir ativo ou enable pending real; apenas
     ativo permite login com a senha original. Nenhuma segunda criação de senha.
  6. Repetir cadastro de A com outra senha: a senha original continua válida e a
     nova não toma a conta. Não registrar nenhuma delas em gravação/relatório.
  7. Em conta pendente C confirmada, recuperar senha pelo e-mail e verificar que
     isso não aprova/habilita. Depois aprovar e entrar com senha redefinida.
  8. Exercitar cadastro antigo pendente, link expirado/repetido, reenvio dentro dos
     limites e tentativa de recuperação de conta desativada. Esta última não
     ganha acesso. Se expiração real não puder ser reproduzida, registrar esse
     subcaso como pendente, não simular resultado de produção.
  9. Verificar um convite autorizado preservado; CSV em sandbox somente se lote
     e destinatários de teste também estiverem autorizados. Nada de envio em massa.

- [ ] **7.3 Registrar resultado e solicitar decisão de publicação.**

  Separar SMTP aceito, inbox recebida, verificação aplicada, decisão persistida e
  login real. Se o Firebase impedir confirmação com disabled, tratar como BLOCKED:
  nenhuma habilitação prévia ou relaxamento de autorização é permitido por este
  plano. Apresentar evidência e revisar especificação com o usuário.
  Remover contas de teste apenas pelo fluxo autorizado e escopo combinado, sem
  SQL direto ou limpeza ampla. Publicação/deploy é decisão posterior, não uma
  etapa implícita deste plano. Marcar a sétima etapa só quando o gate for atendido.

## Conferência de cobertura antes da execução

| Requisito da especificação | Tarefas/gates |
| --- | --- |
| Senha no cadastro, limites e confirmação local | 2 e 4 |
| Nenhuma credencial em persistência/logs/filas | 1, 2, 5 |
| Duplicidade sem trocar senha ou reabrir decisão | 2 e 7 |
| Reconstrução conservadora e não adoção de órfão | 2 |
| Locks, compensação e commit ambíguo | 1, 2, 5 |
| Confirmação separada de aprovação/enable | 3, 5, 7 |
| Recuperação de pendentes antigos e novos | 3, 4, 7 |
| Endpoint legado e convites/CSV preservados | 3, 5, 6 |
| UI acessível, sem etapa extra, proteção assíncrona | 4 e 6 |
| Documentação e evidência local versus externa | 6 e 7 |
| Sem schema/deploy/serviços/produção no escopo local | Global Constraints e 7.1 |

## Handoff

Plano para revisão, ainda não executado. Após aprovação, o usuário pode escolher
execução na sessão principal, com checkpoints por tarefa, ou execução delegada
com a skill `subagent-driven-development` e revisão entre tarefas. Delegação,
homologação externa e publicação não estão autorizadas só pela redação deste plano.
