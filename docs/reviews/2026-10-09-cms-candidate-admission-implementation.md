# Frente 2 C/D — admissão independente do candidato

## Design aprovado e plano inline

Policy root local no caminho fixo
`/etc/ownerinc/payload-candidate/production-policy.json`, fora do archive. Aprovação
por SHA exato e hash dos bytes do workflow, nunca por branch/tag ou CI verde.
Nenhum SHA real aprovado, policy instalada, serviço ou host operado nesta entrega.

Arquivos exclusivos: `ops/payload-candidate-verifier.py`,
`scripts/register-payload-candidate-admission.mjs`,
`tests/unit/payload-candidate-admission.test.mjs` e este documento. A+B, receiver,
preparadores, runtime, recovery e parser legacy permanecem intocados.

- [x] Contratos estritos policy/registro, parsers sem duplicação e testes adversariais.
- [x] Helper Python read-only: arquivos/ancestry protegidos, policy atual, hash do
  archive antes de extração, tuple redigida, sem executar código recebido.
- [x] Registrar instalado: verificar closure de módulos/binários antes de imports;
  Git bare novo com fetch da origem oficial, A+B autenticado, reconstrução e
  comparação byte-for-byte; registro exclusivo durável, sem deploy.
- [x] Fixtures HTTP/Git privadas e metadados POSIX simulados; sem bypass no CLI.
- [x] Focused tests, verify/security/diff-check e handoff separado para worker 3.

Tech stack: Python 3 stdlib e Node ESM stdlib, sem nova dependência. Execução inline
autorizada, sem subagents/commit. O hash da policy é SHA256 dos **bytes originais**;
não é campo da própria policy. Mudança de qualquer byte invalida registros sob a
policy anterior, que são preservados como evidência.

## Fronteira de confiança e instalação futura

O bootstrap é o código **já instalado/revisado pelo operador**, invocado por caminho
absoluto em ambiente limpo. Não executar estes entrypoints a partir do release
recebido. Uma auto-checagem de hash não torna seguro iniciar código malicioso; a
instalação inicial e o sistema operacional root-trusted são pré-condições externas.
O patch não instala nada, não cria policy real e não seleciona um SHA aprovado.

Layout fixo aprovado para futura instalação:

- Policy: `/etc/ownerinc/payload-candidate/production-policy.json`.
- Ferramentas: `/opt/ownerinc/lib/payload-candidate/`, preservando os quatro paths
  listados em `TOOL_FILES` (registrar, packager, biblioteca qualificadora e helper).
- Helper HTTPS do Git: cópia regular revisada em
  `/opt/ownerinc/lib/payload-candidate/bin/git-remote-https`; não usar symlink ou
  hardlink ao helper do sistema. Esse executável também é hasheado pela policy.
- Work privado: `/var/lib/ownerinc/payload-candidate/work`, previamente criado.
- Registry privado: `/var/lib/ownerinc/payload-candidate/records`, previamente criado.

Todos os arquivos e diretórios têm UID/GID **0:0**, sem seleção pelo caller.
Policy/records/bundle exigem modo exato `0600`, módulos `.mjs` `0644`, helper Python
e binários `0755`. Work/registry exigem `0700`. Toda ancestry, incluindo `/`, deve
ser diretório root:root sem escrita de grupo/outros ou bits especiais; não existe
exceção para `/tmp` sticky, symlink ou paths com `..`. Files exigem nlink=1.
As leituras usam NOFOLLOW, limites efetivos e comparação de dev/inode/size/timestamps/
mode/owner/links antes/depois. Os intérpretes/binários devem ser arquivos regulares
em paths canônicos, não aliases/symlinks como um `python3` que aponte para outro arquivo.

