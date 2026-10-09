# CI 37991858855 — transporte de imagens base, sem mudança de runtime

## Causa observada

Commit reportado pelo primary: `5211664`. Attempts 1/2 falharam em Initialize
containers antes do checkout. O log local da attempt 2 confirma três pulls do
PostgreSQL pinned recusados por Docker Hub com `toomanyrequests` / unauthenticated
pull rate limit. Nenhum gate de build, scans, sessão, recovery ou qualification foi
executado nessa tentativa; ela não é evidência de falha do recovery nem de aceite.

Consulta read-only `gh secret list --repo OWNERINC/portal_ownerinc --json name`:
somente os cinco nomes PORTAL_VPS_*; nenhum nome de credencial Docker Hub no repo.
Não li valores. A consulta de nomes de secrets de organização disponíveis ao repo
retornou HTTP 422; portanto não declaro ausência de todos os secrets herdados.
O workflow não referencia credenciais Docker Hub nem environment com tais secrets.
Não inventei conta/secret, não repassei GITHUB_TOKEN ao Docker Hub e não solicitei
credencial nova para implementar esta alternativa pública.

## Inventário CI e prova read-only dos mirrors

Todos estes índices foram obtidos pela API Registry v2 via HTTPS e **SHA256 dos
bytes originais**, não hash de JSON renormalizado nem digest confiado ao header:

| Uso | Imagem oficial e digest do índice | Bytes | GCR / ECR index |
| --- | --- | ---: | --- |
| Service migrations; fixtures API-v2; recovery, dois bancos | postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777 | 10301 | 200 / exact |
| Nginx route delivery/browser e recovery | nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752 | 10333 | 200 / exact |
| API/cron build; fixture API-v2 | node:24.12.0-alpine3.23@sha256:c921b97d4b74f51744057454b306b418cf693865e73b8100559189605f6955b8 | 3866 | 200 / exact |
| Três estágios base independentes CMS | node:24-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2 | 3878 | 200 / exact |
| Compiler Go patched para esbuild | golang:1.26.9-alpine3.23@sha256:96123126ac58e910f4dd3619a8901e2fb6d1ad84b59b1232cac7c9ea65a8f888 | 9019 | 200 / exact |

Endpoints: `https://mirror.gcr.io/v2/library/<name>/manifests/sha256:<digest>` e
`https://public.ecr.aws/v2/docker/library/<name>/manifests/sha256:<digest>`.
ECR usa apenas o token **público/anônimo** do desafio do registry, guardado em memória
e não impresso. Tokens e URLs assinadas de blobs não foram salvos neste documento.

GCR também retornou 200 com SHA256 exato para todos os manifests linux/amd64:

- postgres: `sha256:7a396fd264a2067788b6551122b50f162bf6136312c7fc9d74381cb92c648382`;
- nginx: `sha256:1d40e3eb3bf4f138de1d67193f2aa5309fcaf343eb5ffadbf5e9439de1eb1ebb`;
- node API: `sha256:c720a25dd3a78e6274d55267e76d89e5c096c46940b5ea83f7a99978feb0b514`;
- node CMS: `sha256:a01ebbfa28f5ac85e27044d661b4415d30508b2e64dc23eef236493b7a99f916`;
- golang: `sha256:52c60db0b6661204bf2ed874743bffc80c17eaf95d6ff51d87e205484358d40f`.

HEAD dos blobs config+layers GCR: **37/37 HTTP 200**, Content-Length igual ao tamanho
de cada descriptor (12+9+5+5+6). Layers não foram baixados/hasheados localmente;
Docker ainda deverá verificar seu digest ao fazer o pull. Isso é disponibilidade
read-only atual, **não** um pull/build Docker executado ou aceite de container.

Também conferi o protocolo usado pelo pull direto do service: `/v2/` GCR responde
401 com desafio Bearer normal; o endpoint de token com scope
`repository:library/postgres:pull` emite token anônimo (HTTP 200), sem conta/secret.
Com esse token, GET index/manifests linux/amd64/config retornou 200 e todos os três
hashes ficaram exatos. Token mantido somente em memória, não exibido/persistido.

