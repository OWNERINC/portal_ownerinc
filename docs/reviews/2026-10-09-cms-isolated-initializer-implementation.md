# Task 3 — initializer isolado e floorcommit explícito

Status: **implementado, ready-for-review; não é runtime PASS**.
Contrato técnico aprovado pelo primary. O journal closure anterior está SHIP
por revisão independente. Não há aprovação humana pendente para implementar
este recorte; o aceite operacional final continua separado.

## Entrega e limites

- `ops/payload-control-state.py`: binding do produtor explicitamente discriminado
  por `bindingVersion: 2`, receipts monotônicos e terminal auditável. O binding
  histórico sem esse campo mantém seu shape estrito, inclusive os quatro hashes
  históricos; não é reinterpretado como produtor.
- `ops/payload-control-runtime.py`: comandos reais `initialize-isolated` e
  `install-floor-commit`. A entrada isolada recusa produção, exige inventário
  protegido fixo, namespace descartável e contexto Docker local no socket padrão.
  Purpose é discriminador de input, não privilégio nem flag para desligar checks.
- `ops/payload-operations-guard.sh`: dispatcher para esses dois comandos sob a
  mesma lease herdada. Não há installer de host nem entrada JSON de estado.
- `scripts/integration/payload-preauthority-initialize.mjs`: pedido canônico
  privado/exclusivo, conferência do HEAD real e uma chamada ao guard sob fd9.
- `scripts/test-payload-preauthority-recovery.mjs`: apenas setup em
  `createRuntime()`/`provisionProject()`. Source é content-addressed pelos bytes
  reais de `.image-env`, com hash completo no binding; seu basename de 40 hex
  **não é SHA de commit de produção**. Candidato usa o commit real do checkout/run.
- `tests/unit/payload-install-initializer.test.mjs`: fluxo executável, negativas,
  interrupções e replay. `payload-preauthority-recovery-guard.test.mjs` acompanha
  a execução delegada ao initializer sem remover os gates de setup. No teste
  anterior `payload-install-transition.test.mjs`, somente o double de reload de
  inventário e sua negativa foram acrescentados para a nova revalidação.

Comparadores, seed, probe, 14 checks, 11 negativas e schema do relatório recovery
não foram alterados nesta entrega. Os demais arquivos dirty do checkout pertencem
a entregas anteriores/outras frentes e não foram revertidos nem apropriados.

## Sequência executada pelo initializer

1. Validar pedido/candidato/source, ownership, inventário e lease. Confirmar
   contexto Docker `unix:///var/run/docker.sock`, sem seleção de endpoint pelo
   operador. O kernel mantém produção negada e o receiver continua bloqueado.
2. Usar o preflight existente, fechar admission no journal, criar sentinel,
   parar writers e provar quiescência. Portal permanece `legacy/1`.
3. Capturar B0 em `000-initial-install-b0`: `postgres.dump` custom,
   `uploads.tar.gz` por mount read-only, manifest de duas entradas e proof
   assinado existente. CMS é null nessa proof. Validar archive e fingerprints
   reais antes de qualquer write posterior de grants/CMS.
4. Reservar intent; registrar `portal_grants_pending` antes do migrate normal
   Portal. Revalidar grants estritos e source/dados/uploads/alvos antes do postmark.
   O novo caminho não substitui migrate/provision por GRANT ad-hoc.
5. Registrar `cms_resources_pending` com nonce antes de create. Criar cada volume
   e container por comandos reais e persistir receipts observados: volumes têm
   fingerprint incluindo labels/CreatedAt/scope/options/mountpoint; containers
   têm ID completo, imagem e fingerprint de labels/Created/mounts. Bind de DB usa
   systemIdentifier/databaseOid/databaseName depois de start/readiness do banco.
6. Provisionar CMS, bootstrap-control e migrar native pelos comandos existentes.
   Verificar runtime/control/migrator, grants Portal, imagens, alvo físico,
   catálogo parsed, zero News rows, protocolo `absent`, coverage `not-applicable`
   e quiescência antes de assinar `provisioned`.
7. Pré-validar integralmente a mesma fronteira; assinar `floor_commit_pending`
   com fingerprint e pointers exatos; substituir o pointer protegido
   atomicamente; revalidar depois da troca; assinar `floor_committed`/`migrated`.
   Admission termina closed e worker held. Receipts/binding/floor ficam no intent.
