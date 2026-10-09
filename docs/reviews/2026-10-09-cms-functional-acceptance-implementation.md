# Frente 5 — runner funcional e matriz executável, primeira fatia

## Resultado e limite

Implementação **staged**, não aceite integrado completo. Há oito casos executáveis
pré-autoridade, com Portal/API/PostgreSQL/Firebase Emulator/CMS/Nginx/Chromium reais
no caminho de execução. Essa campanha **não foi executada nesta frente**. Nenhum
novo serviço, fixture Docker, login, banco remoto ou produção foi iniciado.

O inventário possui 44 entradas: oito casos desta fatia e 36 casos restantes
declarados, **não implementados**. Todos começam `INCOMPLETE`; não existe `SKIP`
como sucesso. Mesmo oito PASS reais resultariam em `preauthorityComplete=true`,
`acceptanceComplete=false`, resultado global `INCOMPLETE` e **exit 2**.
`implemented=true` significa que existe código executável, não que o caso passou.

Não se declara “CMS funcional/100% entregue”. Entrada administrativa, permissões e
sessão são distintos de criar artigo/upload/draft/Versions/publicar/ler. Aceite no
destino final, qualificação da imagem e migração/cutover continuam gates próprios.

## Arquivos e ownership

- `scripts/test-payload-integration.mjs`: dispatch explícito de matriz, preparação
  e execução; preserva o guard host-side e `--check-config` anteriores.
- `cms/tests/support/integration-config.mjs`: contrato funcional separado, sem
  fallback de URL/banco/storage/ator/autoridade; recusa produção antes de Docker.
- `scripts/integration/payload-functional-fixture.mjs`: preparador privado,
  lease one-shot, Compose próprio, TLS e binding do checkout/artefatos/ferramentas.
- `scripts/integration/payload-functional-targets.mjs`: recursos novos, Docker
  local, volumes próprios e identidade física dos dois clusters antes de DDL.
- `scripts/integration/payload-functional-isolation.mjs`: rede interna única,
  allowlist do env das imagens, env efetivamente resolvido e probe de existência
  de arquivos operacionais antes dos entrypoints da aplicação.
- `scripts/integration/payload-functional-base-images.mjs`: captura pública dos
  digests/Config.Env exatos de PostgreSQL/Nginx, por plataforma.
- `scripts/integration/payload-functional-forwarder.mjs`: listener TCP no processo
  do runner, bind loopback atômico, destino Nginx inspecionado/revalidado e cleanup.
- `scripts/integration/payload-functional-readiness.mjs`: confirmação do listener
  efetivo e probes HTTPS reais de API/CMS, antes de login/browser.
- `scripts/integration/payload-functional-http.mjs`: transporte HTTPS Node 18
  limitado, sem redirects, e contas reais verificadas no Emulator.
- `scripts/integration/payload-functional-run.mjs`: lifecycle dos serviços próprios,
  migrations existentes, readiness real, campanha e relatório sanitizado.
- `cms/tests/integration/functional-matrix.mjs`: IDs, precondições, oráculos,
  evidências obrigatórias e máquina de estados da matriz.
- `cms/tests/integration/functional-preauthority.mjs`: casos HTTP/SQL/browser.
- `tests/unit/payload-functional-{guard,http,matrix,native-me,isolation,base-images,forwarder,runtime}.test.mjs`:
  checks offline; doubles de request/SQL/FS/Docker são explicitamente identificados.

Não foram editados protocolo/authority/auth/UI de produção, ops, CI, recovery ou
runbooks compartilhados. Alterações concorrentes de outras frentes no checkout
não pertencem a esta entrega. Sem commit/push/delegação/SSH.

## Casos executáveis nesta fatia

