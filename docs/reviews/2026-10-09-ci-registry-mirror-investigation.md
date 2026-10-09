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