A closure de módulos ESM alcançáveis é fixa: somente os módulos locais acima e
builtins Node. O registrar usa apenas builtins até autenticar a policy e conferir
os hashes dos quatro arquivos; o import do packager é então um path absoluto fixo.
Node, Python, Git e git-remote-https têm hashes de binário obrigatórios. Bibliotecas
do SO e stdlibs permanecem sob a confiança root do SO, não sob o archive. O helper
exige Python `-I -S`, sem site/path injection. O registrar rejeita argumentos de
preload Node e variáveis NODE_*, GIT_*, PYTHON*, LD_*, DYLD_*, SSL_* e OPENSSL_*.
Esta rejeição complementa, mas não substitui, o bootstrap por ambiente limpo:
preload de um intérprete já acontece antes do script poder rejeitá-lo.

## Policy v1 — campos exatos

`schemaVersion: 1`, `kind: ownerinc-payload-candidate-policy-v1`,
`environment: production`, `repository: OWNERINC/portal_ownerinc`, `repositoryId`,
`workflow: .github/workflows/ci.yml`, `workflowId`, `approvedRevisions`, `toolchain`.

- repositoryId/workflowId: strings decimais positivas, 1–20 dígitos, que devem
  coincidir com as identidades obtidas na API oficial pelo packager.
- approvedRevisions: array não vazio de até 128 objetos de campos exatos `commit`
  (40 hex lowercase, único) e `workflowSha256` (64 hex lowercase). Hash do workflow
  é dos bytes Git naquela revisão, não de uma cópia do workflow atual. Nenhuma
  branch/tag/wildcard, ancestralidade ou flag `approved: true` é aceita.
- toolchain.files: mapa dos **quatro nomes relativos exatos** em TOOL_FILES para
  seus SHA256. Faltantes/extras são inválidos.
- toolchain.executables: exatamente `node`, `python`, `git`, `gitRemoteHttps`, cada
  um com `path` absoluto canônico e `sha256`. Paths distintos; basename do Git é
  `git` para fixar a resolução interna de A+B; gitRemoteHttps tem o path fixo acima.

Não há campo uid/gid/mode/endpoint/branch/default nem campo self-hash. JSONs limitam
1 MiB/depth 32, UTF-8 estrito; campos duplicados inclusive escapados, desconhecidos,
boolean/string em lugar de versão, números fracionários/exponenciais e hashes/IDs
malformados falham. O identificador do schema e os hashes do toolchain ancoram a
versão de contrato/código; o policySha256 identifica a aprovação concreta instalada.

## Registrar — fluxo efetivamente implementado

1. Valida CLI, root Linux, contexto do processo, policy protegida e tooling instalado.
2. Recusa SHA fora da allowlist antes de rede/registro; exige token GitHub em
   GH_TOKEN/GITHUB_TOKEN, nunca em argumento/registro/log.
3. Lê o bundle root protegido e cria um workspace UUID exclusivo sob work privado.
4. Inicializa **novo Git bare**, template vazio, hooks desabilitados. Fetch do SHA
   explicitamente aprovado somente de `https://github.com/OWNERINC/portal_ownerinc.git`.
   Nenhum checkout/origin vindo do caller. Ambiente Git fechado, config global/system
   desabilitada, credential.helper vazio, sem prompt, protocolos proibidos exceto
   HTTPS, redirects HTTP proibidos e GIT_EXEC_PATH fixo no helper hasheado.
5. Git fsck verifica objetos. Os bytes de `.github/workflows/ci.yml` do SHA devem
   coincidir com a aprovação. O A+B instalado repete a API autenticada para a mesma
   seleção explícita, valida todos os gates/artifacts/report/qualified e reconcilia
   tree SHA retornado pela API com os objetos Git/source archive.
6. Compara **bytes inteiros** do gzip reconstruído com o bundle fornecido, além do
   tamanho/hash do receipt derivado. Não lê nem confia em recibo/sidecars fornecidos.
   Gzip semanticamente equivalente com compression/header/timestamp diferente falha.
   Reprodutibilidade depende do tooling aprovado: não há normalização ou fallback.
7. Monta registro com bindings autenticados, revalida policy/tooling/bundle e publica
   sem overwrite. Revalida novamente antes de responder. Falha nunca anuncia sucesso.