8. Só após retorno, o setup inicia API/cron-bootstrap/CMS com `--no-recreate`,
   verifica readiness, usa verify/open existentes já migrated e executa seed.
   O identity seed legítimo de `portal_editors` não é usado para passar o gate
   de zero mutations antes do floor.

## Retry e falhas conservadoras

- Pedido divergente, source material alterado, B0 modificado, lease/inventário/
  alvo/imagem divergentes ou roles/catálogo inválidos recusam sem abrir admission.
- Receipts só crescem em `cms_resources_pending`; registros existentes, nonce,
  target, binding e floor são imutáveis. A mesma validação anterior→seguinte vale
  para escrita e replay, antes de qualquer reparo do head.
- Um create sem receipt durável deixa resíduo bloqueado para reconciliação.
  Não existe adoção por nome/label, delete/prune ou tentativa de "limpar para retry".
- B0 parcial ou proof que não chegou a ser vinculada ao journal também não é
  sobrescrita/adotada automaticamente. Uma interrupção antes de B0 completo pode
  deixar admission fechado e exigir reconciliação; não é alegado retry universal.
- No pending de pointer, somente source original ou candidato exatos são legais.
  Uma terceira release é recusa. Falha do pós-check conserva pending/closed,
  mesmo que o pointer candidato já esteja escrito.
- Retry terminal exige o mesmo pedido e toda a fronteira inicial ainda closed,
  parada e igual a B0; não retorna sucesso só porque pointer está current. Depois
  de seeds/alterações legítimas, deve-se usar backup/restore/deploy normais, não
  reexecutar um install inicial.
- Backup/restore e verify/open normais reconhecem terminal como auditoria, não
  intent pendente. Seus próprios campos avançam sem reescrever `installIntent`.
  Isso não entrega B1, rollback produtivo nem recuperação real de quatro stores.

## Evidência offline e verificação da entrega anterior ao fresh review

Os testes novos executam Runtime, guard, kernel/HMAC/journal/proofs e parsing reais,
com Docker/SQL/health explicitamente instrumentados. No teste de guard, a seam
do entrypoint instala essas observações e chama `Runtime.main`; não se afirma
execução Docker real. No Windows, uid/gid/mode POSIX e `/proc/fd9` não constituem
evidência nativa de ownership/lease Linux. O teste Linux root real permanece skip.

Cobertura inclui ambos os formatos de binding, interrupção antes de cada append,
janela append/head de cada marco e receipt, falha antes/depois do pointer,
resíduo sem receipt, inputs/alvos/roles/B0/imagens/catálogo divergentes, protocolo/
News presentes, daemon remoto e pares ilegais assinados com HMAC/parent corretos.
Há exercício dos comandos/checkpoints de backup/restore após terminal sem mutar
auditoria; dumps/SQL são doubles, **não restauração física nem B1 passando**.

- Focused completo final: **78 PASS, 3 skips, zero falhas** (81 testes).
- `npm run security`: **zero vulnerabilidades** API/cron/CMS.
- `git diff --check`: **PASS**, incluindo repetição no fechamento.
- Python AST e LF do guard: **PASS**.
- `npm run verify` final estável: **PASS** — Portal **1.690 PASS, 7 skips**;
  CMS **448 PASS, 11 skips**; zero falhas. Sintaxe/typecheck/checks de segurança
  e Compose concluídos com `verify: ok`.
- As falhas anteriores de outra frente e de comparação do source copiado não
  reapareceram no fechamento estável. Nenhuma assertion de source hash foi
  enfraquecida e nenhum arquivo funcional dessa frente foi editado.

A primeira execução de `npm run verify` excedeu o timeout externo de 120s, sem
concluir. A repetição com orçamento maior passou (Portal 1.686 PASS/7 skips, CMS
448 PASS/11 skips) antes dos quatro últimos cenários serem adicionados. Um focused
em paralelo com verify excedeu o deadline local de 30s no teste de 13 cenários
append/head; o orçamento desse subprocesso foi corrigido para 90s, sem alterar
assertions, skip, source hashes ou condições de sucesso. Focused final executado
sem outra suíte pesada em paralelo passou integralmente. Código ficou estável
durante a verificação final; depois dela somente este registro documental mudou.

