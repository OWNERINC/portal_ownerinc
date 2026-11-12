# Cadastro sem confirmação de email — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Não iniciar delegação sem escolha explícita do usuário. Na execução principal, trabalhar com checkpoints locais.

**Goal:** Solicitar nome, email e senha no cadastro, dispensar confirmação do email e manter aprovação administrativa antes de qualquer acesso.

**Architecture:** Firebase mantém a senha e a identidade inicialmente desabilitada e não verificada. PostgreSQL mantém somente os metadados e a decisão de admissão; a API autoriza por token válido, usuário admitido, conta ativa, habilitação concluída e permissões. Recuperação atende usuários ativos e solicitações pendentes antigas, sem aprovar nem habilitar contas.

**Tech Stack:** Express, Firebase Admin/Auth, PostgreSQL existente, frontend estático, node:test e harness DOM existente, sem dependências novas.

## Steps

- [x] Proteger credenciais e implementar cadastro com senha e repetição segura, sem enviar confirmação.
- [x] Retirar a exigência de email verificado da aprovação e da autorização, preservando os outros bloqueios.
- [x] Unificar recuperação para ativos e pendentes, incluindo cadastros antigos sem senha conhecida.
- [x] Atualizar formulário, mensagens, estados administrativos e testes de interação.
- [x] Atualizar documentação, revisar o diff e concluir a verificação local.
- [ ] Homologar Firebase e a jornada externa somente com autorização específica.

### Execução em 11/11/2026

Usuário confirmou o fluxo e autorizou implementação. Tasks 1–5 aplicadas na
sessão principal, sem delegação, commits ou publicação. Os comandos de commit
abaixo continuam como proposta, não como histórico executado. O checklist
detalhado original permanece como referência do plano; o acompanhamento de
entrega está nas etapas acima e nas evidências abaixo.

Gate final: `npm run verify` com 865 PASS, 0 FAIL, 2 SKIP Linux (867 testes).
Navegador local: 10 larguras, três estados de acesso, axe sem violações
automatizadas e cadastro acessível em 360 × 480/568/667.
Relatório: `docs/reviews/2026-11-11-registration-without-email-verification.md`.
Task 6, integração Git e deploy continuam pendentes; nenhuma escrita externa.

## Global Constraints

- Especificação aprovada: `docs/superpowers/specs/2026-11-10-registration-without-email-verification-design.md`, commit local `31a610a`.
- Este plano substitui o fluxo com confirmação do plano de 09/11/2026; não executar o desenho antigo por engano.
- Email passa a ser identificador de login, não prova de posse da caixa postal. A aprovação administrativa é a fronteira de admissão; o operador deve conferir a identidade e o endereço informado antes de aprovar.
- Não marcar `emailVerified: true` artificialmente para novos cadastros. A identidade nasce com `emailVerified: false` e `disabled: true`.
- Senha tem entre 12 e 128 unidades UTF-16 e não pode ser composta apenas por espaços em branco. Aceitar espaços e Unicode, sem regras de composição.
- Senha não sofre trim nem normalização.
- Senha existe apenas na memória transitória e no Firebase. Não persistir em PostgreSQL, filas, storage do navegador, URLs, logs, auditoria ou emails.
- Repetição pública nunca troca a senha nem reabre aprovação/rejeição de uma solicitação existente; preserva UID, nome, estado e idade da solicitação.
- Não adotar automaticamente identidade órfã apenas pelo email.
- Recuperar ou criar senha nunca aprova nem habilita uma conta.
- Não alterar convites administrativos, importação CSV ou bootstrap do primeiro superadministrador, exceto testes compartilhados indispensáveis à regressão.
- Não alterar schema nem adicionar armazenamento de credenciais.
- Preservar Node 18 e fronteiras `api/`, `cron/`, `public/` e `nginx/`. O package.json da raiz usa Node 24 para as ferramentas; não trocar engines ou infraestrutura neste trabalho.
- Não alterar scripts de deploy, produção ou serviços em execução. Não iniciar Docker ou usar banco remoto. Portal e Ownerinc Brain permanecem separados.
- Não reiniciar a prévia cancelada na porta 4180.
- Sem acesso parcial, aprovação automática, novo email de aprovação, login social ou MFA.
- Não publicar checkpoints intermediários com contratos frontend/backend incompatíveis.
- Preservar limites, locks, auditoria, compensação, retenção e reconciliação. Não apagar alterações alheias.

