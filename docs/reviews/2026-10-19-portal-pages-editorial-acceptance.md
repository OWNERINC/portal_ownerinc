# Task 4 — aceite editorial das páginas modulares

## Estado desta entrega

**Status global: integração real nativa Payload/PostgreSQL PASS; navegador e checklist manual NOT_EXECUTED.**
Os checks offline e as suites unitárias reportadas abaixo são verificações de
código; não provam sessão V2 de produção ou acessibilidade por leitor de tela.
A execução nativa real foi feita em fixture local descartável, explicitamente
optada e removida após a coleta de evidência.

## Evidência offline

| Caso/comando | Resultado | Observação |
|---|---|---|
| `node --import tsx --test tests/unit/portal-page-editorial-config.test.ts tests/unit/portal-page-editorial-integration-guard.test.ts tests/unit/portal-page-editorial-preview.test.ts tests/unit/portal-page-media-reader.test.ts` | PASS | 36 testes: safe asset headers, cancellation/descriptor closure, Range/backpressure, textarea wrapper, filesystem privacy, strict environment, stale-run abort, handoff and exhaustive aggregation. |
| `npm run typecheck` em `cms/` | PASS | TypeScript sem emissão. |
| `npm run test:unit` em `cms/` | PASS | Verificação final: 705 casos, 694 PASS, 11 SKIP opcionais (PGlite indisponível), 0 FAIL. |
| `npm run generate:importmap` com `CMS_BUILD_ONLY=true` e `NEXT_PHASE=phase-production-build` | PASS | CLI informou `No new imports found`; o mapa gerado já contém o novo wrapper e preserva os imports anteriores. |
| `npm run generate:types` com as mesmas variáveis | PASS | Executado pela CLI; nenhum delta de tipo necessário. |
| `node --check` dos runners MJS e dos helpers de integração | PASS | Sintaxe local; não inicia Payload nem serviços. |
| `npm run verify` com `PAYLOAD_TEST_EXTERNAL_PARENT=C:\Windows\Temp` | PASS | 1.993 testes raiz: 1.974 PASS, 19 SKIP, 0 FAIL; suíte CMS final: 705 casos, 694 PASS, 11 SKIP, 0 FAIL; typecheck, segurança e Compose passaram. Nenhum serviço foi iniciado por este check offline. |
| `git diff --check` | PASS | Sem erros de whitespace. |

## RED/GREEN dos achados da revisão

| Achado | RED observado antes da correção | GREEN após a correção |
|---|---|---|
| Metadados privados nos headers e evidência do ciclo do stream | O teste novo do endpoint falhou: `Content-Disposition` revelava o storage key em vez do filename opaco esperado. | Filename agora deriva somente de UUID/MIME, preservando Content-Type/Length/Range, cache privado e nosniff. Cancelamento downstream e erro de commit fecham exatamente uma vez; consumidor pausado lê sob demanda em chunks de 64 KiB. |
| Propriedade/modo de diretórios e arquivos de evidência | Regressões falharam porque os validadores e writer ainda não existiam; a guarda anterior aceitava os cenários simulados. | Linux exige UID/modo privado e grava via arquivo temporário exclusivo `0600`, fsync e rename; entradas inseguras não são lidas. Windows reporta apenas validação portátil de caminho/tipo. |
| Textarea de callout usando wrapper de input | A configuração apontava `body.callout.text` ao wrapper single-line; a asserção de campo falhou. | Callout usa `TextareaField` nativo e registra o `<textarea>` real para foco; demais single-line continuam no wrapper original. |
| Aceitação sem casos exaustivos | Os testes para caso ausente/duplicado/status inválido falharam porque não existia agregador/registros esperados. | Registries native/browser nomeados: ausência, duplicidade, inesperado, `FAIL`, `NOT_EXECUTED` ou `SKIP` nunca agregam `PASS`. |
| Ambiente e handoff reutilizável | A regressão observou `NODE_ENV=development` aceito onde a configuração do runner exigia test. | Exige exatamente `NODE_ENV=test`; remove apenas saídas Task 4 previamente validadas antes da migration, e cria handoff/storage state novos somente após todos os casos native passarem. |

