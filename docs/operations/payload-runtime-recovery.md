# Runtime Payload e recuperação coordenada

## P1 — ordem de mounts no ticket efêmero do coordinator

O método real `_writer_inspect` tinha um defeito reproduzível em memória: duas
respostas Docker com o mesmo container ID e os mesmos registros de mounts, mas
em ordem diferente, produziam fingerprints diferentes. `STATE.canonical` ordena
chaves de objetos, não arrays; a ordem do array Docker `Mounts` não é uma identidade
estável. Isso demonstra o defeito local, **não** atribui retroativamente a causa
do report real de `38454684188` que falhou em `restore_start_readiness`, exit 2,
`writer_identity_mismatch`, após fixtures e 11 negativos passarem. Esse report
não identificou qual componente da identidade divergiu.

O ticket efêmero assinado passa a ter kind **`coordinator-writers-v2`**. Antes do
hash, exige-se `Mounts` como lista de objetos, cada um com `Destination` string
absoluta Linux, sem NUL e sem destinos duplicados. A lista é ordenada por
`Destination`; todos os registros, campos e a cardinalidade permanecem no hash.
Não há projeção que descarte `Source`, `Type`, `Mode`, `RW`, `Propagation`, campos
extras, labels ou outras propriedades. Não se normalizam listas internas nem a
ordem de `Healthcheck.Test`, que continua semanticamente significativa.

`observe-writers` produz somente v2; `resume-writers` e
`resume-readiness-writers` recusam v1, inclusive com HMAC válido. Não há tentativa
de aceitar hash antigo **ou** novo. Não atualizar o adapter no meio de uma operação
coordenada: tickets são efêmeros e vinculados ao mesmo processo ancestral/lease;
não se convertem ou reaproveitam tickets v1 em v2. HMAC, FD9, identidade do processo
ancestral, origem no journal, floor, admission fechada, worker hold, validação de
todo o conjunto antes do primeiro start e revalidação após start não mudam.

**Receipts persistentes não migrados:** `_creation_container` mantém exatamente
seu algoritmo anterior, inclusive sensibilidade à ordem de mounts. Alterá-lo
silenciosamente invalidaria receipts já assinados. Uma correção desse contrato
exige versionamento e migração explícitos em bloco posterior; não está incluída
neste patch e continua sendo uma lacuna conhecida. O diagnóstico de divergência
continua o código finito existente, sem inventar componente/serviço histórico ou
publicar mounts, paths ou valores privados.

Regressões usam os métodos Python reais, canonicalização/HMAC/journal reais e
transporte Docker explicitamente simulado. Cobrem permutações de três mounts,
mudanças reais em campos/cardinalidade, destinos malformados/duplicados, ordem do
healthcheck, recusa antes de qualquer start e falha pós-start com admission/journal
preservados. Isso não substitui recovery Linux/Docker nem comprova deploy.

## Progresso diagnóstico do recovery (2026-10-13)

O CI `38436732170` atingiu o limite de 60 minutos sem report final publicado.
Os artefatos observados foram candidate, digest CMS e SBOM. O runner captura saída
dos comandos e escreve o report de aceite somente no término: silêncio no log
**não identifica um hang, etapa culpada ou causa raiz**. Os budgets cumulativos
podem ultrapassar o limite global. Este bloco adiciona visibilidade, não altera
budgets, timeout HTTP, retries, spawn síncrono, sinais, critérios de qualificação
ou comportamento operacional.

O runner agora emite JSON redigido em cada início/fim de comando síncrono e nas
transições de stage/substep. Cada registro inclui `schemaVersion: 1`,
`artifactKind: "diagnostic-progress"`, `qualifiesAcceptance: false`, `sequence`,
`elapsedMs`, `stage`, `substep`, `fixtureRole`, `event`, `commandCategory`,
`timeoutMs`, `outcome` e `firstFailure`. Os nomes são allowlists finitas; desconhecidos viram
`unknown`. Roles públicas são apenas `source`, `target`, `leaseTarget`, `global`.
Não entram argumentos, nomes de projetos, caminhos, environment, SQL, URLs,
saída de filhos ou texto de exceções. O timeout de cada comando reflete exatamente
`options.timeout || 180_000`, inclusive os budgets já maiores do coordinator.
`elapsedMs` é monotônico desde o início do diagnóstico; comparar eventos begin/end
para a duração observada. `completed` descreve somente o retorno da operação, não
aceite recovery. Não há heartbeat, nova espera, retry ou polling; chamadas repetidas
com stage/substep inalterados não geram novas transições.

Antes de bloquear em um comando, o registro é persistido sincronamente como um
checkpoint de **último evento**, limitado a 1 KiB, usando arquivo temporário
exclusivo + fsync + rename atômico. `PAYLOAD_RECOVERY_PROGRESS` seleciona o destino;
o default é `payload-preauthority-recovery-progress.json` em RUNNER_TEMP/temp.
Esse destino não pode coincidir com o report final. O CI fornece explicitamente
esse caminho e publica somente esse arquivo no artefato separado
`payload-preauthority-recovery-progress`, inclusive após falha quando possível.
Não há glob sobre fixtures, stderr ou evidência privada. A publicação diagnóstica
não bloqueia a qualificação; seu upload tem `continue-on-error`.

O artefato existente `payload-preauthority-recovery-report` continua contendo
apenas seu JSON original. O schema do report final e a entrada do qualifier não
mudaram. O qualifier rejeita o checkpoint diagnóstico, mesmo após um evento
`completed`; ele nunca substitui report ausente ou autoriza instalação/ativação.

Há boundaries explícitos para cleanup, holds pós-falha, persistência de evidências
privadas, corrida de lease e escrita do report terminal. O motivo/stage/substep
primário é capturado antes dos holds, respeitando qualquer falha de snapshot já
preservada antes de um restart. `firstFailure` é `null` antes da primeira falha
primária de aceite (rejeições esperadas da matriz negativa não o preenchem);
depois contém somente `{stage, substep, fixtureRole}` normalizados e aparece em
**todos** os registros seguintes, separado da operação atual. Uma falha posterior
ou mudança para holds/cleanup não substitui esse snapshot. Stages dinâmicos são
traduzidos apenas por igualdade com identidades conhecidas dos runtimes, nunca
por regex que aceite nomes arbitrários. Códigos de erro, texto bruto e nomes de
projetos não entram em `firstFailure`. A primeira falha fica retida em memória
antes de qualquer I/O: se sua escrita falhar, um checkpoint posterior ainda a
preserva, sem exceder o limite de 1 KiB por registro. Falha no checkpoint/console produz no máximo um
alerta fixo `Payload recovery diagnostic progress unavailable.` e não substitui
o erro operacional nem impede holds. Falha ao escrever o report terminal mantém
o objeto de falha original, emite somente alerta fixo e termina sem anunciar PASS.

Um checkpoint `command_begin` sem end correspondente significa **conclusão não
observada**, não prova deadlock. SIGKILL/cancelamento do job pode impedir report
terminal, holds em JS e até upload posterior; o checkpoint não garante execução
dessas ações. Testes locais cobrem I/O real/serialização, interrupção de um processo
filho e trechos reais do runner com doubles operacionais identificados. A próxima
execução candidata autorizada ainda é necessária para localizar o orçamento gasto
e obter aceite real; nenhum serviço ou recovery foi executado por esse bloco.

## Task 3 — contrato do proxy fixture após CI 37997573123 (2026-10-13)