## Mapa de arquivos

- `api/middleware/validation.js`: contrato estrito de cadastro e política de senha.
- `api/routes/auth.js`: transporte da senha, recuperação unificada e logs limitados.
- `api/services/pending-registration.js`: criação, repetição/reconstrução, recuperação e aprovação.
- `api/middleware/auth.js`: autorização sem requisito de verificação, mantendo admissão.
- `api/routes/registrations.js`: estado pendente e remoção do erro de confirmação.
- `api/middleware/security.js`: somente sanitização de logs que possa expor credenciais.
- `api/integrations/password-reset-email.js`: texto da recuperação de cadastro antigo, sem alegar confirmação prévia.
- `public/login.html`, `public/js/login.js`: senha no cadastro e recuperação única.
- `public/js/admin.js`, `public/admin.html`: estado pendente uniforme e orientação de conferência da identidade/endereço.
- `public/js/auth.js`: manter compatibilidade com negativas legadas sem tornar confirmação uma exigência do novo fluxo.
- `tests/unit/api-security.test.mjs`, `pending-registration.test.mjs`, `password-reset-email.test.mjs`, `login-approved-reference.test.mjs`, `frontend-invariants.test.mjs`: atualizar contratos existentes e acrescentar regressões.
- Criar `tests/unit/registration-http.test.mjs`: rotas reais com Firebase e pool falsos e servidor local efêmero.
- Criar `tests/unit/registration-admission.test.mjs`: executar middleware real em VM com identidades não verificadas e estados locais variados.
- `docs/architecture/data-flow.md`, `docs/product/feature-inventory.md`: comportamento implementado.
- Criar `docs/reviews/2026-11-10-registration-without-email-verification.md`: evidências locais e pendências externas.

## Task 1: cadastro com senha, repetição segura e proteção de logs

**Files:** `api/middleware/validation.js`, `api/routes/auth.js`, `api/services/pending-registration.js`, logs tocados em `api/middleware/security.js`; testes `api-security.test.mjs`, `pending-registration.test.mjs`, `registration-http.test.mjs`.

**Interfaces:** preservar assinaturas `validateRegistration(body)`, `createPendingRegistration({client,data,requestId})`, `recoverPendingRegistration({pool,data,requestId})`. `data` passa a conter `password`. Criação retorna `{uid}` e HTTP retorna somente `{status:'accepted',state:'received'}`.

- [ ] **1.1 RED — adicionar casos de senha ao teste de validação existente.**

```js
test('registration requires an unmodified bounded password', () => {
  const valid = { name: 'Ana Silva', email: 'ana@example.test', password: '  senha com espaços  ' };
  assert.equal(validateRegistration(valid), true);
  for (const password of [undefined, null, 123, 'a'.repeat(11), 'a'.repeat(129), ' '.repeat(12)]) {
    assert.equal(validateRegistration({ ...valid, password }), false);
  }
  for (const password of ['a'.repeat(12), 'a'.repeat(128), '😀'.repeat(6)]) {
    assert.equal(validateRegistration({ ...valid, password }), true);
  }
  assert.equal(validateRegistration({ ...valid, confirmPassword: valid.password }), false);
  assert.equal(validateRegistration({ ...valid, role: 'admin' }), false);
});
```

Run: `node --test tests/unit/api-security.test.mjs`.
Expected: novo caso falha porque `password` ainda é um campo proibido.

- [ ] **1.2 GREEN — alterar contrato e criação.** Aplicar a validação abaixo junto às regras atuais de nome/email; não afrouxar as regras existentes.

```js
if (Object.keys(body).some((key) => !['name', 'email', 'password'].includes(key))) return false;
if (typeof body.password !== 'string' || body.password.length < 12
    || body.password.length > 128 || !body.password.trim()) return false;
```

