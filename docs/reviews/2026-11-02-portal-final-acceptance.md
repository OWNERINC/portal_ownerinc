# Portal — evidência de conclusão em andamento (2026-11-02)

## Estado e escopo

Execução da cadeia OWN-23 → OWN-32 → OWN-33 → OWN-28 → OWN-35 → OWN-24 →
OWN-25 → OWN-26 → OWN-31 → OWN-34. Este registro não é aceite de produção.
As correções estão na branch `fix/portal-final-acceptance`, ainda sem candidato
final qualificado para os novos bytes. Planejamento, decisões e implementação
delegados a Astra xhigh por solicitação do usuário.

O candidato histórico `a7b7f35792ca5c7b3f5db82094f406b56912ba70` permanece
evidência histórica. Mudanças no PDF, workflow e preparação exigem nova
qualificação e bindings correspondentes antes de uso operacional.

## Verificações executadas antes da conclusão da barreira B0

| Verificação | Resultado observado | Limite da evidência |
|---|---|---|
| PDF e suites relacionadas | 159 aprovados, zero falhas/skips | HTTP multipart real; persistência e identidade dobradas |
| CI/preparação/operações focados | 94 aprovados, seis skips | Skips nativos não provam Linux/root |
| `npm run verify` | 2.092 aprovados, duas falhas, 32 skips na suíte raiz | Duas falhas por timeout Bash no Windows; execução integral não aprovada |
| Repetição isolada `payload-operations.test.mjs` | 20 aprovados, zero falhas/skips, 124,1 s | Timeout anterior não reproduzido; não substitui novo verify integral |
| `npm run test:cms` | 477 aprovados, zero falhas, 11 skips | PGlite opcional e capacidades Linux indisponíveis nesta execução Windows |
| `npm run typecheck:cms` | PASS | Offline; não valida runtime produtivo |
| `CMS_BUILD_ONLY=true npm --prefix cms run build` | PASS | Build com entradas sintéticas, sem inicialização produtiva |
| `npm run security` | PASS no threshold high | API: um advisory moderado qs; cron: zero; CMS: oito baixos na cadeia deepmerge/Payload |

O build reportou warning de tracing de filesystem dinâmico em
`cms/src/migration/staging.ts:125`. Compilação, TypeScript e geração das páginas
concluíram. O warning não é evidência de exposição de conteúdo ou falha de runtime.

Esses resultados precedem a conclusão da barreira B0. A barreira requer testes
próprios, revisão fresca e qualificação nativa positiva capture/accept/resume.

### Segunda execução integral e revisão da barreira

A segunda execução de `npm run verify`, com o pacote B0 em revisão, terminou na
suíte raiz com **2.099 PASS, quatro FAIL, 33 SKIP**. Duas falhas detectaram novos
erros B0 ausentes nas allowlists finitas de diagnóstico; outra detectou um
extrator de teste ainda preso à assinatura anterior do initializer. A quarta
foi o timeout de 15 segundos do subprocesso Bash do fixture de operações no
Windows. Nenhuma dessas falhas foi ignorada: correções delimitadas estão em
andamento, preservando as invariantes e os limites produtivos.

A revisão independente Astra xhigh retornou **fix-first** por dois findings
High: correspondência incompleta entre inputs de retomada e receipt protegido;
reparo de head interrompido antes da conferência da identidade assinada do
lease. Ambos foram confirmados por leitura primária e encaminhados para
correção/testes adversariais. Esse pacote permanece sem aprovação de revisão e
sem qualificação Linux/root até nova evidência.

A revisão de retorno encerrou os dois findings com veredito **ship** para o
pacote B0 delimitado: `payload-resume-v3` vincula os 19 campos ao registro
autenticado antes de reparar/publicar, e o callback de reparo compara o lease
assinado com FD9 e pathname. O revisor inspecionou o source, mas não pôde executar
shell; os **120 PASS / 11 platform skips** são do implementador. A qualificação
Linux/root e o verify integrado continuam necessários. O CMS editorial segue em
implementação separada e não foi abrangido por essa revisão.

