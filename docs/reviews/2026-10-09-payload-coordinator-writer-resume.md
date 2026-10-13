# Coordinated backup — exact writer resume after CI 37982456244

## Validação integrada do primary — 2026-10-13

Os cinco blocos foram implementados e passaram por revisão independente do diff.
O único blocker demonstrado na revisão era o orçamento de 180s do subprocesso
Portal. Com autorização explícita do usuário, somente a chamada Node de testes
em `scripts/verify.mjs` recebeu `timeout: 600000`; o default de 180s dos demais
comandos, os timeouts HTTP e os critérios de aceite foram preservados.

- Primeira execução integrada: 1.759 PASS / 1 falha / 12 skips, cerca de 230s.
  O arquivo `payload-functional-forwarder.test.mjs` falhou sem causa detalhada no
  relatório. A falha não foi apagada ou corrigida por hipótese.
- Execução isolada desse arquivo com TAP: 10 PASS, zero falhas/skips, sem alteração.
- Repetição completa de `npm run verify`: **PASS**, `verify: ok`; Portal
  **1.769 PASS / zero falhas / 12 skips** (237,162s); CMS
  **448 PASS / zero falhas / 11 skips** (33,193s).
- Auditoria executada pelo primary: zero vulnerabilidades API/cron/CMS.
- `git diff --check`: PASS antes desta atualização documental.

Logs preservados em `%LOCALAPPDATA%/Temp/opencode/`:
`cms-nginx-final-primary-verify.log` e
`cms-nginx-final-primary-verify-repeat.log`. A causa da falha isolada da primeira
execução permanece indeterminada; o segundo resultado não a apaga.

O aceite nativo POSIX, Docker/Nginx/PostgreSQL, os 14 checks e os dois restores
continuam dependentes da nova CI candidata. O resultado local não autoriza deploy.

## Follow-up 2026-10-13 — bloco 1: causa e contratos do fixture HTTP

**Estado ao concluir o bloco 1:** somente documentação do bloco 1. Os blocos 2–5
abaixo ainda não estão implementados ou verificados. Este registro não é revisão
independente, aceite Linux/Docker/HTTP, PASS de restore ou autorização de produção.
Os estados e checks históricos nas seções seguintes pertencem às suas entregas.

### Evidência real em f4a4c71

- HEAD observado: `f4a4c71744cdce3169e80acac83003da841e298c`.
  O report de CI `37997573123` conserva `status=failed`,
  `failedStage=first_actual_restore`, `failureCode=coordinator_restore_failed`,
  exit 1 e `commandDiagnostic.coordinatorStep=restore_smoke`.
- Os três fixtures têm initial CMS health, restart e comparação quiescent
  positivos; os 11 negativos estão registrados como rejeitados com conteúdo do
  alvo inalterado. O primeiro coordenador de restore não retornou com sucesso;
  suas comparações completas e o segundo restore não passaram. Isso não é aceite
  dos quatro stores nem permite promover os checks restantes a true.
- O log público confirma falha em `first_actual_restore`. Não contém stderr HTTP
  privado recuperável, erro de curl, status HTTP ou corpo de resposta. Não há
  reprodução local de curl contra aquele runner nem uma mensagem de conexão
  recuperada para atribuir ao CI.

**Defeito comprovado pelo callflow:** em
`scripts/test-payload-preauthority-recovery.mjs:597–625`, a preparação faz
`up postgres api cron`, executa o initializer e depois
`up --no-deps --no-recreate api cron cms`. Nginx não é criado por essas chamadas.
API e CMS saudáveis não demonstram o frontend/proxy no host. O produtor fixa
`runtime.baseUrl=http://127.0.0.1:<porta alocada>` e fornece esse mesmo valor como
`RESTORE_BASE_URL`; o coordenador passa-o explicitamente como `BASE_URL` ao smoke.

O diff real do commit `5211664989633d9200871e0976d5ef68716c04c0` substituiu
`compose up -d --no-deps api cms nginx` na readiness do restore por
`guard resume-readiness-writers "$writer_ticket"`. A criação implícita de Nginx
desapareceu corretamente: resume só pode usar identidades pré-stop assinadas.
`ops/payload-control-runtime.py:1735–1744,1764,1793–1818` já admite Nginx observado
como serviço opcional, exige identidade integral antes dos starts e aceita ausência
de healthcheck para esse serviço. Não deve criar/adotar o proxy ausente para
contornar o defeito de preparação do fixture.

Logo, a ausência de preparação do endpoint HTTP é uma incompatibilidade concreta
do harness com o resume seguro. O **erro HTTP exato do run continua indisponível**;
não se afirma qual requisição/status/mensagem de curl falhou primeiro.

### Contratos fechados para os blocos seguintes

