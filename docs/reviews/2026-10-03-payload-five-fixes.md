# Payload Owner News — cinco correções e reruns reais

## Resultado delimitado — 03/10/2026

As **cinco falhas confirmadas receberam correções**, com **34 cenários reais PASS**
nesta rodada: 10 de sessão, 4 de importação, 5 de criação, 4 de links, 2 de
publicação/draft e 9 de layout. GETs autenticados e SQL somente leitura corroboram
IDs, conteúdo, versões e DTO. A revisão independente nova de especificação/código/
evidência permanece o gate de fechamento. Não é aceite integral do piloto.

Base: `ca8bfe1279f39f344e6302f241bdedf2833f9b43`, branch `feat/payload-owner-news`.
O [registro de 02/10](2026-10-02-payload-tasks-1-4-real-validation.md) mantém seus
FAILs como evidência histórica; estas contagens não se somam àquelas como cobertura
única. Não foram retomadas Tasks 5–15.

Ambiente: PostgreSQL16/Firebase Auth Emulator reais do projeto Docker exclusivo
`ownerinc-payload-local`, Express e Next/Payload3.90.2 reais, Node24/Windows,
Edge154.0.4258.48/Playwright1.63.0 isolados. Origem `http://localhost:18080` pelo
proxy descartável já autorizado; CMS usa `cms_runtime`, sem DDL. Nenhum setup,
migration, pacote/fork, produção, banco remoto ou deploy foi alterado.

## Correções, causas e asserções

| Falha original | Correção e prova real desta rodada | Estado |
|---|---|---|
| EDGE-04 — link padrão | Ausência de `newTab` agora significa false; valores fornecidos continuam booleanos estritos. Checkbox intocado, URL HTTPS, criação e edição pelo drawer nativo, marcador adicional, autosave200 e reload mantiveram link **e** marcador. DTO confirma `new_tab:false`; checkbox marcado confirma true. Seis PATCHs com tipo/URL inválidos receberam400 sem alterar o body | PASS |
| EDGE-01 — duas criações por navegação | View pública de coleção `/create` sem mutação no render; um POST REST autenticado por montagem, depois editor nativo por UUID. Quatro ações distintas (hard/in-app em editorA/editorB) produziram quatro UUIDs, cada qual com uma linha/versão inicial e um autosave posterior. IDs de redirect/form/GET/SQL coincidem; identidades `/me` distintas. GET, HEAD e prefetch RSC não criaram documentos | PASS |
| LEGACY-ID — UUID trocado | Config/processo local separado com opção pública `allowIDOnCreate:true`; helper transacional confere ID retornado e relido. UUID solicitado/persistido `389acfb6-87b7-49fc-88f7-0daf7cd48b3a`; null e provenance preservados. Repetição não sobrescreveu nem criou versão, conteúdo inválido reverteu; POSTs nativos tentando escolher IDs novo/existente e PATCH tentando trocar ID receberam400 | PASS |
| AUTH-DUP-01 — rotação inutiliza cookie anterior | Advisory lock por UID e espera limitada **antes** da única emissão; igualdade/colisão negadas, revogação+INSERT atômicos, Set-Cookie após commit. Emulator continua produzindo cookies idênticas em chamadas diretas no mesmo segundo; chamadas HTTP imediatas/concorrentes agora geram substitutas distintas201/200, antigas401, hashes/UID/expiração verificados no banco. Falhas reais de provedor, lock e revogação conservaram a anterior200 e não criaram hash utilizável | PASS |
| EDGE-10 — overflow narrow | Restrições flex de AppHeader/StepNav e overlay nativo mobile abaixo do header, sem máscara no body. Artigo com título longo/lista/home, menu aberto/fechado, 1440×900/390×844/320×844: scrollWidth=clientWidth em todos os18 estados. Conta/menu/breadcrumb dentro da viewport; Publish dentro dela com menu fechado, alcançável ao fechar o menu. Tab→Account→Enter e toggles reais passaram | PASS |

### Diagnóstico da criação duplicada