| ID | Caminho/oráculo efetivo | Limite |
|---|---|---|
| CMS-01 | Academy-only e Benefits-only entram com Firebase SDK real; UID coincide com `/api/users/me`; áreas exatas no hub; viewer não emite sessão nem ganha projeção nativa | Não cobre CRUD das áreas, todos os perfis da matriz ou perfil News positivo |
| CMS-02 | Clique no hub emite v2 HTTP 201, chega ao admin nativo e compara UID em sessão/`portal-editors/me`; cookie real Secure/HttpOnly/host-only/Lax; SQL confirma `legacy/1` | Heading sozinho não aprova; não cria News |
| CMS-05 | Origin ausente/estranho nega antes de INSERT; sessão de duas horas; somente SHA-256 no store; rotação distinta revoga cookie anterior | Sessão real em Emulator, não provider de produção |
| CMS-07-legacy-policy | Access map nega News/Versions; REST nega ou retorna lista comprovadamente vazia; global exige 403; locks vazios; POST de lock/artigo negado; API v2 sem cookie 401, mas `/portal-editors/me` sem cookie exige 200 com `user:null`, sem identidade ou writes | POST de artigo é uma negativa deliberada, não criação positiva; cookie revogado continua sendo 401 |
| AUTH-01 | Clique “Sair do editorial”, DELETE 204, cookie removido, replay HTTP/API nativa 401, Firebase Portal preservado | Não cobre falha do DELETE nesta fatia |
| AUTH-02-portal | Sessão nova; clique “Sair” no Portal; ACK DELETE observado antes da transição real `onAuthStateChanged`; store revogado, cookie removido, Firebase signed out | Observador não substitui/wrap/mock `signOut`; abas/bfcache pendentes |
| AUTH-expiry-permission | Alterar somente grants e expiry das linhas sintéticas próprias; GET recarrega capacidade; expirada não revogada e revogada não expirada negam | SQL induz condições de teste, não simula relógio global nem altera autoridade |
| OPS-preauthority-integrity | Digests reais dos stores News/Versions/jobs/locks e anúncio legado iguais; autoridade `legacy/1`; clusters físicos distintos; sem worker/import/finalizer | Não é restart, restore, coverage ou drain |

A fatia usa três contas `@example.test`: admin Academy, admin Benefits e viewer.
Criação dessas identidades/perfis é setup; **não prova criação de conteúdo**.
Tokens/cookies usados em replay são os realmente emitidos, nunca fabricados.
O browser não usa `route/fulfill`, auth doubles, `addCookies`, atores injetados,
conteúdo interceptado ou readiness fixture. Firebase SDK 10.12.0 é carregado de
`www.gstatic.com`; Chromium restringe DNS a esse host e ao loopback. O proxy de
configuração/emulator é exclusivamente da fixture; frontend/auth/UI permanecem
os atuais. Isso não é validação completa de CSP/headers de produção.

## Preparação e execução futuras pela coordenação

Os comandos abaixo são interfaces disponíveis, **não comandos executados neste
handoff**. Não adicionar esta campanha automaticamente ao CI/verify nesta frente.

```sh
# Somente inventário; sem serviços ou arquivos; exit esperado 2.
node scripts/test-payload-integration.mjs --matrix

# Somente preparação de arquivos privados; não contacta Docker/bancos.
node scripts/test-payload-integration.mjs --prepare-lease

# Mutável: apenas após autorização da coordenação, em runner Linux isolado.
node scripts/test-payload-integration.mjs --execute --lease "<lease.json nova>"
```

O processo preparador exige ambiente explícito:

| Variável | Contrato |
|---|---|
| `NODE_ENV` | `test` no host e API; CMS/Next usa runtime production |
| `MIGRATION_TEST_DISPOSABLE` | Literal `true` |
| `GITHUB_SHA` | HEAD completo de 40 caracteres hex; não branch/tag |
| `PAYLOAD_FUNCTIONAL_PRIVATE_PARENT` | Parent existente, absoluto, fora do checkout, sem symlink; owner seguro em POSIX |
| `PAYLOAD_FUNCTIONAL_API_IMAGE` | Imagem API imutável já carregada no Docker local |
| `PAYLOAD_FUNCTIONAL_CMS_IMAGE` | Imagem CMS production construída previamente pela coordenação, imutável e distinta |
| `PAYLOAD_FUNCTIONAL_EMULATOR_IMAGE` | Imagem Auth Emulator imutável distinta, já disponível |
| `PAYLOAD_FUNCTIONAL_HTTPS_PORT` | Literal `0`: kernel reserva porta efêmera no listener host durante execução; não aceita porta fixa |
| `PAYLOAD_FUNCTIONAL_CERTIFICATE` | Certificado local self-signed válido com SAN IP `127.0.0.1` |
| `PAYLOAD_FUNCTIONAL_PRIVATE_KEY` | Chave correspondente, arquivo privado externo ao checkout |
| `PAYLOAD_FUNCTIONAL_PLAYWRIGHT_MODULE` | `index.mjs`/`index.js` absoluto de Playwright 1.62.1 previamente instalado fora do checkout, como o tool isolado atual do CI |
| `PAYLOAD_FUNCTIONAL_BROWSER_EXECUTABLE` | Opcional: binário absoluto instalado previamente, também externo |

Imagens aceitas por ID `sha256:…` ou referência GHCR Ownerinc com digest, nunca
`latest`/tag solta. API/CMS devem ter label
`org.opencontainers.image.revision` igual ao SHA. Essa checagem **não substitui**
qualificação/signature/SBOM nem prova, sozinha, que uma imagem contém o diff dirty.
O bind do frontend e fontes do harness e o hash do diff são registrados; alterações
de checkout entre preparação/execução invalidam a lease. Checkout compartilhado
requer janela exclusiva da coordenação. O runner não instala ferramentas, não
faz build/pull, não abre browser do usuário e não acessa `.env`/state TaskN.

Ambientes `production`, overrides comuns de DB/Firebase/bridge/storage/Docker e
`NODE_OPTIONS/NODE_PATH` são recusados. Variáveis funcionais desconhecidas ou que
contradizem a lease também são recusadas. A execução desta primeira versão exige
Linux; não afirma uma campanha Windows validada. As APIs do harness são
compatíveis com Node 18; imagens CMS/Next mantêm a exceção Node 24 do projeto.

A API usa a exceção **existente** de Emulator (`NODE_ENV=test`, disposable marcado,
projeto `demo-*`), não `development` nem produção com bypass. Seu contrato de cookie
continua o HTTPS seguro real. Teste offline chama os validadores reais da API para
conferir esse wiring; isso ainda não comprova login integrado executado.

### Isolamento físico e freshness

Cada preparação cria diretório privado novo com UUID, segredo aleatório e nomes
de projeto/container/rede/volumes novos. `consumed.json` é exclusivo (`wx`);
reexecução exige **outra lease e outros recursos**, nunca reuso do banco anterior.
Arquivos são 0600/diretório 0700 em POSIX; helpers existentes aplicam ACL privada
na preparação Windows. O Compose é reconstruído e comparado ao template revisado,
além de conferir hashes: editar JSON/hash não autoriza volumes externos ou writers.

Portal e CMS usam dois containers PostgreSQL 16 e volumes independentes. O Portal
tem nome de DB namespaced; o CMS mantém `ownerinc_cms` porque o provisionador atual
o exige. Nome de DB **não é isolamento**: antes de migrations/DML, o runner compara
`pg_control_system().system_identifier`, DB/role/porta/endereço de servidor,
inventário público vazio, mounts/labels e endereço da rede do container inspecionado.
Repete bindings e identidade física antes de cada migration. Nenhuma porta de DB
é publicada. Mídias Portal/CMS têm volumes próprios, não diretórios de produção.

### Correções da fresh review — FIX FIRST 2

#### Plano da correção concreta (sem delegação/commit)

