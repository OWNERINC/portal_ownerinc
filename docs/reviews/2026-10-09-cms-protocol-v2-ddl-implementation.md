# Gate 1 — ledger DDL qualificado e diagnóstico de operação

Data: 2026-10-09. Frente 4, escopo bounded autorizado. Base Git observada:
`7893d35ae896e9b6ca51aae27cd5f8d3c7acf7ab`; mudanças locais, sem commit/push.

## Resultado e limite de aceite

O finalizer cria o ledger explicitamente em `public` mantendo
`SET LOCAL search_path = pg_catalog, public`. A instalação fria identifica qual
dos três statements falhou sem analisar/splitar SQL nem registrar mensagens do
driver. Contratos instalados V1/V2 continuam verificados estritamente; reentrada
não reinstala tabelas, funções ou grants. `coverageVersion=0` e `ready=false`
continuam invariantes desta operação.

**PASS local:** testes offline, reprodução SQL PostgreSQL 16.4 via PGlite WASM,
comparação independente de catálogo legado/corrigido e rollback transacional.
**PENDENTE:** review independente e aceite PostgreSQL 16 Linux em duas fixtures
novas e independentes (`fresh-v2` e `upgrade-v1`). Não houve execução destes
scenarios nesta frente, autenticação PostgreSQL de roles ou ativação editorial.

O `42501` histórico do fixture `7908a0d1...` continua **hipótese causal**, não
causa retrospectivamente comprovada: seu relatório privado com statement exato,
SHA e configuração não foi recuperado. Negações esperadas do observer não são
esse erro de instalação e não são tratadas como regressão.

## Alterações sob ownership desta frente

- `cms/src/publication/mutation-ledger.ts`: qualifica CREATE de head/events,
  INSERT inicial e FK para `public.news_migration_runs`; exporta três statements
  imutáveis com operações fechadas. Conserva `NEWS_MUTATION_LEDGER_DDL` como batch
  composto dos mesmos statements para callers de integração existentes.
- `cms/scripts/finalize-news-protocol.ts`: executa cada statement em ordem, sob
  a mesma transação/lock `7194030`, e associa a falha à operação ativa. Mantém
  preconditions, inventários, verificação instalada, COMMIT/ROLLBACK e resultado.
- `cms/tests/integration/protocol-finalizer.mjs`: aceita somente a cauda estrita
  de diagnóstico abaixo e instala a fixture V1 pelo SQL legado congelado. Nesta
  fixture de teste, o ledger legado usa `search_path=public`, restaurando
  `pg_catalog, public` antes das funções; não é mudança do finalizer de produção
  nem alegação sobre o contexto do run histórico.
- Testes de protocolo: `cms/tests/unit/news-protocol-finalizer.test.ts`,
  `cms/tests/unit/news-protocol-v2-integration.test.ts`,
  `cms/tests/unit/news-protocol-ledger-ddl.test.ts`,
  `cms/tests/integration/protocol-finalizer-guards.test.mjs`,
  `cms/tests/integration/protocol-ledger-pglite.test.ts` e fixture independente
  `cms/tests/fixtures/protocol-ledger-legacy.ts`.

Não foram alteradas as seis migrations históricas, o snapshot nativo, os builders
de funções/triggers/bootstrap, nem os testes `preauthority-catalog*`. Alterações
preexistentes de outro owner no parser de expressões do finalizer foram
preservadas; não pertencem a esta entrega. Arquivos de ops/runtime/recovery,
consumidores operacionais de diagnóstico e runbooks compartilhados também não
foram editados por esta frente.

## Contratos, hashes e catálogo

Qualificar o alvo de criação corrige resolução de schema sem substituir o
contrato instalado. `protocolFunctionBodies` no finalizer obtém os corpos exatos
dos builders de mutation triggers, item binding e bootstrap V2; não extrai
funções do ledger DDL. `canonicalTriggerDefinitions` também continua obtendo
suas definições desses mesmos builders. Nenhum corpo, assinatura, owner, ACL,
`SECURITY DEFINER`, `proisstrict` ou configuração de função foi alterado aqui.

