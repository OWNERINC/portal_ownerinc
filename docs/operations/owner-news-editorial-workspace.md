# Owner News — entrada e workspace editorial (Task 9)

Entrega local, sem cutover. **Solicitar autorização antes de qualquer deploy na
VPS.** Não foram alterados Docker, Nginx ou workflows de deploy.

## Entrada, mesma conta e saída

- `/editorial-entry.html` é uma página autenticada do shell. Exige a capacidade
  `manageKnowledge` e abre uma sessão com
  `authenticatedFetch('/api/cms/session', {method:'POST',body:'{}'})`, antes de
  navegar para `/editorial/admin`. Não emite JWT/sessão Payload. A API mantém a
  rotação atômica e os **7.200.000 ms fixos** de duração existentes.
- Links para a entrada e `/editorial/` respeitam as guardas globais de dirty,
  upload e mutação do shell. Cancelar a saída não encerra sessão nem abandona o
  formulário.
- `SessionWatch` é um provider público Payload. Importa o módulo estático
  `/js/editorial-session-watch.js` pelo browser, reutilizando exclusivamente
  `/js/firebase-config.js`. Não há configuração Firebase duplicada no Next.
- O observador aguarda `authStateReady`, compara o UID do Firebase com o GET
  `{uid,expiresAt}` da sessão e revalida em foco, visibilidade, mudança de conta,
  a cada 60 segundos e na expiração original. Uma troca conhecida de UID ou
  expiração oculta imediatamente o conteúdo, antes de aguardar rede. Erros
  operacionais ocultam o conteúdo e oferecem retry, sem afirmar logout confirmado.
  Cleanup remove listeners, assinatura Firebase e timers, abortando leituras.
- Sair do Portal (`logout`/`endSession`/evento de outra aba) revoga o cookie por
  DELETE cru, sem recursão no helper autenticado. Só depois confirma a saída;
  uma falha permite retry. Antes de chamar Firebase `signOut`, verifica novamente
  o UID capturado: não desloga uma conta nova durante uma resposta lenta/retry.
- **Sair do editorial** mantém a conta do Portal conectada. O link passa pela
  guarda nativa antes da página de saída; o GET apenas renderiza a página, e o
  browser confirma DELETE antes de retornar à entrada. DELETE falho preserva o
  cookie e mostra retry. A revogação continua idempotente.
- Os guards Origin/REST/Server Actions e a estratégia de autenticação atuais
  permanecem intactos. Não foi aberta exceção de serviço para polls.

## Enquetes e fronteira privada

- `createPollAdminRouter({authenticate,db})` conserva `.admin` e o reader/voter
  exportados. Somente montagem/autenticação/conexão são injetáveis; validators,
  SQL, `withAudit`, `expected_version`, locks e índice one-open são os mesmos.
- `/api/internal/editorial/polls` exige **PAYLOAD_TO_PORTAL_SECRET e cookie
  editorial real** por request. Resolve hash, revogação Firebase, expiração e
  perfil atual, recarrega o perfil e aplica o mesmo `canManageCms`. Nenhum UID,
  role ou permissão enviados pelo browser concedem acesso.
- `/editorial/api/portal-polls` faz proxy para essa montagem. Encaminha somente
  o cookie editorial selecionado e o segredo server-side, nunca headers
  arbitrários. Não segue redirects. Erros de infraestrutura/configuração viram
  503 sanitizado; 409 e reasons de domínio são preservados. Respostas no-store,
  `X-Total-Count` preservado. Nenhum segredo/cookie é retornado em JSON.
- `requestPolls(path,{method,body,signal}) -> {data,total?}` aceita somente GET e
  POST `/`, PUT `/:uuid/draft`, POST `/:uuid/publish|close`. GET aceita somente
  `limit=20`, offset seguro não negativo múltiplo de 20 e status
  `draft|open|closed`; rejects duplicados, extras, encoding, URLs externas.
  Mutações não aceitam query e o corpo tem shape exato (limite de 16 KiB).
- View nativa `/editorial/admin/polls`, lista de 20, 2–6 opções ordenáveis,
  validação e guarda de alterações. Baseline e versão só mudam após ACK; 409
  preserva inputs e exige recarregamento explícito. Publicar congela todos os
  campos; encerradas só permitem criar uma cópia **não salva**, sem IDs/votos.
  Resultados são agregados, sem UIDs de votantes. Não há upload nesta view.
- Extensões públicas: `DefaultTemplate`, `Form`, `TextInput`, `Button`,
  `LeaveWithoutSaving`, `SetStepNav`, providers/nav/logout/graphics. Não há fork
  dos componentes nativos. Tradução oficial `pt`, timezone `America/Sao_Paulo`,
  marca original e ajustes SCSS pequenos, com foco visível.

## Legado e limite da Task 12

GET autenticado `/api/cms/owner-news/authority` expõe apenas `{mode,epoch}`,
sem ampliar o GET de sessão. Quando a autoridade não é `legacy`, a UI antiga
desabilita edição, home e enquetes legadas, oferece **Abrir no Payload** e mantém
prévia/histórico somente leitura, inclusive em links antigos.

**Isso é capacidade de apresentação, não freeze de segurança.** Task 12 ainda
deve bloquear todas as escritas legadas no servidor, assets/promoter/cutover.
Não ativar Payload para leitores reais usando apenas esta entrega.

## Verificação local reproduzível

```powershell
node --test tests/unit/editorial-entry.test.mjs tests/unit/editorial-polls-proxy.test.mjs tests/unit/owner-news-polls.test.mjs tests/unit/owner-news-polls-frontend.test.mjs
npm --prefix cms run typecheck
npm --prefix cms run test:unit
$env:CMS_BUILD_ONLY='true'; npm --prefix cms run build
# Em processo separado, somente para gerar/verificar import map com entradas sintéticas:
$env:CMS_BUILD_ONLY='true'; $env:NEXT_PHASE='phase-production-build'; npm --prefix cms run generate:importmap
npm run verify
git diff --check
```

Harness opt-in: `node cms/tests/integration/run-task9.mjs --prepare-new-task9`
cria **somente novos** `cms_task9_test` e `portal_task9_test` em
127.0.0.1:55441. Recusa se algum existir, sem resetar ou copiar bancos antigos.
Aplica migrations existentes e usa o state privado local autorizado para as
credenciais, sem logá-las. Depois execute, separadamente:

```text
node cms/tests/integration/run-task9.mjs --http <diretório-privado-Task9>
node cms/tests/integration/run-task9.mjs --browser <diretório-privado-Task9>
```

Somente seus processos Next 19092, Express 19091 e browser são encerrados. Os
fixtures de enquetes são gravados apenas no banco Task9. PostgreSQL/Payload/Next,
HTTP proxy, sessão hash/profile e domínio/auditoria são reais. **Firebase Auth
provider/SDK e o hosting Nginx são doubles explícitos**, não aceite de identidade
real. Testes incluem publicação concorrente, replay, policy atual, Origin,
baseline/409, cancelamento/espera de saída, encerramento/cópia, permissão perdida,
retry de logout e troca de conta/logout entre abas. Aceite Firebase Emulator real,
Nginx/CSP e full-stack final permanece na Task 15.