- Capturar somente campos públicos do registry para os dois digests base;
  `payload-functional-base-images.mjs` conserva referência, config/manifest ID por
  plataforma e Env exato. Testar aceitação do snapshot e recusa de extras/valores
  alterados, outra imagem ou plataforma.
- Substituir publicação Docker por `payload-functional-forwarder.mjs`: listener
  TCP em processo no host, `127.0.0.1:0`, sem seleção de destino pelo cliente.
  Inspeções de lease/network/container selecionam somente IP privado do Nginx,
  porta 443. Revalidar antes de cada conexão e fechar em divergência. TLS fica no
  Nginx, com timeout/limites/cleanup do listener e sockets.
- Derivar arquivos runtime privados exclusivos somente depois da reserva do
  listener; API/CMS/Firebase usam essa mesma origem. Compose não publica nenhuma
  porta; validar config resolvido, Ports efetivos e readiness HTTPS antes do
  browser. Testar o forwarder real contra backend TCP/TLS sintético, nunca como
  evidência de Docker. Rodar Compose config real sem iniciar serviços se o binário
  estiver disponível, checks focados, verify, security, typecheck e diff check.

1. **Contrato nativo sem cookie distinto de revogação.** Viewer com ID token mas
   sem cookie editorial, e anônimo sem cookie, usam o contrato real do handler
   Payload: HTTP 200, `user:null`, somente campos `user`/`message`. Resposta 200 com
   usuário/token/ator/metadata de identidade é rejeitada; códigos alternativos
   não passam como “negação equivalente”. Antes/depois do GET há snapshots SQL
   read-only de todas as tabelas e sequências públicas dos dois bancos, inclusive
   projeções existentes e sessões; qualquer diferença falha. Viewer continua sem
   projeção própria. Replay de cookie realmente revogado exige **401** e
   `{error:'editorial_session_invalid'}`, não aceita 200 null, 403 ou 503.
   A regressão offline chama o handler `/me` da versão instalada, com request/DB
   traps, e confirma seu 200 null sem trabalho de banco; não simula um login real.
2. **Isolamento da fixture e das imagens (correção concreta).** A única rede
   Compose continua bridge `internal:true`. **Nenhum container publica portas**:
   o Moby 28.5.1 não efetiva publicação de portas em endpoint exclusivamente
   interno, portanto `HostConfig.PortBindings` não era prova de um listener real.
   Inspeções conferem `Internal`, driver/labels/ID, membership singleton,
   `PublishAllPorts=false`, `HostConfig.PortBindings` vazio e ausência de bindings
   efetivos em `NetworkSettings.Ports` (somente valores null são aceitos).
   `compose config --format json` é validado antes de DB/application start;
   o `Config.Env` efetivo coincide exatamente com base aprovada + overlay.

O transporte host-side é um forwarder **TCP**, não HTTP/CONNECT e não container.
É um `net.Server` no próprio PID do runner, reservado com `127.0.0.1:0`, sem
check-close-rebind. Antes de admissão do destino, conexões são fechadas. Depois,
somente o IP IPv4 privado do Nginx em execução, pertencente ao subnet inspecionado,
pode ser usado, sempre na porta 443; gateway/rede/broadcast, loopback, link-local,
URL/DNS arbitrários, rede extra, container substituído e endpoint divergente são
recusados. IP, network/container IDs, imagem e UUID da lease ficam pinados. Cada
conexão é pausada até re-inspecionar network/container; divergência fecha sockets
e listener. Cliente não escolhe URL/destino. Não há segunda bridge, root/iptables,
container privilegiado ou socket Docker montado para esse transporte.