Em `api/routes/auth.js`, compor `data` assim:

```js
const data = {
  email: req.body.email.trim().toLowerCase(),
  name: req.body.name.trim(),
  password: req.body.password,
};
```

Em `createPendingRegistration`, usar `password: data.password`, mantendo `emailVerified:false` e `disabled:true`. Remover apenas as chamadas de geração/envio de verificação; manter SQL parametrizado sem senha e o retorno UID usado pela compensação. Remover import de `randomBytes`, `temporaryPassword` e `sendVerificationEmail` se não houver mais consumidores no serviço. O helper atual `verificationSettings` continua necessário à criação do link de recuperação; mantê-lo ou renomear junto de todos os seus consumidores/testes, sem mudar a validação de URL.

- [ ] **1.3 RED/GREEN — adaptar os mocks do serviço, sem perder cobertura.** No primeiro teste de `pending-registration.test.mjs`, enviar senha com espaços, verificar igualdade exata em `createUser`, `disabled:true`, `emailVerified:false` e ausência da senha em todos os parâmetros SQL. Os mocks de `generateEmailVerificationLink` e `sendVerificationEmail` devem lançar erro se chamados: criação precisa passar sem chamá-los. Trocar os antigos testes de compensação acionados por falha SMTP por falha SQL após criação Firebase; o erro continua carregando `firebaseUid`, sem limpar identidade enquanto a transação estiver aberta.

- [ ] **1.4 RED/GREEN — restringir `recoverPendingRegistration` mantendo a infraestrutura de locks/rollback/cleanup.** A sequência de decisões é:

1. Adquirir a identidade pelo helper existente; recusar `identity.changed`, cleanup pendente ou usuário admitido por UID/email.
2. Sem solicitação correspondente: retornar `false`; não adotar ou apagar identidade órfã.
3. Solicitação aprovada/rejeitada: retornar `false`, sem reabrir ou atualizar a data.
4. Pendente com identidade existente: retornar `true`, sem alterar senha, nome, criação, confirmação ou UID, sem enviar email. Não executar `updateUser`.
5. Pendente com identidade ausente: revalidar referências/cleanup e janela de cadastro sob locks; criar somente esta identidade com `data.password`, `disabled:true`, `emailVerified:false`; atualizar somente seu `firebase_uid`, preservando nome/data/status. Checar novamente a linha antes do update e exigir `rowCount===1`.
6. Preservar compensação apenas para UID criado pela operação, inclusive fila durável e descarte da conexão em commit/rollback ambíguos.

Cobrir em testes cada ramo, concorrência simulada e preservação da senha anterior; adaptar o teste de commit ambíguo para partir de solicitação pendente com identidade desaparecida, não de órfão sem solicitação.

- [ ] **1.5 RED/GREEN — testar HTTP real e vazamento.** Em `registration-http.test.mjs`, usar `createRequire`, `require.cache` com restauração em `t.after` e Express resolvido de `api/package.json`, seguindo os padrões existentes do repositório. Montar router real em Express com JSON, `requestContext`, `safeResponses` e `errorHandler`, escutar em `127.0.0.1:0` e fechar no teardown. Injetar pool transacional e Firebase falsos; nunca importar `api/index.js` inicializando serviços reais. Validar 400 sem senha e campos extras, 202 válido/duplicado, 429/503 conhecidos e falha SQL/commit. Registrar chamadas de Firebase, SQL, emails e logs. Injetar exceção contendo uma senha sentinela; nenhum log ou resposta pode contê-la. Não registrar body ou objetos de erro completos.

Nos logs tocados, emitir apenas evento, requestId e código limitado. Para o caminho global, retirar `error: err.message` do evento `request_error` e testar que a resposta genérica continua correta. Nos caminhos de cleanup/recovery acionados pelo cadastro, não serializar mensagens arbitrárias do provedor; preservar a informação operacional via evento/código limitado, sem refatoração ampla.

- [ ] **1.6 Verify/checkpoint.**