1. **Bloco 2 — preparar e observar, nunca criar no resume.** Após API/CMS ready,
   criar Nginx explicitamente na preparação dos três fixtures, antes da primeira
   observação de IDs e de qualquer coordenador. Reutilizar a imagem pinned e os
   mounts read-only de `docker-compose.yml:111–120`, o backend e a publicação
   exclusiva `127.0.0.1:${HTTP_PORT}:80` do overlay fixture. Não modificar a
   topologia opcional de produção. O lifecycle do fixture passa a exigir
   exatamente `api,cron,cms,nginx`: quatro IDs completos e únicos, quatro chaves
   exatas, resposta canônica limitada a **512 bytes**, validação de todo o conjunto
   antes do primeiro start, e verificação posterior dos mesmos IDs/estados. Não
   criar/recriar/puxar/relabel/adotar objetos no restart. `cms-worker` continua held.
   Nginx não recebe `awaitService` de health: exigir identidade running e readiness
   HTTP real. O arquivo `scripts/integration/payload-logical-snapshot-conversion-probe.mjs`
   está explicitamente incluído no bloco 2, **somente para acrescentar Nginx ao
   conjunto exigido parado**; manter worker held e todas as verificações do probe.
   O conflito de escopo anteriormente reportado está resolvido nesse limite.
2. **Bloco 3 — smoke completo antes e depois.** Usar a URL loopback exata do
   fixture, sem fallback de porta/host. Executar `scripts/smoke.sh` real com todos
   os critérios existentes na preparação e antes de cada restore positivo, com
   os serviços originais ainda running. Proxy ausente, porta incorreta ou proxy
   morto deve bloquear antes de `pg_restore` ou limpeza de storage. A preflight é
   do fixture: não substituir/relaxar a semântica do coordenador. Preservar o
   smoke completo POST-restore, todos os critérios, retries e limites de tempo.
3. **Bloco 4 — regressões completas.** Cobrir proxy ausente e ausência de efeitos
   destrutivos; API healthy com proxy ruim; ID de Nginx substituído e start dos
   mesmos IDs; produtor→wire de quatro chaves, duplicados e oversized; timeout,
   falha transitória/retry, transferência parcial e signal; status/page/JS/MIME/
   redirect inválidos; percurso HTTP completo válido inicial e pós-restore;
   staged failures sem `pg_restore`/storage clear; falha de smoke com admission
   fechado e motivo primário conservado. Também exigir isolamento de credentials/
   contexto no transporte/diagnóstico. Doubles de Docker/guard/smoke existentes
   continuam evidência de sequência, nunca prova Docker ou HTTP. Não adicionar
   skip para contornar ausência de capacidade no Linux real.
4. **Bloco 5 — diagnóstico finito, privado e coerente.** Atribuir apenas nomes
   fixos de checks e razões delimitadas de transporte, status, readiness, conteúdo,
   redirect e módulo. Não publicar URL com credentials, paths privados, corpos,
   erros arbitrários ou stacks; manter stderr desconhecido privado. Parser restrito
   ao contexto real correspondente, sem reconhecimento ampliado de output
   desconhecido. Integração de diagnóstico/report deve conservar o schema estrito
   de sucesso do qualifier e não introduzir campos diagnósticos no report PASS.

Permanecem obrigatórios os **14 checks, 11 negativos, dois restores completos,
autoridade legacy/1, worker held, lease/identidades, catálogo/prova assinados e
comparações independentes**. Não há alteração necessária em ops Python para este
plano. Nenhum bloco autoriza deploy, nova branch, CI dispatch, commit/push, SSH,
operação de serviços ou delegação nesta sessão.

### Verificação deste bloco

Somente leitura de fonte/histórico/report/log e `git diff --check`; suites completas
ficam para a implementação. A regressão red preexistente em
`tests/unit/payload-preauthority-writer-restart.test.mjs` foi preservada, sem edição
ou nova execução neste bloco, assim como o demo untracked e `ops/__pycache__/`.
Review independente e aceite runtime dos blocos seguintes continuam pendentes.

## Follow-up 2026-10-13 — bloco 2: proxy preparado e lifecycle de quatro IDs

**Estado ao concluir o bloco 2: implementação local concluída; blocos 3–5 pendentes.**
Nenhuma afirmação de revisão independente, smoke completo, Docker PASS ou restore
positivo. O report failed de `37997573123` não foi alterado.

- `provisionProject` agora faz a criação explícita de **somente Nginx** após health
  de API/cron/CMS e antes de observar identidades ou chamar seed/coordenador:
  `up --detach --no-deps --no-recreate --no-build --pull never nginx`, sob a lease
  existente. O serviço herda a imagem pinned e os dois mounts read-only já presentes
  na stack; o overlay fixture existente conserva backend e porta loopback atribuída.
  Nenhum Compose de produção, pin ou overlay precisou mudar.
- O protocolo/helper e o ciclo de snapshot exigem exatamente `api,cron,cms,nginx`.
  São quatro chaves exatas/IDs 64-hex distintos; a observação continua canônica e
  agora aceita até **512 bytes**, sem relaxar truncamento, duplicação, campos extras
  ou trailing output. Todos os quatro são inventariados/validados antes do primeiro
  start; apenas os IDs pré-stop são iniciados e todos são reinspecionados depois.
  O produtor usa o serializer real compartilhado, mantendo a mesma configuração
  commit-bound e os três pares de role/projeto. Restart não cria/adota serviços.
- Snapshot stop inclui os quatro serviços. A **única alteração** no conversion
  probe é adicionar `nginx` ao conjunto que deve permanecer parado, mantendo
  `cms-worker` e os gates existentes de DDL/rejeição/cleanup/equality/lease.