O hook diagnóstico temporário, removido antes da entrega, capturou duas chamadas
`renderDocument → payload.create` em **dois GETs**, não duas chamadas de metadata.
O primeiro redirect observado pelo Edge apontava novamente para `/create`.
O wrapper público instalado `withPayload` adiciona
`Critical-CH: Sec-CH-Prefers-Color-Scheme`, que faz o Chromium reiniciar a primeira
navegação sem esse hint. Duas navegações diagnósticas sem hint criaram dois pares;
o controle com hint fornecido desde o início criou uma única linha.

`generatePageMetadata → getMetaBySegment → generateEditViewMetadata` apenas monta
metadata. A causa é a mutação durante render de GET combinada com o reinício
Critical-CH. A correção mantém os headers nativos e Strict Mode e elimina a
mutação desse render, inclusive em prefetch. O teste após correção ainda observou
o GET repetido, mas **somente um POST/UUID**. Os cinco artefatos diagnósticos novos
foram conservados e rotulados pela UI; os artefatos históricos foram preservados.

### Sessão e limitações da garantia

- Cookie bruta Firebase, SHA-256 no banco e chamada com `expiresIn:7200000` mantidos.
- Lock `(7193030,hashtext(uid))` coordena processos via PostgreSQL; o único
  `pg_sleep` é limitado a1,1s e calculado desde a inserção confirmada. Lock timeout3s,
  statement timeout5s. `created_at=clock_timestamp()` evita usar a hora antiga do BEGIN.
- A nova hash precisa diferir da anterior e de qualquer registro existente,
  inclusive revogado. INSERT sem linha retornada também falha. Não há upsert,
  ressuscitação, wrapping, nonce adicional, duração variável ou retry automático.
- Sem cookie anterior, rotação imediata, concorrência e troca de conta foram
  exercitados. DELETE repetido204 e cookie revogada401 continuam válidos.
- O teste de falha do provedor chama o serviço real/SDK/Emulator com token sintético
  inválido. Falhas DB/UPDATE usam locks PostgreSQL reais em conexões independentes;
  `pg_stat_activity` confirmou espera na revogação. Nenhum mock de transporte foi usado.
- Regressões determinísticas cobrem output idêntico, INSERT/COMMIT/RETURNING vazio,
  falha pré-emissão e rollback. Elas complementam os cenários reais.
- A unicidade do **Firebase assinado de produção continua não comprovada**.
  Um provedor que repita a cookie mesmo após espera recebe503 seguro; não há promessa
  de sucesso universal nem de recuperar commit cujo resultado seja indeterminado
  por perda de conexão. A identidade de sessão aprovada permanece a mesma.

### Geometria final

| Viewport | Documento client/scroll, três rotas × dois estados | Account x/right | Publish x/largura (artigo, fechado) |
|---|---|---|---|
| 1440×900 | 1440/1440 | 1355/1380 | 1219,67 / 118,33 |
| 390×844 | 390/390 | 349/374 | 16 / 109,34 |
| 320×844 | 320/320 | 279/304 | 16 / 109,34 |

O oracle admite no máximo1px de arredondamento, mas não foi necessário. A lista
mantém seu scroller horizontal nativo; campos Monaco e datas mantêm seus próprios
scrollers. O menu mobile aberto cobre o conteúdo, conserva o header e pode ser
fechado; não empurra mais o editor para uma coluna de largura zero fora da tela.
Capturas finais foram lidas, incluindo menu aberto/fechado e as três rotas.
Isso não certifica aparelho físico, teclado virtual ou acessibilidade completa.

## Fixtures e evidência

| Finalidade | UUID |
|---|---|
| editorA hard; links/publicação/draft posterior | `4805cf13-c7fe-405b-892a-e54ec6552a9a` |
| editorA Create New | `8fb6dcfe-0752-4d21-aa46-af2bbd72ba4c` |
| editorB hard | `c7d3b95d-369f-48d9-ad2e-2d2056e96de6` |
| editorB Create New | `588f4008-9c7b-4607-bbec-a5f70ba68bb3` |
| Import confiável | `389acfb6-87b7-49fc-88f7-0daf7cd48b3a` |