Run: `node --test tests/unit/api-security.test.mjs tests/unit/pending-registration.test.mjs tests/unit/registration-http.test.mjs`.
Expected: novos contratos de cadastro passam; testes antigos relacionados à aprovação/recuperação serão atualizados nas Tasks 2–3, sem apagar casos negativos.

```sh
git add api/middleware/validation.js api/routes/auth.js api/services/pending-registration.js api/middleware/security.js tests/unit/api-security.test.mjs tests/unit/pending-registration.test.mjs tests/unit/registration-http.test.mjs
git commit -m "feat: accept registration password without verification email"
```

Adicionar ao commit somente outros arquivos de logs efetivamente alterados por esta task, depois de conferir o diff.

## Task 2: aprovação e autorização sem exigir email verificado

**Files:** `api/services/pending-registration.js`, `api/middleware/auth.js`, `api/routes/registrations.js`, `tests/unit/pending-registration.test.mjs`, novo `tests/unit/registration-admission.test.mjs`.

**Interfaces:** preservar `approvePendingRegistration` e os estados `active`, `enable_pending`. Listagem pendente retorna `state:'pending_approval'` e `state_label:'Pendente de aprovação'`, sem afirmar verificação. Respostas de negação continuam usando `pending-approval`, `account-disabled`, `enable-pending`.

- [ ] **2.1 RED — executar middleware real contra identidades não verificadas.** Usar VM no padrão do teste final de `tests/unit/academy-progress.test.mjs`: ler `api/middleware/auth.js`, fornecer require falso para Firebase Admin, db, policy e rateLimit. `verifyIdToken(token, true)` retorna `{uid:'candidate',email_verified:false}` e deve registrar o segundo argumento `true`. Pool retorna, por cenário: usuário ativo; ausência de usuário com cadastro pending; usuário local desativado (boolean e string); habilitação pendente. Esperar acesso somente no primeiro cenário. Testar token inválido/ausente e identidade não admitida.

- [ ] **2.2 GREEN — remover somente a condição `decoded.email_verified !== true` do middleware.** Preservar `verifyIdToken(...,true)`, queries de usuário/solicitação, política e limites por UID. Não confiar na informação do frontend ou em cache para admissão.

- [ ] **2.3 RED/GREEN — aprovar solicitação não verificada sem mudar sua senha ou alegar verificação.** Converter o teste antigo de recusa de não verificado para aprovação com contrato/cargo válido e `emailVerified:false`. Conservar os testes de cargo inválido, PJ inválido, falta da identidade, cleanup, decisão anterior, commit ambíguo e enable pendente. Em produção retirar a linha que lança `EMAIL_NOT_VERIFIED`; manter consulta Firebase para garantir existência. Nenhum update de aprovação pode enviar `password` ou `emailVerified:true` ao Firebase.

- [ ] **2.4 GREEN — simplificar estado da listagem.** `registrationState` deixa de consultar Firebase para decidir se pode aprovar e retorna estado administrativo pendente uniforme. Preservar estados históricos approved/rejected e ocultação do UID. Remover mapeamento 422 `EMAIL_NOT_VERIFIED` e import `firebaseAuth` se ficar sem uso. Cobrir listagem HTTP autorizada e negação sem `manageUsers` no harness da Task 1; a listagem não chama Firebase por item.

- [ ] **2.5 Verify/checkpoint.**

```sh
node --test tests/unit/registration-admission.test.mjs tests/unit/registration-http.test.mjs tests/unit/pending-registration.test.mjs tests/unit/academy-progress.test.mjs
git add api/middleware/auth.js api/routes/registrations.js api/services/pending-registration.js tests/unit/registration-admission.test.mjs tests/unit/registration-http.test.mjs tests/unit/pending-registration.test.mjs
git commit -m "fix: gate admission on approval instead of verified email"
```

## Task 3: recuperação e compatibilidade com cadastros antigos