- API/cron/CMS continuam com health checks. Nginx não passa por `awaitService`:
  na criação e após restart, a disponibilidade exige o ID observado, labels de
  projeto/serviço/non-one-off e flags running/paused/restarting corretas, mais um
  único binding `80/tcp → 127.0.0.1:<porta atribuída>`. A URL deve ser exatamente
  `runtime.baseUrl=http://127.0.0.1:<runtime.port>`, sem fallback. Identidade/porta
  são verificadas antes da requisição e novamente após sucesso HTTP.
- Essa verificação consulta somente `/api/ready`, exige HTTP 200, não segue
  redirect nem lê/publica o corpo: **é disponibilidade, não o smoke completo**.
  Há oito tentativas com deadline de 3s/requisição e intervalo de 250ms. Falhas
  usam códigos fixos `fixture_nginx_endpoint_invalid`, `fixture_nginx_identity_invalid`,
  `fixture_nginx_port_invalid` ou `fixture_nginx_http_unavailable`, nos campos
  existentes. Parser/wire de smoke e diagnóstico refinado ficam no bloco 5.

### Regressões e checks deste bloco

A regressão red preexistente foi repetida **antes** da implementação e falhou
pela ausência de Nginx no conjunto de três serviços. Depois passou. Testes também
cobrem produtor/serializer → parse de quatro IDs completos, missing/extra/duplicate,
oversized/truncated/noncanonical output; quarto Nginx ausente, substituído,
duplicado ou com labels/estado inválidos sem qualquer start; mesmo-ID start,
falha parcial no quarto start e erro no estado pós-start. O fixture produtor de
teste preexistente permanece intacto: o teste usa sua configuração real e fornece
o quarto ID ao mesmo serializer usado na produção, sem escrever um contrato
Compose alternativo. O transporte mock Linux existente foi estendido a quatro IDs.

O teste de disponibilidade usa **HTTP real em loopback com servidor de teste**,
mas metadados Docker explícitos como double. Confirma ausência de healthcheck de
Nginx, recusa de ID/porta/endpoint antes de qualquer request, oito tentativas ao
receber 503 e reinspeção após 200. Não testa Nginx real, grafo de módulos, corpos,
transferência parcial ou sucesso do smoke: essas fronteiras ficam nos blocos 3–4.

- Checks direcionados nos três arquivos de regressão do bloco: **29 PASS / um
  skip Linux root/FD9 existente**, zero falhas.
- Checks direcionados ampliados a command/configuration/probe protocol:
  **49 PASS / três skips nativos existentes**, zero falhas. Log:
  `%LOCALAPPDATA%/Temp/opencode/cms-nginx-block2-focused.log`.
- `node --check` dos cinco scripts de produção alterados: **PASS**.
- `git diff --check`: **PASS**. Full verify/security ficam, conforme o plano, após
  todos os blocos; não foram executados neste bloco.

Os 14 checks, 11 negativos, sucesso estrito do qualifier, legacy/1, worker held,
prova/catálogo assinados e lease continuam intactos. Sem arquivos novos, alteração
ops Python, CI dispatch, commit/push, SSH, Docker daemon/serviço ou delegação.
Demo untracked e `ops/__pycache__/` preservados. Próximos blocos: smoke completo
inicial/pré-restores (3), complementos de regressão (4), diagnóstico finito (5).

## Follow-up 2026-10-13 — bloco 3: smoke completo antes dos efeitos

**Estado ao concluir o bloco 3: concluído localmente; blocos 4–5 e revisão independente pendentes.**
O report failed original permanece preservado. Esta entrega não comprova Docker,
Nginx real, PostgreSQL restore ou aceite integrado dos quatro stores.

O runner guarda uma vez `runtime.fixtureNginxIdentity`, usando o ID observado após
preparar o proxy. `assertFixtureFullSmoke` chama o gate fixture-only do helper de
comandos: verificar esse ID/endpoint com a checagem do bloco 2, executar a cópia
real `<release>/scripts/smoke.sh`, verificar **o mesmo ID** novamente e só então
executar o callback permitido. Não reobserva/adota um novo proxy para produzir PASS.
A configuração de ambiente é o produtor real do fixture: `RESTORE_BASE_URL` deve
coincidir com `runtime.baseUrl`, e `BASE_URL` recebe esse mesmo valor explícito.
`SMOKE_ATTEMPTS` é preservado, sem fallback para outro host/porta ou smoke reduzido.

- Na preparação dos três fixtures, o gate fica após criação/observação de Nginx e
  antes de seed, abertura de admission e qualquer coordenador.
- Antes do primeiro restore positivo, fica depois dos negativos e antes de
  `snapshot(target, 'first_target_before')` e da chamada do coordenador.
- Antes do segundo restore positivo, repete-se antes de
  `snapshot(target, 'second_target_before')` e da segunda chamada. Os flags de
  retorno/comparação do restore continuam posteriores ao coordenador verdadeiro.
- Ausência do ID salvo, substituição, binding incorreto ou endpoint morto recusa
  antes do script completo e do callback de snapshot/restore. Falha do smoke
  completo também não libera esse callback, mesmo com API availability positiva.

