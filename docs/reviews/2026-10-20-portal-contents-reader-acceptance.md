# Aceite do leitor Portal Conteúdos — Task 4

**Status: PARTIAL / BLOCKED.** Os testes offline direcionados passaram. `npm run
verify` foi executado, mas falhou em testes Windows/Academy/smoke não relacionados
abaixo. Os 15 casos reais de serviço/browser continuam `NOT_EXECUTED`; o agregado
permanece código 2. Isto não é aceite de produção ou prova de transporte real.

## Identificação e autorização

- Data: 2026-10-21.
- Ambiente de trabalho: Windows, Node `v24.15.0`.
- Base sob teste: `55bd6c66ba2bb49a3e9cf5c3768538bde5c471d5` mais o diff Task 4;
  o SHA do commit de código Task 4 será registrado no relatório complementar.
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

## Resultado dos casos obrigatórios

Todos os registros usam o mesmo run ID, ambiente
`disposable-local service/browser run NOT_EXECUTED (Docker Linux daemon unavailable; no stack started)`,
browser/viewport `NOT_EXECUTED`, `artifact: null` e status `NOT_EXECUTED`.

| Caso requerido | Status | Evidência / bloqueador |
| --- | --- | --- |
| `live-auth-gate` | NOT_EXECUTED | Sem Portal/API/Auth Emulator; Docker indisponível. |
| `catalog-routing` | NOT_EXECUTED | Sem browser/serviços; não confundir testes de harness com navegação real. |
| `native-image` | NOT_EXECUTED | Sem emissão HTTP 204/cookie ou GET nativo real. |
| `native-range` | NOT_EXECUTED | Sem Nginx/streaming; nenhum Range 206/416 real medido. |
| `long-video-renewal` | NOT_EXECUTED | Sem vídeo real >6 min nem renovação em browser. |
| `media-failure-recovery` | NOT_EXECUTED | Sem falhas de rede/429/expiração em browser real. |
| `large-pdf` | NOT_EXECUTED | Sem PDF nativo de fixture/visualizador independente. |
| `auth-exit-cross-tab` | NOT_EXECUTED | Sem duas abas, logout/troca de usuário ou cookie real. |
| `gallery-keyboard` | NOT_EXECUTED | Harness não substitui sequência manual em browser real. |
| `screen-reader-gallery` | NOT_EXECUTED | Nenhum leitor de tela/browser foi usado. |
| `embeds-effective-csp` | NOT_EXECUTED | Sem headers efetivos do Nginx ou playback YouTube/Vimeo. |
| `layout-mobile` | NOT_EXECUTED | Sem screenshots/viewport/zoom/touch reais. |
| `bfcache-cleanup` | NOT_EXECUTED | BFCache `pageshow.persisted` não observado; harness não satisfaz o caso. |
| `owner-news-regression` | NOT_EXECUTED | Testes offline executados; smoke de News/Academy/editor no browser não executado. |
| `editorial-accessibility` | NOT_EXECUTED | PDF/vídeo de fixture não examinados manualmente. |

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
- `--aggregate`: 15 registros reais ausentes de execução são `NOT_EXECUTED`, exit 2;
  o resultado permanece bloqueado, nunca PASS.

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