O texto-fonte do batch **muda**; eventual hash de SQL bruto não deve ser chamado
de hash inalterado. O teste offline compara o SQL anterior congelado com o atual
permitindo apenas as quatro qualificações e whitespace entre statements. O teste
PGlite instala cada forma separadamente e compara colunas/ordem/tipos/defaults,
owners observados, constraints/FK e definições de índices sob o mesmo search_path
de deparse. O head inicial também é idêntico; events está vazio. Esse snapshot
é limitado ao ledger e à tabela referenciada mínima, não um fingerprint integral
de CMS, ACLs de roles autenticadas ou aceite V1/V2 completo.

Os snapshots/hashes do runner real continuam usando seu contrato existente.
Identidades físicas/OIDs de uma instalação nova não são prova de equivalência
com outra instalação. Reentrada no estado instalado preserva os objetos em vez
de recriá-los; o upgrade real deve preservar o V1 instalado e adicionar somente
o bootstrap V2 e os grants já definidos. Não há relaxamento de strict checks
para acomodar diferença de definição.

## Diagnóstico finito e sanitização

Ordem preservada: `ledger-head-create`, `ledger-head-init`,
`ledger-events-create`. Exemplo de saída permitida:

```text
CMS news protocol diagnostic: phase=protocol-ledger-ddl reason=database_error sqlstate=42501 operation=ledger-head-create ddl_source=mutation-ledger expected_owner=cms_admin
```

- `operation` é selecionada do inventário fechado, não do erro do banco.
- `ddl_source=mutation-ledger` e `expected_owner=cms_admin` são literais estáticos
  do installer admin-only. **Owner esperado não é owner observado**, identidade
  autenticada provada nem descrição de quem possui as funções (`cms_control`).
- SQLSTATE continua somente `none` ou cinco caracteres maiúsculos/dígitos.
  Razões e fases continuam allowlisted. Mensagem/detail/hint/SQL/URLs/caminhos
  e campos arbitrários de erro não entram no diagnóstico.
- O runner rejeita operações desconhecidas, fonte/owner não fixos e cauda de
  ledger fora de `protocol-ledger-ddl`; não retém os valores rejeitados.
- Diagnósticos anteriores sem operação continuam aceitos. Diagnósticos de
  triggers e de fechamento de conexão mantêm seus contratos anteriores.

Propagação implementada somente no CLI do finalizer e no runner de protocolo sob
ownership desta frente. Se outra frente quiser consumir os novos campos em seus
relatórios de ops/runtime/fixture, precisa coordenar com seus próprios owners;
nenhum desses consumidores foi modificado ou certificado aqui.

## Reprodução local autorizada

Usou-se o módulo PGlite **já instalado** fora do checkout, com banco em memória,
sem install/download, listener, dataDir persistente, URL de DB ou serviço externo.
O teste opt-in recebe o caminho absoluto do entrypoint CJS em
`OWNERINC_PROTOCOL_PGLITE_MODULE`; não altera dependências do projeto.

```powershell
# A variável deve apontar para o módulo local já existente, sem instalar pacote.
node --import tsx --test tests/integration/protocol-ledger-pglite.test.ts
```

Executar esse comando de `cms/`, com a variável fornecida privadamente. Sem ela,
o teste é SKIP, não PASS. O teste não faz parte do discovery de unit tests de
`npm run verify`; foi executado explicitamente neste aceite local.

Evidência observada da execução final:

| Probe | Resultado |
| --- | --- |
| Engine/version | PGlite WASM / PostgreSQL `16.4` |
| Configuração inicial PGlite | `allow_system_table_mods=on` |
| Configuração explicitamente reproduzida na transação | `allow_system_table_mods=off`, `search_path=pg_catalog, public` |
| Primeiro CREATE legado | `42501`, alvo `pg_catalog.owner_news_mutation_head` reconhecido internamente; mensagem não impressa |
| SQL corrigido, mesma configuração | Três statements executados, objetos em `public` |
| Comparação catálogo legado/corrigido | Igualdade estrutural exata do snapshot limitado |
| SHA-256 desse snapshot limitado | `f07458931047bdd592abaf58cb23fb3634217bbdd59b405aa2c83ac77681cc92` |
| Head inicial | coverage `0`, barrier `open`, igual ao legado |
| Rollback após sucesso | Baseline de catálogo restaurada, sem ledger em `pg_catalog` |
| Falha por duplicação do CREATE head dentro da transação | `42P07`, rollback sem resíduos |
| Falha por duplicação do INSERT inicial dentro da transação | `23505`, rollback sem resíduos |
| Falha por duplicação do CREATE events dentro da transação | `42P07`, rollback sem resíduos |