`scripts/smoke.sh` e `scripts/payload-operations.sh` **não foram alterados**. Todos
os critérios existentes de liveness/readiness/Origin, root/canonical/alias,
missing-HTML 404, redirect editorial relativo e grafo de módulos/MIME permanecem.
O smoke POST-restore, traps/cleanup, admission, worker hold e guard bindings do
coordenador continuam intactos. O gate novo não altera a semântica de produção e
não executa automaticamente em caminhos externos ao fixture ou nas negativas.

O comando usa o `runFixtureCommand` existente através de `run`, com substep/código
fixos `fixture_full_smoke`/`fixture_full_smoke_failed`, buffer de 64 KiB e orçamento
de 15 minutos igual ao comando de coordenador existente. Stderr bounded é privado;
stdout não é devolvido/publicado pelo gate. Nenhum parser detalhado foi adicionado:
atribuição finita por critério de smoke continua reservada ao bloco 5.

### Evidência dos testes e do timeout de verificação

Os testes executam um Node filho com o **wrapper de comandos real**, produtor real
de ambiente e uma cópia byte-idêntica do script da release. Bash/curl acessa HTTP
loopback real, páginas/módulos do checkout e respostas de health/redirect servidas
pelo servidor de teste. Os três fluxos inicial/primeiro/segundo exercitam os
critérios completos. Docker metadata e callbacks destrutivos são explicitamente
doubles: os marcadores de `pg_restore`/storage clear demonstram ordering/refusal,
**não execução de restore/containers**. Regressões confirmam ID ausente/substituído,
porta incorreta, endpoint morto, API availability positiva com smoke ruim, recusa
antes dos callbacks e retenção privada de falha. Não há unconditional smoke success.

A primeira execução do comando direcionado foi interrompida pelo orçamento externo
da ferramenta de **120s**, sem resultado final. Após autorização, foi repetido o
**mesmo comando**, sem alteração de código/tentativas/timeouts/asserts, com orçamento
externo de 600s. Resultado observado: **exit 0, 44 PASS, zero falhas/cancelados/skips**;
tempo Node **103,033s** e wall time medido por Stopwatch **103,200s**. Nenhum caso
ficou pendente nesse run. O grafo completo repetido via Bash/curl no Windows tem
custo relevante; somar durações de arquivos/subtests paralelos não mede wall time.
Esse resultado não recupera a duração exata da tentativa anterior nem prova sua
causa exclusiva; não há evidência de hang no run concluído. Somente o orçamento do
comando de verificação foi aumentado, não timeout/retry da aplicação/produção.

- Log completo: `%LOCALAPPDATA%/Temp/opencode/cms-nginx-block3-focused-complete.log`.
- `node --check` do runner, command helper e dois arquivos de testes: **PASS**.
- `git diff --check`: **PASS**. Full verify/security ficam após o bloco 5.
- Alterados neste bloco: runner, command helper, testes existentes recovery-guard/
  smoke-origin e os dois documentos de acompanhamento; nenhum arquivo novo.

14 checks/11 negativos, schema de sucesso do qualifier, duas comparações completas,
legacy/1, worker held e gates assinados/lease continuam obrigatórios. Sem alteração
ops Python, CI, commit/push, SSH, Docker operacional ou delegação; untracked demo/
pycache e todos os diffs anteriores foram preservados. Não avançou ao bloco 4.

## Follow-up 2026-10-13 — bloco 4: regressões e ownership do harness

**Bloco 4 concluído localmente, com checks direcionados; bloco 5 e revisão
independente pendentes.** Nenhum código de produção, HTTP/curl, critério do smoke,
timeout/retry da aplicação, schema ou runtime foi alterado neste bloco. Alterações
somente nos testes existentes writer-restart, conversion, coordinator-writer-resume,
payload-operations e smoke-origin, mais estes dois documentos. Recovery-guard foi
reexecutado, conservando sua cobertura dos blocos anteriores.

### Cobertura executável, sem duplicar o grafo completo desnecessariamente

- Conservados produtor/configuração reais → serializer/parser de quatro chaves,
  IDs 64-hex distintos, limite de 512 bytes e recusa de missing/extra/duplicate,
  truncated/oversized/noncanonical. Cada posição API/cron/CMS/Nginx agora recebe
  falhas de identidade/flags, exigindo **zero starts**; permanecem os casos de
  quarto proxy ausente/substituído/foreign, same-ID start e estado pós-start.
- O corpo lexical **real** de `assertStopped` do conversion probe é executado com
  somente stdout Compose doubled. Nginx ativo, worker ativo e cada outro writer
  recusam antes de baseline/DDL/capture/cleanup. Não é execução Docker/PostgreSQL.
- O adapter Python real, HMAC/journals v1/v2 e replay usam metadata/transport
  doubles explícitos. Incluem Nginx sem `Health`/healthcheck, proxy substituído/
  ausente/foreign, starts parciais em cron/Nginx, quatro inspeções antes do primeiro
  start e falha de health pós-start. Admission e bytes do journal permanecem
  fechados/inalterados. Não se cria/adota uma nova identidade para satisfazer teste.