**Files:** `api/routes/auth.js`, `api/services/pending-registration.js`, `api/integrations/password-reset-email.js`, `tests/unit/registration-http.test.mjs`, `tests/unit/pending-registration.test.mjs`, `tests/unit/password-reset-email.test.mjs`.

**Interfaces:** preservar `requestPendingRegistrationPassword({pool,email}) -> boolean` e `/api/auth/registration-password`. `/api/auth/password-reset` continua respondendo genericamente HTTP 202, sem links ou estado individual.

- [ ] **3.1 RED — expandir a matriz HTTP de recuperação.** Ativo admitido com `emailVerified:false` recebe link; pendente antigo desabilitado/não verificado recebe link de criação de senha; inexistente, rejeitado, cleanup pendente, usuário local desativado e habilitação incompleta não recebem. Todas as respostas públicas continuam genéricas. Firebase só recebe `generatePasswordResetLink`; nunca `updateUser` para habilitar ou alterar senha. Testar também o endpoint legado com a mesma segurança.

- [ ] **3.2 GREEN — unificar os ramos da rota sem confundir desativado com pendente.** Primeiro consultar identidade Firebase. Para identidade desabilitada, chamar o helper de pendentes sob `withRegistrationOperation`; ele precisa checar solicitação ainda pending, UID/email correspondentes, identidade desabilitada, ausência de cleanup e ausência de usuário admitido por UID/email. Para identidade habilitada, preservar a query de usuário ativo e enable concluído, retirando somente `emailVerified` da condição de envio. Demais casos retornam o mesmo 202. Manter rate limits e mensagens genéricas, inclusive quando o provedor falhar.

- [ ] **3.3 GREEN — helper de cadastro antigo.** Retirar `firebaseUser.emailVerified !== true` do helper. Comparar UID/email da identidade consultada com a solicitação antes de gerar link. Acrescentar query parametrizada de ausência de usuário admitido, para não tratar conta administrativamente desativada como solicitação antiga. Preservar locks, transação, commit/rollback e exclusão de cleanup pendente. Não alterar o estado Firebase/local.

- [ ] **3.4 RED/GREEN — texto do email sem alegar confirmação ou habilitação.** Em `registrationPasswordMessage`, substituir a alegação “Seu e-mail foi confirmado” por instrução de definir/recuperar senha, lembrando que o acesso depende da aprovação. Manter escape de link e nome, remetente e transporte SMTP. Não alterar template de convite nem o helper histórico de verificação sem necessidade.

- [ ] **3.5 Verify/checkpoint.**

```sh
node --test tests/unit/registration-http.test.mjs tests/unit/pending-registration.test.mjs tests/unit/password-reset-email.test.mjs tests/unit/user-invitation-delivery.test.mjs tests/unit/bulk-user-import.test.mjs
git add api/routes/auth.js api/services/pending-registration.js api/integrations/password-reset-email.js tests/unit/registration-http.test.mjs tests/unit/pending-registration.test.mjs tests/unit/password-reset-email.test.mjs
git commit -m "fix: recover active and pending accounts without email verification"
```

Incluir também `tests/unit/user-import-worker.test.mjs` na regressão de importação. Os dois arquivos existem no checkout atual.

## Task 4: formulário e estados administrativos

**Files:** `public/login.html`, `public/js/login.js`, `public/js/admin.js`, `public/admin.html`, `tests/unit/login-approved-reference.test.mjs`, `tests/unit/pending-registration.test.mjs`, `tests/unit/frontend-invariants.test.mjs`; helpers/visual scripts somente se dependerem do formulário removido.

**Interfaces:** cadastro envia somente `{name,email,password}`; confirmação fica no navegador. Recuperação única usa `/api/auth/password-reset`. PodFalar, layout aprovado, aurora, foco, reduced motion e destino seguro de login permanecem.

- [ ] **4.1 RED — atualizar teste de contrato do formulário usando `createLoginHarness` existente.**