As três regressões de diagnóstico/extração foram corrigidas e repetidas pelo
primário: **29 PASS, zero FAIL, zero SKIP** nas três suites afetadas, incluindo
negações de códigos desconhecidos, contexto/action/frame inválidos e preservação
da ordem B0/grants/provisioning. O check Compose envolvido usa somente parser
CLI, sem contatar/iniciar serviços. O fixture Bash recebeu orçamento externo de
45 s somente no Windows (Linux continua 15 s); o implementador repetiu seus
20 testes com zero falhas/skips, e o primário conferiu o diff. Limites operacionais
produtivos não foram alterados. O próximo verify integral ainda é necessário.

### Pacote B0 estabilizado — verify integral aprovado

O snapshot delimitado B0/PDF/qs/diagnósticos foi verificado em checkout temporário
separado, com os mesmos locks e diretórios de dependências instaladas. O source
editorial, a recuperação pré-floor e os demais pacotes em implementação não
integram esse snapshot. Árvore Git verificada:
`21215e73000780d7603e62d16f35cabd505e3ce8`.

Após fixar a fixture histórica do receiver nos bytes de SHA-256
`7a5da50bbb36a6d0f95c66898e0c4e12bc0ba319fd7dd8d4ccbd4aac8c3ea2db`, sem mudar
o hash autorizado pelo instalador, `npm run verify` terminou com **PASS**:

- Suíte raiz: **2.109 PASS, zero FAIL, 33 SKIP**.
- CMS offline: **477 PASS, zero FAIL, 11 SKIP**.
- Sintaxe, typecheck CMS, scanner de segredos, nomenclatura e validação Compose:
  concluídos; nenhum serviço Docker foi iniciado.
- Nova negação confirma que o receiver atual com o path histórico não é um
  predecessor aprovado.

A revisão B0 permanece `ship`. Os skips Linux/root e PGlite são limitações
declaradas; CI nativo ainda é obrigatório. Esse PASS não se estende aos arquivos
concorrentes nem estabelece instalação ou restore produtivos.

