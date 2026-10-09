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