TLS termina **no Nginx**. API/CMS/CORS/Firebase Emulator usam a mesma origem HTTPS
da porta realmente reservada. Os artefatos da preparação com porta 0 são somente
templates, nunca executados: depois de conferir seus fingerprints e contrato, o
runner cria `runtime/` privado exclusivo com `compose.json`, `nginx.conf`,
`firebase-config.js`, cert/key da lease e `transport-binding.json` (PID/origem/hashes).
Nenhum segredo novo de produção é carregado. O relatório permanece no diretório
original da lease. Listener/PID/destino observado, probes TLS de `/api/ready` e
`/editorial/ready` e recheck de identidade são obrigatórios antes do browser.
Se o host Linux não alcançar o bridge interno (por exemplo, runtime rootless com
topologia incompatível), a readiness falha; não existe fallback para rede externa.

Limites do forwarder: 32 conexões, 5 s para connect/recheck, 15 s idle, 60 s por
conexão, 16 MiB cumulativos por conexão e 30 min de vida. Usa backpressure nativo
dos pipes. SIGINT/SIGTERM e o finally do runner fecham somente o listener e seus
sockets, depois os serviços próprios inspecionados; não enviam sinais a PID de
outro processo. Cleanup aguarda eventos `close` tanto dos sockets cliente quanto
upstream, além de `server.close`, e verifica ausência efetiva de listener/sockets.

O `Config.Env` da imagem tem allowlist estreita de valores de base (PATH, versões
Node/Yarn, LANG/HOME e os dois defaults CMS conhecidos). PostgreSQL/Nginx usam
**maps exatos vinculados ao digest, config ID e plataforma**, não regex genérica
de versão ou exceção ampla para todas as variáveis da imagem. Qualquer chave
operacional herdada — mesmo vazia ou substituída no Compose — é recusada, incluindo
Firebase project/credenciais, URLs/bridge/DB, SMTP/provider keys, proxy e opções
de loader. Os overlays dos serviços Node deixam credenciais Google/Firebase e
SMTP/SendGrid/Resend explicitamente vazias. Email não está configurado nem é
testado; não existe mail stub ou confirmação fictícia de envio.

Captura pública em 2026-10-09: registry Docker Hub, manifests/index e config blobs,
sem layers/serviços. PostgreSQL index
`57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777` inclui
`GOSU_VERSION=1.19`, `DOCKER_PG_LLVM_DEPS=llvm21-dev \t\tclang21`, `PG_VERSION=16.14`
e SHA de fonte fixo. Nginx index
`4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752` inclui
`ACME_VERSION=0.4.1`, `NGINX_VERSION=1.31.3`, `NJS_VERSION=1.0.0` e releases fixos.
Somente os configs Linux amd64/arm64 capturados no arquivo próprio são aceitos;
isso não qualifica CMS/Emulator para arm64. Campos ausentes, extras, valor diferente,
digest/config ID ou plataforma não capturados falham fechado. Snapshot exato não
torna SMTP/Firebase/loader operacional da imagem confiável.

Na futura **execução autorizada**, o preflight também executa um processo Node
one-shot de inspeção por imagem API/CMS/Emulator, por image ID imutável, com
`--network none`, filesystem read-only, healthcheck/entrypoint da aplicação
desabilitados, caps removidas e no-new-privileges. Usa UID 0 somente para observar
metadados dos diretórios da imagem, não o runtime da aplicação. Confere cwd e
existência de `.env`/variantes e arquivos de credenciais nos roots `/`, `/app`,
`/app/api`, `/app/cms`, `/workspace` e locais padrão de HOME/ADC. Não lê conteúdo
de segredos; resposta inesperada ou falha de inspeção recusa a imagem. A preparação
da lease continua sem Docker. Esses probes transitórios **não foram executados**
nesta correção: testes exercitam o mesmo script com FS/Docker mocks.

O Firebase SDK continua sendo o script real pinado de `www.gstatic.com`, carregado
pelo **browser no host**, não pelos containers. Não foi introduzido mirror, proxy
de SDK ou rede externa para a fixture. Egress dos containers e ingress loopback
precisam de confirmação efetiva na campanha Linux; o wiring offline não prova
conectividade nem bloqueio de rede reais. Não houve alteração no default de rede
de produção ou na API/auth da aplicação.