Os testes de ciclo do stream e de privacidade de filesystem adicionados nesta rodada agora passam. Não se registra uma falha funcional prévia de cancelamento que não foi observada; o RED de headers foi reproduzido diretamente no endpoint.

## Guard e integração nativa

O quadro abaixo registra o estado antes do aceite descartável real de
2026-10-20; o resultado atual está na seção final deste documento.

O novo runner dedicado é `npm --prefix cms run test:portal-pages:integration`.
`--check-config` exige opt-in, `NODE_ENV=test`, URLs loopback distintas com nomes `test`/`dev`,
diretórios privados separados fora do checkout e UUIDv4. O preflight não lê `.env`,
não importa Payload/pg, não abre conexão e responde `NOT_EXECUTED`; o teste unitário
exercita recusa de opt-in ausente, argumento desconhecido, alvo remoto, aliases,
fallback de database de runtime e diretórios sobrepostos.

| Aceite | Resultado | Motivo |
|---|---|---|
| `--check-config` com configuração real preparada | NOT_EXECUTED | Nenhum conjunto privado de URLs/diretórios/UUID foi fornecido para esta sessão. |
| `--execute` em PostgreSQL/Payload real | NOT_EXECUTED | Nenhum banco disposable autorizado foi conectado/migrado nesta sessão. |
| Suite `portal-page-editorial-native.ts` | NOT_EXECUTED | Depende das duas URLs e migrações em fixture real. |

O runner não provisiona bancos, não inicia Docker e não usa `DATABASE_URL` ou
variáveis de runtime CMS como fallback. O banco Portal é validado como destino
distinto e não é utilizado por esta integração; o CMS target é o único que recebe
migrations. `PAYLOAD_TEST_PLAYWRIGHT_MODULE` é opcional e deve apontar para uma
instalação externa absoluta.

## Browser e aceitação manual

O browser entrypoint consome somente
`PAYLOAD_TEST_EVIDENCE_DIR/portal-page-editorial-browser.json` com `runId`,
`baseURL` loopback, módulo Playwright absoluto e storage state privado dentro da
mesma pasta de evidências. A fixture nativa só escreve essa handoff depois de
criar seus próprios dados. A execução inicia somente um Next de desenvolvimento
em loopback e um transporte V2 local de teste; ambos os processos próprios são
encerrados em `finally`.

| Aceite | Resultado | Motivo |
|---|---|---|
| Preview/assets via Next em navegador | NOT_EXECUTED | Não há fixture native nem handoff/session state desta execução. |
| Suites reais dos controles e cinco destinos de upload | NOT_EXECUTED | Requer a mesma fixture browser e Playwright externo. |
| News smoke no navegador | NOT_EXECUTED | Não houve servidor/browser fixture iniciado. |
| Checklist manual (teclado, foco, leitor de tela, Drawer, viewport/reduced motion) | NOT_EXECUTED | Nenhuma sessão manual acessível foi aberta. |
| Nginx, Firebase real, deploy ou filesystem Linux | NOT_EXECUTED | Fora desta aceitação offline. |

O checklist detalhado e as operações de mídia estão em
[`docs/operations/portal-pages-editorial.md`](../operations/portal-pages-editorial.md).

## Review-fix round 2 — browser acceptance guards

| Check | Result | Evidence |
|---|---|---|
| Focused browser harness, runner registry/source, config/preview/media regressions | **PASS** | 41 tests passed, including success/throw paths for all exported browser assertions, isolated structural-page orchestration, unchanged upload position delivery, exhaustive named-case aggregation, and stateful fixture-cookie revocation. |
| All Task 4 `portal-page-*` unit tests | **PASS** | 154 tests passed. |
| `npm run typecheck` in `cms/` | **PASS** | TypeScript completed without emission. |
| `npm run test:unit` in `cms/` | **PASS** | 703 tests: 692 passed, 0 failed, 11 skipped because optional PGlite is unavailable. |
| `node --check` for Task 4 editorial MJS modules | **PASS** | Browser runner and modified helpers parse; syntax only. |
| `git diff --check` | **PASS** | No whitespace errors before commit. |
| `npm run verify` with `PAYLOAD_TEST_EXTERNAL_PARENT=C:\Windows\Temp` | **PASS** | Root suite: 1,993 tests, 1,974 passed, 0 failed, 19 skipped; CMS suite: 703 tests, 692 passed, 0 failed, 11 skipped; security and Compose checks passed. |