O probe ajusta uma opção que PGlite habilita para seu bootstrap; não pressupõe
que esse `on` seja default do PostgreSQL de produção ou do fixture histórico.
Não se habilitou `allow_system_table_mods` no código de produção, nem se
concederam privilégios em `pg_catalog`, memberships ou superuser ao runtime.
WASM comprova estes comportamentos SQL, **não** identidade/session_user, ACLs de
roles autenticadas, concorrência do protocolo, filesystem Linux ou publicação.

## Verificações

- Suíte focada de protocolo: **218/218 PASS**, sem skips, cobrindo operações
  individualmente, rollback e interrupção antes das próximas fases, sanitização,
  reentrada V2 sem DDL, rejeição de estado parcial sem reparo e contrato V1.
- Reprodução PGlite opt-in: **1/1 PASS**, sem skips.
- `npm run typecheck:cms`: PASS, sem cache incremental.
- `npm run verify`: PASS na execução final (`verify: ok`); Portal **1517 PASS /
  0 FAIL / 7 SKIP** (1524 testes), CMS **448 PASS / 0 FAIL / 10 SKIP** (458 testes).
  Inclui typecheck offline, scanner de segredos e validação declarativa de Compose.
  Os skips não são aceite de integrações ausentes; incluem probes opcionais PGlite
  de outras frentes e limitações de fsync/symlinks Windows. Não iniciou serviços.
- `npm run security`: PASS; API, cron e CMS com **0 vulnerabilidades** reportadas
  pelos audits de dependências de produção.
- `git diff --check`: PASS.
- Nenhum CI, commit/push, SSH, produção, serviço externo ou delegação executado.
  Review independente permanece a cargo da sessão primária.

Comando reproduzível da suíte focada, de `cms/`:

```sh
node --import tsx --test tests/unit/news-protocol-finalizer.test.ts tests/unit/news-protocol-ledger-ddl.test.ts tests/unit/news-protocol-v2-integration.test.ts tests/unit/news-protocol-observer-integration.test.ts tests/unit/news-mutation-sql.test.ts tests/integration/protocol-finalizer-guards.test.mjs
```

## Fila após review e Gate 1 Linux

1. Review bounded destas mudanças, incluindo sanitização, fixture legada e
   diferenças de ownership preexistentes no mesmo worktree.
2. Autorizar separadamente duas leases PostgreSQL 16 Linux novas e independentes:
   `fresh-v2` e `upgrade-v1`. Não reutilizar o fixture histórico `7908a0d1...`.
   Executar o harness com guards intactos; comprovar cold start, V1 legado,
   upgrade, reentrada, ACLs/roles reais, RPC, lock, rollback e snapshots intactos.
3. Se o relatório histórico for disponibilizado pelo custodiante, conferir SHA,
   statement e configuração sem segredos e reclassificar a hipótese somente se
   a evidência permitir. O PASS novo não reescreve o resultado antigo.
4. Só depois, priorizar Gate 2: compatibilidade de alvo/identidade física,
   bootstrap controller com COMMIT confirmado antes de Payload adquirir `7194030`,
   correção da importação/reconciliação preservando IDs/drafts/histórico/mídia e
   política temporal. Nenhuma CLI apply será aberta por esta correção de DDL.
5. Gate 3 permanece separado: coverage real, drain, seal, prova durável, CAS,
   abertura/worker e ensaio de rollback. Nada disso foi implementado ou ativado
   nesta onda. Corrigir `42501` não certifica o editor funcional nem cutover.
