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

| Caso requerido | Status | Critério PASS exigido | Evidência ainda não obtida |
| --- | --- | --- |
| `live-auth-gate` | NOT_EXECUTED | `/users/me`, availability, list/detail autenticados; conta inativa negada; publicação `r1`→`r2` e despublicação coerentes. | HTTP real, CMS outage seguro e Auth Emulator. |
| `catalog-routing` | NOT_EXECUTED | 13+ itens, 12 por página, filtro/página, slug direto, refresh, foco e Back/Forward sem shell reload. | Navegação em browser/serviços. |
| `native-image` | NOT_EXECUTED | Emissão POST 204 bodyless, cookie com atributos/escopo corretos e GET nativo autorizado; Origin inválido negado. | Cookie/asset reais no Nginx. |
| `native-range` | NOT_EXECUTED | GET 200, ranges prefix/suffix 206, range inválido/multi-range 416, headers corretos, streaming incremental e cancelamento. | Transporte Nginx/bytes/cancelamento reais. |
| `long-video-renewal` | NOT_EXECUTED | Reprodução >6 min; renew perto de 4 min sem troca de `src`, reset de `currentTime` ou pausa. | Vídeo e sessão em browser real. |
| `media-failure-recovery` | NOT_EXECUTED | Offline/online, 429 Retry-After, expiração e revisão substituída recuperam sem misturar blocos/IDs de `r1` e `r2`. | Falhas de rede/media reais. |
| `large-pdf` | NOT_EXECUTED | PDF ≥20 MiB abre nativamente, usa Range; aba independente expira após 5 min e reabre via Portal. | Visualizador nativo e cookie expirado. |
| `auth-exit-cross-tab` | NOT_EXECUTED | Logout/troca invalida duas abas via BroadcastChannel e storage fallback; emissão tardia não ativa sessão antiga; GET revogado negado. | Duas abas e cookies reais. |
| `gallery-keyboard` | NOT_EXECUTED | Foco contido/restaurado, setas com wrap, Escape/backdrop, inert e scroll restaurados, vídeo pausado. | Sequência manual no browser. |
| `screen-reader-gallery` | NOT_EXECUTED | Leitor anuncia diálogo, nome, alt/caption, índice e controles; fundo inert e foco restaurado. | Árvore/anúncio em tecnologia assistiva real. |
| `embeds-effective-csp` | NOT_EXECUTED | CSP efetiva restringe origins canônicas; YouTube/Vimeo carregam e reproduzem sem wildcard ampliado. | Header Nginx e playback real. |
| `layout-mobile` | NOT_EXECUTED | 10 tipos × 5 layouts + default omitido, em 320/375/768/1440, zoom 100/200%, touch e reduced motion sem overflow. | Matriz de screenshots/viewport. |
| `bfcache-cleanup` | NOT_EXECUTED | 10 ciclos, ao menos um `pageshow.persisted=true`, cleanup idempotente e revalidação antes de reativar mídia. | BFCache do browser. |
| `owner-news-regression` | NOT_EXECUTED | News/Academy/editor navegam e preservam shell, permissão e dados publicados; retorno a Conteúdos é funcional. | Browser smoke de News/Academy/editor. |
| `editorial-accessibility` | NOT_EXECUTED | PDF marcado/ordem de leitura, headings/links/alt e legendas/transcrição/alternativa verificados manualmente. | Inspeção de PDF e mídia por leitor/ferramenta. |

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