O pacote foi publicado como commit `4ec9e06`,
[PR #82](https://github.com/OWNERINC/portal_ownerinc/pull/82). Qualificações CI
iniciadas: B0 administrativo `41535912423`, rotação de policy `41535912000` e
validação geral `41535912007`.

- Validação geral `41535912007`: **PASS**, incluindo Nginx/Chromium, build CMS,
  PostgreSQL/migrations/Owner News/Academy, builds, scans, audit e SBOMs. Deploy,
  publicação de imagens/candidato e runtime manual não executados nesse evento.
- Rotação Linux/root `41535912000`: **PASS**.
- B0 administrativo `41535912423`: **130 PASS / 1 FAIL / zero SKIP**. A nova
  jornada administrativa B0 passou; a fixture histórica de receipt não relocava
  `LOCK_ROOT`, e falhou procurando o path produtivo. O gate completo permanece
  reprovado até a repetição verde.

A correção delimitada da fixture reloca incoming, nonces e locks para o mesmo
diretório privado descartável, usa validade relativa ao relógio real e conserva
os guards de ownership, ancestry, flock e fsync. Cobre receipt positivo, replay,
preflight incompleto, troca de inode com bytes idênticos e ancestry insegura.
Somente os dois subprocessos privilegiados são doubles. Na execução Windows:
**14 PASS / zero FAIL / três SKIP**; o corpo Python nativo foi compilado, não
executado. A correção recebeu revisão independente **ship**.

Essa repetição terminou com **2.108 PASS / um FAIL / 33 SKIP** na raiz. A falha
foi no subprocesso Bash do teste `authenticated preparer uses fixed context
protocol...`, em `cms-infrastructure-preparation.test.mjs:335`: status `null`,
após cerca de 74 segundos para o caso que inclui subprocesso com limite de 60 s.
É compatível com timeout, mas o assert não registrou `error`/`signal` do processo.
Esse teste não foi alterado pela correção de receipt. Sua repetição isolada passou
em **84,6 s**. Isso não transforma a repetição integral em PASS; o CMS dessa
repetição não foi alcançado.

A correção foi publicada isoladamente em
`86b61eab5784b411b7993f089aaa3c2db53e6df5`, preservando byte a byte o diff
editorial/catálogo previamente staged. Resultados desse commit:

- [B0 Linux/root `41541000716`](https://github.com/OWNERINC/portal_ownerinc/actions/runs/41541000716):
  **PASS**, incluindo a fixture nativa de receipt/nonce/ancestry corrigida.
- [Rotação Linux/root `41541000703`](https://github.com/OWNERINC/portal_ownerinc/actions/runs/41541000703):
  **PASS**.
- [Validação geral `41541000655`](https://github.com/OWNERINC/portal_ownerinc/actions/runs/41541000655):
  **PASS** no mesmo commit, com verify, Nginx/Chromium, build CMS, migrations e
  integração PostgreSQL, builds/scans/audit/SBOMs. Publicação e deploy foram
  explicitamente skipped; manual-runtime também não foi executado nesse run.

Esses gates exercitam a cadeia administrativa em fixtures descartáveis. Docker,
PostgreSQL e readiness dobrados nessa suíte não demonstram instalação privada ou
restore produtivo. Nenhuma rotação administrativa foi aplicada.

### Pacote editorial e extração do catálogo — em revisão

O perfil editorial frio foi entregue pelo implementador com **496 PASS / 11
SKIP / zero FAIL** no CMS, **106 PASS / zero FAIL** em API/runners delimitados,
typecheck e build-only aprovados. A extração dos leitores/comparadores de catálogo
reportou **196 PASS / zero FAIL / zero SKIP** focados e preservação dos 54 exports
do finalizer. São resultados dos implementadores, não qualificação nativa.

Foi criado um segundo snapshot estável, árvore
`01958ca8e49de2ecd7f677cfe60cbfa83c7bb2b5`, com os 52 arquivos editoriais e quatro
arquivos de extração/plano. A revisão fresca editorial e a revisão da extração
são independentes. O verify integral desse snapshot terminou **PASS**: **2.116
PASS / zero FAIL / 33 SKIP** na raiz e **523 PASS / zero FAIL / 11 SKIP** no CMS,
além de sintaxe, typecheck, scanner e Compose. A extração recebeu revisão **ship**,
limitada aos leitores/comparadores e wrappers preservados.

A revisão editorial retornou **fix-first**: dois P1 (headers/cookie perdidos ao
abrir uma transação a partir de Web Request e controles draft/autosave ambíguos
descartados pelo parser nativo) e dois P2 (cache privado sobrescrito pela boundary
REST e restauração habilitada na UI sob lock estrangeiro). A primeira correção
reportou **45 PASS** focados e **528 PASS / 11 SKIP** no CMS, sem falhas. O snapshot
estável de 63 arquivos, árvore `f3e337d07c85e50f7a4daf9a23575f56fe2e3a31`, passou
no verify integral: **2.172 PASS / 33 SKIP** na raiz e **528 PASS / 11 SKIP** no
CMS, zero falhas, incluindo sintaxe, typecheck, scanner e Compose. O snapshot
exclui o novo verificador de catálogo ainda em andamento e precede as duas
correções adicionais de parsing abaixo.

A revisão de retorno confirmou headers/contexto, cache privado e lock read-only,
mas manteve **fix-first** por dois P1: aliases root-bracket como `[draft]` escapam
da validação raw, e slugs percent-encoded divergem do path canônico resolvido pelo
adapter Next. Ambos podem perder draft intent antes da seleção de publicação.
As correções foram entregues e receberam revisão de retorno **ship**. O adapter
usa o mesmo path canônico do Payload Next 3.90.2; hooks de operações News conhecidas
validam os controles raw independentemente de pathname/método. As regressões
incluem 519 casos negativos offline e 60 controles positivos; a fonte da suíte
nativa contém 204 requests negativos, ainda não executados em CI.

O verificador completo de catálogo runtime também foi entregue, em cinco arquivos
unstaged separados da extração aprovada. Sua revisão retornou **fix-first** por um
P1: ACLs efetivas de tabelas/colunas/sequences de `cms_control` e `cms_controller`
não eram observadas pelo novo runtime, embora já verificadas pelo finalizer.
Isso poderia aceitar tanto INSERT ausente no ledger quanto UPDATE direto indevido
no head. A extração/reutilização desses checks SELECT-only foi autorizada, com
regressões para direitos ausentes e excedentes sem elevar o runtime. O revisor
executou independentemente 106 testes de catálogo, todos PASS; a lacuna não era
exercitada por esses testes. O primário
repetiu conjuntamente 11 suítes editoriais/catálogo/finalizer/observer/preauthority:
**331 PASS / zero FAIL / zero SKIP**. São testes offline com doubles explícitos;
não comprovam a execução SQL sob os privilégios do PostgreSQL nativo.

A correção de ACL foi entregue e recebeu revisão de retorno **ship**: runtime e finalizer
compartilham comparadores SELECT-only com inventário completo, privilégios nulos
no native-absent e direitos estreitos no V2. O primário repetiu sete suítes com
cache TSX desativado: **318 PASS / zero FAIL / zero SKIP**, incluindo as duas
regressões P1. O implementador reportou 324 PASS em sua seleção de suítes. Essa
extensão permanece fora do pacote editorial/monitor congelado abaixo.

O slice de configuração/readiness foi entregue em 27 arquivos, ainda sob revisão:
lifecycle explícito e imutável, endpoint native-absent sem probe de storage,
readiness strict com catálogo completo e probe durável, e CLI de saúde com destino
loopback fixo e deadline de 4,5 s. O implementador reportou **112 PASS / dois skips
Windows / zero FAIL**, mais 14 PASS após sua última correção. Integração de Compose,
host, runners e qualificação nativa continuam pendentes. O primário propagou a
seleção explícita no runner manual: migrations native/held, runtime qualified;
seus sete testes offline passaram. O primário também repetiu environment,
readiness, lifecycle, health-response e health-CLI: **46 PASS / zero FAIL / zero
SKIP**. A fixture Nginx ampliada recebeu revisão **ship**, com 51 probes privados
por estado inactive/promoted/unavailable. Repetição primária em Windows:
**um PASS / dois skips Linux / zero FAIL**; sua execução nativa será feita em CI.

A revisão do lifecycle retornou **fix-first**: probe de storage sem deadline no
servidor, logs do driver antes do catch sanitizado e fingerprint sem
`flattenedFields`/`sanitizedIndexes`. As correções estão com o implementador;
os passes anteriores não encerram esses findings. A propagação de perfis nas seis
fixtures recebeu **ship**. O delta posterior do primário seleciona o endpoint e
proxy de saúde por fase, com **77 PASS / zero FAIL / zero SKIP**, e recebeu **ship**.
Essa fixture observa listener/TLS/status; não qualifica os headers de descriptor.

As três correções lifecycle foram entregues em 11 arquivos: deadline storage de
2 s com single-flight e cleanup por identidade, logger finito antes do cold-start
e binding das entradas sanitizadas realmente consumidas pelo adapter. O primário
repetiu seis suítes com concorrência limitada: **63 PASS / zero FAIL / zero SKIP**,
incluindo inicialização Payload/PG com somente o transporte dobrado. A revisão
de retorno está em andamento; esse delta não pertence ao snapshot de CI abaixo.
A revisão fechou storage/logging, mas encontrou um novo P2 no initializer: ele
validava a config capturada, não a config real de `args.payload`. O primário
adicionou a verificação de identidade antes do adapter e regressão pelo SDK real
com config clonada e schema alterado. Repetição: **24 PASS / zero FAIL / zero SKIP**;
revisão de retorno pendente. O wiring Compose/preview recebeu **ship** após corrigir
duas assertions antigas de healthcheck; o primário repetiu cinco suítes:
**78 PASS / zero FAIL / zero SKIP**.

O CAS de coverage foi entregue em três arquivos, sem empacotamento ou admissão
produtiva. O primário repetiu suas suítes e runtime-catalog: **218 PASS / zero FAIL /
zero SKIP**. A revisão independente retornou **ship**; execução PostgreSQL pendente.
Sua resposta mantém `ready:false`, `writeCoverageCertified:false` e
`releaseCertified:false`; coverage 1 sem receipt autenticado é `coverage_in_doubt`.
A fonte nativa de catálogo, em dois arquivos, também recebeu **ship** e repetição
primária **19 PASS / zero FAIL / zero SKIP**. Wiring no runner e execução PG16
continuam pendentes. A extensão posterior de cancelamento do catálogo está em
implementação separada; não herda automaticamente esses veredictos.

A suíte de navegador editorial implementa quatro cenários e mantém o resultado
global `INCOMPLETE`/2 quando os demais continuam pendentes. CI próprio de navegador
está conectado com validação estrita dos quatro cenários, 44 demais `INCOMPLETE`,
`acceptanceComplete:false` e `productionValidated:false`. O primário integrou o
campo persistido `editorialPhaseComplete` e o finalizer na allowlist da imagem;
**77 testes focados PASS**. A correção de orçamento global recebeu revisão **ship**:
deadline derivado de `run_started_at` do run/attempt autenticado, mais 35 minutos;
reserva mínima de 15 minutos antes da execução (8 execução, 6 cleanup, 1 margem).
O primário repetiu quatro suítes: **81 PASS / zero FAIL / zero SKIP**.
O runtime nativo foi disparado com `manual_runtime_only` para `88c18eb`, run
`41546883545`, e falhou em `protocol-finalizer`. O log expõe somente
`manual_runtime_process_failed`, sem artifacts exportados; diagnóstico finito mais
amplo está em preparação, e a causa do finalizer ainda não foi identificada.
O browser `41546885302` falhou no build do emulador: o contexto não contém
`.firebaserc`. API e CMS foram construídos nessa execução, mas a jornada não
começou. A correção do contexto está em andamento. Nenhuma jornada nativa/browser
foi declarada PASS.

A correção do build usa o contexto raiz existente no Compose e acrescenta
`firebase.json`/`.firebaserc` aos paths do workflow. Repetição primária:
**60 PASS / zero FAIL / zero SKIP**. Revisão fresca **ship**; publicação pendente.
SMTP, contexto do emulador e este relatório foram congelados em seis arquivos,
árvore `6a54e27d7657cfe679fe010f1e4d7975dcd7b38f`, para novo verify integral isolado.
O manifesto `.openchamber/reviews/ci-fixture-fixes.json` identifica o checkout;
as demais extensões permanecem fora dessa árvore.
Esse verify passou: **2.222 PASS / 35 SKIP raiz e 533 PASS / 11 SKIP CMS, zero
falhas**, incluindo sintaxe, typecheck, scanner e Compose. A árvore exata foi
commitada e pushada como `c80825fa3086d08a538f3b2b87611ec30d55ce8a`.

O diagnóstico do finalizer foi ampliado em um delta independente: enums finitos de
phase/reason, SQLSTATE estrito, prioridade preservada do diagnóstico canônico,
parser de linhas completas TAP e remoção do erro original da saída da fixture.
Revisão **ship**, primário **30 PASS / zero FAIL / zero SKIP**. Somente os cinco
hunks de diagnóstico do runner acompanham esse pacote; seletores lifecycle seguem
em integração separada. A causa da falha PostgreSQL permanece desconhecida até
nova execução CI com esse diagnóstico.

Recuperação pré-floor e monitoramento OWN-34 seguem em implementação, fora desse
snapshot. Lifecycle completo, ativação vazia e recuperação active/frozen ainda
exigem integração e qualificação. A janela absoluta do Gate E de até 60 minutos
permanece distinta da janela de início de migrations B0; planejamento posterior
não autoriza prolongar o cutover apenas porque uma operação começou.

### Recuperação pré-floor e monitoramento — checkpoints sob revisão

O executor pré-floor foi entregue como checkpoint **NOT SHIP**. O implementador
reportou **93 PASS / zero FAIL / nove skips nativos** nas cinco suítes focadas e
**10 PASS / zero FAIL / dois skips Linux** na fixture ampliada, além de sintaxe
Python e diff check. A revisão independente do código retornou **fix-first**:
dois P1 (consumidores estrangeiros via bind mount/namespace não detectados e
publications ausentes da classificação pré-restore) e um P2 (token Firebase
expirado sem refresh autenticado para retomada). O primário conferiu os caminhos
e autorizou as correções delimitadas com regressões antes de efeitos destrutivos.
A implementação da qualificação continua para cobrir
a cadeia ADMIN completa em processos/leases frescos, imagens reais da aplicação
anterior e transporte OpenSSH forced-command do witness. A execução PostgreSQL e
storage nativa permanece exclusiva ao CI e ainda não foi realizada. O executor
destrutivo produtivo exige aprovação autenticada específica do incidente.

As três correções pré-floor foram entregues, com qualificação CI ADMIN/PG16,
imagens históricas e OpenSSH. O implementador reportou **81 PASS / dez skips
nativos / zero FAIL** em Node e **13 PASS / dois skips Linux / zero FAIL** em
Python. A revisão fresca retornou **fix-first**: histórico de uso nativo não
comprovado por sequences em conteúdo UUID, aliases reais de bind mounts do host
fora da comparação de paths e ausência de orçamento agregado com reserva de
cleanup no workflow. As correções estão em andamento; estados sem prova confiável
de ausência de uso devem ser recusados. Essa fonte ainda não executou em CI.
Os planos de ativação e recuperação active/frozen foram emendados para admissão
boot-bound, revogação preservadora de sessões, separação entre autorização B e
efeito A e terceiro lifecycle operacional. Permanecem **PROPOSED**, com todos os
steps desmarcados, aguardando crítica independente e autorização de implementação.
Na crítica de retorno, revogação de sessões, separação B/A e preparação privilegiada
foram aceitas no nível de desenho; admissão/release recebeu **rethink**. Restam
HIGHs por COMMIT efetivado após o deadline absoluto, avanço direto de sequences e
exclusão física anterior ao COMMIT sem prova de órfão válida na execução. O autor
reavalia os mecanismos; o prazo não foi relaxado e a implementação desse incremento
continua sem autorização.

O núcleo do monitoramento foi entregue com collector, units, runner não
privilegiado, incident/outbox durável, SMTP e observação API. Testes focados do
implementador: **102 PASS / zero FAIL / quatro skips Linux**. Foi congelado um
snapshot independente dos 29 arquivos, árvore
`4d02428606010c950e782ad9a000d6ce687130f1`, para revisão fresca e verify integral.
O verify terminou com **2.121 PASS / 17 FAIL / 35 SKIP** na raiz: 16 falhas no
harness que ainda não carregava `createOperationalRouter`, e uma no reconhecimento
da autenticação dedicada pelo teste de boundaries. A correção de três arquivos
de teste usa o router real e exercita a autenticação antes das dependências;
o primário repetiu **21 testes, todos PASS, zero skips**. Esse ajuste do harness
recebeu revisão independente **ship**.

A revisão do núcleo também retornou **fix-first**: incidente e recuperação podem
desaparecer durante outbox pendente; relógio anterior à leitura pode classificar
backup concorrente como inválido; reason em array passa por coerção; alternância
de motivos ruins pode impedir o limiar de incidente. As quatro correções foram
entregues: FIFO durável com overflow explícito, relógio pós-leitura, reason
primitiva e contagem contínua de amostras ruins independente da assinatura.
O primário repetiu sete suites: **109 PASS / quatro skips Linux / zero FAIL**.
O snapshot corrigido de 32 arquivos, árvore
`e8164cca003d29535d34f4c66d110262cf2061cb`, recebeu revisão de retorno **ship**.
O verify integral terminou **2.145 PASS / um FAIL / 35 SKIP** na raiz. As 17
falhas anteriores de integração foram resolvidas; o subprocesso Bash do preparer
retornou `status=null` na etapa apply, compatível com seu timeout de 60 segundos.
A repetição isolada passou em **35,6 s**. Isso não converte o verify integral em
PASS; o CMS não foi alcançado nessa repetição.

O wiring opcional foi entregue separadamente em quatro arquivos: token vazio por
default, exclusivo ao ambiente da API, e documentação do provisionamento protegido
do runner systemd. Revisão **ship**; primário repetiu **25 PASS / zero FAIL / zero
SKIP**. O implementador também validou Compose base/overlays, sintaxe e LF. Ainda
não houve instalação ou ativação no host.

O primeiro snapshot integrado dos 101 arquivos revisados, árvore
`b3e7590c567a3258640c3db9614aec596709a04a`, terminou com **2.205 PASS / nove FAIL /
35 SKIP** na raiz. As nove falhas pertencem ao preparador de preview: sua
allowlist de interpolação ainda não incluía o novo token opcional do Compose.
A correção delimitada inclui o nome exato na allowlist e mantém o token vazio no
ambiente gerado, com limpeza da variável herdada nos launchers. O preparer Bash
que havia atingido timeout passou nessa execução; o CMS não foi alcançado por
causa das nove falhas. A correção dos quatro arquivos de preview recebeu revisão
independente **ship**; o primário repetiu preparation, HTTPS e operations:
**53 PASS / zero FAIL / zero SKIP**, incluindo limpeza POSIX/PowerShell e Compose
config read-only.
O novo snapshot isolado de 105 arquivos, árvore
`db151d5715bc73753e0e2d261dd23b34a60c888a`, passou no verify integral:
**2.214 PASS / 35 SKIP raiz e 533 PASS / 11 SKIP CMS, zero falhas**, incluindo
sintaxe, typecheck, scanner e Compose. Foi commitado e pushado como
`88c18eb64402534e37781578fc504615458b8dfa`, com árvore idêntica à verificada.
PR #82 atualizada; extensões lifecycle/runtime/ops continuam em integração.

CI do SHA `88c18eb`: B0 `41546885268` e rotação `41546885199` **PASS**; geral
`41546885237` ainda em andamento neste checkpoint. SMTP `41546885341` falhou
porque a fixture pressupunha Message-ID em uma linha, enquanto Nodemailer emite
um header RFC dobrado. A correção test-only de três arquivos recebeu **ship** e
repetição primária **12 PASS / zero FAIL / zero SKIP**, incluindo o composer real
em stream transport sem sockets. Publicação da correção e repetição nativa pendem.

A bridge privada CMS foi entregue e revisada **fix-first** por alias `/globals`
antes do dispatcher, ausência da validação do adapter real e ocultação de drift
quando uma leitura local falha. Registros na config/rota ainda pendem. O orçamento
da resposta não comprova cessação de I/O nativo do catálogo dentro do agregado.
As três correções foram entregues com **50 PASS** reportados pelo implementador,
em revisão fresca. A extensão separada de cancelamento do catálogo recebeu
**272 PASS** reportados pelo implementador e também está sob revisão; a bridge
ainda não a utiliza.
A integração de observação CMS, adapters de lifecycle/recovery/rota, instalação,
SMTP nativo e entrega/ownership reais continuam pendentes. `contract_missing` e
`unsupported_contract` não são convertidos em saúde ou aceite operacional.

### Remediação posterior de qs

O lock da API foi atualizado de `qs@6.16.0` para `6.16.2`, mantendo o manifest e
as demais entradas do lock. A revisão primária confirmou o diff de três campos
e repetiu os testes de dependências API e do advisory: **19 PASS, zero FAIL,
zero SKIP**. O implementador registrou RED/GREEN das quatro regressões e audit
de produção da API com zero findings. Detalhes, fontes e distinção dos advisories
opcionais estão em [Dependências](2026-11-02-dependency-advisories.md).

A fonte oficial CVE foi consultada também pelo primário e confirma
`CVE-2026-93753` como `REJECTED`. O feed residual npm/GitHub continua documentado;
não houve downgrade, override ou supressão do Payload.

### SBOMs locais

`npm run sbom` concluiu após a atualização do lock. Os três documentos foram
abertos e validados como JSON SPDX-2.3; API contém `qs@6.16.2`.

| Documento local | Pacotes | SHA-256 dos bytes gerados |
|---|---:|---|
| `api.spdx.json` | 316 | `a52d5ab3713b268af28a4ac48ef0a56d2bfc680bb5fdbe708c624e2c37b41941` |
| `cron.spdx.json` | 18 | `465d266b88ed7128f2c95e9da65346e63ececa725d38137aa0365c0ee0423020` |
| `cms.spdx.json` | 443 | `74319d6b223713ec1f52f53981c5b993d45beec7b173273112743f44cd9e5050` |

São inventários locais dos locks, não SBOMs das futuras imagens qualificadas.
IDs, digests e scans das imagens do candidato final continuam pendentes.

## Baseline produtivo observado por leitura

Observação do host em `2026-11-02T21:18:24Z`:

- Release apontada: `b573a3d900c823a700c167878717bb7534bef500`.
- Policy SHA-256: `bfd564a5e8c3e99badacdafe47a85daee4aa07b6ca3f576031915821e2216aa0`.
- Registry de candidatos: zero registros; launcher autenticado ainda ausente.
- Receiver legado `/usr/local/libexec/ownerinc-portal-deploy` presente, regular,
  root-owned `0755`. Wrapper produtivo Payload, receiver/helper novo, launcher,
  guard Gate E e fragmento sudo Payload ainda ausentes nos paths previstos.
- Usuário `deploy` observado com UID/GID 1000; nenhum usuário cujo nome contenha
  `payload` ou `cutover` encontrado. Essa busca não demonstra separação de
  identidades nem transporte SSH não-root efetivamente qualificado.
- API, cron e PostgreSQL reportaram healthy; Nginx running.
- Espaço livre observado: aproximadamente 66,84 GiB.
- HTTPS `/api/health`: 200, JSON `status=ok`.
- HTTPS `/api/ready`: 200, JSON `status=ready`.

O Nginx legado observado ainda responde `/editorial` com 308 para
`/editorial/admin`, e `/editorial/ready` com 502. A inspeção read-only de `nginx -T`
confirmou o proxy legado amplo para `/editorial/`, com CMS ausente. Portanto,
**não há evidência de rota privada moderna instalada nem de Gate D concluído**.
O status 200 HTML de `/health` ou `/ready` fora de `/api` não é prova de saúde da
API e foi descartado como oracle.

Não houve rotação, preparação aplicada, instalação, promoção de rota ou cutover
nesta rodada. Essa observação de baseline não aprova source, restore ou aceitação.

Consulta read-only de systemd também encontrou o timer de backup ativo, último
disparo em `2026-11-02 06:00:00 UTC`, próximo em `2026-11-03 06:00:00 UTC`; o
serviço reportou `Result=success`, `ExecMainStatus=0`. O timer de renovação do
certificado está ativo. Esses estados não verificam conteúdo/restore dos backups,
entrega de alertas ou recuperação coordenada do futuro CMS.

## Dependências externas verificadas

A conta GitHub disponível continua com `push=true`, `admin=false`,
`maintain=false`. A API lista apenas `production` e `staging`, sem
`protection_rules`. Os Environments `payload-cutover-preflight` e
`payload-cutover-activation` estão ausentes. Registrado em OWN-23, comentário
`311ffcc2-4387-4967-90a3-4fc78dd96116`.

Não foi obtida permissão para configurar esses controles com a conta atual.
Autorizações conversacionais não substituem a configuração nem os approvals
autenticados previstos nos workflows.

## Critérios de fechamento ainda pendentes

- Barreira B0 completamente testada e revisada; novo candidato e closure.
- Preparação protegida, transporte não-root e Environments de OWN-23.
- B0 exato restaurado/qualificado, evidência privada e aceite posterior previsto.
- Instalação privada e B1 recuperável, vinculados ao candidato final.
- Rota e jornadas reais de admin, editor e leitor independente.
- Gate E com identidades, approvals e deadline próprios; autoridade observada.
- Handoff com SHA/digests/receipts reais, responsáveis e alertas definidos.

Nenhum desses critérios será fechado por fixtures, geração de um documento,
aprovação antecipada de evidência inexistente ou apenas por testes offline.
