# Task 4 — aceite editorial das páginas modulares

## Estado desta entrega

**Status global: NOT_EXECUTED para integração real, navegador e checklist manual.**
Os checks offline e as suites unitárias reportadas abaixo são verificações de
código; não provam persistência PostgreSQL, sessão V2 real ou acessibilidade por
leitor de tela. A execução ainda requer uma fixture disposable previamente
preparada e opt-in explícito.

## Evidência offline

| Caso/comando | Resultado | Observação |
|---|---|---|
| `node --import tsx --test tests/unit/portal-page-editorial-config.test.ts tests/unit/portal-page-editorial-integration-guard.test.ts tests/unit/portal-page-editorial-preview.test.ts tests/unit/portal-page-media-reader.test.ts` | PASS | 36 testes: safe asset headers, cancellation/descriptor closure, Range/backpressure, textarea wrapper, filesystem privacy, strict environment, stale-run abort, handoff and exhaustive aggregation. |
| `npm run typecheck` em `cms/` | PASS | TypeScript sem emissão. |
| `npm run test:unit` em `cms/` | PASS | 698 casos: 687 PASS, 11 SKIP opcionais (PGlite indisponível), 0 FAIL. |
| `npm run generate:importmap` com `CMS_BUILD_ONLY=true` e `NEXT_PHASE=phase-production-build` | PASS | CLI informou `No new imports found`; o mapa gerado já contém o novo wrapper e preserva os imports anteriores. |
| `npm run generate:types` com as mesmas variáveis | PASS | Executado pela CLI; nenhum delta de tipo necessário. |
| `node --check` dos runners MJS e dos helpers de integração | PASS | Sintaxe local; não inicia Payload nem serviços. |
| `npm run verify` com `PAYLOAD_TEST_EXTERNAL_PARENT=C:\Windows\Temp` | PASS | 1.993 testes raiz: 1.974 PASS, 19 SKIP, 0 FAIL; suíte CMS: 698 casos, 687 PASS, 11 SKIP, 0 FAIL; segurança e Compose passaram. Nenhum serviço foi iniciado. |
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

## Docker e recursos

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
- A evidência acima não transforma `NOT_EXECUTED` em aceite real. Erro ou ausência
  na execução futura deve continuar visível como `FAIL`/`NOT_EXECUTED`, sem relaxar
  autorização, CAS, versionamento ou limites.