Nenhum CI, commit/push, SSH, produção, delegação ou mutação de serviços/bancos reais
foi executado. O production outer admission gate permanece inativo. A qualificação
não é exigida circularmente ao produtor Task 3 nem aos preflights de backup.
Próximos gates: revisão desta entrega, execução isolada autorizada, B1, rollback
fenced/publicação e closed recovery; admission/verifier somente no boundary
externo produtivo em entrega própria.

## Fresh review — correções dos dois bloqueios Linux/CI

Escopo autorizado: somente setup do runner, coordenador initializer, testes
correspondentes e este documento. A abordagem já aprovada foi aplicada inline:
teste RED dos contratos → namespace privado fixo → Git com confiança scoped →
focused/verify/security/diffcheck. Sem nova pausa de design/delegação.

### 1. Ancestry dos runtimes privados

O root leaf em `RUNNER_TEMP` não resolve seus ancestrais runner-owned. Esse caminho
foi removido do setup privado, sem relaxar o inventário Python, ownership do
environment, chave, journal, lock ou B0. O relatório redacted continua no mesmo
`RUNNER_TEMP`/`PAYLOAD_RECOVERY_REPORT` e o upload existente não exige mudança.

`createPrivateRecoveryRoot()` usa somente
`/var/lib/ownerinc-payload-recovery-ci`, sem override de caminho. Exige Linux
UID/GID 0, umask 077, ancestry real sem symlink e UID/GID 0, sem group/world write.
Verifica `/var/lib` **antes** de criar o base, por mkdir exclusivo não recursivo.
Base é 0700 e só é aceito existente com marker `.namespace` exclusivo 0600,
conteúdo exato, owner/group root e nlink 1. Um base sem marker ou com filhos
estrangeiros é recusa; não há chmod/chown, adoção ou delete para consertá-lo.

Cada execução cria um filho exclusivo `run-<runId>-<attempt>-<nonce128bit>` 0700;
repetição nunca reutiliza um run anterior. `createRuntime()` valida o novo parent
antes dos writes, cria seu root exclusivamente e valida novamente antes de
inventário/environment. O initializer também valida ancestry do runtime antes
de criar o pedido privado. Falhas conservam os diretórios; somente o cleanup
existente de sucesso continua removendo o run que acabou de passar. Não há
chown de runnerhome, seleção de raiz produtiva nem alteração de workflow.

### 2. HEAD sob root em checkout runner-owned

`verifyInitializerCheckout()` deriva a localização do próprio módulo carregado,
não de cwd, UID de sudo ou caminho fornecido pelo operador. Caso `GITHUB_WORKSPACE`
seja preservado, ele deve coincidir exatamente, sem redirecionar o checkout;
não é obrigatório porque o comando sudo atual não o passa explicitamente.

Valida caminho canônico sem links, owner real root ou runner UID >=1000 diferente
de nobody, ancestry somente root/owner observado e grupos root/grupo observado,
sem world write. Essa confiança limitada no checkout lido pelo job GitHub não
se estende aos ancestrais dos artefatos privados, que permanecem estritamente root.
`.git` precisa ser diretório real do mesmo owner/group; toda sua árvore é validada
sem ler credenciais. Links, arquivos hardlinked, commondir, alternates, grafts e
refs/replace recusam. Metadata/identidades são comparadas antes/depois do Git.

Cada observação usa argv separado com `git -c safe.directory= -c
safe.directory=<checkout-canônico> -C <checkout-canônico> rev-parse ...`.
A entrada vazia limpa a lista de confiança herdada para aquele comando, e a
seguinte autoriza **somente** o checkout validado. Verifica não-bare, top-level
exato e HEAD SHA real igual ao run; não escreve configuração global/sistema/local,
não usa wildcard e não depende de SUDO_UID. A conferência ocorre antes do
primeiro write de setup e novamente antes do pedido do initializer.

### Regressões e limites

Novo `tests/unit/payload-preauthority-ci-setup.test.mjs` cobre contratos do
namespace/metadados e a integração concreta de setup/report/Git. Os testes Linux
root condicionais usam filesystem/chown e subprocessos reais, sem metadata seam:

- root leaf abaixo de ancestor UID/GID 1001 é recusado pelo helper e pela ancestry
  do inventário/environment Python; path root-protegido legítimo é aceito;
- allocator fixo cria dois runs distintos, conserva evidence anterior e recusa
  uma colisão estrangeira sem removê-la;
- checkout Git novo realmente owned 1001 causa dubious ownership sob root sem
  safe.directory, enquanto o helper scoped verifica o mesmo HEAD; trust não
  persiste. SHA errado, world write, bare repository e `.git` symlink recusam.

Esses três testes são **skip honesto neste host Windows**. Não foram executados
Linux nativo, CI ou Docker; sua execução na CI autorizada ainda é necessária.
Os testes instrumentados de kernel/HMAC/producer v2 continuam independentes.
Comparadores, probe, 14 checks, 11 negativas, seeds e contrato do relatório não
mudaram. Código de kernel e arquivos funcionais não foram editados neste fix.

Focused após os fixes: **80 PASS, 6 skips, zero falhas** (86 testes). Os três
skips extras são as regressões Linux nativas acima, não remoção de gates.
Fechamento estável desta revisão:

- `npm run verify`: **PASS**, `verify: ok`; Portal **1.692 PASS/10 skips**,
  CMS **448 PASS/11 skips**, zero falhas.
- `npm run security`: **zero vulnerabilidades** API/cron/CMS.
- `git diff --check`: **PASS**; repetido após registrar estes resultados.
- Não houve edição de código durante verify. Arquivos dirty de outras frentes
  foram preservados; workflow não foi alterado nesta correção.
- **Ready-for-review, não native Linux/CI/runtime PASS.** Nenhum CI, commit/push,
  SSH, produção, delegação ou mutação de serviços/bancos reais foi executado.

## Fresh review — fixture unitário non-root após CI 37954438979

O commit integrado `105200c` falhou no `npm run verify` non-root do run
`37954438979`: **1.689 PASS, 1 falha, 21 skips**. O tail de 95 linhas do log
local aponta o teste retry adapter em `payload-install-transition.test.mjs:196`,
fixture:71 → `install_retry_check`:1764 → `_install_origin_check`:1754,
`unsafe_backup_directory`. A execução não chegou aos testes root/build/recovery;
esse resultado não é evidência de runtime.

O check B0 real exige diretório canônico, dentro do backup root, e em POSIX
UID 0/modo 0700. O fixture é criado pelo usuário do processo com mkdir 0700;
o log não expõe UID/modo observados. A correção passa a normalizar explicitamente
0700 e conferir por lstat o modo **e** UID real (igual ao euid), sem atribuir a
falha apenas ao modo nem ignorar a ownership non-root.

Patch limitado aos dois testes e este registro, sem código de produção:

- No teste de retry, seam somente de **UID** em lstat para os dois paths exatos
  de B0/lock quando POSIX non-root. Tipo, modo, links, realpath e demais metadata
  permanecem reais. Windows mantém o branch nativo; metadata POSIX sintética
  adicional é declarada como teste de contrato, não prova Linux.
- Lock agora é um arquivo real 0600; removido o bypass genérico de
  `_safe_regular`. O predicado real é executado, assim como o check inline B0.
  Grants por estágio, B0/proof, lease/targets, HMAC e barreira contra efeitos
  continuam sendo exercitados sem skip do teste central.
- Em cada estágio, o check real recusa observações POSIX de UID 1001, modo 0750,
  symlink e arquivo em lugar de diretório; aceita UID 0/0700. Em POSIX, B0 com
  metadata real sem seam é recusado non-root e aceito root.
- No branch root, chmod 0750 e chown 1001 reais do B0 sintético são recusados
  com lstat sem mock, depois restaurados em finally. Uma chamada focada deste
  teste foi adicionada à suíte `payload-preauthority-ci-setup.test.mjs`, já
  executada pelo step root existente. Não foi preciso alterar workflow.