Round 2 fixes remove undeclared Node-style `assert.*` calls from the browser
controls module and exercise the replacement helpers directly. A distinct
structural Page prevents reorder/insertion checks from altering the upload
fixture; an orchestration guard snapshots and rechecks the original image,
gallery, video and PDF paths before forwarding them to upload tests. The
required browser registry now includes an exact historical-preview-after-newer-
publication case and a final fresh-Range-after-revocation case. The local test
bridge invalidates subsequent V2 resolution for the exact revoked synthetic
cookie, with an offline HTTP test proving unrelated fixture-cookie state remains
valid.

These checks do **not** claim either browser case passed against a live browser
or real Portal service. No disposable PostgreSQL fixture, browser handoff, or
external Playwright installation was provided for this run. Native/database,
browser, manual accessibility, and live-service acceptance remain
**NOT_EXECUTED**. If those prerequisites are absent, both new named browser cases
are emitted as `NOT_EXECUTED`; aggregation cannot produce overall `PASS`.

## Review-fix round 3 — editor restoration and direct PDF link

| Check | Result | Evidence |
|---|---|---|
| Focused browser harness | **PASS** | 6 tests passed, including navigation to a Versions view, restoration/readiness before the second snapshot and upload invocation, and restoration in `finally` after a controls error. |
| All Task 4 `portal-page-*` unit tests | **PASS** | 155 tests passed. |
| `npm run typecheck` in `cms/` | **PASS** | TypeScript completed without emission. |
| `npm run test:unit` in `cms/` | **PASS** | 704 tests: 693 passed, 0 failed, 11 skipped because optional PGlite is unavailable. |
| `node --check` for Task 4 editorial MJS modules | **PASS** | Browser runner and editorial helpers parse; syntax only. |
| `git diff --check` | **PASS** | No whitespace errors before commit. |
| `npm run verify` with `PAYLOAD_TEST_EXTERNAL_PARENT=C:\Windows\Temp` | **PASS on retry** | The first run reported a root subprocess failure for `admin-list-filters.test.mjs`; the file passed independently (38/38), and the full rerun passed root tests, CMS tests, security, and Compose checks. |

The orchestration captures the original editor URL before controls, restores it
from `finally`, and waits for the exact native save button and image, gallery,
video, and PDF wrappers before taking the second upload-position snapshot. The
behavioral harness confirms restoration and all readiness checks precede that
snapshot and upload invocation. If controls throw, restoration is attempted and
uploads are not called. The historical-preview case now reads the direct child
`.portal-page-preview__pdf > a` link before and after reload, excluding the
nested `<object>` fallback anchor.

Browser and real PostgreSQL/Payload acceptance remain **NOT_EXECUTED** in this
round. No disposable database/browser handoff or external Playwright fixture was
started. The named browser case order and synthetic revocation behavior are
unchanged; the local revocation bridge remains test-only evidence, not evidence
about the live Portal service.

## Docker e recursos

O quadro abaixo descreve a rodada offline anterior ao aceite descartável real; a
execução nativa de 2026-10-20 e sua limpeza estão registradas na seção final.

- O `npm run verify` consultou `docker compose version` (`29.5.3`); nenhum daemon,
  container, serviço ou recurso Docker foi iniciado, alterado ou removido.
- Nenhum container, volume, rede, banco, upload dir ou evidência de integração foi
  criado nesta sessão. Nenhum nome novo de recurso ou `runId` de aceite real existe.
- Containers locais não relacionados que já estavam ativos foram deixados
  intactos; nenhum `stop`, `down`, reset ou remoção foi solicitado/executado.