ECR tinha índices/manifests iguais, mas HEAD dos blobs retornou 401, enquanto GET
retornou redirects 307 para CDN; uma conferência HEAD da CDN não confirmou a
disponibilidade. Não o escolhi como implementação com base apenas nos manifests.
ECR tampouco serve `/v2/library/...` como mirror transparente do Hub (404 na
sondagem), por causa do namespace `docker/library/...`. Não instalei um proxy para
reescrever isso e não inventei suporte a prefixo no daemon.

Downloads de API/cron/CMS já publicados são GHCR, fora dessa quota. Trivy action
instala a ferramenta de scan e consulta seus próprios recursos; os scans dos
outputs locais e os pins/actions/versões existentes permanecem intactos. npm,
Alpine apk, Go modules, Playwright e recursos de scanner são dependências de rede
separadas, não resolvidas nem enfraquecidas por este patch.

## Patch bounded, CI-only

Arquivos: `.github/workflows/ci.yml`, `tests/unit/cms-image-pipeline.test.mjs` e
este relatório. Nenhum Dockerfile, Compose, runtime, recovery, initializer,
qualifier, packager, helper de admissão ou deploy script foi alterado.

1. O service PostgreSQL do validate job usa
   `mirror.gcr.io/library/postgres:16-alpine@sha256:<mesmo índice>` diretamente.
   Services são inicializados **antes** de steps; login/setup posterior não corrige
   esse primeiro pull. A tag não autoriza alteração: o digest segue obrigatório.
2. Depois de checkout/setup-node, antes de verify e de pulls/builds posteriores,
   um step obrigatório GET-confere os **cinco** índices GCR por hash dos bytes, com
   timeout e sem redirects. Falha de rede/digest encerra a CI, sem modo permissivo.
3. Somente no runner `github-hosted`, contexto Docker default, sem DOCKER_HOST ou
   DOCKER_CONTEXT externo, merge de `registry-mirrors: [https://mirror.gcr.io]` em
   `/etc/docker/daemon.json`. Demais opções são preservadas; nenhuma credencial é
   gravada. Config é validada com `dockerd --validate` antes do reload.
4. SIGHUP somente no processo main de docker.service, **não restart**. Registry
   mirrors é configuração recarregável; espera bounded por Docker info confirmar
   o mirror e verifica que o service PostgreSQL segue healthy. Não altera TLS,
   portas, contextos, storage driver ou identidade de quota.
5. Builds mantêm as mesmas invocações/contextos/Dockerfiles e exigem builder default
   com driver `docker` (integrado ao daemon), não um builder docker-container com
   configuração de mirror independente. O daemon encaminha os pulls Hub seguintes,
   incluindo as fixtures/recovery que mantêm seus refs canônicos por digest.

Há cache fallback normal do Docker para o Hub se o mirror perder disponibilidade;
isso **não muda o pin** nem transforma uma recusa em sucesso. Os índices foram
comprovados agora e são novamente conferidos na CI. Cache GCR não garante retenção
eterna ou SLA de cada digest; ausência/eviction exigirá diagnóstico/decisão nova,
nunca tag flutuante, identity rotation, retry infinito ou abandono de gates.

O uso direto do cache no service é necessário pela ordem pré-step; sua API v2
atendeu o índice/plataforma/blobs acima, mas a documentação Google recomenda a
configuração de daemon para uso geral do cache. Por isso esse pull direto e o
reload efetivo continuam gates de execução CI pendentes, não aceite local.
Um registry espelho próprio durável ou autenticação Docker Hub autorizada exigiria
escopo/credenciais novos do primary, não provisioning silencioso neste patch.

Refs de suporte consultadas read-only:

- https://cloud.google.com/artifact-registry/docs/pull-cached-dockerhub-images
  (cache gerenciado Google, em sync com Hub, não conta contra quota de pull Hub,
  sem garantia de retenção; scans continuam responsabilidade do projeto).
- https://docs.docker.com/reference/cli/dockerd/ (validate/config/reload).
- Moby v28.0.4: `daemon/reload.go` recarrega registry mirrors;
  `daemon/hosts.go` consulta a ServiceConfig atual;
  `cmd/dockerd/daemon.go` passa `d.RegistryHosts` ao BuildKit integrado.