```js
test('registration submits its password once and clears both password fields', async () => {
  const h = await createLoginHarness({ responseStatus: 202, responseBody: { status: 'accepted', state: 'received' } });
  await h.click('register-link');
  h.node('register-name').value = 'Pessoa de teste';
  h.node('register-email').value = 'person@example.test';
  h.node('register-password').value = '  senha com espaços  ';
  h.node('register-password-confirm').value = '  senha com espaços  ';
  await h.submit('register-section');
  assert.deepEqual(JSON.parse(h.requests[0].options.body), {
    name: 'Pessoa de teste', email: 'person@example.test', password: '  senha com espaços  ',
  });
  assert.equal(h.node('register-password').value, '');
  assert.equal(h.node('register-password-confirm').value, '');
  assert.match(h.node('register-success').textContent, /aprovação/);
  assert.doesNotMatch(h.node('register-success').textContent, /confirmar o e-mail|Criar senha do cadastro/);
});
```

Adicionar casos de confirmação divergente sem request; senha ausente/curta/longa/branca mesmo quando o DOM falso retorna `reportValidity:true`; falha preserva nome/email e limpa senhas; navegação para fora limpa senhas. Usar fetch deferred no harness para provar que segunda submissão e navegação durante envio não alteram o formulário nem geram segunda chamada.

- [ ] **4.2 GREEN — inserir os campos no formulário, sem redesenhar a página.**

```html
<div class="form-group">
  <label class="form-label" for="register-password">Senha</label>
  <input class="form-input" type="password" id="register-password" name="password" autocomplete="new-password" minlength="12" maxlength="128" aria-describedby="register-help register-error" required>
</div>
<div class="form-group">
  <label class="form-label" for="register-password-confirm">Confirmar senha</label>
  <input class="form-input" type="password" id="register-password-confirm" name="password-confirm" autocomplete="new-password" minlength="12" maxlength="128" aria-describedby="register-help register-error" required>
</div>
```

Instrução: “Use de 12 a 128 caracteres na senha. Após enviar, aguarde a aprovação do administrador. Você entrará com o email e a senha informados.”

Remover formulário e gatilhos de criação separada de senha do HTML e todos os seus listeners no JS, sem remover endpoint legado. Recuperação orienta também quem fez cadastro antigo sem senha. Não bloquear colar ou gerenciadores.

- [ ] **4.3 GREEN — guard e limpeza de senha.** Criar booleano de operação de cadastro e retornar imediatamente em submissões concorrentes. Enquanto envia, desabilitar campos e botões de navegação para fora; `showView` também precisa recusar transições durante a operação. Validar a política no JS antes de enviar, incluindo confirmação, e limpar ambos os campos inclusive em erros de validação; restaurar foco no campo adequado. Após capturar os valores para o request, limpar os campos e, no `finally`, limpar novamente e liberar os controles. Não colocar senha em storage, URL, snapshot ou logs. Manter nome/email nas falhas, sucesso com contrato exato 202 e retorno de foco ao sair.

Texto de sucesso: “Se o cadastro puder ser processado, aguarde a aprovação do administrador. Quando seu acesso for liberado, entre com o email e a senha escolhida no cadastro.”

Erros de pendência dizem “Cadastro recebido. Aguarde a aprovação do administrador.” Não orientar confirmação em `reason=email` legado: usar orientação genérica de acesso/suporte, mantendo tratamento seguro de sessão. `public/js/auth.js` pode reconhecer a negativa antiga durante transição, mas o backend novo não a emite.

- [ ] **4.4 RED/GREEN — atualizar admin e invariantes.** Badge pendente usa estado administrativo uniforme, sem depender de `confirmed`. No modal de aprovação inserir orientação de conferir a identidade e o endereço informado. Atualizar os testes do fluxo antigo em vez de apagar testes de acessibilidade, PodFalar, destino seguro, contrato exato de sucesso ou anti-enumeração. Ajustar scripts visuais se tentarem acessar o formulário removido, sem disparar email/login real.

- [ ] **4.5 Verify/checkpoint.**

