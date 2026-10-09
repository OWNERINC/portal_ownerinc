# Task 3 — initializer isolado confiável e floorcommit explícito

Status: **contrato técnico aprovado e implementado; ready-for-review**.
Entrega: [initializer e floorcommit](2026-10-09-cms-isolated-initializer-implementation.md).
O journal closure anterior está SHIP por revisão independente. Esta entrega não
abre receiver/admission de produção e não constitui runtime PASS.

## Observações grounded no bootstrap anterior (baseline do design)

`scripts/test-payload-preauthority-recovery.mjs:createRuntime()` emite inventário
v2 protegido e inicializa o journal cold, mas os diretórios de release usavam
`legacy-floor`/`payload-candidate`, enquanto o binding de instalação exige nomes
de 40 hex e candidato igual ao commit. `provisionProject()` naquele baseline:

1. inicia Portal/API/cron e confirma cron bootstrap-only;
2. revoga os grants de sessão para reproduzir o floor legado;
3. chama release-preflight e aplica GRANT diretamente, sem captura B0;
4. cria CMS postgres, provisiona roles e migra;
5. inicia CMS e faz seed;
6. chama cold verify-release (agora corretamente recusado) e escreve o pointer.

O intent atual não possui transição legal para floor: remoção de intent é
proibida; o único pós-marco final é provisioned. O binding atual também exige
reportSha256/qualificationSha256/bundleSha256. Não é possível preenchê-los com
artefatos ainda não produzidos sem circularidade ou evidência inventada.

## Alternativas e decisão proposta

- Reabrir cold verify-release ou editar diretamente o estado fixture: rejeitado;
  contorna o kernel/journal e perde os marcos assinados.
- Exigir qualificação antes de inicializar Task 3: rejeitado; o produtor teria de
  consumir seu próprio resultado antes de executá-lo.
- **Initializer isolado de contrato fechado + floorcommit no mesmo kernel**:
  recomendado. Separar explicitamente binding do produtor de binding de admission,
  preservar receipts e audit trail; production outer gate continua inativo.

## Interface proposta

### 1. Binding do produtor, não recibo de qualificação

Introduzir formato fechado e discriminado de candidato para produtor isolado:
purpose, commit, runId, runAttempt, três imagens GHCR por digest e hash de bytes
do pedido/material candidato efetivamente validado. Não inserir campos de
qualificação vazios, opcionais ambíguos ou hashes sintéticos.

O formato anterior de binding permanece legível e estrito; não reinterpretar
envelopes históricos. A evolução explícita do shape de install intent deve ser
coberta por escrita/replay e testes de rejeição. Não alterar schema das proofs B0
ou quatro-stores para acomodar essa interface.

`scripts/integration/payload-preauthority-initialize.mjs` será coordenador de setup
do produtor. Seus inputs são os dados reais de run/candidato e o runtime já criado;
não fornece JSON de estado nem observa recursos desconhecidos para adotá-los.
Um pedido privado fixo dentro do runtime, criado exclusivamente e root-protegido,
faz binding desses inputs para o comando real de ops. Invocation usa o inventário
protegido fixo e uma única lease fd9 herdada; nenhuma override de owner/volume/DB.

Não usar um prefixo isolado como autorização de produção: entrada de initializer
verifica namespace descartável, runtime protegido, daemon local, inventário,
source e resources, e recusa projeto produtivo. Admission qualificada fica somente
no futuro gate externo de produção, jamais em todos os initializers/preflights.

### 2. Sequência assinada e B0

Preservar o bootstrap existente do Portal e a verificação de cron bootstrap-only.
Com Portal no floor legado completo e pointer no source, realizar preflight,
fechar admission pelo guard real, parar writers e conferir quiescência. Sob a
mesma lease, capturar B0 real antes de writes posteriores de grants/CMS:

- postgres.dump custom e uploads.tar.gz por mount read-only;
- manifest.sha256 com duas entradas exatas;
- preauthority-proof.json assinado pelo helper existente, CMS null;
- revalidação do archive, hashes, grant floor, dados/uploads, source/targets/lease.

Reservar intent somente depois de verificar B0 e alvos Portal. Registrar
portal_grants_pending antes de executar a migração/provisão normal do Portal;
verificar grants v2 estritos e dados/source estáveis antes de portal_grants_verified.
Não substituir a migração normal por GRANT avulso no fluxo novo.

### 3. Criação física sem adoção

Antes de Docker create: registrar reserva assinada com projeto, nomes exatos,
candidato e nonce de criação. Verificar ausência global dos recursos esperados.
Registrar os receipts de cada criação bem-sucedida com observações reais:

- volumes: labels de projeto/compose/reserva, driver, scope, mountpoint,
  CreatedAt e fingerprint; Docker volumes não oferecem UUID imutável;
- containers: ID completo real, imagem, labels de serviço/projeto/reserva e mounts;
- após start do banco: systemIdentifier/databaseOid/databaseName reais.

Receipts e alvos já registrados são imutáveis e rechecados no retry. Não aceitar
somente nome/label de projeto como prova de origem. Na janela create→receipt,
perder o receipt deixa resíduo **bloqueado para reconciliação**, sem adoção ou
delete automático; isso é o fallback seguro autorizado, não retry garantido de
qualquer efeito ambíguo. Receipts adicionais só crescem nos marcos permitidos.

Depois de bind físico, provisionar roles CMS, bootstrap control e migrar native
pelos caminhos reais já existentes; conferir roles/grants, ausência de protocolo,
inventário/catálogo, quiescência e imagens, com worker sempre parado. Persistir
provisioned somente após essas verificações.