- O smoke real mantém seus três percursos completos inicial/primeiro/segundo.
  A passagem completa anterior também cobre falha transitória e sucesso na segunda
  tentativa configurada; não se adicionou outra repetição bem-sucedida do grafo.
  HTTP real inclui refused connection, curl timeout original de 5s com prefixo
  HTML válido incompleto, Content-Length incompleto de HTML/JS, interrupção real,
  status/conteúdo/Origin/MIME/redirect ruins. Exaustão de duas tentativas nos três
  gates impede seed/snapshot/pg_restore/storage-clear callbacks, mesmo com API
  availability positiva. Callbacks destrutivos/Docker são doubles, não restores.
- O Bash coordenador real com smoke/guard/Docker **doubles declarados** recusa
  POST-smoke, conserva primary step/status e proteção/prova/manifesto. Se cleanup
  stop consegue, writers ficam parados; se cleanup stop falha, o teste registra
  writers ainda ativos, não uma contenção fictícia. Cron/worker continuam held,
  admission fechado e o exit primário do smoke não é substituído pelo do cleanup.
  Parser detalhado/contextos privados/malformed de smoke continuam no bloco 5.

### EBUSY: evidência antiga preservada e correção test-only

A primeira suíte deste bloco terminou em **88 PASS / uma falha / um skip**,
wall time **137,187s**. A falha foi o `rmdir` do fixture temporário
`fixture-full-smoke-IJgxaZ` após o teste de wrapper timeout de 500ms. Não havia PID
dos filhos no log. A inspeção read-only posterior encontrou o diretório/script
preservados e nenhum processo de teste correspondente vivo. **O holder histórico
não foi identificado**: não foi morto, reanexado, removido ou tratado como prova
de um orphan específico.

O gap confirmado no harness era aguardar apenas o Node driver/parent close, sem
ownership/teardown explícito de Bash/subshell/curl, embora o wrapper real usasse
`cwd=<release>` e o timeout pudesse terminar apenas o processo direto. O ajuste
autorizado ficou exclusivamente no harness de `smoke-origin.test.mjs`:

- **Windows:** supervisor nativo via APIs de Job Object embutidas no teste, sem
  helper/dependência instalada. Cria root suspenso, atribui ao job sem permissões
  de breakaway, confere membership e só então resume. O handle estável do job
  continua owning os descendentes após saída do root; não mata por nome/PID
  retrospectivo. Root wait é finito, cleanup usa eventos de conclusão e accounting
  zero com bound de 10s; ausência de prova falha e retém o fixture. Cancelamento
  do teste de signal atua somente no job owned e exige confirmação nativa.
- **POSIX:** sessão/grupo criado no spawn antes de forks. Driver mantém o líder
  vivo via IPC até o teardown controlled, evitando reutilização do PGID no ato
  de sinalizar. O sandbox exercita saída antecipada de um subroot com descendente
  ainda vivo no mesmo grupo e líder owned retido. Ausência de grupo após término
  é uma condição obrigatória, não espera arbitrária ou retry de `rm`. Esse ramo
  **não foi executado neste Windows** e necessita verificação Linux.
- A remoção da release ocorre **uma vez**, somente após ledger de ownership/
  terminação confirmado para todos os lançamentos. Não há retry de cleanup,
  sleep arbitrário, remoção do teste de timeout, mock de PASS ou skip Windows.
  A injeção de falha de reporting do cleanup ocorre depois da terminação nativa
  comprovada e mantém o resultado original `fixture_full_smoke_failed`/
  `command_timeout` e callbacks bloqueados; uma falha real sem prova não libera rm.

A primeira regressão nativa supôs indevidamente que o filho Node padrão sobreviveria
à saída do root e falhou com `activeBefore=0`. A versão sincronizada exige handshake
de root/descendente vivos e owned antes da liberação; mantém um ramo **real** de
saída antecipada com descendente sobrevivente, em vez de relaxar a asserção. Houve
também um erro de compilação C# confirmado pelo primary (`member` sombreado);
renomeados somente os locais para `rootMember`/`witnessMember`. Falha de compilação
ou frame nativo ausente agora conserva stderr do sandbox bounded para investigação,
sem adicionar parser de aplicação ou alterar diagnóstico de produção.

Na execução Windows final, ambos os handshakes passaram. O filho padrão apresentou
transição de saída entre consultas nativas (status pré-cleanup 0); não se usa isso
para atribuir a causa exclusiva da tentativa anterior. No ramo detached, root
exit=0 e descendente **STILL_ACTIVE=259 após essa saída**, ainda no mesmo job,
seguido de espera pelo handle do descendente e accounting **activeAfter=0**. Isso
comprova o caso de orphan risk e o teardown owned novo, não quem segurou o lock antigo.
O timeout real do wrapper permanece **500ms**; HTTP/curl/tentativas não mudaram.

### Checks finais do bloco 4

- Native ownership isolado: **um PASS, zero falhas/skips**.
- Suíte direcionada nos seis arquivos aprovados: **92 testes — 91 PASS, zero
  falhas/cancelados, um skip Linux root/FD9 existente**, exit 0.
- Wall time final: **208,162s**; Node **207,922s**, com orçamento externo de 600s.
  Log: `%LOCALAPPDATA%/Temp/opencode/cms-nginx-block4-owned-focused.log`.
- Timeout/signal, early root exit, ownership antes de descendants e remoção única
  passaram nativamente neste Windows. A suíte concluiu sem EBUSY ou retry de rm.
- `node --check` dos seis testes e `git diff --check`: **PASS**.

