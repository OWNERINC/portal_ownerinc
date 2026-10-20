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
| `node --import tsx --test tests/unit/portal-page-editorial-preview.test.ts` | PASS | 12 casos: UUID/Version exatos, autorização, assets privados/Range/cancelamento e renderer dos DTOs. |
| `node --import tsx --test tests/unit/portal-page-editorial-config.test.ts tests/unit/portal-page-editorial-integration-guard.test.ts tests/unit/portal-page-editorial-preview.test.ts` | PASS | 20 testes; inclui preservação News/import map e guard offline. |
| `node --import tsx --test tests/unit/portal-page-editorial-config.test.ts tests/unit/portal-page-editorial-integration-guard.test.ts` | PASS | 8 testes: slots, destinos de mídia, focus wrapper, News e 4 cenários do runner. |
| `npm run typecheck` em `cms/` | PASS | TypeScript sem emissão. |
| `npm run test:unit` em `cms/` | PASS | 687 casos: 676 PASS, 11 SKIP opcionais (PGlite indisponível), 0 FAIL. |
| `npm run generate:importmap` com `CMS_BUILD_ONLY=true` e `NEXT_PHASE=phase-production-build` | PASS | Gerado pela CLI; imports anteriores mantidos e quatro entradas Portal Pages acrescentadas. |
| `npm run generate:types` com as mesmas variáveis | PASS | Executado pela CLI; nenhum delta de tipo necessário. |
| `node --check` dos runners MJS e do guard MJS | PASS | Sintaxe local; não inicia Payload nem serviços. |
| `npm run verify` | BLOCKED (ambiente) | Suite raiz: 1.960 PASS, 14 FAIL por `directory_overlaps_repository` nos testes preexistentes `payload-preview-https`/`payload-preview-preparation`: o temp autorizado está sob `C:\Users\Criação\.git` e o helper o recusa. Os testes CMS não são alcançados por esse runner; foram executados separadamente acima. Nenhum serviço foi iniciado. |
| `git diff --check` | PASS | Sem erros de whitespace. |

## Guard e integração nativa

O novo runner dedicado é `npm --prefix cms run test:portal-pages:integration`.
`--check-config` exige opt-in, URLs loopback distintas com nomes `test`/`dev`,
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

## Docker e recursos

- Docker observado como disponível (`29.5.3`); nenhuma ação Docker foi executada.
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