São aplicadas somente migrations/provisionadores nativos existentes, sem
finalizer, control bootstrap, importer, cron ou worker. Não se força `payload`,
`frozen`, ator News, coverage, seal ou readiness. `/api/ready` e `/editorial/ready`
são os endpoints reais. Guard privado do leitor/importer
`scripts/owner-news-payload/files.mjs` é reutilizado somente para leitura vinculada
de arquivos, sem alterar Task3 ou reivindicar capability de importação.

## Evidência, status e cleanup

- `functional-acceptance-report.json` é exclusivo/privado por lease. Guarda
  cenário separado de qualquer futuro documentId, SHA/diff/source hash,
  image IDs, hashes das identidades físicas, início/fim, checks/booleans e HTTP
  status sanitizados, traces de request/response/SDK e cleanup.
- Nunca grava token/cookie/password, corpo editorial, SQL bruto, headers de auth,
  `.env`, dump, screenshot de formulário de login ou stderr privado no relatório.
  `compose.json` contém segredos **somente da fixture**, permanece privado e não
  deve ser publicado como artifact. Nginx não monta o diretório completo da lease.
- As evidências mínimas por caso são exigidas por nome; array vazio, heading-only,
  inventário truncado, case duplicado, `SKIP`, ou PASS de caso não implementado
  falham fechado. Exceções não viram PASS. Casos não alcançados seguem INCOMPLETE;
  falha de setup é registrada como falha de execução, não teste fictício executado.
- Exit 1: guard/execução/asserção/cleanup falhou. Exit 2: campanha incompleta,
  inclusive oito PASS desta fatia. Exit 0 de preparação/config significa somente
  preparo/config válido, nunca aceite. Exit 0 da campanha está indisponível enquanto
  houver casos restantes não implementados.
- Ao finalizar, o runner fecha seu listener/sockets, confere ownership e para somente os serviços da lease;
  não executa `down -v`, DELETE de conteúdo ou purge. Volumes, containers parados e
  evidências permanecem para diagnóstico. Se ownership/stop falhar, registra FAIL
  e preserva recursos para a coordenação. Remoção exige autorização nova restrita
  ao manifesto dessa lease. Não apagar histórico/Versions reais nem contornar
  `news_history_retention_required`.

## Restante e interface da gate 4

NEWS-01–11 e PUB-01–10 permanecem INCOMPLETE com dependência explícita
`gate4_verified_native_writer_and_durable_authority_admission`. NEWS-01–10
preservam os cenários da matriz histórica de 02/10; NEWS-11 explicita a criação
sem artigo preexistente. Não existe adapter positivo escondido ou callback que
injete ator. A gate 4 deve fornecer admission real durável/autoridade legitimamente
obtida e identidade verificada; depois se implementa a jornada positiva nativa com
novos bancos/storage e UI create, sem seed de artigo.

CMS-03/04/06, SEC-01–04, UX-01, falha de DELETE, abas/bfcache, OPS-01–04 e
regressões das demais áreas têm oráculos individuais no inventário, mas ainda
dependem de suas suítes reais. Restore positivo Linux, Task9 dirty/pending,
qualificação de imagem, migração/readiness/coverage/drain/seal/cutover e validação
no destino final **não são supridos** por esta fatia. A aprovação humana final
continua obrigatória.

## Verificação desta implementação (atualizada após FIX FIRST 2 concreto)

- Checks focados (guards funcionais, HTTP com transport double, estados/evidências
  da matriz, contratos `/me`, snapshots base exatos, isolamento/configuração,
  forwarder, artefatos runtime e compatibilidade do guard anterior): **89 PASS**,
  zero FAIL/SKIP, exit 0, sem serviços Docker/CMS (apenas backends host sintéticos de teste).