## Checks e limitações

Focused final pipeline/packager/qualifier/setup: **96 PASS / 0 FAIL / 3 SKIP**; os três
skips são native Linux root/chown no Windows, não são execução CI. HTTP do teste
de probe é explicitamente mocked; respostas 404/429, hash adulterado mesmo com
header correto, timeout e redirect recusam antes de logar sucesso. Testes conferem
inventário completo/pins, ordem, ausência de bypass, contexto hosted/local, reload
sem restart e driver integrado. O snippet Python real de merge foi executado
somente em fixtures privadas temporárias: cria config ausente, preserva todas as
demais opções e recusa JSON malformed/array/null/boolean sem sobrescrever o input.

`npm run verify`: **PASS**, exit 0 / `verify: ok`; Portal **1730 PASS / 0 FAIL /
12 SKIP**, CMS **448 PASS / 0 FAIL / 11 SKIP**; syntax/typecheck/scanner de
segredos/Compose config read-only passaram. Totais do shared worktree observado,
não SHA publicado. `npm run security`: **PASS**, zero vulnerabilidades nos três
audits API/cron/CMS. `git diff --check`: **PASS**.
Parser YAML instalado no CMS: workflow parse com uniqueKeys **PASS**. Snippet Bash
do novo step com Git Bash `-n`: **PASS**. Python inline AST: **PASS**. O comando
genérico `bash` deste Windows inicialmente apontou para WSL sem `/bin/bash`; foi
usado o Git Bash instalado explicitamente para a conferência, sem iniciar Docker.

Não houve Docker pull/build/run/reload local, serviço, instalação/host/prod, SSH,
CI dispatch, commit, push, deleção de evidência ou delegação. O patch é para review
fresh; a CI ainda precisa provar initialization, mirror aplicado, scans/recovery e
native root suite sem skips. Não se declara candidato qualificado ou deploy pronto.

## Seguimento: CI 37994301180 / ac1e80d — fallback apesar do mirror configurado

Inspeção read-only de jobs/logs do GitHub e do log local
`cms-ci-37994301180-failed.log` confirma:

- Initialize containers: **success**, PostgreSQL baixado de
  `mirror.gcr.io/library/postgres@sha256:57c72...07777`, digest exato.
- Checkout/setup-node: **success**.
- Verify pinned CI mirrors and configure runner pulls: **success**, os cinco
  hashes logados; `configuration OK`. O código só retorna success após confirmar
  mirror via Docker info e PostgreSQL healthy, mas isso não prova o pull canônico.
- bootstrap e verify: **success**.
- Test preauthority CI setup with native Linux root: **5 PASS / 0 FAIL / 0 SKIP**.
  Este é agora aceite nativo dessa suíte específica, não aceite recovery.
- Test route delivery with production Nginx image: **failure**, imagem canônica
  pinned ausente localmente; o erro final aponta para registry-1.docker.io e token
  auth.docker.io com `account=githubactions`, timeout de 15s.
- Build/scans/API-v2/recovery/qualification: **skipped**, deploy: **skipped**.

O erro final não contém a primeira falha do mirror. Não atribuo uma causa definitiva
com esse log. API Docker 1.48 é observada; versão exata/storage backend não são
mostrados, portanto a análise dos fontes abaixo não substitui identificação nativa.

Moby v28.0.4 read-only:

- `registry/service_v2.go`: LookupPullEndpoints lista mirrors antes do Hub;
  credencial preenchida não elimina essa lista.
- `distribution/pull.go`: mirror errors podem continuar no endpoint seguinte;
  o erro final pode ser só do Hub, omitindo o erro que disparou o fallback.
- `distribution/registry.go` + `registry/auth.go`: no backend clássico, o
  StaticCredentialStore usado pelo token handler devolve Username/Password/
  IdentityToken sem filtrar hostname, inclusive para autenticação do mirror.
  Hub auth pré-configurada pode assim contaminar a autenticação pública GCR.