O fetch Git é HTTPS oficial; a seleção de repository/commit/tree e artifacts que
autoriza o registro vem da API autenticada de A+B. Para repo privado, o token também
autentica **somente o child fetch** via config de ambiente transitória com extraHeader
Basic scoped à URL oficial exata; não aparece em argv, config no disco, outros
estágios Git ou credential helpers. Redirects permanecem proibidos. O executável
HTTPS que recebe esse header é o helper instalado/hash-verificado, não código do
candidato. Nenhum fetch real foi executado nesta entrega.
A tool não modifica refs do checkout do projeto, hooks do candidato ou serviços.
Workspaces derivados permanecem privados para inspeção; não são backup de produção.

## Registry e durabilidade

Filename único: `<archiveSha256>.<policySha256>.json`, sem inferir paths de JSON.
Registro schema 1 / kind `payload-candidate-admission-record-v1`, campos exatos:

- environment, policySha256, repository/repositoryId, workflow/workflowId,
  workflowSha256, commit, runId/runAttempt;
- images API/cron/CMS nos repositórios GHCR exatos, somente por SHA256;
- artifacts candidate/qualified/report: exatamente id/digest do ZIP confirmado;
- qualificationContract, candidateSha256, qualifiedManifestSha256,
  recoveryReportSha256, sourceTreeSha, sourceArchiveSha256;
- archiveSha256, archiveBytes e **deploymentAuthorized: false**.

O writer não é API exportada para JSON arbitrário. Apenas o CLI autenticado alcança
a escrita. Helpers puros exportados retornam objetos em memória **sem admissão**.
Registro é escrito como `.pending-UUID`, modo 0600, com fsync do arquivo; depois de
recheck é publicado por link exclusivo (rename comum sobrescreveria outro record).
O link pending é removido e o diretório recebe fsync. Durante o curto intervalo
nlink=2, leitores rejeitam. EEXIST recusa até um registro idêntico; não sobrescreve.
Falha conserva records existentes e eventual pending para inspeção, sem retry que
apague evidência. Não é promessa de cleanup/recuperação após falha de disco.

Rotação de policy muda o suffix/hash e invalida o lookup dos registros antigos.
Um novo registro sob a nova policy exige reconstrução/autenticação nova. Nenhum
registro anterior nem backup é apagado, reescrito ou migrado automaticamente.

## Helper read-only e interface de integração

`verify_candidate(archive, request)` e CLI exigem policy/tools/arquivo/registro root
protegidos. Request tem commit/runId/runAttempt, images (3) e artifactIds (3).
O helper **hasheia o pacote antes de procurar o registro**, não importa código nem
abre tar/zip. Valida schema e tuple completa, policy atual e SHA/workflow aprovados;
reconfere policy/tools/archive/registro antes de retornar. Record ausente, sidecars
forjados, ambiente divergente, SHA igual com digests diferentes ou policy rotacionada
não passam. O hash final vincula todos os bytes aos report/qualified/source que o
registrar autenticou; o helper não tenta substituir essa prova por JSON no tar.

Stdout é somente JSON de identidade validada: hashes/IDs, ambiente/repo/workflow,
imagens por digest, tamanhos/contrato e deploymentAuthorized false. Sem paths, URLs
de download assinadas, tokens, relatório privado ou stderr de subprocesso. Erros
de CLI também são redigidos, sem argparse echo de argumentos sensíveis. Ambos os
CLIs acrescentam `admissionRecordSha256`, hash dos bytes do registro protegido,
**fora** do próprio registro (sem self-hash circular). Worker 3 pode vincular seu
estado à identidade policy/record/archive e à tuple completa, sem confiar em um
objeto JSON renormalizado recebido do candidato.

Exemplos de interface **não executados nesta entrega**; variáveis devem vir da
seleção operacional já validada. O operador usa paths absolutos de intérpretes
canônicos aprovados pela policy, ambiente limpo e quoting literal:

```sh
# Shell root já limpo, com GH_TOKEN ou GITHUB_TOKEN exportado sem imprimir o valor.
# Não colocar o token em argv, inclusive assignments passados ao utilitário env.
"$APPROVED_NODE" \
  /opt/ownerinc/lib/payload-candidate/scripts/register-payload-candidate-admission.mjs \
  --environment production --repository OWNERINC/portal_ownerinc \
  --commit "$SHA" --run-id "$RUN_ID" --run-attempt "$RUN_ATTEMPT" \
  --candidate-artifact-id "$CANDIDATE_ID" --qualified-artifact-id "$QUALIFIED_ID" \
  --report-artifact-id "$REPORT_ID" --archive "$ROOT_PROTECTED_ARCHIVE"

/usr/bin/env -i PATH=/usr/bin:/bin \
  "$APPROVED_PYTHON" -I -S -B \
  /opt/ownerinc/lib/payload-candidate/ops/payload-candidate-verifier.py verify \
  --archive "$ROOT_PROTECTED_ARCHIVE" --commit "$SHA" \
  --run-id "$RUN_ID" --run-attempt "$RUN_ATTEMPT" \
  --api-image "$API_DIGEST_REF" --cron-image "$CRON_DIGEST_REF" --cms-image "$CMS_DIGEST_REF" \
  --candidate-artifact-id "$CANDIDATE_ID" --qualified-artifact-id "$QUALIFIED_ID" \
  --report-artifact-id "$REPORT_ID"
```

Não há --policy/--registry/--checkout/--trust-local-json/--fixture/--uid. O receiver
do worker 3 deve futuramente chamar o helper instalado somente no caminho Payload
de três imagens, antes de extrair/consumir esse mesmo bundle protegido, e vincular
os passos posteriores à tuple retornada. O fluxo legacy de duas imagens não deve
requerer este helper. Não confundir sucesso do helper com release preflight,
readiness, recovery/cutover ou deploy autorizado. Não há aprovação humana adicional
por candidato nem qualificação circular via preflight de produção.

## Verificação e revisão

Focused final: **132 PASS / 0 FAIL / 0 SKIP** (42 C/D novos + 90 A+B/pipeline).
`npm run security`: **PASS**, zero vulnerabilidades nos audits API/cron/CMS.
`git diff --check`: **PASS**. Python AST e LF nos três novos arquivos de código:
**PASS**. A primeira execução global do verify falhou no processo estrangeiro
`tests/unit/editorial-session.test.mjs` (1627 PASS / 1 FAIL / 7 SKIP), sem asserção
detalhada no log; esse arquivo passou isoladamente **30/30**, sem alterações.
Uma repetição global passou durante a estabilização. A conferência global **final
no código estabilizado** também passou: `verify: ok`, exit 0; Portal **1655 PASS /
0 FAIL / 7 SKIP**, CMS **448 PASS / 0 FAIL / 11 SKIP**; sintaxe/typecheck/scanner de
segredos/Compose passaram. Os skips permanecem explícitos, não são aceite Linux/
PGlite. Não atribuí causa à falha anterior nem alterei outro scope. Os totais são
do worktree compartilhado observado, não de um SHA publicado/congelado.

Fixtures HTTP são **mocks**, reports/policies aprovados são sintéticos; objetos Git
só existem em diretórios temporários descartáveis. POSIX owners/modes/ancestry e
publicação atômica/fsync foram exercitados com metadados/filesystem simulados em
Python/VM Node no Windows. O VM exporta privados apenas na cópia em memória do
teste; o runtime entregue não possui esses exports nem switch de fixture.

Pendente de revisão independente: contracts cross-language, bootstrap/trust boundary,
remote Git helper/tool closure, races/publicação durável e interface para worker 3.
Não houve live GitHub auth/artifacts, fetch remoto real, instalação, registro root
real, execução Linux/VPS, receiver wiring, serviços, CI dispatch, commit/push, SSH,
produção ou delegação. A entrega implementa C/D mas não fecha a admissão operacional
até instalação/integração/aceite coordenados pelo primary após review e CI.