- Os testes do forwarder usam listener e sockets TCP/TLS **reais no host**, com
  backend sintético e dial remap explícito de IP privado:443 para esse backend
  loopback. Confirmam transporte/half-close, TLS terminado no backend, validação
  de CA/SAN, reserva de porta 0, rejeição de falso binding, readiness negativa,
  limites, drift/recheck e cleanup efetivo. **Não são testes Docker/CMS reais**.
- Runtime/artifacts: listener e arquivos exclusivos são reais; lease/cert/key de
  binding são sintéticos e há uma seam explícita de leitura. Não se afirma
  admission dessa lease pelo leitor privado Task3. Mudança real no arquivo de
  chave e no Compose rejeita fingerprints originais; hash autoalterado não admite
  alvo operacional. O leitor compartilhado/fingerprints/ctime não foram relaxados.
- As três falhas funcionais relatadas por outra rodada ficaram corrigidas:
  `functional_forwarder_still_running` exigia aguardar os eventos de close dos
  sockets além do listener; `functional_private_file_changed` e a diferença para
  `functional_tls_identity_invalid` vinham da recusa `checkout_path_forbidden`
  do leitor compartilhado no HOME Windows com Git, não de precisão de ctime.
  A seam somente do teste separa binding runtime de admission privada.
- Resolver **real** Docker Compose 5.1.4, `config --format json`, recebeu o
  manifest funcional com credenciais sintéticas e env-file vazio: nove serviços,
  `internal:true`, zero ports e guard de config resolvido aprovado. Não executou
  `up`, build, pull ou probes de imagem. `command:null` emitido por esse resolver
  para CMD herdado é aceito estritamente como ausência; `command:[]` é rejeitado.
  No Windows, `ProgramFiles` foi incluído somente como caminho de ferramenta no
  env limpo para o CLI descobrir seu plugin Compose; não foram admitidos overrides
  Docker, credenciais ou settings operacionais.
- `npm run verify`: uma rodada completa passou com **exit 0**, syntax/typecheck,
  scanner e Compose config read-only, Portal **1.674 PASS/0 FAIL/7 skips**, CMS
  **448 PASS/0 FAIL/11 skips**. A **última repetição** no checkout concorrente
  terminou **exit 1**, Portal **1.672 PASS/2 FAIL/7 skips**, sem falhas funcionais;
  interrompeu antes das suítes CMS/scanner/Compose nessa repetição. Não se declara
  o estado global final verde com base na rodada anterior.
  - `cms-infrastructure-preparation.test.mjs:246`: cópia do arquivo ops versus
    fonte viva divergente; **passou** na reexecução isolada subsequente.
  - `payload-preauthority-recovery-guard.test.mjs:150`: **ainda falha** na
    reexecução isolada. Espera `cms-provision` → `cms-control-roles` → `cms-migrate`
    textualmente em `provisionProject`; o runner Task3 atual delega a
    `initializePreauthority`. Nenhum desses arquivos foi editado por esta frente.
  - Uma primeira rodada também teve duas transições `invalid_cold_state` fora do
    ownership; não reapareceram nas rodadas seguintes.
  Os checks funcionais focados foram repetidos após a última mudança: **89/89**.
  Totais gerais incluem outras frentes; skips opcionais/Linux não são evidência
  funcional. A coordenação precisa estabilizar o checkout e resolver o guard Task3.
- `npm run test:cms`: exit 0 separado, **448 PASS/0 FAIL/11 skips**.
- `npm run security`: exit 0; audit de produção API/cron/CMS retornou zero
  vulnerabilidades em cada pacote na consulta desta frente. Não é scan de imagem.
- `npm run typecheck:cms`: exit 0, `--noEmit --incremental false`.
- `git diff --check`: exit 0 no checkout compartilhado.
- Build, browser integrado, Docker up, campanha HTTPS e produção **não executados**.
- Revisão local de contratos/ownership realizada; revisão independente e execução
  autorizada pela coordenação ainda pendentes. Sem delegação nesta autorização.