- **Distinção importante**: `daemon/containerd/resolver.go` filtra auth pelo host
  no backend snapshotter. Sem saber qual backend estava ativo, a contaminação do
  mirror é uma hipótese consistente, não conclusão. O account do erro final prova
  apenas que a tentativa Hub tinha uma identidade pré-configurada.

### Patch de seguimento, sem retag / sem alteração de consumidor

Novo helper **exclusivamente CI** `scripts/prepare-ci-registry-pulls.mjs`, chamado
após verificação/configuração do mirror e antes de bootstrap/tests/build. Arquivos
do seguimento: workflow, helper, `tests/unit/ci-registry-pulls.test.mjs`, relatório.

1. Somente Linux github-hosted, contexto default/local, sem DOCKER_HOST/CONTEXT
   externo, sem argumentos ou modo fixture no CLI.
2. Lê a configuração original sem imprimir/decodificar seus segredos e sem a
   alterar. Cria cópia privada UUID sob RUNNER_TEMP (dir 0700/config 0600).
3. Remove somente auths dos aliases do Hub: docker.io, index.docker.io,
   registry-1.docker.io, registry.hub.docker.com. Substitui helpers desses aliases
   por overrides **presentes e vazios**, mantendo auths/helpers/config dos demais
   registries, inclusive GHCR, e preservando o credsStore global.
   O fonte Docker CLI v28.0.4 `cli/config/configfile/file.go` comprova a precedência:
   `getConfiguredCredentialStore` retorna a entrada específica presente (inclusive
   vazia) antes do global; `GetCredentialsStore` seleciona file-store quando vazia.
   O mapa de helpers não vazio também evita autodetecção de helper depois de remover
   a última auth. Não usar mera deleção do helper, que voltaria ao global.
   BuildKit v0.20.2 `session/auth/authprovider/authprovider.go` normaliza o host
   Docker Hub para `https://index.docker.io/v1/` e usa `config.GetAuthConfig`, a mesma
   precedência. Isso fundamenta manter os overrides no DOCKER_CONFIG dos builds;
   não comprova a versão nem o comportamento do builder desta execução, que ainda
   precisa passar no driver `docker`/builder `default` já exigidos no workflow.
4. Loga somente versão/storage/backend do engine, sem conteúdo de config. Faz para
   **cada um dos cinco pins**: pull explícito no GCR por digest para linux/amd64;
   inspect exige RepoDigest exato GCR e Image ID; **pull canônico real por digest**;
   inspect exige RepoDigest canônico exato e mesmo Image ID/plataforma.
5. Não há `docker tag`, troca do pin nem inferência de que a tag cria @digest.
   Pull canônico passa pelo resolver real do daemon com configuração isolada; se
   ainda fizer fallback/timeout, a preparação falha obrigatoriamente antes de
   testes/build/push/recovery. Logs distinguem reason fechado do pull direto,
   canônico ou identidade divergente, sem refletir URLs/token/private stderr.
6. Somente após as cinco verificações publica DOCKER_CONFIG no GITHUB_ENV. Login
   GHCR e pre-pulls posteriores usam a cópia privada no ambiente hosted. O recovery
   root **não recebe** esse path nem qualquer DOCKER_*; a fronteira é detalhada na
   correção P1 abaixo. Nenhuma configuração/credencial
   original é apagada ou sobrescrita, nenhum helper credencial é executado para
   descobrir/exportar valores diretamente pelo novo código. A Docker CLI pode
   consultar helpers preservados para outros registries conforme sua semântica;
   overrides Hub selecionam file-store vazio. A cópia privada permanece apenas no
   runner descartável; não é publicada como artifact nem incorporada a builds.

O novo gate comprovará **resolução local canônica após pull real**, não que nenhum
pedido canônico jamais tocou o Hub: o daemon ainda permite fallback normal. Se for
necessário eliminar todo fallback por política/availability, isso exige desenho
adicional do primary (por exemplo transporte CI explícito para cada consumidor ou
registry durável), não alteração silenciosa de Dockerfiles/Compose/recovery.

Testes novos usam credenciais sintéticas e comandos Docker **explicitamente mocked**:
transformação seletiva/preservação e precedence de override sobre store global, ordem pull mirror /
inspect / pull canônico / inspect, auth contaminada com fallback simulado, falha de
pulls, tag-only sem RepoDigest, mesmo SHA com ID divergente, wrong digest/platform,
preservação GHCR e CLI sem bypass. Mock de engine não prova causa nativa.