O primeiro focused local passou (**80 PASS, 7 skips**, 87 testes). O primeiro
verify detectou o contrato existente de exatamente três branches/skips na suíte
root: o wrapper inicialmente acrescentado criava um quarto. A chamada root foi
então incorporada ao teste nativo de ancestry existente, preservando o contrato
sem editar/enfraquecer o teste de pipeline ou workflow. O teste central de
transições continua sem skip; em Windows só o branch nativo já existente é skip.
Execução Linux non-root/root continua pendente — não houve
CI, serviços/bancos reais, produção, SSH, commit/push ou delegação nesta correção.
Política root/private de produção, comparadores/probe/checks/relatório e todos
os arquivos funcionais permanecem inalterados. Entrega **ready-for-review**.

Fechamento do patch estável:

- Focused completo **incluindo o contrato de pipeline**: **83 PASS, 6 skips,
  zero falhas** (89 testes).
- `npm run verify`: **PASS**, `verify: ok`; Portal **1.693 PASS/10 skips**,
  CMS **448 PASS/11 skips**, zero falhas.
- `npm run security`: **zero vulnerabilidades** API/cron/CMS.
- `git diff --check`: **PASS**, repetido após este registro.
- Somente `payload-install-transition.test.mjs`,
  `payload-preauthority-ci-setup.test.mjs` e este documento foram alterados.
  Untracked anteriores preservados; sem commit/push. Checks locais Windows não
  fecham o aceite Linux non-root/root nem autorizam build/recovery/produção.

## Fresh review — nested Node runner após CI 37956660040

No commit integrado `2c69d32`, o run `37956660040` avançou após verify non-root
PASS até a suíte root: **5 testes, 4 PASS, 1 falha, zero skips**. O log local
comprova allocator e Git scoped passando em Linux root. O teste de ancestry
falhou na assertion do subprocesso (linha 58): exit 0, stdout vazio, sem o
esperado resultado de retry. Ele parou antes das assertions de ancestry/B0;
essa execução não comprova esses gates nem recovery.

Diagnóstico reproduzido localmente em **Node 24.15.0/Windows**, com o mesmo
arquivo e nome de teste: herdando `NODE_TEST_CONTEXT=child-v8`, exit 0 e stdout
vazio, com warning `node:test run() is being called recursively within a test
file. skipping running files.`. Removendo somente esse marker, o comando com
reporter TAP executa o teste selecionado: **1 teste/1 PASS/zero skips**. O código
builtin de `internal/test_runner/runner` confirma o retorno antecipado para
execução recursiva quando `NODE_TEST_CONTEXT` está definido.

Patch somente de harness unitário/documentação:

- `tests/helpers/payload-nested-test.mjs`: clona o ambiente e remove somente
  `NODE_TEST_CONTEXT`, sem mutar o caller nem remover variáveis da aplicação.
  Execução por argv, cwd explícito, timeout 90s e captura máxima 1 MiB; reporter
  TAP explícito e name pattern ancorado/escaped para o **nome completo exato**.
- A suíte root usa esse helper, preservando os três branches nativos e o
  workflow. O aceite exige ausência de erro/sinal, exit 0, evento `ok` com o
  nome planejado exato, um único plano de 1 teste e counters exatos:
  tests/pass 1, fail/cancelled/skipped/todo 0. Não aceita stdout vazio,
  skip ou exit 0 com zero execução planejada.
- `payload-preauthority-nested-test.test.mjs` executa regressões cross-platform
  com contexto child-v8 injetado: chama o retry real selecionado; fixture com
  receipt físico prova execução; falha produz exit 1 e é propagada; skip,
  nome ausente e stdout vazio são recusados. O nome ausente revelou um detalhe
  do Node 24: plano vazio `1..0` pode aparecer junto de um PASS do wrapper do
  arquivo/counter pass 1. Esse falso positivo também é recusado por nome/plano,
  não apenas pelo contador. A fixture não selecionada nunca executa.

Nenhuma mudança no runtime/política de produção, filesystem seams do teste de
transições, comparadores, probe ou relatório. O subprocesso corrigido rodou
localmente sem privilégio Linux; o branch real chmod/chown da CI root ainda
precisa executar. Evidência Linux já obtida para allocator/Git é preservada,
sem convertê-la em PASS da suíte root inteira ou de runtime/recovery.

Fechamento local com código estável:

- Focused completo, incluindo nested regressions e pipeline: **86 PASS,
  6 skips, zero falhas** (92 testes).
- `npm run verify`: **PASS**, `verify: ok`; Portal **1.696 PASS/10 skips**,
  CMS **448 PASS/11 skips**, zero falhas.
- `npm run security`: **zero vulnerabilidades** API/cron/CMS.
- `git diff --check`: **PASS**, repetido após documentação.
- Somente helper novo, regressão nova, chamada do teste root e este documento
  foram alterados. O teste de transições e workflow não mudaram neste patch;
  untracked anteriores preservados. **Ready-for-fresh-review**, sem alegar
  Linux root B0/ancestry PASS. Sem CI, commit/push, SSH, produção, delegação
  ou mutação de serviços/bancos reais nesta sessão.

## Fresh review — diagnóstico concreto do initializer após CI 37958217164

Commit integrado `988c832`, run `37958217164`: consulta **read-only** ao GitHub
e logs confirmaram verify non-root PASS e step root **5 PASS/zero falhas/zero
skips**. Builds, scans e publicação passaram; qualification e deploy foram
skipped. Isso comprova os gates nativos unitários anteriores (inclusive B0
chmod/chown/ancestry e Git/allocator), não initializer Docker ou recovery PASS.

O relatório baixado registra `prepare_...-source` → `payload_initialize_isolated`,
exit 2, `controlErrorIdentifier: null`, zero checks de recovery passando.
O step durou aproximadamente **4m30s** no total; não há timestamp específico do
início da chamada initializer, portanto não se atribui todo esse tempo a ela.
O artefato local contém somente o relatório redacted. O stderr privado ficou
no runner, não publicado: **o reason exato dessa execução não foi recuperado**.
Exit 2 sem process error não é evidência de timeout do caller (budget 15 min).

### Defeitos comprovados e hipótese histórica

1. A chamada initializer não passava contexto diagnóstico. Somente os contextos
   preflight/verify eram reconhecidos: mesmo um reason válido ficaria null.
2. `_initializer_command()` classificava falhas de comandos comuns Docker/Compose
   como `native_catalog_verifier_execution_failed` e descartava seu stderr.
3. O argv de criação usava `docker compose create --no-deps`, flag inválida.
   Prova local **sem efeitos**: Compose **5.1.4**, `create --no-deps --help` retorna
   `unknown flag: --no-deps`. A fonte pública Compose **v2.40.3** de `up.go`
   confirma que `--no-deps` seleciona `IgnoreDependencies` e `--no-start` chama
   somente `backend.Create`, não `backend.Up`/start:
   <https://github.com/docker/compose/blob/v2.40.3/cmd/compose/up.go>.

O terceiro defeito é uma **causa plausível forte**, não prova do reason histórico:
outro gate pode ter recusado antes. Não se escolheu entre ownership, B0/archive,
grants, imagens, receipts, readiness ou catálogo somente pela duração da falha.

### Correção autorizada e conservadora

- Criação agora usa `up --no-start --no-recreate --no-build --no-deps --pull never`.
  Não foi simplesmente removido `--no-deps`: dependências não podem surgir sem
  reserva/receipt. Overlay/labels, inventário, reserva e receipts imutáveis não
  mudaram. O start explícito continua **depois** dos dois receipts assinados.
- Runtime marca uma fase fechada antes de cada etapa e emite, junto ao reason
  no exit 2, `PREAUTHORITY_INITIALIZER_DIAGNOSTIC` com phase, installStage,
  commandExit/commandSignal e privateStderr. O marco é o último estado assinado
  carregado/retornado, não uma inferência de head/pointer nem um reparo após erro.
- Generic tool failure/launch/signal usam identifiers próprios do initializer.
  Exceção interna continua fail-closed sem expor sua mensagem. Metadata privada
  não entra no frame; nenhum SQL, environment, path, ID Docker ou userdata.
- Stderr de ferramenta é streamed para tempfile privado no runtime validado;
  em falha, só o tail de até **16 KiB** é retido em arquivo exclusivo 0600.
  Falha ao guardar evidência não substitui a falha primária. Não há echo do raw
  stderr, adoção/delete de resíduos nem mudança dos budgets existentes.
