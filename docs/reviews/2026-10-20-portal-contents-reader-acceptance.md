# Aceite do leitor Portal Conteúdos — Task 4

**Status: PARTIAL / BLOCKED.** Os testes offline direcionados passaram. `npm run
verify` foi executado e falhou; a falha anterior de `smoke-origin` foi reproduzida
uma vez, de forma isolada e com limite finito, e passou. A causa da falha observada
somente no conjunto completo continua sem prova; ela não é classificada como
“não relacionada”. Os 15 casos reais de serviço/browser continuam `NOT_EXECUTED`;
o agregado permanece código 2. Isto não é aceite de produção ou prova de transporte real.

## Identificação e autorização

- Data: 2026-10-21.
- Ambiente de trabalho: Windows, Node `v24.15.0`.
- Base sob teste: `55bd6c66ba2bb49a3e9cf5c3768538bde5c471d5` mais o commit de código
  Task 4 `19d9c2fdd90140df6a453f4bdeb09462236e556f`.
- Run ID: `a72e87b2-f750-4d51-88e3-ffe8d92a6a68`.
- Referência de autorização: apenas um stack **LOCAL descartável e nomeado** foi
  autorizado pela sessão supervisora. Nenhum projeto/stack ou recurso foi
  selecionado; a autorização não foi ampliada para produção, VPS, deploy ou remoto.
- Pré-condição bloqueadora: `docker info --format '{{.ServerVersion}}'` falhou ao
  conectar em `npipe:////./pipe/dockerDesktopLinuxEngine` (`The system cannot find
  the file specified`). Nenhum container, browser, API, CMS, banco ou Nginx foi
  iniciado; nenhum reload ocorreu.
- Evidências externas: diretório
  `C:\Users\Criação\AppData\Local\Temp\opencode\portal-contents-acceptance-a72e87b2-f750-4d51-88e3-ffe8d92a6a68`;
  manifest `portal-contents-acceptance.json`, com 15 registros `NOT_EXECUTED` e
  `artifact: null`. Sem cookies, tokens, HAR, storage state ou screenshots.
- Limite Firebase: Auth Emulator não executado; Firebase real não executado.
  Nenhum resultado local/emulado é extrapolado para Firebase real.
- Browser/versão/viewport: não executados / não aplicável; sem handoff local.

## Resultado e critérios dos casos obrigatórios

Todos os registros usam o mesmo run ID, ambiente
`disposable-local service/browser run NOT_EXECUTED (Docker Linux daemon unavailable; no stack started)`,
browser/viewport `NOT_EXECUTED`, `artifact: null` e status `NOT_EXECUTED`.