Focused de seguimento (CI helper/pipeline + A+B): **108 PASS / 0 FAIL / 0 SKIP**.
`npm run verify`: **verify: ok**, Portal **1744 PASS / 0 FAIL / 12 SKIP**,
CMS **448 PASS / 0 FAIL / 11 SKIP**. Skips existentes incluem testes que exigem
POSIX/native Linux root e dependências opcionais indisponíveis localmente;
não converto esses skips em aceite nativo da preparação Docker. `npm run security`:
API/cron/CMS **zero vulnerabilities**. `git diff --check`, LF/whitespace dos quatro
arquivos owned, parse YAML com keys únicas, sintaxe Bash dos passos e AST Python
do inline configurador passaram. Totais descrevem o worktree local observado,
não SHA publicado/aceite do candidato.
Não executei Docker operacional, CI dispatch, commit/push/SSH, produção ou delegação.
O primary precisa de review fresh e de futura execução CI dos pulls reais para
aceitar esta correção; a execução ac1e80d não certifica a preparação nova.

## Fresh review P1 — separar transporte autenticado do ambiente recovery

O review encontrou um defeito real do patch anterior: `DOCKER_CONFIG` enviado ao
`sudo env` entra em `runRecovery` (runner 1108–1114), que coleta **todos** os
DOCKER_* e chama `validateRecoveryInputs`. O guard do fixture 86–93 rejeita qualquer
valor não vazio com `docker_endpoint_override_forbidden`. Além disso, mesmo que
fosse aceito, `safeEnvironment` e Compose via `env -i` não propagariam a variável
aos filhos. A alegação anterior de propagação downstream era incorreta, removida.

### Correção limitada ao CI

- **Guard, runner, initializer, adapter, coordenador, Compose e pins inalterados.**
- Recovery passa a usar `sudo env -i PATH="$PATH" HOME=/root ...`, com somente
  imagens/identidade/run/report explicitamente enviados. Não encaminha
  DOCKER_CONFIG nem relaxa o bloqueio a quaisquer DOCKER_*.
- Preparação, builds, publicação/login GHCR e os três pulls exatos do candidato
  continuam com DOCKER_CONFIG privado no ambiente hosted. Não são pulls root;
  a imagem pertence ao daemon, não ao usuário que a baixou.
- No passo de pre-pull (mesma condição do recovery), um **gate root read-only sem
  DOCKER_CONFIG** verifica que o contexto de root aponta exatamente para
  `unix:///var/run/docker.sock`, o mesmo socket local/default usado pela preparação.
  Depois exige `docker image inspect` das referências exatas API/cron/CMS e dos
  pins **canônicos**, não mirror-only, PostgreSQL/Nginx. Qualquer falta/endpoint
  diferente falha antes de iniciar o recovery. Nenhum retag ou download extra root.
- Root não necessita credenciais do hosted para consultar imagens já locais.
  O initializer mantém também sua verificação independente do endpoint local.
  Não há nova configuração root instalada, env preserve global ou exceção ao guard.

### Inventário e políticas realmente existentes

Conferidos `docker-compose.yml`, `docker-compose.payload.yml`, overlays fixture /
produção, `createRuntime` (copia esses mesmos arquivos e escreve `.image-env`),
`provisionProject`, initializer real, snapshots e coordenador backup/restore:

| Consumidor recovery | Imagem / dependência | Política existente |
| --- | --- | --- |
| Postgres Portal e CMS | mesmo pin PostgreSQL canônico | Runner `up` e initializer creation `up`: `--no-build --pull never` |
| API, migrate, uploads helpers | API publicado por digest | Runner e initializer creation/migration: `--pull never`; helpers do coordenador: default |
| Cron bootstrap / runtime | cron publicado por digest | Runner `up --no-build --pull never`; resume reinicia containers existentes |
| CMS, provision, control-roles, migrate, catalog verifier / media helpers | CMS publicado por digest | Initializer/adapter/native verifier `run`: `--pull never`; helpers/migrations do coordenador: default |
| B0 / legacy restore protection archive | pin Nginx canônico | Adapter `docker run --network none --pull never`; Nginx Compose, se consultado, mesmo pin |