```sh
node --test tests/unit/login-approved-reference.test.mjs tests/unit/pending-registration.test.mjs tests/unit/frontend-invariants.test.mjs tests/unit/auth-stability.test.mjs tests/unit/login-aurora.test.mjs
git add public/login.html public/js/login.js public/js/admin.js public/admin.html tests/unit/login-approved-reference.test.mjs tests/unit/pending-registration.test.mjs tests/unit/frontend-invariants.test.mjs
git commit -m "feat: collect signup password and show approval-only onboarding"
```

Adicionar ao commit somente ajustes de helper/script visual efetivamente feitos. Inspecionar frontend no navegador local se houver servidor seguro já disponível ou harness estático sem serviços; não iniciar Docker. Confirmar 360px, desktop, teclado, reflow e foco. Não usar contas reais para provar testes locais.

## Task 5: documentação, revisão e aceite local

**Files:** `docs/architecture/data-flow.md`, `docs/product/feature-inventory.md`, novo `docs/reviews/2026-11-10-registration-without-email-verification.md` e plano de acompanhamento.

**Interfaces:** relatório separa comportamento implementado, provas automatizadas locais e dependências externas ainda pendentes.

- [ ] **5.1 Atualizar fluxo e inventário.** Substituir descrições de cadastro sem senha, confirmação obrigatória e criação posterior por nome/email/senha, aprovação obrigatória e recuperação de legado. Login exige token válido não revogado e conta admitida ativa, não email verificado. Não reescrever relatórios históricos como se o passado tivesse mudado.
- [ ] **5.2 Revisar diff completo.** Conferir ausência de senha em SQL, filas, logs, respostas e storage; nenhuma nova dependência/schema; nenhuma alteração de deploy/cron/nginx. Revisar decisões de duplicidade e identidade órfã, estado da conta e ausência de chamada que marque email como verificado. Usar skill de revisão de código no aceite; qualquer delegação continua sujeita à autorização do usuário.
- [ ] **5.3 Rodar os gates.**

```sh
npm run verify
git diff --check
```

Baseline conhecido antes da implementação: 10/11/2026, 839 PASS, 0 FAIL, 2 SKIP Linux, `verify: ok`. Não usar esse resultado como prova do código novo. Preservar logs de eventual falha e sua repetição, sem aumentar timeouts para mascarar problemas.

- [ ] **5.4 Registrar relatório e checkpoint.** Informar comandos reais, totais, checks ignorados, limitações do navegador e pendências. Marcar etapas concluídas nos dois registros do plano sem remover restrições.

```sh
git add docs/architecture/data-flow.md docs/product/feature-inventory.md docs/reviews/2026-11-10-registration-without-email-verification.md docs/superpowers/plans/2026-11-10-registration-without-email-verification.md
git commit -m "docs: record approval-only registration and local evidence"
```

## Task 6: homologação externa — exige autorização separada

**Files:** atualizar apenas relatório de evidências e acompanhamento. Nenhuma escrita externa está autorizada por este plano.

- [ ] Obter autorização para ambiente e contas de teste controladas, sem usar cadastros de pessoas reais como fixtures.
- [ ] Demonstrar cadastro sem envio de confirmação, Firebase desabilitado/não verificado e ausência de acesso antes de aprovação.
- [ ] Aprovar pelo Portal com cargo/contrato válido e demonstrar login com a senha originalmente escolhida e email ainda não verificado.
- [ ] Demonstrar recuperação de pendente antigo e de ativo não verificado; separar SMTP aceito de mensagem recebida e link realmente utilizável. Se o Firebase impedir reset enquanto disabled, registrar o bloqueio e revisar a compatibilidade antes de liberar; nunca habilitar antecipadamente para contornar o provedor.
- [ ] Demonstrar desativação bloqueando acesso e recuperação sem reativação, repetição sem troca de senha, e links antigos sem bypass de aprovação.
- [ ] Registrar resultados, limpar somente fixtures autorizadas e manter publicação/deploy como decisão independente.

## Handoff e condição de parada

Implementação local das Tasks 1–5 concluída em 11/11/2026, no working tree da sessão principal. Task 6, integração Git e deploy permanecem pendentes de autorização específica. Não afirmar que a confirmação foi retirada do sistema em produção antes da mudança publicada e homologada.