Bloco 5, full verify/security após sua conclusão, revisão independente e aceite
Linux/four-store permanecem pendentes. 14 checks/11 negativos, schema do qualifier,
legacy/1, worker held, pins/provas/lease intactos. Sem CI, commit/push, SSH,
Docker/serviço operacional, arquivos novos no repo ou delegação. Diffs anteriores,
demo/pycache untracked e evidência failed antiga preservados.

Status: **uncommitted/unpushed, ready-for-fresh-read-only-review**. This is not
native recovery acceptance, independent review, or production activation.

## Bloco 5 — atribuição finita implementada; full verify bloqueado no harness

Escopo de código/testes deste bloco: `scripts/smoke.sh`,
`scripts/integration/payload-preauthority-diagnostics.mjs`,
`scripts/integration/payload-preauthority-command.mjs`,
`tests/unit/payload-preauthority-diagnostics.test.mjs`,
`tests/unit/smoke-origin.test.mjs`, `tests/unit/payload-operations.test.mjs`, mais
este documento e `docs/operations/payload-runtime-recovery.md`.
`scripts/payload-operations.sh` não precisou mudar: os frames existentes já
delimitam a falha POST-restore, antes do cleanup, preservando o status primário.

Sem alterar chamadas HTTP, semântica/endpoints, flags curl, timeout, tentativas,
critérios ou output de sucesso, o smoke emite metadata apenas na falha final:
check de allowlist, reason `transport/http_status/readiness/content/redirect/module`
e HTTP status 100–599 ou `null`. Status não disponível na chamada original não é
adivinhado; não há request extra. Sidecars privados na tentativa atual conservam
os fatos reais através de command substitutions; nenhum corpo/URL/path/header ou
stderr arbitrário integra esses fatos, e erro de I/O diagnóstico não troca o
retorno da chamada. Critério e ordem de falha permanecem os do smoke existente.

O parser fechado exige um único JSON canônico terminado por newline, <=512 bytes,
exit 1 sem erro de processo/signal, contexto/substep explícitos e chaves/tipos
exatos. Rejeita duplicatas, valores desconhecidos, mensagem privada anexada,
status fora do intervalo e metadata fora do contexto. O POST-smoke exige também
um único step `restore_smoke`, frames de progresso conhecidos/bem formados e um
único failure frame com step/status consistentes no contexto real de restore.
Stderr de cleanup depois desse failure frame não sobrescreve a causa primária.
Sanitizer mantém `smokeFailure` opcional somente em falhas dos dois contextos
aprovados. Wrapper recusa `PASS`, JSON duplicado ou failure output com exit 0,
timeout/signal nunca autorizam metadata de falha completa. Sucesso do smoke e
schema/progress do relatório qualificado continuam inalterados; a regressão
de schema usa explicitamente dados sintéticos, não é evidência de recuperação.

Evidência:

- Bash syntax e `node --check` dos cinco arquivos JS/testes: **PASS**.
- Quatro arquivos focados: **78 testes / 77 PASS / zero falhas/cancelados / um skip
  Linux root/FD9 existente**, exit 0, wall time **248,709s** (Node 248,569s), orçamento
  externo 600s. `%LOCALAPPDATA%/Temp/opencode/cms-nginx-block5-focused.log`.
- Framing final duplicado/malformado: três arquivos focados, **37 testes / 36 PASS /
  zero falhas/cancelados / o mesmo skip**, exit 0, wall time **87,697s** (Node 87,449s).
  `%LOCALAPPDATA%/Temp/opencode/cms-nginx-block5-framing-focused.log`.
- `npm run security`: **PASS**, zero vulnerabilidades nos três pacotes.
- Checks finais: `npm run lint`, `npm run typecheck:cms`, `npm run security`,
  `node scripts/verify.mjs security`, `node scripts/verify.mjs dho`, `node --check`
  dos três testes e `git diff --check`: **PASS**, todos exit 0, wall time **36,069s**.
  Log: `%LOCALAPPDATA%/Temp/opencode/cms-nginx-block5-final-static-security.log`.
  Os checks separados não substituem o full verify interrompido.
- Full `npm run verify` tentou sintaxe/typecheck/testes. Sintaxe e CMS typecheck
  passaram; a suíte Node recebeu **SIGTERM** no timeout interno de **180s**, sem
  resumo de contagens. A chamada da ferramenta foi interrompida pelo restart do
  servidor; log final preservado, exit externo não recuperado. Não é full PASS:
  CMS unit tests e os gates seguintes não foram alcançados. Log:
  `%LOCALAPPDATA%/Temp/opencode/cms-nginx-block5-full-verify.log`.

O blocker foi comunicado antes de qualquer correção fora do plano. Não houve
aumento de timeout do verify, nova execução de CI, refactor de ownership,
kill por PID/nome ou remoção de fixture antiga. A inspeção read-only posterior
não encontrou processo correspondente vivo; não atribui holder histórico.
Full verify completo permanece pendente de decisão do primary sobre o orçamento
do harness. Testes HTTP reais e Windows Job Object nativo não comprovam POSIX,
Nginx/Docker/DB ou os dois restores; transport/coordinator doubles estão declarados.