- Parser JS exige action **e substep exatos**, exit 2 sem signal/process error,
  body completo conhecido e frame finito. Catálogo mantém seu diagnóstico próprio
  quando válido. Single-line reasons/guard messages anteriores são reconhecidos
  somente nesse contexto estreito. Unknown/malformed/appended stderr fica privado.
- Parent timeout/signal recebe apenas identifiers finitos de processo: não
  autoriza um reason nem uma fase de adapter que não retornou normalmente.
  Primary/secondary/hold continuam separados; relatório continua schema 1,
  com metadata opcional dentro de commandDiagnostic e nenhum gate novo de PASS.

Os quatro reasons novos (`initializer_command_failed`,
`initializer_command_launch_failed`, `initializer_command_signaled`,
`initializer_internal_error`) são **exclusivos desse contexto**, não aceitos como
linha avulsa em preflight/verify. Exigem frame e relação exit/signal coerente;
reasons anteriores permanecem no allowlist finito compartilhado. A regressão
confronta os códigos `fail()` literais dos três helpers com o parser initializer
para que um novo gate não volte a aparecer silenciosamente como null.

Budgets não foram ampliados: wrapper initializer **15 min**, stop writers
`--timeout 120`, readiness CMS até **180 observações com sleep 1s**. Os comandos
Python continuam síncronos sem novo timeout próprio; duração total do step não
identifica qual comando/check consumiu tempo. Em timeout/signal externo não se
atribui reason do adapter; somente o erro/sinal finito do processo pai.

### Regressões

`payload-initializer-diagnostics.test.mjs` valida as fases contra o source Python,
action/substep/status, frames inválidos, reasons legados, catálogo e sanitização;
executa `Runtime.main` + comando Python reais pela command wrapper JS, incluindo
erro, launch, exceção interna, signal, timeout e stderr opaco. Nessa seam de
transporte o constructor não é evidência Linux/Docker; signal POSIX é real em
Linux e explicitamente simulated em Windows. Teste da CLI usa **somente**
`version`/`--help`, sem daemon ou serviços.

O teste initializer instrumentado também passa por main, kernel/HMAC e journal
reais em oito pontos de falha, conferindo a fase e o marco efetivo e admission
closed/worker held. Docker/DB continuam doubles declarados. O modelo verifica
que o start explícito só ocorre depois de ler os dois receipts no journal real.
Negativas/quiescência/floor/assinaturas/ownership/comparadores/probe/14 checks/11
negativas e todos os arquivos funcionais não foram relaxados para passar.

O primeiro focused completo local expôs **ENAMETOOLONG** em dois subprocessos
Python Windows: o modelo completo duplicado em `-c` excedeu o limite de argv
após ampliar suas assertions. O helper de teste agora grava o mesmo programa
integral em arquivo exclusivo 0600 dentro do fixture e executa-o com os mesmos
argumentos/budget; não houve truncamento, skip ou remoção de assertions.

### Fechamento local estável deste suplemento

- Focused completo: **105 testes — 98 PASS / 7 skips / zero falhas**.
  Skips são branches nativos/lease/symlink indisponíveis no Windows; a consulta
  real de argv Compose e o transporte Python/JS novos **executaram**, sem skip.
- `npm run verify`: **PASS**, Portal **1.700 PASS / 10 skips** e CMS
  **448 PASS / 11 skips**, zero falhas; `verify: ok`.
- `npm run security`: **zero vulnerabilidades** nos três pacotes.
- `git diff --check`: **PASS**, repetido depois do registro documental.
- Logs locais: `initializer-diagnostics-focused-final.log` e
  `initializer-diagnostics-verify-final.log`, no diretório temporário aprovado
  do OpenCode. Não contêm stderr privado dos serviços.

**Uncommitted/unpushed, ready-for-fresh-review**, sem revisão independente ou
runtime/recovery PASS atribuído. O run histórico root é evidência nativa do
patch **anterior**, não execução Linux do patch presente. Nenhum novo CI,
commit/push, SSH, deploy, delegação ou mutação de serviço/banco real foi feito.
Workflow/receiver/qualificação externa continuam inalterados; material untracked
anterior foi preservado. Integração/CI e execução física isolada requerem sua
autorização separada.
