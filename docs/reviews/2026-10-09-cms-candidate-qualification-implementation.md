# Frente 2 — qualificação e pacote candidato Payload

## Escopo e estado

Implementação bounded A+B do plano de pipeline, sobre a branch
`feat/payload-cms-final`, baseline `7893d35`. Não altera receiver, release manual,
preparadores, manifesto operacional, recovery harness ou Dockerfiles. Não houve
commit/push, dispatch CI, SSH, serviço, deploy, cutover ou delegação nesta frente.

**Não encerra a frente operacional:** o receiver ainda não consome/exige esta
qualificação. A admissão independente pertence à próxima entrega do worker 3.
Nenhum recibo gerado aqui autoriza implantação.

## Contrato de qualificação

`scripts/lib/payload-candidate-qualification.mjs` extrai o antigo bloco inline do
CI. `scripts/qualify-payload-candidate.mjs` é o entrypoint usado pelo workflow.

O manifesto qualificado mantém `schemaVersion: 1` e acrescenta o discriminador
obrigatório `qualificationContract: "payload-preauthority-recovery-v1"`. Não há
fallback para manifesto antigo sem discriminador ou relatório incompleto.

Este contrato aceita o **success report schema 1 atualmente emitido pelo harness**:

- SHA completo lowercase, runId/runAttempt positivos como strings, três imagens
  dos repositórios GHCR exatos, sempre por digest.
- Os mesmos 14 checks, todos boolean true, e as mesmas 11 negativas, sem ausência,
  duplicação ou nome extra. Rejected/contentUnchanged permanecem obrigatórios;
  quatro negativas exigem fixtureDdlCleaned.
- `target_changed_after_restore_preflight` exige
  `raceInjectedAfterLeaseReservation: true`.
- `restoreAcceptanceProgress.first/second` exigem retorno bem-sucedido do
  coordenador **e** comparação completa independente bem-sucedida.
- Os três papéis do recoveryProgress exigem health inicial, restart saudável e
  snapshots quiescentes passed. Identidades de inventário são hashes distintos.
- Evidence só admite metadata redigida e fixture não retida no sucesso.
- Shapes exatos, JSON UTF-8 limitado, sem campos duplicados mesmo quando escapados,
  sem números não finitos e sem nesting ilimitado.

`recoveryReportSha256` é calculado sobre os bytes originais, incluindo whitespace.
Validação semântica não reserializa nem normaliza a evidência hasheada. Os guards
não produzem prova de runtime por si: o producer só pode gerar o success report
após os restores reais; as fixtures unitárias são explicitamente sintéticas.

O workflow invoca o CLI, exige os arquivos candidato/qualificado nos uploads e
expõe os três artifact IDs nos outputs do job. Mantém os nomes existentes dos
artifacts, a ordem build/test/scans → publish → recovery → qualificação e os gates
que excluem o autodeploy nos dois modos candidatos. O deploy legacy normal não foi
alterado.

## Preparador autenticado, sem transporte ou admissão

`scripts/package-payload-candidate.mjs` não aceita artifacts/metadata de arquivos
locais nem knobs `trusted`, `skip`, endpoint alternativo ou token em argumento.
O CLI usa `GH_TOKEN` ou `GITHUB_TOKEN`, não grava/imprime essa credencial.

Exemplo **somente para uso futuro autorizado, não executado nesta entrega**:

```sh
node scripts/package-payload-candidate.mjs \
  --repository OWNERINC/portal_ownerinc \
  --commit SHA40_DA_REVISAO_PRODUTORA_REVISADA \
  --run-id RUN_ID --run-attempt ATTEMPT \
  --candidate-artifact-id CANDIDATE_ID \
  --qualified-artifact-id QUALIFIED_ID \
  --report-artifact-id REPORT_ID \
  --checkout /caminho/absoluto/checkout \
  --output /caminho/absoluto/pacote-novo
```

O repo é fixado a OWNERINC/portal_ownerinc e o workflow a
`.github/workflows/ci.yml`. Metadados vêm de `https://api.github.com`, via requests
autenticadas; URLs fornecidas em respostas não escolhem repo/workflow/API host.

As verificações vinculam:

1. Repository/head_repository sem fork, workflow ID/path, SHA, event dispatch,
   run/attempt concluído com success.
2. Job validate do attempt, com build, integração v2, três scans, audit/SBOM,
   publicação, recovery e qualificador concluídos com success. Deploy production
   deve estar skipped; jobs inesperados são recusados.
3. IDs explícitos e distintos, nomes exatos, run/SHA/repository IDs, não expiração
   e created_at dentro da janela do job daquele attempt. Os artifacts não expõem
   runAttempt próprio na API: esta janela é conferida **junto** com o binding
   runAttempt dos JSONs, não como substituto dele.
4. Digest SHA256 publicado pelo GitHub e tamanho dos ZIPs, além da validação
   executable de candidate/report/qualified e do hash dos bytes do relatório.
5. Commit/tree retornados pela API versus os objetos locais. `git fsck --strict`
   recusa corrupção; `git --no-replace-objects archive SHA` não lê HEAD/worktree.
   Cada arquivo/modo arquivado é reconciliado com ls-tree e o hash do blob. Overrides
   locais de attributes não podem ocultar/substituir conteúdo. `tar.umask=0022` é
   explícito, não depende do default ou da configuração local.

Os downloads ZIP só aceitam redirecionamento HTTPS para storage GitHub/Azure
permitido, sem encaminhar Authorization. Só um JSON regular do nome esperado é
lido, em memória, com bounds e CRC; nenhum ZIP é extraído em disco.