Bloco 5 implementado, patch cumulativo ainda **uncommitted/unpushed** no mesmo HEAD,
com 14 checks/11 negativos, authority `legacy/1`, worker held, bindings de
identidade/lease e proofs/catalog intactos. Preservados diffs anteriores, demo e
`ops/__pycache__/` untracked e evidências/fixtures failed. Revisão independente
primary-owned e aceite Linux/four-store continuam pendentes. Sem delegação,
branch/commit/push/PR, SSH, Docker/produção ou deploy.

## Evidence and source diagnosis

Read-only GitHub inspection of run `37982456244`, commit
`0fa5818d2476bf61ae84faf3953d72c9574971e6`, confirms the existing root setup,
build/scan/publication gates passed, recovery failed, qualification and production
deploy were skipped. The downloaded report confirms all three fixtures passed
initial CMS health, writer restart and quiescent comparison. Its three initial
checks are true; coordinated adapter/four-store restore acceptance is not true.
Failure: `capture_actual_coordinated_backup`, `coordinator_backup_failed`, exit 1,
`coordinatorStep=resume_writers`, `controlErrorIdentifier=null`.

**Proven source defect:** coordinator `resume()` used `compose start` with service
names rather than identities observed before stop. It neither bound the start to
the original containers nor isolated the start from Compose dependency traversal.
`cms` depends on `cms-migrate: service_completed_successfully`; initializer runs
that one-shot with `--rm --no-deps`. Compose's public v2.40.3 implementation invokes
`InDependencyOrder`/`startService` in its start path:
<https://github.com/docker/compose/blob/v2.40.3/pkg/compose/start.go>.

**Historical cause still unproven:** the available report has no raw Docker
stderr. Missing `cms-migrate` is a concrete plausible explanation, not the
recovered exact error of this CI. The regression deliberately models that
dependency error if Compose start is invoked, rather than claiming a local
Docker reproduction. No Docker daemon/service/container was operated here.

The front-1 `payload-preauthority-writer-restart.mjs` was read as a reference,
not imported or edited. Its observe-before-stop / validate-all-before-start
principle is retained, with the host adapter's own inventory/state/lease boundary.

## Bounded implementation and compatibility

- `observe-writers` runs before close/stop and captures full IDs plus fingerprints
  of immutable image/config image, labels, creation, mounts and healthcheck for
  running API/cron/CMS and optionally running Nginx. Required API/cron/CMS must
  match the already signed migrated release; ambiguity or invalid states refuse.
- The existing host key signs a purpose-discriminated ticket. It binds release,
  inventory identity, an existing journal sequence/hash, root coordinator PID and
  start ticks, and the exact inherited fd9 device/inode. The coordinator PID must
  be a live root ancestor whose fd9 references the protected lock. The runtime's
  normal constructor still validates its own inventory/root/lease/state first.
- Ticket is kept only in coordinator shell memory. **No new state schema, journal
  field, raw-trust sidecar, durable resume file or operator state setter.** Both
  v1/v2 signed journals remain strict and use the existing full replay validation.
  Snapshot origin is reread as a private 0600 signed journal entry and its hash
  uses the existing canonical-envelope convention (without the file newline).
- Resume requires closed admission, migrated floor, no pending install/restore,
  unchanged signed release/catalog/terminal audit, and a new signed backup proof
  since observation. Another coordinator process/lease cannot replay the ticket.
  An interrupted process is **not automatically resumable**: reconciliation stays
  a separate operation. `LEAVE_STOPPED` does not persist a resume authorization.
- Under the same outer fd9, validate the entire captured set before the first
  start: exact current ID/fingerprint, project/service/non-oneoff labels, legal
  exited/running status and Running/Paused/Restarting flags; worker must remain
  stopped. Replacement, missing, duplicate, foreign image/mount/label or active
  uncaptured writer refuses before a start. No lookup-by-name adoption.
- Start only captured full IDs via `docker start`; no Compose start/up, pull,
  recreate, delete or automatic dependency migration. Re-inspect exact identities
  and health afterward (API/cron/CMS require healthy; Nginx may have no healthcheck).
  Starting health gets up to 180 observations with one-second sleeps per writer;
  bad states/health/transport refuse. Existing outer timeouts remain unchanged.
- Backup resume does not mutate journal or admission. Existing verify-release and
  open-admission remain separate mandatory gates. Failure leaves admission closed
  and retained capture/proof; a partially successful start is not called recovery.
- Restore readiness also uses the ticket, not the previous `compose up`. It starts
  only original API/CMS/Nginx, leaving cron for final resume after smoke. An
  original Nginx absent/stopped is not created/adopted; if smoke needs it, the
  operation fails closed and requires explicit setup/reconciliation. No new
  fixture/harness behavior was invented to satisfy that case.
- Tool failures map to fixed reasons such as `writer_start_command_failed` or
  `writer_inspect_command_failed`. A bounded 16 KiB stderr tail stays in an
  exclusive private 0600 `payload-writer-command-<random>.stderr` file. Retention
  errors do not replace the primary failure; raw tool stderr is not echoed into
  the coordinator wire. The parser recognizes these exact guard steps/reasons;
  appended/unknown tool or cleanup output stays private/unclassified.