### 4. Floorcommit e pointer

Adicionar fronteira real de ops para floorcommit, não um shortcut fixture:

```text
provisioned → floor_commit_pending → floor_committed
```

O pré-marco valida intent exato, B0 assinado, source/lease/inventory/alvos físicos,
roles/grants, catálogo nativo com fingerprint parsed, protocolo absent e imagens
candidatas. Guarda observações necessárias no intent assinado antes de mudar
pointer. Pointer é arquivo protegido substituído atomicamente. Na janela de
retry pending, somente source ou candidato exatos são aceitos; pointer diferente
é recusa, não sucesso already-current.

O pós-marco revalida a fronteira, confere pointer candidato e compromete migrated
com imagens/fingerprint coerentes, **admission closed e worker held**. Intent não
é apagado: terminal floor_committed conserva binding/receipts/auditoria.

Validador compartilhado anterior→seguinte reconhece apenas esse caminho explícito
e continua aplicado tanto à escrita quanto ao replay antes de head repair.
Restore/backups futuros podem atualizar seus próprios campos sem reescrever a
auditoria de instalação. Pending continua bloqueando operações incompatíveis;
terminal não deve ser confundido com pending. Migrated não faz downgrade legado.

Commit de floor não exige iniciar writers: imagens/configs/roles/catálogo e DBs
são verificados com writers parados. O harness inicia API/cron-bootstrap/CMS depois,
confere readiness/imagens e usa verificação/open existentes somente já migrated.
Readiness não é fabricada nem deriva só de sucesso do provisioner.

### 5. Call sites autorizados, sem alterar aceite

Alterar somente nomes/binding dos diretórios de release e setup em createRuntime/
provisionProject para chamar o novo initializer. Identidade do diretório source
deve representar o material legado fixture explicitamente, sem alegar SHA de
deploy histórico; candidato usa SHA real do run. Seeds/comparações, probe,
14 checks e 11 negativas continuam intactos e independentes.

Initializer repetido deve ter comportamento explícito: pedido divergente ou
recurso anterior sem receipt é recusa; mesmo intent interrompido só retoma nas
fronteiras verificáveis; terminal não implica adotar outro candidato. Não há
fixture skip flag, host installer ou registro falso de qualificação.

## Plano de verificação após aprovação

Testes novos executarão o journal/HMAC/kernel/commands reais com observações
Docker/DB instrumentadas: sequência completa, falhas antes/depois dos marcos,
create sem receipt, divergência de candidato/lease/targets, roles inseguras,
B0 alterado, pointer parcial, protocolo presente, replay semântico e audit terminal
compatível com backup/restore. Nenhuma negativa poderá abrir admission ou apagar
recursos desconhecidos. Testes de shell/JS serão explícitos quanto aos doubles.

Executar focused completo, npm run verify, npm run security e git diff --check.
Não executar CI, commit/push, SSH, bancos/serviços de produção ou delegação. Não
executar o harness full-stack nesta sessão sem autorização de serviços; checks
offline não serão descritos como runtime PASS.

## Handoff de produção

O admission helper/verifier de worker2 será integrado apenas à fronteira externa
de produção, na entrega coordenada autorizada e revisada. Receiver permanece
inativo nesta onda. B1, rollback fenced de produção e recovery fechado são gates
posteriores; este initializer não os satisfaz nem permite exposição editorial.

## Baseline observado nesta passada de design

Nenhum arquivo de código foi alterado por esta passada; somente esta proposta.
Os checks abaixo verificam o checkout atual, **não uma implementação do initializer**:

- Focused kernel/ownership/controller/preparação/diagnostics/operations:
  **54 PASS, 3 skips**, zero falhas.
- npm run security: zero vulnerabilidades reportadas API/cron/CMS.
- git diff --check: PASS.
- npm run verify: **1.668 PASS, 7 skips, 3 falhas** na suíte Portal; parou antes
  de CMS/security/Compose. Falhas fora do escopo desta passada:
  - payload-functional-forwarder.test.mjs: functional_forwarder_still_running;
  - payload-functional-runtime.test.mjs: functional_private_file_changed;
  - mesmo arquivo: expectativa functional_tls_identity_invalid recebeu
    functional_private_file_changed.

Não atribuir essas falhas ao initializer inexistente nem corrigi-las silenciosamente
em arquivos da outra frente. Comparações/probe/checks/negativas do recovery não
foram alterados. Nenhum runtime Docker/DB foi inicializado, nem CI/commit/push/SSH/
produção/delegação executados. O contrato foi aprovado pelo primary para
implementação, sem novo gate humano de design. Este bloco registra o baseline.

## Plano de implementação inline

- [x] Novo teste initializer: contratos de ambos os bindings, marcos/receipts/floor,
  negativas e guard real; executar red antes da implementação.
- [x] State: bindingVersion 2 discriminado, receipts monotônicos, terminal auditável
  e invariantes compartilhadas escrita/replay, sem reinterpretar envelopes antigos.
- [x] Runtime/guard: initializer isolado real sob fd9, B0, migração normal, criação
  e receipts reais, provisionamento e floorcommit fenced.
- [x] Coordenador JS e setup mínimo do runner: inputs reais/protegidos, diretórios
  bound e chamada única; readiness/seed somente depois do floor.
- [x] Focused, verify/security/diffcheck; registrar limites e failures externos.
  Execução inline, sem commit/delegação/serviços reais.