O source tar recusa traversal, caminhos privados/reservados, symlinks, hardlinks,
devices, membros duplicados e indicadores fortes de segredo, inclusive em arquivos
com extensão arbitrária. PAX só aceita o comentário SHA Git e path/mtime limitados.
O scan reconhece somente a atribuição completa conhecida do placeholder Firebase
na `.env.example` da raiz: nome exato do campo, aspas, delimitadores PEM, separadores
`\n` literais, corpo único `SUA_CHAVE_AQUI` e nenhum prefixo/sufixo. Exige uma ocorrência;
duplicação, campo diferente, conteúdo alterado ou template em outro path não têm
exceção. Apenas essa linha é retirada da **visão de scan**; o resto continua
inspecionado e os bytes da fonte/arquivo nunca são reescritos. PEM real adicional
ou material de chave no lugar do corpo-placeholder são recusados antes do output.
O archive não inclui arquivos untracked nem ownerinc-novo-agente. Secrets scanning
é defesa em profundidade, não prova universal de inexistência de segredo.

Limites: JSON 1 MiB, ZIP 2 MiB, source tar 200 MiB e pacote gzip 10 MiB (floor atual
do receiver). Exceder limite falha; não há truncamento ou exclusão silenciosa de
arquivos para fazer o pacote caber. Diretório de output é exclusivo; arquivos são
0600. Falha de gravação conserva eventual output parcial para inspeção, sem anúncio
de sucesso e sem sobrescrever evidências anteriores.

## Interface para worker 3

Output externo:

- `payload-candidate.tar.gz`: fonte do commit exato e sidecars abaixo.
- `package-receipt.json`: hashes/tamanhos do source/final archive, IDs/digests
  de artifacts e todos os bindings. `deploymentAuthorized` permanece **false**.

No archive, além da fonte:

- `.ci-commit`: SHA40;
- `.ci-images`: exatamente três linhas API/cron/CMS;
- `.ci-candidate.json`: bytes originais do candidato;
- `.ci-qualification.json`: bytes originais do manifesto qualificado;
- `.ci-recovery-report.json`: bytes originais do relatório;
- `.ci-provenance.json`: seleção e hashes verificados, **não assinados**, sem o
  hash circular do archive final.

**Não confiar no recibo/provenance apenas por seu nome ou seus hashes.** APIs puras
exportadas para testes validam shape/binding, não autenticam JSONs fornecidos pelo
caller. A CLI real obtém os bytes pela API autenticada. O próximo gate do host deve
autenticar independentemente a origem/producer revisado e a mesma seleção de
artifacts/fonte antes de qualquer efeito operacional. O SHA explicitamente
selecionado deve ser a revisão produtora já revisada; esta ferramenta não aprova
código nem torna benevolente um workflow arbitrário.

Não foi criado registro protegido no host, approval humano intermediário,
assinatura fictícia ou mecanismo de autodeploy. Nenhum arquivo do receiver/guard
foi editado por esta frente.

## Regressão private_or_reserved_source_path

A falha comunicada durante o verify paralelo era do teste que passava o **pacote
gerado**, contendo `.ci-*`, ao inspector de **source**. O teste agora confere os
sidecars diretamente e exige que esse uso como source seja rejeitado.

A negativa adicional constrói um commit Git real em fixture descartável com
`.ci-images` no source: packaging continua rejeitando esse conflito real e não
cria output. Não houve relaxamento do guard de paths privados/reservados.

## Verificação e limites de evidência

- Suíte focada após o FIX-FIRST do template: **90 PASS, 0 FAIL,
  0 SKIP** (qualification/package/pipeline). Inclui requests HTTP simuladas, ZIPs
  adversariais e objetos Git reais somente em fixture temporária, sem commit/ref
  no repositório do projeto.
  Os três novos testes cobrem o `.env.example` real preservado byte-for-byte,
  variantes de chave/contexto indevidos e o **git archive completo do HEAD real**,
  somente leitura, aceito pelo inspector com seus placeholders públicos. Fixtures
  Git descartáveis também comprovam packaging do template real e rejeição de chave
  Ed25519 gerada no mesmo arquivo, sem criação de output.
- `npm run security`: **PASS**, zero vulnerabilidades reportadas nos três audits
  npm configurados. Isso não examina OS/stdlib Go nem substitui Trivy da imagem.
- `git diff --check`: **PASS** na conferência realizada; inclui o worktree paralelo.
- `npm run verify` final após o FIX-FIRST: **PASS**, `verify: ok`. No snapshot paralelo
  observado: Portal **1581 PASS / 7 SKIP / 0 FAIL**, CMS **448 PASS / 11 SKIP /
  0 FAIL**; sintaxe, typecheck, scanner de segredos e Compose passaram. Os skips
  permanecem explícitos; não são aceite Linux/PGlite/serviços. A falha estrangeira
  `invalid_environment_file_owner` comunicada antes não ocorreu nesta execução;
  nenhum arquivo do owner 3 foi modificado por esta frente.

O verify global anterior também passou, mas os totais diferem porque outros
workers acrescentaram testes no mesmo worktree. Os números acima descrevem a
execução observada, não um SHA publicado ou um working tree atomicamente congelado.

Não houve autenticação GitHub/download de artifacts reais, execução do preparador
contra um candidato real, build/scan de imagem, CI Linux, recovery real ou admissão
na VPS. Esses são gates posteriores do primary, não PASS desta implementação.

## Revisão independente requerida

Revisar especialmente: fronteira autenticada versus helpers puros; API GitHub de
attempt/artifact digest/size; parser ZIP/PAX limitado; reconciliação archive/tree;
compatibilidade do success report versionado; e interface de sidecars para o gate
do worker 3. O patch fica sem commit para a revisão independente coordenada pelo
primary. A entrega A+B não autoriza merge/deploy e não declara toda a frente 2
encerrada.