- Comportamento de shutdown: não se aplica porque nenhum serviço foi iniciado.
  Durante uma execução futura do browser, somente o processo Next próprio e o
  listener local de transporte V2 serão fechados pelo `finally` do runner.
- Nenhuma migration foi aplicada e nenhum deploy/script de produção foi alterado.

## Revisão de escopo

- News e seu import map foram preservados; as asserções de configuração continuam
  cobrindo os controles/imports anteriores.
- Alterações de runtime são restritas ao CMS editorial das páginas. Nenhum frontend
  público do Portal, Nginx, script de deploy, serviço em execução ou Ownerinc Brain
  foi incluído.
- Os casos browser/manual ainda marcados `NOT_EXECUTED` não se convertem em aceite
  real. Erro ou ausência em nova execução deve continuar visível como
  `FAIL`/`NOT_EXECUTED`, sem relaxar autorização, CAS, versionamento ou limites.

## Aceite real nativo — 2026-10-20

| Caso/comando | Resultado | Evidência |
|---|---|---|
| `npm --prefix cms run test:portal-pages:integration -- --check-config` | CONFIG_VALID / NOT_EXECUTED | UUID de execução validado; preflight confirmou diretórios e alvos sem conectar nem alegar aceite. |
| Migrations revisadas via `npm --prefix cms run test:portal-pages:integration -- --execute` | PASS | Migrations aplicadas somente ao banco CMS descartável PostgreSQL 16.15. |
| Suíte native Payload/PostgreSQL do mesmo `--execute` | **PASS, 16/16 casos obrigatórios** | Payload 3.90.2 e adapter PostgreSQL reais; hooks Portal Pages, tabela Versions, autosave, CAS, publicação concorrente, rollback/readback, MIME e autorização privada executados. |
| Resultado agregado do comando `--execute` | NOT_EXECUTED | Correto: o caso browser foi NOT_EXECUTED por não haver módulo Playwright externo nem handoff/sessão browser válida. O agregado não converte browser ausente em PASS. |
| Browser e checklist manual | NOT_EXECUTED | Sem Playwright/session handoff; teclado, leitor de tela, reduced motion e viewport não foram validados manualmente. |

Identificação não secreta da fixture: `runId` `9eb8f3f8-2663-446b-83f8-43fb6e6eaec7`;
container `task4-acceptance-pg-9eb8f3f82663446b`; volume
`task4-acceptance-data-9eb8f3f82663446b`; PostgreSQL `16.15`; bind somente
`127.0.0.1:58270`; bancos `portal_pages_portal_dev` e `portal_pages_cms_test`.
Os diretórios de upload e evidência eram distintos e exclusivos sob
`%LOCALAPPDATA%\Temp\opencode` e foram removidos. Cleanup confirmado: container
parado e removido, volume removido, diretórios removidos. Nenhuma senha ou URL
com credencial foi registrada.

### RED/GREEN durante o aceite nativo

- **RED — create inicial:** a execução real inicial falhou em
  `initial explicit create runs Portal author hooks and persists a native Version`
  com `portal_page_published_at_server_owned` (403). Payload 3.90.2 inclui a
  propriedade `publishedAt` com valor `undefined` no hook de create; a comparação
  antiga tratava o placeholder como tentativa de escrita. O teste focado novo
  reproduziu a mesma falha (0 PASS, 1 FAIL).
- **GREEN — create inicial:** o hook agora ignora apenas o placeholder
  `undefined`, grava o valor original server-owned (`null` no create) e continua
  recusando timestamp efetivamente fornecido. O teste focado passou (1/1), e a
  execução real final confirmou create, hooks e Version persistida.
- **RED — matriz MIME:** após o primeiro ajuste, a execução real falhou no caso
  `complete media MIME-role matrix accepts every supported native role` com
  status 400. A fixture chamava o helper de persistência com blocos no formato
  Payload (`blockType`/`asset`), embora o helper receba blocos públicos já
  projetados (`type`/`asset_id`); assim, o erro era conteúdo inválido, não a
  validação de MIME. A mesma forma inválida fazia os testes negativos anteriores
  obterem 400 sem alcançar a regra pretendida.