| Caso requerido | Status | Critério PASS exigido | Procedimento vinculante | Evidência ainda não obtida |
| --- | --- | --- | --- | --- |
| `live-auth-gate` | NOT_EXECUTED | Zero publications oculta apenas o nav link; deep link autenticado independe de gate/cache; publish revela link após navigation, visibility e online probes independentes; auth/revisions coerentes. | [Caso 1](../operations/portal-contents-reader.md#case-live-auth-gate) | HTTP real, CMS outage seguro e Auth Emulator. |
| `catalog-routing` | NOT_EXECUTED | Category-only retry; modified/native new-tab gestures; duplicate/hostile query rejeitada e permitida canonizada; 12/page, history e slug direto. | [Caso 2](../operations/portal-contents-reader.md#case-catalog-routing) | Navegação em browser/serviços. |
| `native-image` | NOT_EXECUTED | POST 204/cookie/GET nativo válidos; Origin inválido negado; caminho original `/uploads/cms-private` não entrega bytes. | [Caso 3](../operations/portal-contents-reader.md#case-native-image) | Cookie/asset reais no Nginx. |
| `native-range` | NOT_EXECUTED | `bytes=0-1023`, `bytes=1024-` e `bytes=-1024` dão 206 exato; `bytes=N-`/multi-range dão 416; streaming/cancelamento. | [Caso 4](../operations/portal-contents-reader.md#case-native-range) | Transporte Nginx/bytes/cancelamento reais. |
| `long-video-renewal` | NOT_EXECUTED | POST media-session 204 observado enquanto document permanece hidden e vídeo playing; foreground recovery é separado; seek autorizado >5 min sem reset. | [Caso 5](../operations/portal-contents-reader.md#case-long-video-renewal) | Vídeo e sessão em browser real. |
| `media-failure-recovery` | NOT_EXECUTED | Suspend past expiry pausa vídeo/remove PDF href; retry medido 5/15/30, sem quarto automático; 429 e troca `r1`/`r2` seguras. | [Caso 6](../operations/portal-contents-reader.md#case-media-failure-recovery) | Falhas de rede/media reais. |
| `large-pdf` | NOT_EXECUTED | Release da lease Portal precede expiry standalone; fresh Range negado; open/download e fallback sem viewer observados por browser. | [Caso 7](../operations/portal-contents-reader.md#case-large-pdf) | Visualizador nativo e cookie expirado. |
| `auth-exit-cross-tab` | NOT_EXECUTED | Failed clear exige retry; revoke editorial negado; logout/troca invalida tabs por BroadcastChannel e storage real; emissão tardia não ativa. | [Caso 8](../operations/portal-contents-reader.md#case-auth-exit-cross-tab) | Duas abas e cookies reais. |
| `gallery-keyboard` | NOT_EXECUTED | Failed-next persistente/reload, opener removido→heading fallback, browser Back, backdrop drag exclusion, drawer isolado e foco/inert restaurados. | [Caso 9](../operations/portal-contents-reader.md#case-gallery-keyboard) | Sequência manual no browser. |
| `screen-reader-gallery` | NOT_EXECUTED | Leitor anuncia diálogo, nome, alt/caption, índice e controles; fundo inert e foco restaurado. | [Caso 10](../operations/portal-contents-reader.md#case-screen-reader-gallery) | Árvore/anúncio em tecnologia assistiva real. |
| `embeds-effective-csp` | NOT_EXECUTED | CSP efetiva restringe origins canônicas; YouTube/Vimeo carregam e reproduzem sem wildcard ampliado. | [Caso 11](../operations/portal-contents-reader.md#case-embeds-effective-csp) | Header Nginx e playback real. |
| `layout-mobile` | NOT_EXECUTED | Todas 10×5 células + 10 defaults; quatro larguras/2 zooms, sidebar expanded/collapsed e controles ≥44×44 CSS px. | [Caso 12](../operations/portal-contents-reader.md#case-layout-mobile) | Matriz de screenshots/viewport e medidas. |
| `bfcache-cleanup` | NOT_EXECUTED | Dez ciclos com pelo menos um `pageshow.persisted===true`; revalidação e nova lease antes de reativar mídia. | [Caso 13](../operations/portal-contents-reader.md#case-bfcache-cleanup) | BFCache do browser. |
| `owner-news-regression` | NOT_EXECUTED | Ação de mídia privada do item sintético usa GET `/api/announcements/assets/:id` (200/private/no-store/native element); logout nega sem bytes; Owner News permanece inalterado. | [Caso 14](../operations/portal-contents-reader.md#case-owner-news-regression) | Browser smoke de News/Academy/editor. |
| `editorial-accessibility` | NOT_EXECUTED | PDF marcado/ordem de leitura, headings/links/alt e legendas/transcrição/alternativa verificados manualmente. | [Caso 15](../operations/portal-contents-reader.md#case-editorial-accessibility) | Inspeção de PDF e mídia por leitor/ferramenta. |

Os procedimentos reproduzíveis, pré-requisitos, sequência e checks HTTP/Range
completos estão no [runbook](../operations/portal-contents-reader.md#matriz-operacional-reproduzível--15-casos).
O status desta tabela permanece `NOT_EXECUTED`; critérios escritos não são
evidência de execução.

## Verificação offline

- Suíte Task 4 focada (routing, acceptance, navigation regressions, shell/mobile):
  **82 passed, 0 failed, 0 skipped**, exit 0.
- Suíte ampliada (+ persistent navigation, auth, media, Academy player e
  `owner-news-reader`): **223 passed, 0 failed, 0 skipped**, exit 0.
- `node scripts/generate-public-shell.mjs --check`: exit 0.
- `git diff --check`: exit 0.
- `--check-config`: configuração válida, 15 casos `NOT_EXECUTED`, process exit 2;
  não conectou nem gravou o manifest.
- `npm run verify` com `NODE_OPTIONS="--test-skip-pattern=^Academy initial/repeated error focuses usable retry"`:
  exit 1; **2.139 testes descobertos: 2.103 pass, 17 fail, 19 skipped**.
  Syntax e CMS typecheck offline passaram antes da etapa de testes. Falhas: 14
  `EPERM` em `mkdtemp` sob `C:\Users\payload-*` (4 em `payload-preview-https`,
  10 em `payload-preview-preparation`); `academy-frontend.test.mjs` falhou após
  ~154 s com `RangeError: Array buffer allocation failed`; `smoke-origin.test.mjs`
  / `rejects entry without mount export` falhou a asserção de metadados esperados,
  levando também a suíte pai a falhar. CMS unit tests, secret scan, DHO e Compose
  não foram alcançados após a falha do conjunto root.
- O teste completo incluiu todos `tests/unit/owner-news*.test.mjs`; nenhum está
  entre as falhas. O focused ampliado também executou `owner-news-reader`.
- `node scripts/test-portal-contents-acceptance.mjs --aggregate`: manifest externo
  presente, 15 registros `NOT_EXECUTED`, status `NOT_EXECUTED`, exit 2, sem erros;
  o resultado permanece bloqueado, nunca PASS.
- Round 1: regression do bypass `NOT_EXECUTED` em todos os campos PASS, matriz de
  separadores/placeholder, PASS provenance legítima, timestamps, artifact opcional
  sem placeholder e getter/subscriber do harness passam na suíte direcionada; veja
  RED/GREEN e diagnóstico único de `smoke-origin` no relatório local detalhado.

### Correção final P2 — contrato de URL CMS

- O limite de 2.048 unidades UTF-16 (`String.length`) agora é aplicado pela
  normalização CMS de links de bloco e links Lexical, tanto no valor submetido
  quanto na URL HTTPS canonicalizada. URLs com credenciais e HTTP continuam
  rejeitadas. Inputs de URL nativos de link/embed e o campo URL do editor rich text
  expõem `maxLength=2048`.
- Red/Green focado: CMS `portal-pages.test.ts` + `portal-page-editorial-config.test.ts`:
  **20 aprovados**; Portal/API/browser `portal-contents-dto.test.mjs`:
  **9 aprovados**, incluindo 2048 aceito e 2049/credenciais/HTTP rejeitados em
  link de bloco e rich text. Nenhum CMS/PostgreSQL real foi iniciado.
- Este resultado offline não muda o bloqueio de aceite HTTP/browser real acima;
  o resultado da correção P1 e das verificações finais será acrescentado após a
  execução efetiva.

### Correção final P1 — consultas bounded/canceláveis

- O catálogo calcula a contagem e busca somente os IDs da página solicitada em
  uma transação determinística sob `CMS_REFERENCE_LOCK`; cada DTO continua
  vinculado à Version publicada exata, e divergência na página selecionada falha
  fechada. A disponibilidade usa ação CMS própria, sem count/list, e termina no
  primeiro DTO publicado elegível.
- Categorias percorrem cursor UUID crescente, no máximo dez candidatos por
  transação/lock e 100.000 candidatos por leitura. O lock é liberado entre lotes;
  não existe snapshot global de categorias durante publicação concorrente. Abort,
  deadline, falha ou exceder limites resulta em 503 sanitizado, nunca em resultado
  parcial. JSON requests têm deadline de 4,2 s na API e clamp de até 4 s no CMS,
  com `lock_timeout`/`statement_timeout` pelo tempo restante.
- Regressões offline cobrem ordem/offset do catálogo (inclusive desempate por UUID),
  caminho de existência e early exit, exaustão `available:false`, lock isolado por
  lote, publicação entre lotes, abort antes do próximo lote, orçamento esgotado,
  validação do body deadline, stream abortado, DTO estrito e limite da resposta.
- CMS `npm run test:unit`: **720 descobertos, 709 aprovados, 0 falhas, 11 skips
  opcionais** antes do último ajuste de timeout após lock. Depois desse ajuste,
  `node --import tsx --test tests/unit/portal-pages-reader.test.ts
  tests/unit/portal-pages-service-access.test.ts` passou (**17 aprovados, 0
  falhas**) e CMS `npm run typecheck` passou novamente.
- API bridge + Payload client + browser/API DTO: **36 aprovados, 0 falhas**.
  Testes CMS URL-focused: **20 aprovados, 0 falhas**.
  `node scripts/generate-public-shell.mjs --check` passou; `npm run security`
  encontrou **0 vulnerabilidades** nos três pacotes. Após o ajuste final, o modo
  de secret scan `node scripts/verify.mjs security` e `git diff --check` também
  passaram; este modo de verificação de segredos não repete o audit de dependências.
- `npm run verify` foi executado uma vez nesta rodada: **2.154 descobertos,
  2.113 aprovados, 22 falhas e 19 skips**, exit 1 após cerca de 249 s. A etapa de
  typecheck CMS passou antes da etapa de testes. As falhas observadas foram
  restrições do ambiente Windows/recursos: `EPERM` ao criar diretórios `C:\Users\payload-*`,
  falhas de memória/alocação nos testes Academy e fixtures Python, erro de cópia
  Cygwin (`Win32 error 299`), processos auxiliares com exit `3221225773`/
  `3221226505` e falha de compilação PowerShell por `OutOfMemoryException` nos
  checks de smoke/ownership. O agregador do processo completo não chegou às etapas
  posteriores; a suíte CMS foi executada separadamente e passou. Estes resultados
  não são classificados como alheios sem prova.
- Nenhum stack, banco, API/CMS runtime ou browser foi iniciado; os 15 casos de
  serviço/browser mantêm `NOT_EXECUTED`. Os checks offline não substituem aceite
  HTTP, PostgreSQL ou browser real.

## Conclusão e próximas ações

Os testes offline cobrem identidade do shell, admissão de rota, loader/restauração,
descarte de mídia/galeria, revalidação simulada, CSP estática e agregação. Não
provam autenticação HTTP, Range no Nginx, streaming, playback, leitor de tela,
BFCache real, Firebase real, headers efetivos ou fixture editorial. Não foram
alterados publicação, editor, upload, Owner News, APIs de deploy ou serviços.

Limpeza exata: **nenhuma necessária**. Não foram criados projeto Compose,
containers, volumes, redes, portas, bancos, fixtures, usuários, assets ou estado
de browser. Nenhum `docker compose down`, `down -v` ou comando de remoção foi
executado. O diretório externo mantém somente o manifest sanitizado `NOT_EXECUTED`.

Depois de disponibilizar e autorizar um stack descartável nomeado, execute a
matriz completa conforme o [runbook](../operations/portal-contents-reader.md).
Mantenha os casos não realizados como `NOT_EXECUTED`; não declare aceite completo
enquanto o agregado não retornar PASS. Veja também o relatório detalhado
[`task-4-report.md`](../../.superpowers/sdd/2026-10-20-portal-contents-reader/task-4-report.md).