**Bloco 1 documental e implementação/testes locais dos blocos 2–4 concluídos; bloco 5
pendentes.** Este
contrato não declara revisão independente, recovery PASS nem operação autorizada
em produção. Fonte e evidência detalhadas:
[follow-up do coordinator resume](../reviews/2026-10-09-payload-coordinator-writer-resume.md#follow-up-2026-10-13--bloco-1-causa-e-contratos-do-fixture-http).

O report real de `37997573123`/`f4a4c71` falhou no primeiro restore em
`restore_smoke`, exit 1. Os três fixtures haviam passado health/restart/comparação
quiescent, e os 11 negativos estavam rejeitados sem alteração de conteúdo. O
primeiro restore não retornou com sucesso/comparação completa; o segundo não
passou. O log público só confirma `first_actual_restore`: o stderr HTTP privado,
status e corpo não foram recuperados. Não atribuir ao run um erro de curl
fabricado nem interpretar health de API/CMS como prova de frontend/proxy.

O harness em `f4a4c71` prepara Postgres/API/cron e depois API/cron/CMS, sem criar
Nginx. O commit `5211664` removeu da readiness do restore a criação implícita via
`compose up ... nginx`, substituindo-a por resume de identidades pré-stop. Esse
resume é a fronteira correta: a falta do proxy deve ser corrigida na preparação
do fixture, não pela criação/adoção de um objeto durante recovery.

### Preparação, URL e identidade — bloco 2 implementado localmente

- Após API e CMS ready, o harness prepara Nginx explicitamente nos fixtures source, target
  e leaseTarget **antes da primeira observação de identidades e de qualquer
  coordenador**. Reutilizar imagem pinned e mounts read-only existentes, backend
  e porta publicada somente no loopback. Não mudar a topologia opcional de
  produção, receipts, estado assinado ou ops Python.
- O endpoint é exatamente `runtime.baseUrl=http://127.0.0.1:<porta alocada do
  fixture>`, também fornecido como `RESTORE_BASE_URL`. Smoke usa esse valor
  explícito como `BASE_URL`; não troca por porta default, outro host, endpoint
  direto da API ou URL com credentials para produzir um PASS.
- O lifecycle do fixture exige exatamente quatro serviços `api,cron,cms,nginx`:
  quatro IDs completos distintos/chaves exatas, observação canônica de até
  **512 bytes**, validação de **todos** antes do primeiro start e inspeção dos
  mesmos IDs/estados depois. Resume não cria, recria, puxa, relabela ou adota.
  `cms-worker` permanece held. Nginx não tem healthcheck: exigir running identity
  mais readiness HTTP, nunca aguardar healthcheck inexistente via `awaitService`.
- No bloco 2, o conversion probe está no escopo explicitamente, limitado à
  inclusão de Nginx no conjunto exigido parado. Não mudar DDL, rejeição CLI,
  cleanup/equality, lease ou política de worker. Seu prerequisite Linux continua
  obrigatório e fail-closed, sem skip de capacidade real.

### Smoke inicial/pré-restores implementado; diagnósticos e complementos pendentes

O harness executa o smoke **real e completo** na preparação e antes de cada restore
positivo, enquanto os serviços originais ainda estão running, com a URL exata.
Ausência do proxy, porta errada ou proxy morto deve recusar antes de `pg_restore`
ou limpeza de storage. Essa preflight fica no fixture; não substitui os gates do
coordenador. Manter smoke completo após restore e todos os critérios existentes
de HTTP/Origin, páginas, redirects e grafo local JS/MIME, com os mesmos retries e
limites de tempo. Falha pós-restore continua fechando admission e conservando
evidência/motivo primário; não chamar uma retomada parcial de recovery.

Os blocos 4–5 devem verificar produtor→wire de quatro chaves, duplicados,
oversized, troca/ausência de proxy, API healthy com proxy ruim, mesmo-ID start,
timeout/transiente/retry/partial/signal, credentials/contexto, status/conteúdo/JS/
redirect inválidos, percurso real de smoke inicial e pós-restore e staged failures
sem efeitos destrutivos. Mocks existentes não são aceite Docker/HTTP. Diagnósticos
usam somente checks/razões finitos para transporte/status/readiness/conteúdo/
redirect/módulo; nenhum path privado, credential, corpo ou stack sai no report.
Stderr desconhecido permanece privado e parser não ganha fallback para output
arbitrário. O schema estrito de sucesso do qualifier permanece igual.

### Evidência delimitada do bloco 2

Criação explícita sob lease usa `up --detach --no-deps --no-recreate --no-build
--pull never nginx` somente na preparação; resume permanece mesmo-ID start sem
criação. O conjunto de quatro chaves/IDs é validado integralmente antes do primeiro
start e reinspecionado depois; stop e o conjunto parado do conversion incluem Nginx.
Nenhum ops Python/Compose de produção/pin foi alterado, e o overlay fixture já
existente fornece backend/loopback.

Na criação e após restart, a checagem limitada exige identidade running/labels e
um único binding da porta 80 ao loopback/porta atribuída antes da requisição, mais
reinspeção após sucesso. Usa a URL exata e apenas status 200 de `/api/ready`, oito
tentativas de até 3s, intervalo de 250ms, sem seguir redirect ou ler o corpo.
**Isso não substitui o smoke completo do bloco 3.** Códigos finitos de endpoint,
identidade, porta e disponibilidade HTTP usam os campos existentes; o protocolo
diagnóstico de smoke ainda não foi implementado.

A regressão red de três→quatro foi reproduzida e corrigida. Checks direcionados:
**49 PASS / três skips nativos existentes**, zero falhas; sintaxe dos cinco scripts
alterados e `git diff --check` **PASS**. Teste de HTTP usa um servidor loopback real
e metadados Docker doubled; transporte Linux fake Docker permanece explicitamente
skipped neste Windows. Não há evidência de Nginx/Docker real ou de restore PASS.
Esses resultados pertencem ao bloco 2. Full verify/security continuam reservados
para depois do bloco 5.

### Evidência delimitada do bloco 3

O ID de Nginx observado na preparação é salvo uma vez e usado pelo gate antes e
depois do smoke; não há reobservação/adoção de substituição. A cópia real
`<release>/scripts/smoke.sh` recebe `BASE_URL` exatamente igual ao `RESTORE_BASE_URL`
produzido para o fixture e mantém as tentativas configuradas. O gate inicial fica
antes do seed/open/coordenador; os dois gates positivos ficam antes do snapshot
do alvo e de cada chamada de restore. Falha de identidade/porta/disponibilidade ou
do smoke impede esses callbacks. Smoke POST-restore, critérios completos,
cleanup/admission/worker e scripts de smoke/coordenador permanecem inalterados.
O diagnóstico é ainda o código/substep fixo do comando com stderr privado;
parser detalhado pertence ao bloco 5.

O mesmo comando focado, interrompido inicialmente pelo limite externo de 120s,
foi repetido com limite de verificação de 600s, sem mudanças de código/curl/retry:
**44 PASS, zero falhas/skips/cancelados, exit 0, wall time 103,200s** (Node 103,033s).
Todos os casos terminaram; nenhum hang foi observado nessa execução. Somar os
tempos de testes paralelos não é medir wall time, e a duração exata do run anterior
não foi recuperada. Bash/curl com o grafo completo repetido nos três fluxos custa
tempo no Windows; não se removeu cobertura nem se aumentou timeout de produção.

O wrapper real executou o shell/script real contra HTTP loopback do teste e os
arquivos do checkout. Apenas Docker metadata e callbacks de restore eram doubles:
isso comprova smoke HTTP e ordering no harness, não Docker/Nginx/DB restore.
Sintaxe dos quatro arquivos de código/teste alterados e `git diff --check` **PASS**.
Log: `%LOCALAPPDATA%/Temp/opencode/cms-nginx-block3-focused-complete.log`.
Esses resultados pertencem ao bloco 3; a conclusão posterior do bloco 4 segue abaixo.

### Evidência delimitada do bloco 4 — regressões e teardown owned

Regressões adicionais validam cada um dos quatro containers antes de qualquer
start, guard real de conversion com Nginx/worker ativo antes de DDL, adapter real
com Nginx sem healthcheck e resume parcial fechado/journal unchanged. Smoke HTTP
real cobre retry transitório→sucesso, exaustão nos três gates sem callbacks
destrutivos, refused/timeout/partial/signal e critérios HTTP/HTML/JS/redirect já
existentes. Os três percursos completos distintos foram conservados, sem adicionar
outra repetição bem-sucedida cara do grafo. Coordenador com doubles declarados
mantém primary/proteção/admission em falha POST-smoke, inclusive cleanup falhando;
nesse último caso não declara writers parados se o stop realmente falhou.

O EBUSY inicial foi em cleanup do fixture, após **88 PASS / uma falha / um skip**.
Seu holder não foi identificado na inspeção posterior; fixture failed e evidência
originais foram preservados. O gap era aguardar o driver direto sem prova de
terminação da árvore que podia herdar cwd/handles. A correção ficou no harness:
Windows Job Object nativo com root suspenso→assign/membership→resume, sem breakaway;
teardown pelo handle owned, accounting zero/eventos antes da **única** remoção.
Não há retry de rm, sleep arbitrário ou kill de PID/nome não comprovadamente owned.
POSIX usa sessão/grupo próprio e líder vivo via IPC; execução desse ramo Linux
continua pendente, não é demonstrada pelo Windows.

A regressão sincronizada confirma root/descendente vivos e owned antes de liberar
saída antecipada. No ramo Windows detached, o descendente continuou ativo (259)
após root exit=0 e terminou pelo job, com accounting zero confirmado. O ramo padrão
apresentou uma transição de saída entre leituras; não atribui retrospectivamente
o lock antigo a um processo. O erro C# local de nomes `member` foi confirmado pelo
primary e corrigido só no harness. Cleanup reporting failure preserva o timeout
primário real/callbacks bloqueados; ownership incerta retém fixture e falha.
Nenhum HTTP/curl/critério ou timeout de produção foi alterado; teste real de 500ms
permanece, sem mock de sucesso/timeout ou skip Windows.

Resultado final: **91 PASS / zero falhas / um skip Linux root existente**, 92 testes,
exit 0, wall time **208,162s** (Node 207,922s), orçamento de verificação 600s. Native
ownership isolado: um PASS/zero skips. Sintaxe dos seis testes e diff-check **PASS**.
Log: `%LOCALAPPDATA%/Temp/opencode/cms-nginx-block4-owned-focused.log`.
Isso é evidência nativa Windows de lifecycle e HTTP do teste, não Docker/Nginx/PG
restore. Esses resultados pertencem ao bloco 4; o bloco 5 segue abaixo.

Os **14 checks, 11 negativos, dois restores completos, legacy/1, worker held,
identidades/lease, provas e catálogo assinados** continuam obrigatórios. Full verify,
revisão independente e aceite Linux ainda não estão concluídos.
Nenhuma
execução de CI, commit/push, SSH, Docker/serviço ou delegação foi realizada aqui.

### Evidência delimitada do bloco 5 — atribuição finita, sem mudança HTTP

`scripts/smoke.sh` conserva requests, endpoints, argumentos curl, timeout de 5s,
tentativas/intervalos, critérios completos e o output de sucesso existentes.
Somente a falha final pode acrescentar `diagnostic` com check fixo, motivo finito
(`transport`, `http_status`, `readiness`, `content`, `redirect`, `module`) e
`httpStatus` numérico 100–599 ou `null`. Fatos da tentativa corrente atravessam
command substitutions por sidecars no diretório temporário privado já existente;
falha em gravar diagnóstico não muda o retorno HTTP. Não são publicados recursos,
paths, URLs, headers, corpo, credenciais ou stderr arbitrário. O status é `null`
quando a chamada existente não o fornece; não há request adicional para inferi-lo.

O parser exige um único registro canônico de no máximo 512 bytes, exit 1 sem
timeout/signal e contexto/substep explícitos. Os preflights inicial e antes dos
dois restores usam `fixture-full-smoke`/`fixture_full_smoke`; o POST-restore usa
apenas o frame consistente e único de `payload-coordinator:restore`, substep
`payload_coordinator_restore`, step `restore_smoke`. Duplicatas, frame malformado,
contexto desconhecido, mensagem privada anexada ao registro e output fingindo
sucesso são recusados. O wrapper valida o output de sucesso existente, sem mudar
suas chaves. Cleanup output após o frame de falha permanece privado e não troca
a causa primária. O sanitizer acrescenta `smokeFailure` opcional somente em falha;
schema do relatório qualificado, progress e 14 checks/11 negativos estão intactos.
Não foi necessário alterar `scripts/payload-operations.sh` nem runtime Python.

Checks locais do bloco 5:

- Quatro arquivos focados: **78 testes, 77 PASS, zero falhas/cancelados, um skip
  Linux root/FD9 existente**, exit 0, wall time **248,709s**, orçamento externo 600s.
  Log: `%LOCALAPPDATA%/Temp/opencode/cms-nginx-block5-focused.log`.
- Após endurecer o framing contra steps duplicados/malformados: três arquivos
  focados, **37 testes, 36 PASS, zero falhas/cancelados, o mesmo skip**, exit 0,
  wall time **87,697s**. Log: `cms-nginx-block5-framing-focused.log` no mesmo diretório.
- `npm run security`: **PASS**, zero vulnerabilidades em API, cron e CMS.
- Checks finais independentes: `npm run lint`, `npm run typecheck:cms`, scanner
  de segredos/DHO, sintaxe dos três testes e `git diff --check`: **PASS**, exit 0.
  Log: `cms-nginx-block5-final-static-security.log` no mesmo diretório. Esses checks
  separados não substituem o full verify interrompido.
- `npm run verify`: **incompleto/falhou no harness**. Sintaxe e typecheck CMS
  passaram; os testes Node terminaram por **SIGTERM** no limite interno de 180s,
  sem resumo completo. A ferramenta foi interrompida pelo restart do servidor;
  não se recuperou o exit externo nem se declara uma contagem completa. O log
  preservado é `cms-nginx-block5-full-verify.log`. CMS unit tests e gates seguintes
  não foram alcançados nessa execução. Não se mudou o limite nem o ownership para
  contornar isso, e nenhuma fixture failed foi removida.

HTTP real/Bash/curl no teste e ownership Windows nativo continuam distintos dos
doubles declarados de transporte do coordenador/Docker e da regressão sintética
de schema do qualifier. **Não** comprovam Nginx/Docker/PostgreSQL, POSIX ownership
ou os dois restores reais. Full verify completo, fresh review primary-owned e CI
Linux autorizado continuam pendentes; não há aceite de recuperação nem deploy.

## Revisão pendente — restart exato do coordenador (2026-10-09)

O CI `37982456244`/`0fa5818` passou health/restart/comparação dos três fixtures e
falhou no backup coordenado em `resume_writers`, exit 1. Stderr da ferramenta não
foi recuperado; dependência Compose ausente permanece hipótese. O patch local
substitui resume/readiness por start de IDs observados antes do stop, com ticket
assinado somente em memória, vinculado ao processo/journal/inventário/fd9 e
validação integral antes dos starts. Não muda o schema de estado nem cria/adota
serviços. Interrupção não autoriza retry automático por outro coordenador.

Entrega, compatibilidade v1/v2, regressões e limites estão em
[fresh review do coordinator resume](../reviews/2026-10-09-payload-coordinator-writer-resume.md).
**Revisão independente e aceite Linux/Docker/DB ainda pendentes**; esse registro
não autoriza instalação do adapter/coordenador em produção nem ativa admission.

## Evidência Task 3 — comparação independente pós-restore (2026-10-09)

O run `37918102226`, commit `7893d35`, passou novamente pelas onze negativas e
falhou em `first_actual_restore` com `acceptance_assertion_failed` e subpasso
residual `snapshot_cms_media`, sem erro do coordenador nem stderr privado. Isso é
compatível com uma assert posterior ao retorno do coordenador, mas o report não
identifica o campo divergente. **Não é aceite dos quatro stores.**

A instrumentação distingue agora `restoreAcceptanceProgress.first/second`:
`coordinatorReturnedSuccessfully` só vira true após retorno normal da chamada;
`fullSnapshotComparisonPassed` só vira true após igualdade dos seis componentes.
Autoridade, documento de origem, remoção do documento independente do alvo e
worker hold têm códigos fixos próprios. A segunda execução também passa a ter
stage explícito `second_actual_restore` antes de invocar o coordenador.

`restored_snapshot_mismatch` publica apenas a lista finita de componentes
divergentes (`portalDatabase`, `cmsDatabase`, `portalSchema`, `cmsSchema`,
`portalUploads`, `cmsUploads`) e seus SHA256 esperado/observado. O esperado é a
captura independente da origem, não valor bundled ou resultado copiado do
adapter. Ausência de componente/shape inválido falha fechada. `restore_target_unchanged`
distingue o caso de o alvo não ter mudado. O mesmo snapshot pós-restore serve às
duas comparações, evitando uma nova amostragem entre igualdade e mudança do alvo.

Em falha, capturas privadas dos dumps de dados/schema e arquivos tar dos dois
stores ficam sob `private-snapshots/` (0700, arquivos 0600), separadas do report
público. São seis labels fixos: alvo antes/depois e origem depois, para primeiro e
segundo restore; até seis componentes de 1 MiB por label. O manifesto privado
identifica formato, tamanho original e truncamento. O limite afeta **somente a
cópia diagnóstica**: hashes lógicos/de arquivos usam a captura completa, nunca o
prefixo privado truncado. A flag pública
`privateSnapshotEvidenceRetained` não implica que todos os arquivos estejam
completos; o manifesto privado registra isso. Nada dessa árvore é adicionado aos
artifacts públicos. Ela existe apenas durante a vida do runner descartável.

Na continuação desta mesma tarefa, o aceite passou a usar **snapshots lógicos
independentes** para Portal e CMS. `pg_dump --data-only --column-inserts` e
`--schema-only` permanecem somente no ramo de evidência privada, sem participar
do hash de aceite. Como são capturas auxiliares em outra transação, não são a
fonte autoritativa dos hashes lógicos. Não há rewrite de SQL de dumps.

### Contrato da captura lógica independente

`payload-logical-snapshot.mjs` gera SELECTs em uma transação repeatable-read/read-only
por banco, com timezone UTC, search_path pg_catalog e formatos de saída fixos.
`psql -XAtq -v ON_ERROR_STOP=1` executa apenas consultas geradas com `%I`/`%L`
para identidades descobertas no catálogo. O manifesto de seções e as listas de
tabelas/sequences são reconciliados; transporte incompleto não gera hash.

- **Schema observado:** namespaces (inclusive vazios), relações, colunas com
  ordinal lógico denso, tipos/enums/domains/composites, defaults, índices,
  constraints, funções/procedures, triggers não internos, rules/views/materialized
  views, policies, herança/partições, parâmetros/ownership lógico de sequences,
  collations, extended statistics, extensões, casts e security labels. OIDs são
  resolvidos em identidades; attnum físico e seus buracos não são identidade,
  mas reordenar colunas visíveis altera o hash. Comentários e opções presentes
  nos registros também são vinculados. Owners/ACLs não são comparados aqui, como
  no antigo dump `--no-owner --no-privileges`; os gates próprios de roles/grants
  continuam obrigatórios. Objetos internos de FK são representados pela própria
  constraint, não por nomes automáticos de triggers que contêm OIDs.
- **CHECK:** uma função pura expõe o parser observado sem chamar o verificador
  nativo. O modo genérico conserva casts e identidades quoted, sem as equivalências
  de casts restritas ao contrato nativo revisado. Agrupamento redundante de CHECK
  é canonicalizado; gramática não suportada permanece como texto bruto marcado,
  não como TRUE/definição esperada. Snapshot de catálogo propositalmente inválido
  continua possível para comparar as negativas antes/depois.
- **Dados:** todas as tabelas de usuários, incluindo operacionais, ledger e
  sessões, partitions e materialized views. `ONLY` evita duplicar dados herdados.
  PostgreSQL produz um objeto JSONB `coluna -> valor SQL::text ou NULL`, que
  viaja como texto dentro de uma string e nunca tem seus números convertidos em
  Number JavaScript. Diferentemente de `to_jsonb(row)` simples, conserva SQL NULL
  versus JSON null, lexemas de JSON, limites inferiores de arrays e composites
  nulos; tipos são vinculados pelo schema. Rows são ordenados por bytes,
  preservam duplicatas e são hasheados com framing de comprimento. Cada tabela
  tem identidade, contagem conferida e SHA256 próprio; tabelas vazias não somem.
- **Sequences:** todas as identidades, tipo, início, incremento, limites, cache,
  cycle, owned-by, `last_value` e `is_called`. Inteiros de 64 bits são texto, nunca
  Number. Nenhuma chamada a `nextval` é feita. Estado de sequences não é MVCC;
  continuam necessárias as barreiras de writers e provas de quiescência.
- **Limites fechados:** 32 MiB de transporte total por banco, 100.000 rows e
  statement_timeout 120s. Exceder limite/inventário incompleto falha; não há
  truncamento do material hasheado. Foreign relations/servers, base/range types
  não cobertos, aggregates, operadores/opclasses/opfamilies de usuário, text-search
  objects, publicações/subscriptions, event triggers, large objects, transforms e
  linguagens adicionais falham explicitamente como objetos não suportados.
  O report conserva um `logicalSnapshotErrorIdentifier` de enum finito somente
  no contexto explícito da CLI de fingerprint; stderr desconhecido fica privado.
  Overflow do buffer é `output_limit_exceeded`, nunca sucesso parcial.
- **Arquivos:** permanece a árvore tar existente: paths ordenados, tipo,
  permissões, tamanho e SHA256 dos bytes, incluindo `.owner-news-import/staging`.
  Ordem do tar/mtime/uid/gid já não faziam parte desse contrato; não foi criada
  nova normalização de arquivos para passar o teste. Paths/bytes/modos extras ou
  alterados continuam divergindo.

Regressões com PostgreSQL16.4/PGlite executam as seis migrations CMS e as migrations
Portal, recriam o schema observado preservando rows e estado/tipo/ownership de
sequences e comparam os hashes completos. O loader pgcrypto é a única instrução
Portal omitida **no teste WASM**, pois a biblioteca disponível não carrega
`EVP_bf_cbc`; `gen_random_uuid` nativo existe. A captura real não omite a extensão
nem suas funções. Testes cobrem ordem física de rows, duplicatas, numerais acima
de 2^53, NULL, seq last_value/is_called, dados operacionais, schema vazio, CHECK
enfraquecido, tipo/view/índice/função/trigger/domain extra, ordem de colunas e
identificadores SQL quoted. Não há aceite de tipos inválidos pelo native guard:
captura e decisão de segurança são fronteiras distintas.

Isso completa a comparação lógica offline, **não** a recuperação real. Não houve
pg_dump/pg_restore Linux local, teste de pgcrypto nativo nem confirmação dos dois
snapshots privados do run anterior. A hipótese de divergência textual foi
reproduzida e removida da fronteira de aceite, mas o componente que falhou naquele
run permanece desconhecido. Task 3 depende de revisão independente e CI Linux
autorizado com os mesmos gates de catálogo assinado, dados, roles e admissão.

## Evidência Task 3 — fingerprint após restore (2026-10-09)

O run `37912289512`, commit `6ec32bc`, passou pelas onze negativas e chegou ao
primeiro restore real. Falhou em `guard_verify_restored` com
`restored_native_catalog_fingerprint_mismatch`: o verificador aceitou o catálogo
restaurado, mas seu hash observado não coincidiu com o hash da prova assinada de
origem. Essa comparação permanece obrigatória e inalterada; não se avança para
aceite dos dados/arquivos nem se limpa o restore intent após mismatch.

Reprodução local com as seis migrations reais em PostgreSQL16.4/PGlite recriou
enums, sequences, tabelas/colunas/defaults, constraints e índices a partir dos
deparsers do catálogo **observado**, com novos OIDs. Ambos os catálogos passaram no
verificador. A única diferença capturada foi o texto de
`news_migration_items_source_identity_check`: a recriação converteu o agrupamento
`((A AND B) AND CASE ...)` em `(A AND B AND CASE ...)`. O parser estrito de CHECK já
considerava essas representações equivalentes, mas o fingerprint usava a string
bruta. Na reprodução, os hashes anteriores eram `c00edf30ca390b3f206ca66bd7d423b63f5a09a8d297d385c44070a10ca312d7`
e `d287fca93f1f4cc39bd2366b37232a173a9cce6c4ee7fc1c725aff4f70928998`.

A correção usa, somente para definições de CHECK no fingerprint, o mesmo AST
canônico obtido do **CHECK observado** que acabou de ser comparado ao contrato
revisado. Não usa o AST esperado como saída nem substitui o inventário observado
pelo snapshot bundled. Identidades, metadata de constraints, demais definições,
colunas/defaults, índices, enums/labels, relations e migrations continuam no hash.
Nenhuma nova equivalência foi adicionada ao parser ou à validação. Na mesma
reprodução, origem e recriação passaram a produzir
`cd32737e319199b3052573c61c5b5646c9002555c11b9cd0c9cf072d42ee93e3`.

Os testes exercitam o reparse real e rejeitam CHECK enfraquecido, índice parcial,
FK com ação alterada, enum com label extra e default alterado após recriação,
mantendo o hash original após rollback. Regressão offline também comprova que o
hash não é uma constante/snapshot esperado e que a evidência não é mutada. O teste
existente do controller mantém a rejeição de hash observado diferente do assinado,
sem transição de estado e com admissão fechada.

O formato da prova não mudou e não há fallback para o algoritmo antigo: backups
novos devem ser capturados com a nova imagem/verificador; hashes de provas antigas
não são reescritos nem aceitos por relaxamento. O binding de imagens permanece
obrigatório. A reprodução é uma reconstrução lógica de schema em memória, **não
pg_dump/pg_restore**: não copia dados/ACLs, não testa grants/lease e não comprova o
aceite PG16.14/Linux. Demonstra uma causa concreta compatível com o run, mas não
dispõe dos dois inventários privados daquele CI para afirmar identidade de todos
os detalhes. Restore positivo, snapshots pós-restore e repetição após edição
continuam pendentes de revisão independente e nova execução autorizada.

## Evidência Task 3 — negativa de schema vazio (2026-10-09)

O run `37907438863`, commit `196540e`, capturou o backup coordenado real
(`actualAdapterAndCoordinator=true`) e aprovou seis negativas com conteúdo do alvo
inalterado: dump/proof/manifest adulterados, archive inseguro, digest incorreto e
migrations incompatíveis. Falhou em `negative_unexpected_schema`. O report e o log
redigido não identificam qual assert falhou; `snapshot_cms_media` era apenas o
último subpasso de `snapshot()`, não evidência de falha de mídia. O restore positivo
de quatro stores permanece **não aceito**.

Foi reproduzida uma lacuna concreta no verificador: `pg_class INNER JOIN
pg_namespace` omitia `CREATE SCHEMA fixture_unexpected_schema` sem objetos. O
teste opcional PGlite executa as seis migrations reais e comprova que a consulta
anterior e o verificador completo anterior aceitam esse schema vazio. O inventário
agora parte de `pg_namespace LEFT JOIN pg_class`, mantendo o filtro de kinds no
JOIN e as exclusões exatas de namespaces internos. Um namespace sem relações gera
uma entrada nula que não pertence ao catálogo canônico; é rejeitado em
`native_relations/preauthority_native_relation_inventory_mismatch`. O catálogo
canônico e seu fingerprint não mudam. Isso explica uma falha possível da negativa,
mas não recupera o assert ou a sequência executada naquele CI sem stderr privado.

As quatro negativas de catálogo agora exigem exit 2 no guard de preflight e o
motivo específico esperado (fase/reason nativos, ou `cms_migration_floor_mismatch`
para ledger). Timeout, falha de lease, erro genérico ou falha tardia não contam
como rejeição válida. Asserts usam enum finito: baseline/injeção/snapshot,
`negative_fixture_not_visible`, `negative_restore_not_rejected`,
`negative_rejection_reason_mismatch`, `negative_contents_changed`, worker hold,
`negative_ddl_cleanup_error` e snapshot/comparação de cleanup. Não publicam diffs,
SQL, linhas, hashes ou mensagens arbitrárias; uma falha posterior conserva o
diagnóstico delimitado da rejeição quando aplicável. Evidência privada do
coordenador só é descartada após todas as verificações e cleanup bem-sucedidos;
falhas de DDL também solicitam retenção privada. Cleanup não roda após rejeição
inesperada ou conteúdo alterado.

Snapshots continuam comparando rows/sequences e schema dos dois bancos, além das
duas árvores de arquivos; estado operacional assinado não faz parte deles. Não
foram alterados normalização, ordem de snapshots, locks, grants, assinaturas ou
protocol/authority gates. O teste PG16.4/WASM confirma criação/rejeição/remoção do
schema, fingerprint canônico restaurado, ledger sem alteração e estado de
sequences preservado. Não comprova `pg_dump` Linux, concorrência, lease, imagem
publicada ou recuperação PG16.14. Nova revisão independente e execução Linux
autorizada continuam obrigatórias.

Estado: preparação inativa reportada instalada na VPS em 2026-10-08: receiver
comum, guard, overlay de rede e configuração privada CMS. A evidência histórica
da VPS registra `runtime/payload-control` ausente e nenhum runtime, banco ou
worker CMS iniciado. O adapter e seus helpers existem agora **somente neste
checkout**: não foram instalados, revisados independentemente nem aceitos em
runtime. Evidência histórica e limites: [preparação da VPS](../reviews/2026-10-08-cms-vps-infrastructure-preparation.md).
Não executar deploy, comandos SSH, cutover ou alterações de serviços sem autorização.

## Stack opcional e credenciais

`docker-compose.payload.yml` é acrescentado à stack Portal. Sem esse arquivo,
API/cron continuam independentes do CMS em autoridade `legacy`. A API recebe
`CMS_INTERNAL_URL`; o CMS consulta o Portal por HTTP privado, nunca pelo PortalDB.
`cms-postgres` usa PostgreSQL16, banco `ownerinc_cms`, sem porta publicada.
Persistência: `cms_postgres_data` e `cms_uploads_data`, separadas dos volumes antigos.

`cms-provision` recebe somente credencial administrativa e senhas de migrator/runtime;
`cms-control-roles` é um serviço one-shot isolado por profile e recebe a credencial
`cms_controller` junto das credenciais necessárias à verificação. CMS web/worker
recebem somente `cms_runtime`. A preparação privada gera a senha distinta do
controller. Os deploys verificam as roles com `--verify-control` e, somente se a
verificação falhar, executam o bootstrap estrito antes da migration nativa; roles
existentes nunca têm atributos/senhas alterados. Bootstrap rejeita ownership ou ACLs
nativas inseguras, e a verificação de release continua obrigatória. Provisionamento
revoga CREATE/PUBLIC e concede privilégios existentes/defaults. Startup verifica
identidade/grants sem DDL. Migrations CLI terminam antes de web/worker. `push:false`
e ausência de `prodMigrations` permanecem obrigatórios; nenhum autoRun no web.

Imagem única `ownerinc-portal-cms@sha256:...` para todos os processos CMS. Dockerfile
multi-stage Node24 preserva CLI, tsx, configs e migrations; executa como `node`.
Volume CMS `/var/lib/ownerinc-cms/media` nasce com proprietário node e modo0700;
fica fora de `/app`, que é a raiz do código para o guard de storage, inclusive
quando Next muda `import.meta.url` no bundle. API legada mantém `/app/uploads`.
O journal de importação fica em `/var/lib/ownerinc-cms/media/.owner-news-import/`.
Volumes existentes
não são corrigidos por chmod/chown destrutivo automático. Validar permissões no
ensaio. Código compartilhado API/cron mantém APIs Node18, sem alegar que CMS seja
compatível com Node18. Arquivos Linux usam LF.

Build usa **contexto raiz** e `--file cms/Dockerfile`; preserva `/app/cms`,
`/app/scripts` e `/app/api`, com `WORKDIR /app/cms`. O ignore específico
`cms/Dockerfile.dockerignore` usa allowlist e tem precedência sobre `.dockerignore`
da raiz, que continua excluindo scripts para as outras imagens. Não usar contexto
`cms` nem `COPY . .` da raiz. Os módulos de bundle/export/import legado, validators
API e hashes CMS são copiados nos paths originais. `createRequire(api/package.json)`
resolve o grafo **API** instalado explicitamente por seu lockfile (`sharp`/`pg`);
não depende de hoisting do CMS nem de symlink entre grafos.

O guard de storage considera localização do módulo e cwd: com cwd `/app/cms`,
`runtimeCheckout` é `/app`, portanto `/app/uploads` também é inválido para os
assets CMS, inclusive quando Next altera `import.meta.url` no bundle. O volume CMS
fica fora desse root; `.owner-news-import/` fica dentro de
`/var/lib/ownerinc-cms/media`, junto aos bytes promovidos/ambíguos. Uploads Portal
continuam em `/app/uploads`. Nome de volume mantido; nenhuma movimentação de dados
ou mudança de container ocorreu nesta alteração de fonte.

O estágio runtime executará `scripts/check-runtime-packaging.mjs`: imports puros
de producer/consumer e decoding PNG sintético com sharp, sem inicializar Payload
ou conectar ao banco. O build/container real ainda exige lease; smoke local da
closure com dependências instaladas não comprova binários Linux nem imagem final.
CI/SBOM precisa abranger os dois grafos npm contidos na imagem CMS.

O overlay usa build de produção (`NODE_ENV=production`); sessões locais integradas
precisam de origem HTTPS/ingress local autorizado. Não habilitar cookie insegura
de produção para contornar isso. Firebase Emulator pode continuar sendo a fonte
de identidade sintética; o primary deve coordenar TLS e portas do ensaio.

Os placeholders em `.env.example` servem para **parse**, não execução. O
provisionador recusa senhas placeholder. Não imprimir `docker compose config`
com credenciais reais: usar `--quiet` ou parser com ambiente sintético.

## Proxy e CSP

Next16 `src/proxy.ts` gera nonce por request, sobrescreve headers não confiáveis
e entrega a mesma CSP ao request Next e à resposta. Preserva Origin em ações e
exceção service-only estreita. Nginx não emite segunda CSP editorial e mantém a
política do Portal nos demais paths. Headers comuns continuam herdados.

Somente criação news-media aceita51MiB; JSON editorial6MiB. Endpoints privados
com/sem barra e `/_next/image` estão bloqueados; `^~ /_next/` evita captura pelas
locations estáticas. Bytes privados/HTML/APIs continuam no-store.

**Pendente lease do primary:** build produção, Nginx real, nonce efetivo nos scripts
HTML/RSC/Server Actions, Firebase Emulator, logout/BFCache, uploads privados/Range,
Monaco/Lexical/worker CSP e restart. Unit não demonstra hidratação. Browsers
suportados ainda precisam de decisão/evidência; não existe matriz inventada aqui.

## Release e formato de backup

`.ci-images`: exatamente duas linhas API/cron para legacy; três API/cron/CMS para
Payload. `.image-env`: API_IMAGE/CRON_IMAGE, e para CMS também CMS_IMAGE e
RELEASE_FORMAT=payload-v1. Parser recusa duplicados, campos desconhecidos,
referências mutáveis ou CMS parcial. Não carregar manifesto por source/eval.

Conjunto legacy preservado: postgres.dump/uploads.tar.gz e manifest.sha256.
Conjunto payload-v1:

1. postgres.dump — PortalDB, autoridade e sessões;
2. uploads.tar.gz — todos os uploads legados;
3. cms-postgres.dump — conteúdo, jobs, versões, import/mutation ledgers;
4. cms-uploads.tar.gz — **todo** CMS_UPLOAD_DIR, inclusive `.owner-news-import/`,
   staging, promoções, órfãos e bytes com COMMIT desconhecido;
5. release.images, operations-proof.json e backup.format — metadados verificados;
6. manifest.sha256 — sete entradas exatas, incluindo todos os metadados acima.

Backup diário e pré-release usam o mesmo contrato. CMS não aplica expurgo automático
enquanto política coordenada/ambiguidades estiver pendente; legacy mantém14dias.
S3 só copia conjunto verificado; erro preserva cópia local. A agenda diária continua
com S3 desativado. Não alegar recuperação de perda da VPS por backup no mesmo host.

## Lease e barreira externa

`runtime/deploy.lock` é único para release/backup/restore/import/manutenção.
Coordenador abre fd9 e adquire flock antes de qualquer transação DB; filhos recebem
o descriptor e conferem inode, sem readquirir recursivamente. O wrapper diário já
é o coordenador e passa fd9 ao helper. Nunca remover/substituir esse lock.

Import/manutenção externos precisam entrar por `ops/payload-writer.sh`, em foreground,
antes de conectar ao banco. O wrapper confere o journal assinado em estado `open`
e o sentinel após adquirir o lock. Seus filhos não podem daemonizar/fechar fd9 cedo.
A integração desses callers com threads3/4 ainda é necessária; até lá, não executar
import/finalizer junto com a instalação fria. Um caller que ignore o lock ainda
pode abrir uma corrida depois da última observação e invalida a garantia.

`ops/payload-operations-guard.sh` fecha admissão por sentinel no mesmo runtime e
recusa containers/one-shots inesperados. Os serviços nginx/api/cron/cms são parados
e aguardados; `cms-worker` não é iniciado nem retomado, e worker ainda ativo bloqueia
o preflight. Depois o adapter inspeciona `pg_stat_activity` nos bancos envolvidos
e recusa conexões de cliente restantes antes do capture/restore. Essas checagens
não executam finalizer, não inspecionam ledger de cutover/selo e não substituem a
integração futura dos writers externos. A lease operacional permanece durante
dumps sequenciais. Falha conserva evidência e admissão fechada; estado de serviços
deve ser inspecionado antes de recuperação explícita.

O controle de banco nesta fase valida Portal schema/autoridade/grants e catálogo
CMS nativo ausente, sem transação Portal→CMS nem DDL de protocolo. Não alegar
reconciliação de `COMMIT` desconhecido, aprovação de coverage ou selo de cutover.

## Adapter de controle: fonte Task 2, aceitação runtime pendente

`ops/payload-control`, `ops/payload-control-runtime.py`,
`ops/payload-control-state.py` e `ops/payload-control-inventory.py` implementam nesta fonte o controller limitado à
fase `preauthority`. O guard falha se os artefatos não estiverem instalados no
runtime. A implementação local ainda não comprova PostgreSQL, Docker, `flock`
Linux, arquivos de produção ou recuperação real; não instalar nem ativar sem
revisão e aceitação separadas. A ausência do adapter no host continua sendo o
estado da evidência histórica da VPS, não uma afirmação sobre este checkout.

O inventário operacional protegido (`runtime/payload-control-inventory.json`)
é root:root 0600, validado canonicamente e incluído na identidade assinada do
estado/provas. Ele fixa projeto, runtime/release/lock, raízes de backup e as
quatro identidades/labels/mounts Docker. O runtime não aceita troca de projeto,
override de ambiente/Compose/backup nem endpoint Docker por variável. A instalação
deriva os caminhos dos defaults do preparador e recusa um inventário existente
que difira deles. O preparador instala também `runtime/payload-control-inventory.py`;
não instalar isoladamente os três helpers.

Verbos invocados com `(ação, releaseAbsoluta, evidênciaOpcional)`: release-preflight,
close-admission, quiescence-proof, backup-metadata, restore-preflight, prepare-restore,
portal-restore-intermediate, verify-restored, verify-release, rollback-check,
open-admission.

### Grants do Portal e sessão administrativa v2

Uma leitura PostgreSQL read-only reportada pelo primary confirmou no host a
migration `036_payload_editorial_control`, as colunas `token_hash`, `user_uid`,
`expires_at`, `revoked_at`, `created_at`, chave primária em `token_hash` e índice
de expiração válido. O mesmo relato confirmou que `portal_api` não tem nenhum dos
sete privilégios de tabela em `cms_editor_sessions`, e `portal_cron` também não
tem nenhum. Isso é um **floor legado observado**, não prova de grants nem aceite
de sessão v2.

O preflight frio admite somente esse floor antigo, com todos os sete privilégios
efetivos ausentes para ambos os papéis; essa exceção existe apenas antes da
provisão v2, no início da instalação fria. Ela não relaxa os gates pós-provisão.
Após o backup legado coordenado e ainda sob `runtime/deploy.lock`, o fluxo padrão
deve executar o `migrate` normal, que chama `grantRuntimeAccess`, seguido de
`verify-migrations.js`, antes de iniciar a API candidata. O floor pós-provisão
exige exatamente `SELECT`, `INSERT`, `UPDATE` e `DELETE` para `portal_api` em
`cms_editor_sessions`, nenhum `TRUNCATE`, `REFERENCES` ou `TRIGGER`, e nenhum dos
sete para `portal_cron`; o verificador de migration também valida os grants de
`owner_news_authority`. O controller recusa grants parciais ou o floor antigo em
gates estritos. Se a provisão/verificação falhar, não iniciar a API v2, manter a
admissão fechada e preservar o backup para revisão. Não contornar privilégios nem
concedê-los manualmente fora do fluxo revisado. Se a ordem do deploy exigir um
estágio direcionado separado, ele deve ocorrer sob o mesmo lock e somente depois
de um backup real com metadados capturados; essa mudança operacional ainda não
foi executada no host.

- backup-metadata assina prova JSON canônica privada com fase, authority/epoch,
  imagens, identidade/OID das bases, migrations verificadas, protocol ausente,
  fingerprints de dados e hash/tamanho dos dois artefatos legacy ou quatro
  artefatos Payload. Não grava credenciais nem conteúdo. A prova não é selo de
  cutover.
- restore-preflight valida manifesto, prova/assinatura, arquivos e tar seguro,
  floor/catalog e identidade atual do alvo. `prepare-restore` repete a checagem de
  intent/alvo e sessões PostgreSQL imediatamente antes de cada etapa destrutiva;
  não compara identidades de clone com as identidades da origem.
- Depois do `pg_restore` Portal, `portal-restore-intermediate` repete proof, lease,
  identidade, shape/quiescência e exige somente os dois floors de grants completos
  conhecidos, além do fingerprint Portal restaurado. O coordenador então executa o
  `migrate`/`verify-migrations` padrão sob o mesmo lock; o próximo `prepare-restore`
  exige grants v2 estritos antes de tocar o CMS. Falha em reprovisionamento ou no
  gate estrito conserva admissão fechada e não inicia a próxima destruição.
- verify-restored compara fingerprints de ambas as bases e árvores de arquivos,
  além de authority, migrations e catálogo CMS esperado, antes de reabrir admissão.
- rollback-check limita a primeira instalação a rollback de aplicação, condicionado
  à prova do backup legado e ao Portal ainda em authority legacy/1; não restaura nem
  apaga volumes/banco CMS, mantém CMS web/worker parados e nunca inicia o worker.
  O container de banco CMS pode continuar executando, sem acesso público. Após a fase migrada, só aceita o
  mesmo floor CMS preauthority, sem fallback de dados para legacy.
- verify-release verifica imagens/processos e o catálogo CMS nativo read-only;
  não prova a aceitação de browser/sessão v2 nem inicia job, import ou finalizer.

### Aceitação de recuperação descartável Task 3 — código pronto, CI pendente

`scripts/test-payload-preauthority-recovery.mjs` e os fixtures
`scripts/integration/payload-preauthority-*` preparam projetos/volumes com nomes
aleatórios fora do namespace de produção, inventários independentes e registros,
arquivos e credenciais sintéticos. O alvo recebe confiança explicitamente pelo
identificador do inventário da origem e pela cópia host-a-host da chave de fixture;
a chave não integra os conjuntos de backup. O runner chama o coordenador e o adapter
reais sob lock herdado, testa rejeições pré-destrutivas e compara dumps completos,
schemas/catálogos, sequências e árvores de arquivos após dois restores, preservando
o anúncio legado pelo UUID exato da origem (e confirmando ausente o seed do alvo),
authority `legacy/1`, protocolo ausente e worker parado.
O setup CMS descartável também reproduz a sequência de produção: depois de
`cms-provision`, executa o serviço perfilado `cms-control-roles` com uma senha
`cms_controller` sintética e privada, sobrescrevendo o comando com `--bootstrap-control`
antes de `cms-migrate`. Isso cria e verifica somente as roles baseline
`cms_control`/`cms_controller` e seus grants mínimos; não instala o protocolo nem
relaxa a checagem de roles. O `verify-release` continua exigindo esse contrato, então
roles ausentes/inseguras falham antes da verificação do protocolo/catálogo.
Somente o overlay descartável define `CRON_BOOTSTRAP_ONLY=true`; o runner confere
o ambiente efetivo do container cron, aguarda sua healthcheck real e repete snapshots
com os writers parados. Para a identidade dessas comparações (não para os backups
assinados), remove somente o par de linhas `\restrict KEY`/`\unrestrict KEY` no
prologue/rodapé do `pg_dump`; conteúdo de dados, sequências e demais linhas permanece.

O CI segue: build/teste/scans de imagens e dependências → publish dos três digests
imutáveis do mesmo SHA → recuperação real nesses digests exatos → manifesto de
candidato qualificado separado, que vincula run/SHA/digests ao SHA-256 do relatório
redigido. A publicação do candidato e seu manifesto de digests **não** são
qualificação nem deploy. Relatórios de falha são artifacts redigidos; o fixture
privado fica somente no host descartável durante a vida do runner. O recovery não
é iniciado por `npm run verify` e não foi executado nesta entrega porque o Docker
local não está disponível. Só um relatório real com `status=passed` gera o artifact
qualificado; até esse run, Task 3 permanece sem aceite runtime.

Em falhas de comando, o relatório inclui um subpasso estático, exit code, SQLSTATE
identificador de erro PostgreSQL e identificador de erro do adapter somente quando
reconhecidos. Comando, argumentos, stderr/stdout e valores SQL não são serializados
nem impressos. O campo plano `sqlState` só é interpretado nas chamadas `psql` de seed
marcadas e configuradas com `VERBOSITY=sqlstate`; apenas a linha completa `ERROR:
<código conhecido>` em maiúsculas é aceita. Nos contextos explícitos `release-preflight` e
`verify-release`, o adapter Python emite o motivo fixo como uma linha simples em
stderr; runtime, state e inventário são limitados a uma allowlist finita de códigos.
Quando `cms-preauthority-verify` rejeita o catálogo, uma linha estruturada preserva
somente stage, motivo enumerado e SQLSTATE validado. Uma segunda linha opcional para
mismatch de constraints preserva categoria enumerada, identidade escolhida apenas do
inventário esperado da release candidata já validada pelo adapter (manifesto protegido
e arquivos regulares, sem symlink/hardlink e com owner protegido); não consulta o
checkout do controller nem aceita um caminho arbitrário por variável de ambiente.
Contagens e SHA-256
das definições são preservados; SQL e nomes observados não são impressos. O relatório de recuperação mantém esse resumo sob
`nativeCatalogVerifier.constraintMismatch`. Falha de execução sem essa linha e falha
de inicialização local do Compose recebem identificadores/stages distintos da rejeição
do catálogo. Mensagens fixas do guard são mapeadas apenas no contexto próprio e em
correspondência da linha inteira. Códigos desconhecidos, linhas com texto adicional e
stderr fora desses contextos não viram identificadores; conteúdo bruto permanece
somente no arquivo privado do fixture.

Diagnóstico do run Linux `37889449231` (fonte `427f974`): readiness inicial/restart
da origem e snapshots quiescentes passaram, mas `verify_release_source` recusou o
CHECK `legacy_news_revisions_metadata_basis_check`, antes de qualquer aceite de
restore. O SHA observado `d745997d2ddc6747dcdaf1d922d92b00366775f74f38caad50e48620dc5239f4`
foi reproduzido exatamente localmente com as seis migrations reais, compiladas
pelo `PgDialect` do Drizzle e executadas em PGlite 0.2.17/PostgreSQL 16.4 WASM:
`pg_get_constraintdef` acrescenta whitespace aos literais JSONB. O esperado continua
derivado da migration, não do catálogo observado. A comparação canônica agora trata
somente objetos JSONB planos com valores string (sem perder valores/chaves, sem
arredondar números e recusando duplicatas), expansão de `BETWEEN`, a representação
`NOT (IS DISTINCT FROM)` e literais bigint→numeric canônicos dentro do limite int8.
Não remove casts arbitrários, não ignora CHECKs e não aceita apenas pelo nome.

A mesma inspeção local cobriu todos os 24 CHECKs, cujas definições renderizadas estão
em `cms/tests/fixtures/native-checks-pg16.ts` como entradas observadas de regressão.
Também identificou duas regex históricas, em `source_identity` e
`import_provenance_shape`: o `\.` escrito no template JavaScript da migration é
cozido como `.` antes de chegar ao PostgreSQL (portanto casa qualquer caractere,
não somente ponto). A extração do esperado reproduz essa semântica do SQL realmente
executado, somente na fonte; não reescreve regex observada. As migrations permanecem
intactas. Corrigir a restrição histórica exigiria decisão/migration separada antes
de confiar nela como validação estrita de timestamp; não faz parte deste reparo.

Isso é evidência local de parser/catálogo, **não** aceite PG16.14/Linux ou recuperação.
Após revisão independente, o primary deve conferir todos os 24 CHECKs no ambiente
Linux descartável com as seis migrations, sem parar no primeiro mismatch, e então
executar os gates reais de recuperação. Nenhum restore bem-sucedido é alegado aqui.

O run seguinte `37897903239` (fonte `7bd24fa`) passou pelos CHECKs e recusou o
inventário em `native_types`. A causa reproduzida localmente não foi enum extra:
as seis migrations geraram exatamente os 61 enums do snapshot, incluindo os enums
internos do Payload. A consulta agregava `pg_enum.enumlabel` como `name[]` (OID
1003); o driver `pg` instalado devolve esse tipo como string, e o mapper anterior
a substituía por `[]`. PGlite sozinho decodifica esse array, portanto um teste que
usasse apenas seu decoder esconderia a falha. A consulta agora agrega `::text`
com fallback `text[]` (OID 1009), decodificado pelo `pg`, e recusa explicitamente
labels que não sejam array de strings. Nomes, schemas, valores e ordem dos labels
continuam comparados exatamente com o snapshot, nunca aprovados a partir do observado.

O filtro de tipos exclui somente rowtypes ligados à própria relação e arrays
automáticos com binding recíproco `typelem`/`typarray` e dependência interna no
catálogo. Não usa prefixo de nome nem allowlist de `typtype` para descartar tipos:
composites standalone, domains, enums, ranges/multiranges e tipos base/shell extras
permanecem sujeitos à rejeição. O fixture estático
`cms/tests/fixtures/native-types-pg16.ts` preserva os 61 payloads capturados para
regressão com o decoder real de `pg`; não contém dados de usuários ou credenciais.

Depois desse reparo, a sequência **nativa completa** de consultas do verificador
(relações, colunas/defaults, índices, constraints e tipos) passou nas seis migrations
executadas em PostgreSQL 16.4/WASM local, com parsers do `pg` aplicados aos OIDs reais.
DDL real de teste para composite standalone, domain, enum, range/multirange, shell,
base type e enum em outro schema foi rejeitado; cada caso foi revertido e o catálogo
original voltou a passar. A consulta final das 39 tabelas de mutação retornou zero.
Isso não executou conexão/autenticação, provisão de roles, Docker nem restore.
O relatório Linux ainda não contém catálogo bruto para comparar; aceite PG16.14,
recuperação dos quatro stores e revisão independente do patch continuam pendentes.

A revisão seguinte identificou um bypass nos filtros de schema: `_` em SQL `LIKE`
é wildcard, portanto `NOT LIKE 'pg_toast%'` / `NOT LIKE 'pg_temp_%'` escondia schemas
legais como `pgxtoast_hidden` e `pgxtempyhidden`. As quatro consultas nativas de
relações, índices, constraints e tipos agora excluem somente `pg_toast`,
`pg_toast_temp_<dígitos>` e `pg_temp_<dígitos>` por regex ancorada, além dos nomes
exatos `pg_catalog` e `information_schema`. Nenhum lookalike é classificado como
namespace interno por prefixo aproximado.

`cms/tests/unit/preauthority-catalog-pg16.test.ts` executa as seis migrations e as
consultas **reais**, com decoder `pg`, em PGlite em memória quando esse módulo de
teste já estiver disponível. Pode-se apontar `CMS_TEST_PGLITE_MODULE` para o caminho
absoluto de um módulo PGlite existente; não instala dependências, abre conexão de
rede nem usa arquivos de banco. Sem módulo, registra skip explícito; um caminho
fornecido inválido falha, não vira skip. Nesta revisão o teste foi executado com o
módulo local PG16.4/WASM: enum, domain, composite standalone e tabela com índice/CHECK
foram criados em **ambos** os schemas lookalike e rejeitados. Cada consulta afetada
foi executada diretamente, inclusive índices/constraints que o fail-fast de relações
normalmente impediria alcançar. Uma tabela temporária real confirmou as exclusões
de `pg_temp_N`/`pg_toast_temp_N`, e o inventário completo voltou a passar após cada
rollback. Esse teste não substitui o gate Linux PG16.14 nem o restore real.

O CI `37902389682` (fonte `a904954`) avançou pelo catálogo nativo dos três fixtures;
o relatório registra saúde inicial/restart e snapshots quiescentes `passed` em
`source`, `target` e `leaseTarget`. Falhou depois em
`capture_actual_coordinated_backup`, exit 2, sem motivo classificado nem stderr
privado retido. **Não houve aceite de backup/restore.** Foi encontrado e reproduzido
em teste shell um defeito concreto: o guard chamava `payload-control` com apenas
dois argumentos em `close-admission` e `quiescence-proof`, embora o entrypoint
exija exatamente três. A primeira chamada já retorna
`Invalid Payload control invocation.`/exit 2 antes do Python; a segunda apresentava
o mesmo defeito. As duas agora encaminham o terceiro argumento explícito, inclusive
vazio. Isso é compatível com a falha do run, não confirmação por stderr daquela
execução, que não foi preservado. Nenhuma regra de lease, admissão, roles, catálogo,
assinatura ou prova foi relaxada e nenhum estado parcial é reaberto automaticamente.

O coordenador passa a emitir marcadores estáticos `PAYLOAD_COORDINATOR_STEP` e
`PAYLOAD_COORDINATOR_FAILURE` em **stderr**, sem caminhos, argumentos, SQL ou valores.
O trap de `EXIT` cobre comandos, validações com `exit` explícito e erros de ambiente;
registra etapa/status primários antes da tentativa de parar writers no restore
destrutivo, sem permitir que erro de cleanup os substitua. As etapas distinguem
manifesto/configuração/lock, todos os guards, inventário/parada de writers, cada
dump/tar, manifesto de backup, proteção, restauração de cada banco/storage,
reprovisão/verificação de migrations e readiness/reabertura. Stdout e formatos dos
artefatos permanecem inalterados.

O relatório usa subpasso fixo `payload_coordinator_backup` ou
`payload_coordinator_restore`, mais `commandDiagnostic.coordinatorStep` de uma
allowlist finita. Somente o trecho delimitado da **chamada falha a um guard** pode
produzir motivo conhecido ou diagnóstico nativo; stderr anterior, Docker, cleanup,
texto anexado e valores desconhecidos não são promovidos a identificadores. Em
timeout sem marcador final, conserva somente a última etapa conhecida, nunca um
motivo inferido. Todo erro inesperado de backup/restore retém até 16 KiB finais
de stderr no arquivo privado 0600 sob diretório 0700 do fixture; a captura do probe
assíncrono usa buffer limitado a 64 KiB e também cobre falhas de lançamento/timeout.
Negativas esperadas só descartam essa evidência após as verificações de ausência
de mutação e o cleanup do fixture; um processo morto por sinal não conta como
rejeição esperada. Nenhum stderr bruto integra artifacts públicos.

Os testes locais executam o coordenador/guard/entrypoint shell com Docker e adapter
sintéticos. No Windows, somente o teste de dispatch substitui a identidade fd9
indisponível no Git Bash; ele não prova `flock` ou `/proc` Linux. Exercitam falhas
precoces, motivos conhecidos/desconhecidos, captura privada síncrona/assíncrona e
falha dupla restore/cleanup mantendo o erro primário. Recuperação real continua
dependente de nova revisão e do CI Linux descartável autorizado pelo primary.

A parada de `api`, `cron` e `cms` mantém `docker compose stop --timeout 120` por
writer. O deadline do subprocesso agora cobre o pior caso serial de todos os
writers selecionados mais 30 s de margem (390 s para os três), sem remover nem
encurtar o timeout do Docker. O snapshot só começa após `stop` terminar com sucesso
e uma consulta confirmar que nenhum writer continua em execução; timeout continua
sendo falha fechada, nunca autorização para capturar estado parcialmente ativo.

Falhas de readiness incluem apenas motivo enumerado, estado/health/exit code do
container e, para CMS, o status HTTP numérico de `/editorial/ready`; o corpo nunca é
lido. Stderr de comandos diagnósticos fica, quando disponível, em arquivo 0600 sob
diretório 0700 dentro do fixture root efêmero. O workflow publica somente o relatório
redigido, nunca esse arquivo privado. O relatório também registra progresso por
papel fixo (`source`, `target`, `leaseTarget`): readiness CMS inicial, readiness dos
writers após restart e estado da comparação de snapshots (`not_started`, `running`,
`passed`, `failed`). Isso mantém visível uma comparação concluída mesmo se a
restauração dos writers falhar depois.
Se a comparação e a restauração falharem na mesma passagem, o relatório mantém
os dois resumos estáticos separados em vez de deixar a falha de restart ocultar a
falha de snapshot. O `verify-release` seguinte à comparação usa stage por papel e
subpasso fixo `payload_control_verify_release`; stderr da chamada fica somente no
arquivo privado do fixture quando houver conteúdo.
O runtime exige UID 0 (`owner_root=True`) nos arquivos protegidos; não há variável
de owner configurável nem comparação com um valor `uid:gid`. O fixture confirma
UID 0 em inventário, lock, ambiente e overrides, preservando o GID existente, e
inclui uma negativa pelo `verify-release` real com lock temporariamente não-root.
Uma única lease herdada (`fd 9`) permanece aberta durante a troca de UID, chamada
do guard/adapter e restauração por `EXIT` trap; o script confirma que o caminho e
o descritor continuam apontando ao mesmo device/inode e que UID/GID retornam aos
valores protegidos antes de liberar a lease. A negativa só é descartada após o
stderr exato `unsafe_required_owner` e a restauração serem confirmados. Em falha
inesperada, stderr de mutação/adapter/restauração permanece apenas nos arquivos
privados do fixture, e o relatório redigido conserva o diagnóstico primário do
adapter mais o subpasso/status secundário e os indicadores da restauração, sem
texto bruto.

## Preparação inicial da infraestrutura de produção — inativa até nova autorização

`ops/prepare-cms-infrastructure.sh` prepara o receiver, guard, adapter e helpers,
overlay de rede/limites Payload, configuração CMS e journal/chave privada
preauthority. Não é deploy nem cutover. O histórico reportado da VPS precede esta
versão do adapter e não comprova sua instalação. O comando tem alvos fixos e aceita
somente `--check` (padrão, sem mudanças) ou `--apply`; não aceita argumento de
diretório/host alternativo.

O bundle revisado precisa manter juntos `docker-compose.payload.yml`,
`ops/prepare-cms-infrastructure.sh`, `ops/prepare-cms-infrastructure-private.py`,
`ops/deploy-from-ci.sh`, `ops/payload-operations-guard.sh`, `ops/payload-control`,
`ops/payload-control-runtime.py`, `ops/payload-control-state.py`,
`ops/payload-control-inventory.py` e
`ops/compose.payload.production.yaml`. O candidate CMS correspondente também precisa
conter `cms/scripts/verify-preauthority-catalog.ts` e sua verificação read-only
compartilhada. Antes de aplicar, confirme o bundle/commit e execute:

```sh
sudo bash ops/prepare-cms-infrastructure.sh --check
sudo bash ops/prepare-cms-infrastructure.sh --apply
```

Requer Linux, Bash, Python 3, `flock`, utilitários GNU (`install`, `sha256sum`,
`mktemp`, `mv -T`) e o plugin Docker Compose. O preparador exige que o `current-release`
continue exatamente em `d285029970c82d48cd50cc393a054af4cbfdf1e8`, com `.image-env`
API/cron de duas linhas, e que o receiver comum instalado continue root:root,
0755, SHA-256 `30be4941fe15c1c75e16175625685e2f51acc6ceaa52db146d61684cdacce0f7`.
Mudança de release/receiver, symlink, diretório/file inseguro, URL pública não
canônica, credenciais parciais/inválidas/duplicadas ou configuração Compose inválida
aborta antes da escrita.

O Compose é validado com `docker compose config --quiet`, combinando base da release
atual, `docker-compose.payload.yml` do bundle revisado, o mesmo override de produção
efetivo que o receiver selecionará (`current-release/compose.ownerinc-vps.yaml` quando
existir como arquivo regular protegido; caso contrário `runtime/compose.production.yaml`)
e o overlay Payload novo. Um override release-local existente que seja symlink, não
regular, hardlinkado ou gravável por grupo/outros é recusado, nunca ignorado em favor
do fallback. O parser recebe o arquivo de ambiente de produção em modo privado e
valores sintéticos CMS e `PORTAL_PUBLIC_URL=https://portal.ownerinc.com.br` para a
validação; não imprime configuração, URL, segredo ou comando SQL. Não há `docker pull`,
`up`, `run`, `exec`, migration, database,
container, service restart, systemd/timer ou mudança de release atual.

Com `--apply`, o preparador abre o `runtime/deploy.lock` existente sem truncar,
adquirindo `flock` antes de escrever. Preserva esse inode; nunca o remove. A
substituição atômica do `production.runtime.conf` mantém bytes anteriores, uid/gid e
modo existentes (neste host, operador uid 1000 e modo 0600); a instalação não muda
permissões de usuário. O check VPS reportado encontrou `PORTAL_PUBLIC_URL` ausente e
nenhuma chave CMS: nesse primeiro bootstrap, `--apply` acrescenta a URL canônica junto
com as nove chaves CMS na mesma substituição atômica, preservando todo o conteúdo
original. A ausência só é permitida sem qualquer chave CMS; URL explicitamente vazia
ou diferente e configuração CMS completa sem URL são recusadas, sem reparo implícito.
Sem nenhuma das nove chaves CMS exigidas, gera senhas admin,
migrator e runtime e `PAYLOAD_SECRET`/chaves de serviço com 32 bytes aleatórios
distintos. URLs usam `cms-postgres:5432/ownerinc_cms` e os roles correspondentes.
Um conjunto existente completo e válido é preservado sem rotação; qualquer conjunto
parcial, duplicado ou inválido é recusado, sem `source`/`eval` do arquivo e sem
imprimir valores.

O snapshot imediatamente anterior fica em
`/opt/ownerinc/backups/portal-ownerinc/production/cms-infrastructure-preparation-<UTC>-<UUID>`
com diretório 0700. Guarda somente o receiver anterior, o guard anterior quando
existente, o arquivo de ambiente privado (0600) e `metadata.json` com presença,
uid/gid/modo; não contém imagem, release, backup diário nem database dump. O caminho
é impresso antes da primeira instalação, também quando uma etapa posterior falhar.

Instala `/usr/local/libexec/ownerinc-portal-deploy` e
`runtime/payload-operations-guard` (root:root 0755), o adapter
`runtime/payload-control` (root:root 0755), os três helpers Python e
`runtime/compose.payload.production.yaml` (root:root 0644), além do manifesto
`runtime/cms-image-candidate.env` (root:root 0644). A chave/journal de controle
ficam root:root, 0600/0700, fora dos backups de dados. O snapshot anterior continua
limitado ao receiver, guard e environment; não contém o novo código, overlay, chave,
journal, imagem ou dump. Não instala um wrapper production novo, não altera
`authorized_keys` nem permissões/owner do override existente
`runtime/compose.production.yaml`.
O inventário protegido é root:root 0600, contém o projeto de produção e quatro
volumes (`postgres_data`, `uploads_data`, `cms_postgres_data`, `cms_uploads_data`)
com seus labels Compose e mounts revisados, mais paths explícitos para release,
lock, environment, overlays e raízes de backup. O diretório privado de proteção
pré-restore fica separado da raiz diária.
O manifesto de candidato contém somente `CMS_IMAGE=` para o digest revisado
`ghcr.io/ownerinc/ownerinc-portal-cms@sha256:6eaddc9a333ba682508a09a4ae8a6409d9e571abab9ec4a62829c2e9828730b0`; não é copiado para
`current-release/.image-env`, não adiciona `RELEASE_FORMAT`, nem promove release.

O receiver comum acrescenta o override novo somente para release `payload-v1` em
produção, depois do override normal, e falha se ele estiver ausente/for symlink.
Legacy API/cron e staging continuam no conjunto anterior de arquivos Compose. O
override mantém CMS/PostgreSQL/worker sem portas publicadas e somente na rede
`ownerinc-portal-backend` interna; Nginx permanece na topologia já configurada. Aplica
limites de CPU/memória, `no-new-privileges` e logs locais limitados. Não muda
autoridade, formato de backup, retenção ou agenda diária.

Mesmo após sucesso, a preparação está **inativa**: não há pull/up/run, migration,
deploy ou ativação por timer. O instalador verifica um journal existente ou cria
estado frio assinado sem conectar a banco; estado parcial/corrompido não é reparado.
O worker continua explicitamente retido. A API v2 candidata só pode ser iniciada
depois do backup coordenado, da provisão normal de grants e do verificador estrito
de migrations. O aceite CI de API/session v2 do Task 1 foi reportado como concluído,
mas não foi implantado. O helper CMS novo requer um conjunto candidato completo e
recém-construído que o contenha; o digest de imagem CMS já registrado na evidência
histórica não comprova esse helper e não deve ser combinado com imagens de outro
source SHA para alegar um release comum. O runner Task 3 e a ordem CI de publicação,
recuperação e qualificação estão implementados, mas a aceitação real continua
pendente do run Linux descartável. Nenhum sucesso de preparação equivale a deploy
ou recuperação comprovada.

### Rollback manual da preparação inativa

Use o caminho privado impresso pelo instalador como `BACKUP_DIR`. Só faça este
rollback enquanto o `current-release` ainda aponta para o SHA legacy acima, Payload
não foi implantado e nenhuma outra operação/alteração de configuração está em curso.
O comando reabre o mesmo lock, repõe receiver/guard/environment a partir dos backups
e restaura owner/mode do ambiente conforme `metadata.json`; nunca mexe no lock,
override preexistente, current-release, manifesto de imagem, banco ou serviços. Se o
guard anterior estava ausente, o guard revisado recém-instalado é deixado inerte.
Overlay e manifesto CMS novos também permanecem inertes sob o receiver antigo.
Se uma versão revisada do preparador já instalou adapter e estado privado, este
rollback não os restaura nem os remove; não apagar nem substituir manualmente a
chave/journal e confirmar que o receiver/guard restaurado não os invoca.

```sh
BACKUP_DIR='/opt/ownerinc/backups/portal-ownerinc/production/cms-infrastructure-preparation-<UTC>-<UUID>'
sudo bash -s -- "$BACKUP_DIR" <<'BASH'
set -Eeuo pipefail
backup=$1
root=/opt/ownerinc/apps/portal-ownerinc-real
runtime="$root/runtime"
expected="$root/releases/d285029970c82d48cd50cc393a054af4cbfdf1e8"
[[ $backup =~ ^/opt/ownerinc/backups/portal-ownerinc/production/cms-infrastructure-preparation-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || exit 2
[[ -d $backup && ! -L $backup && -f $runtime/deploy.lock && ! -L $runtime/deploy.lock ]] || exit 2
lock_identity=$(stat -Lc '%d:%i:%h' "$runtime/deploy.lock")
[[ ${lock_identity##*:} == 1 ]] || exit 2
exec 9<>"$runtime/deploy.lock"
[[ ! -L $runtime/deploy.lock && /proc/$$/fd/9 -ef $runtime/deploy.lock && $(stat -Lc '%d:%i:%h' /proc/$$/fd/9) == "$lock_identity" ]] || exit 2
flock -n 9 || { echo 'Another coordinated operation holds the lock.' >&2; exit 3; }
[[ ! -L $runtime/deploy.lock && /proc/$$/fd/9 -ef $runtime/deploy.lock && $(stat -Lc '%d:%i:%h' /proc/$$/fd/9) == "$lock_identity" ]] || exit 2
[[ -f $root/current-release && ! -L $root/current-release && $(<"$root/current-release") == "$expected" ]] || exit 2
python3 - "$backup" <<'PY'
import json, os, shutil, stat, sys, tempfile

if os.geteuid() != 0:
    raise SystemExit('Rollback requires root.')
backup = sys.argv[1]
backup_info = os.lstat(backup)
if stat.S_ISLNK(backup_info.st_mode) or not stat.S_ISDIR(backup_info.st_mode) or (backup_info.st_uid, stat.S_IMODE(backup_info.st_mode)) != (0, 0o700):
    raise SystemExit('Unsafe private rollback directory.')
metadata_path = os.path.join(backup, 'metadata.json')
metadata_info = os.lstat(metadata_path)
if stat.S_ISLNK(metadata_info.st_mode) or not stat.S_ISREG(metadata_info.st_mode) or metadata_info.st_nlink != 1 or (metadata_info.st_uid, stat.S_IMODE(metadata_info.st_mode)) != (0, 0o600):
    raise SystemExit('Unsafe rollback metadata.')
with open(metadata_path, encoding='utf-8') as stream:
    metadata = json.load(stream)
targets = {
    'receiver': ('ownerinc-portal-deploy', '/usr/local/libexec/ownerinc-portal-deploy'),
    'guard': ('payload-operations-guard', '/opt/ownerinc/apps/portal-ownerinc-real/runtime/payload-operations-guard'),
    'environment': ('production.runtime.conf', '/opt/ownerinc/secrets/portal-ownerinc/production.runtime.conf'),
}
if set(metadata) != set(targets):
    raise SystemExit('Unexpected rollback metadata fields.')
restore = []
for key, (backup_name, target) in targets.items():
    record = metadata[key]
    if not record['present']:
        continue
    if set(record) != {'present', 'uid', 'gid', 'mode'} or not all(type(record[name]) is int and record[name] >= 0 for name in ('uid', 'gid')) or not isinstance(record['mode'], str) or len(record['mode']) != 4 or any(char not in '01234567' for char in record['mode']):
        raise SystemExit('Invalid rollback metadata record.')
    source = os.path.join(backup, backup_name)
    source_info = os.lstat(source)
    target_info = os.lstat(target)
    if stat.S_ISLNK(source_info.st_mode) or not stat.S_ISREG(source_info.st_mode) or source_info.st_nlink != 1 or (source_info.st_uid, stat.S_IMODE(source_info.st_mode)) != (0, 0o600):
        raise SystemExit('Unsafe rollback source.')
    if stat.S_ISLNK(target_info.st_mode) or not stat.S_ISREG(target_info.st_mode) or target_info.st_nlink != 1:
        raise SystemExit('Unsafe rollback target.')
    restore.append((key, source, target, record))

# Validate every source and target before changing any of them.
for key, source, target, record in restore:
    fd, temporary = tempfile.mkstemp(prefix='.cms-preparation-rollback.', dir=os.path.dirname(target))
    try:
        with os.fdopen(fd, 'wb') as output, open(source, 'rb') as saved:
            shutil.copyfileobj(saved, output)
            output.flush()
            os.fsync(output.fileno())
        os.chown(temporary, record['uid'], record['gid'])
        os.chmod(temporary, int(record['mode'], 8))
        os.replace(temporary, target)
        directory_fd = os.open(os.path.dirname(target), os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(f'Restored {key}; secret values were not displayed.')
PY
BASH
```

This file rollback restores only host preparation files; it is not a release/data
rollback and must not be used after Payload traffic or authority changes.

## Restauração e floor

Restore CMS recusa backup legacy; release legacy recusa backup CMS. Hashes e paths
de tar são conferidos antes de mutação; links/devices/traversal são recusados.
Gera backup de proteção completo sob a mesma lease, sem reaquisição/S3, restaura
ambos os bancos e ambos os storages, reaplica grants/migrations e exige prova do
adapter. CMS restaura ownership `cms_migrator`; runtime permanece sem DDL. Antes de
reabrir a API, grants estritos de sessão v2 e de autoridade devem passar novamente;
o floor legado observado não é suficiente para esse gate.
Em falha, writers ficam parados e proteção é preservada. Não reativar agendas
importadas vencidas/ator desconhecido sem revalidação/decisão formal.

Cutover só depois de floor Payload compatível instalado/ensaiado, Task9 resolvida,
prepare→reconcile→seal→activate integrado e recuperação real comprovada. Selo
vincula baseline/última mutação/epoch/manifesto; editar/desfazer também o invalida.
Não há fallback automático para legacy nem rollback parcial de dados após tráfego.

## Evidência exigida no ensaio autorizado

Bases/volumes novos distintos da amostra; migrations repetidas; DDL negado ao runtime;
Portal disponível com CMS desligado em legacy; worker único; permissões de storage;
backup/restart/restore dos quatro componentes e staging/receipts; falha no meio do
restore; COMMIT desconhecido; hashes inválidos; floor inadequado; lock ocupado;
BFCache/sessão/nonce reais. Registrar comando/exit, commit/digests/ledgers/hashes,
tempos e serviços recuperados. Doubles não provam PostgreSQL, flock/Linux ou browser.