- **GREEN — matriz MIME:** os casos agora passam os blocos nativos por
  `projectPortalPageContent` antes de chamar o helper, incluindo verificações de
  MIME incompatível e mídia incompleta. Na execução final, a matriz completa e
  todos os outros 15 casos nativos passaram.

O `--execute` final foi runId `9eb8f3f8-2663-446b-83f8-43fb6e6eaec7`; seu JSON
privado nomeou migrations e suíte native como PASS, browser como NOT_EXECUTED e
status agregado NOT_EXECUTED. O JSON, storage state (não criado nesta execução),
uploads e demais artefatos privados foram removidos junto com a fixture. Não se
alega browser, acessibilidade manual, Nginx, Firebase real, deploy ou filesystem
Linux.

## Final reviewer-fix wave — 2026-10-20

| Check | Resultado | Evidência |
|---|---|---|
| Regressões focadas de autorização editorial, preview, infraestrutura, Nginx e upload | **PASS, 117/117** | News-only negado em todos os quatro modos sem alterar `canManageNews`; V2 `manageKnowledge`/UID/expiração aceitos; expirado mantém 401 e falha de dependência permanece 503. |
| Montagem sequencial e recuperação | **PASS** | Falhas de abertura/leitura do chunk posterior fecham cada descriptor exatamente uma vez, removem `.assembled.part` e permitem retry; 100 chunks esparsos de 5 MiB confirmam 500 MiB e SHA-256 exatos, pico de um descriptor-fonte e um descriptor de saída. |
| Rota Nginx de save | **PASS / integração real NOT_EXECUTED** | Invariantes confirmam a location exata de 9 MiB e preservam os limites genéricos de 6 MiB. O teste de entrega real de 8 MiB está incluído, mas foi SKIP nesta sessão Windows porque requer Nginx/Linux. |
| CSP de embeds | **PASS** | `frame-src` acrescenta somente `https://www.youtube.com` e `https://player.vimeo.com`; regressão usa embed normalizado e rejeita deriva da allowlist. |
| Contrato operacional de cleanup | **PASS** | 24 horas é elegibilidade, não SLA; init posterior dispara a passagem limitada, sem scheduler nem garantia de prazo. A invariante verifica a arquitetura e o runbook operacional. |
| `npm run test:unit` em `cms/` | **PASS** | 712 testes: 701 PASS, 11 SKIP opcionais por PGlite indisponível, 0 FAIL. |
| `npm run typecheck` em `cms/` | **PASS** | TypeScript sem emissão. |
| `generate:importmap` / `generate:types` em `cms/` | **PASS** | Build-only: import map informou `No new imports found`; geração de tipos encerrou sem delta rastreado. |
| `npm run verify` na raiz | **PASS** | 1.994 testes raiz: 1.975 PASS, 19 SKIP, 0 FAIL; suíte CMS: 712 testes, 701 PASS, 11 SKIP, 0 FAIL; syntax, tipos, segurança e Compose concluíram com `verify: ok`. Executado com `PAYLOAD_TEST_EXTERNAL_PARENT=C:\Windows\Temp`; a afinidade do verificador foi limitada a oito CPUs para evitar starvation dos fixtures Bash no Windows. Nenhum serviço foi iniciado. |
| `git diff --check` | **PASS** | Sem erros de whitespace após a consolidação dos documentos. |

Os cinco itens desta rodada mantêm News e os limites genéricos sem alteração:
autorização de Portal Pages usa somente a sessão V2 viva `manageKnowledge` com UID
correspondente; o ingress de save recebe uma location exata de 9 MiB; CSP permite
os dois origins canônicos dos renderers; limpeza permanece on-demand e sem SLA; e
assembly abre chunks sequencialmente, com no máximo um descriptor-fonte. A evidência
de browser, checklist manual, Nginx/Firebase reais, deploy e filesystem Linux
continua **NOT_EXECUTED** e não é inferida pelos checks offline.