Node e Go são bases de build, não imagens runtime adicionais no recovery. Firebase
emulator é serviço build-only no profile `local`, ausente dos profiles
`notifications` / targeted `cms-control-roles` desta execução. Inventory regression
exige que todas as declarações `image:` dos quatro arquivos permaneçam dentro dos
três slots do candidato mais os dois pins; imagem runtime nova exige revisão.

**Não afirmamos que todos os comandos recovery têm `--pull never`.** O coordenador
`scripts/payload-operations.sh` usa `compose run` sem essa flag para tar, migrations
e verificação; nenhum arquivo Compose envolvido define pull_policy always/build/
refresh. Fonte Docker Compose v2.38.2 inspecionado read-only:

- [`pkg/compose/run.go`](https://github.com/docker/compose/blob/v2.38.2/pkg/compose/run.go):
  `prepareRun` chama `ensureImagesExists`.
- [`pkg/compose/build.go`](https://github.com/docker/compose/blob/v2.38.2/pkg/compose/build.go):
  `getLocalImagesDigests` usa os nomes exatos das imagens; construção é dispensada
  se local presente e pull_policy não é build.
- [`pkg/compose/pull.go`](https://github.com/docker/compose/blob/v2.38.2/pkg/compose/pull.go):
  `pullRequiredImages` usa `mustPull`, cujo caso default é **pull if missing**,
  conforme presença no mapa das imagens locais. Não confundir com `compose pull`
  explícito nem com tag latest: os candidatos são digests e os bases são pins.

O gate root passa somente com todas essas referências locais. Se cache for removido
depois dele, comandos explícitos never falham; comandos default podem tentar pull
e falhar por falta de credenciais. Isso **não autoriza fallback a tag/build** nem
permite chamar o recovery de hermético contra qualquer futura remoção do cache.
Não alteramos essa semântica de recuperação para corrigir o ambiente do CI.
Comportamento da versão instalada e execução integrada continuam pendentes de CI.

### Regressão executável do contrato de ambiente

O teste extrai o `run` real do workflow e executa suas atribuições/expansões Bash e
`env -i`, substituindo **só** sudo (sem elevação) e o runner operacional por uma sonda
Node de ambiente. Ambiente pai contém DOCKER_CONFIG, DOCKER_HOST, DOCKER_CONTEXT,
TLS/cert e variável DOCKER_* desconhecida, todos sintéticos. O ambiente resultante
é mapeado exatamente como `runRecovery` ao **validateRecoveryInputs real**:
inputs normais aceitos e dockerEnvironment vazio. Reinserir DOCKER_CONFIG na cópia
em memória do comando faz o mesmo validator rejeitar com o erro original; demais
overrides seguem rejeitados. Não é mero regex nem mock do guard. Em Windows, Git
Bash traduz paths para Node nativo (verificação de leaf identity); ausência de
DOCKER_* e resultado do validator são exatos. Não é aceite Linux/root/Docker nativo.

Focused P1 (CI helper/pipeline, recovery guard, CI setup, A+B):
**118 PASS / 0 FAIL / 3 SKIP** — skips native Linux root/chown já existentes.
O primeiro teste da sonda falhou por conversão de paths Git Bash/Windows; corrigido
somente no harness, sem mudança do contrato CI Linux. Checks globais P1 finais:
`npm run verify` **verify: ok** — Portal **1746 PASS / 0 FAIL / 12 SKIP**,
CMS **448 PASS / 0 FAIL / 11 SKIP**. `npm run security`: API/cron/CMS
**zero vulnerabilities**. `git diff --check`, LF/whitespace dos quatro arquivos,
YAML keys únicas, Bash syntax **29 passos** e Python inline AST **1**: passaram.
Guard/runner/initializer/coordenador/Compose sem diff. Nenhuma execução operacional,
CI dispatch, commit/push/SSH, serviço ou delegação. O gate root de cache e a execução
integrada continuam aguardando review fresh / CI autorizada do primary.