Report schema, 14 checks, 11 negatives, comparators, probe, seeds, initializer
audit/receipts, authority legacy/1, worker policy and productive ownership are
unchanged. Receiver/outer qualification gate remain unactivated. No front-1 owned
helper, workflow, production deploy script or state schema file was changed.

## Executable regression coverage

1. Actual Bash coordinator/backup/restore scripts with declared Docker/guard
   doubles: Compose start would fail on a missing one-shot dependency; corrected
   flow uses full raw start IDs. Seven-entry manifest/proof remains; readiness
   precedes smoke, cron resumes afterward, verify/open order is retained.
2. Actual Python runtime observe/resume plus real signed journal/HMAC/replay for
   v1 and v2, with explicit process/lease/Docker metadata doubles. Signature/process
   replay, identity/image/label/mount/state drift and missing service refuse before
   any start. Readiness excludes cron; final resume starts only cron; successful
   resume changes no journal bytes/state. Start/health failure stays closed and
   unknown tool stderr is retained privately.
3. Actual initializer → terminal → normal backup metadata → writer resume → normal
   verify/open instrumented path: immutable binding, receipts and floor audit
   remain exactly equal; resume itself advances no signed state. This is not
   Docker/DB restore evidence.
4. Actual coordinator capture failure at resume retains proof, admission closed,
   exact primary step/reason and no verify/open. Unknown output remains unclassified.
   Existing destructive cleanup-failure regression still preserves primary status.

An initial focused run caught a hash-convention mismatch in the new ticket check:
file bytes include a newline, whereas existing journal parent hashes use canonical
envelope bytes. The check now uses the existing convention; no signature/hash
gate was relaxed, and v1/v2 action-flow regressions passed after correction.

## Verification before the P2 follow-up and remaining gates

- Focused: **85 tests, 80 PASS / 5 skips / zero failures**.
- `npm run verify`: **PASS**, Portal **1,726 PASS / 12 skips**; CMS
  **448 PASS / 11 skips**; zero failures and `verify: ok`.
- `npm run security`: **zero vulnerabilities** API/cron/CMS.
- `git diff --check`: **PASS**, including repetition after documentation.
- Logs: `coordinator-resume-focused.log`, `coordinator-resume-verify.log` in the
  approved OpenCode temp directory. Skips are the existing unavailable Windows
  native ownership/root/lease branches, not skipped new transport/state tests.

Fresh independent read-only review is **required and pending**. No delegation
was made because this session is explicitly prohibited from delegating. Local
read-only self-inspection is not mislabeled as independent review. Native Linux
process ancestry/fd9 and Docker identity/health/start behavior of this patch,
backup positive completion, restore/smoke with the same pre-stop objects, all
negative cases and repeated restore acceptance remain separate authorized gates.
There was no new CI, commit/push, SSH, production action or service/DB mutation.
Pre-existing untracked files were preserved.

## Fresh reviewer P2 — parent observation step fixed

Fresh review identified a diagnostic defect in the observation call: `guard`
executed `step guard_observe_writers` inside command substitution, so only the
subshell's variable changed. On observation failure, the parent's EXIT still
emitted `writers_inventory_before`, inconsistent with the last progress frame.
The real extractor correctly refused that inconsistent transcript, losing an
otherwise recognized finite reason.

This follow-up changes only `scripts/payload-operations.sh`, its existing Bash
regression suite, and this record. Observation now sets `guard_observe_writers`
in the **parent**, then directly invokes the same guard with the same three
arguments inside command substitution. Only ticket stdout is captured; progress
is emitted once, outside the substitution. No parser relaxation, ticket binding,
runtime/state/lease or gate change was made.

The new **actual Bash coordinator** regression first failed against the previous
code with `writers_inventory_before` versus `guard_observe_writers`, confirming
the review finding. After correction, all four scenarios passed: exact
`writer_coordinator_scope_invalid`, exact `writer_inspect_command_failed`, opaque
stderr, and a known reason with appended private detail. It checks the real
STEP/EXIT match, single observation marker/primary failure frame, exact exit 2,
the real extractor's recognized reason or null, and no private detail in the
redacted diagnostic. No close/stop/start/capture occurs: admission and running
inventory remain unchanged, backup/protection directories empty, and only
preflight/observe guard calls execute. Docker/guard are declared doubles; this
is shell control-flow evidence, not native runtime/Docker acceptance.

The existing successful backup/restore shell regressions now also require the
resume guard to receive exactly the synthetic ticket stdout, with no progress
marker contamination. Existing resume-failure and private-output coverage remain.

Final checks after this P2 correction:

- Focused: **86 tests — 81 PASS / 5 skips / zero failures**.
- `npm run verify`: **PASS** — Portal **1,727 PASS / 12 skips**, CMS
  **448 PASS / 11 skips**, zero failures; `verify: ok`.
- `npm run security`: **zero vulnerabilities** API/cron/CMS.
- `git diff --check`: **PASS**, including repetition after this record.
- Logs: `coordinator-observation-p2-focused.log` and
  `coordinator-observation-p2-verify.log` in the approved OpenCode temp directory.

**Ready for another fresh read-only review**, not an assertion of reviewer
acceptance. 14 checks/11 negatives and all ticket/safety bindings remain intact.
No CI, commit/push, SSH, service/DB operation or delegation was performed; native
acceptance and production activation remain outside this local correction.