O primeiro artigo tem quatro versões após publicação e draft posterior. Os demais
criados pelo navegador têm duas (criação + autosave de identificação). GET draft
e SQL `latest=true` incluem `REMEDIATION LATER DRAFT ONLY`; o publicado mantém
body distinto, sem esse marcador. Os gestos de seleção inseriram um marcador
dentro do texto do primeiro link, dividindo sua etiqueta em trechos; o conteúdo
sintético salvo está registrado integralmente, sem atribuir ao DOM a prova de DTO.

Artefatos sem credenciais, fora do checkout:
`C:/Users/Criação/AppData/Local/Temp/opencode/ownerinc-payload-real-fixes-20261003/`:

- `auth-isolated-results.json`: dez cenários, tempos das chamadas imediatas,
  hashes/UID/expiração reais e falhas controladas. `auth-results.json` e
  `auth-final-results.json` preservam execuções anteriores.
- `import-results.json`: quatro cenários, UUID solicitado/retornado/persistido,
  null/provenance/DTO e negativas nativas.
- `browser-create-results.json` + `browser-create-resume2-results.json`: cinco
  cenários válidos de criação/render; incluem requests/responses nativos.
- `browser-links-rerun-results.json` + `browser-links-resume-results.json`: quatro
  cenários válidos de links; `browser-publication-results.json`: dois de publicação.
- `persistence-results.json`: DTO real e SELECTs `BEGIN READ ONLY`, papel
  `cms_runtime`, comparados integralmente com GETs publicados/draft e versões.
- `layout-stable-results.json`: nove cenários/18 estados, bounds, hit targets,
  foco e navegação Account. `layout-stable-{1440,390,320}-{article,list,home}-closed.png`
  e `layout-stable-{390,320}-article-open.png` são as11 capturas finais lidas.
- `link-default-reloaded.png`, `link-edited-reloaded.png`,
  `links-complete-reloaded.png`, `remediation-later-draft.png`: capturas de conteúdo.

Oracles e relatório completo ignorados em
`.superpowers/sdd/2026-10-02-payload-owner-news-implementation/`:
`fixes-auth.mjs`, `fixes-import-run.mjs`, `fixes-browser.mjs`, `fixes-layout.mjs`,
`fixes-persistence-run.mjs`, `real-fixes-report.md`.

As tentativas iniciais de oracle foram preservadas: nome acessível do Create New
diverge do texto; click antes de hidratação não navegou; foco imediato após fechar
drawer substituiu seleção; click central no bounding box do link atingiu parágrafo.
Os oracles passaram a esperar hidratação nativa, usar nome acessível/teclado e
aguardar seleção estável. Esses ajustes não alteraram produto para fabricar PASS.
O primeiro ajuste CSS resolveu o header fechado; o teste do menu aberto revelou
a coluna mobile offscreen e motivou a extensão de layout antes da rodada final.

## Checks e handoff

Checks finais: `npm run verify` passou (1.149 PASS, zero FAIL, dois skips específicos
de Linux no Windows); `npm --prefix cms run test:unit` passou (76 PASS, zero FAIL/skip).
`npm --prefix cms run typecheck`, `npm --prefix cms run build` e `git diff --check`
terminaram com exit0. O verify inclui sintaxe, segurança e Compose; não é `npm audit`.
Os skips são semântica de flock e escape por symlink em Linux. Permanecem os avisos
preexistentes `MODULE_TYPELESS_PACKAGE_JSON` dos módulos frontend na suíte raiz;
o build não apresentou erro. Logs e commits estão no relatório completo de
coordenação para conferência independente antes do fechamento.

Somente backend/supervisor/container próprios permanecem disponíveis para essa
revisão. Browsers isolados foram encerrados; estado secreto continua fora do checkout.
Após o build, CMS foi reiniciado pelo supervisor; API e CMS responderam200
`status:ready` pelo proxy autorizado (`handoff-readiness.json`).

Permanecem as dependências já registradas: entrada/logout/cross-tab da Task9,
mídia da Task5, Nginx/CSP/runtimeLinux da Task13, importador operacional/cutover
posterior, produção Firebase e audit de dependências. Nenhuma é reclassificada
como entregue por estes reruns delimitados.
