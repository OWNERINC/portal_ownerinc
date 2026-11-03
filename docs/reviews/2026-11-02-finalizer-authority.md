# Finalizer: autoridade de ownership e diagnóstico `42501`

## Decisão sugerida

Publicar primeiro um diagnóstico finito por operação da fase `protocol-grants`,
preservando SQL, ordem, agrupamento de queries, transação, roles e coverage 0.
Executar novamente somente a qualificação descartável em CI. A correção funcional
precisa usar cada owner apropriado; mover `RESET ROLE` isoladamente é insuficiente.

## Fatos comprovados

- O run GitHub `41550800535` executou o commit
  `52b63ad482af70590238f25708e2cf83bcb2ecdf` e falhou com
  `phase=protocol-grants reason=database_error sqlstate=42501`. O runner confirmou
  a parada dos serviços próprios. A mensagem exportada não identifica a query.
- Duas análises independentes Astra xhigh inspecionaram o commit publicado e
  fizeram uma rodada de crítica cruzada. O bloco de instalação publicado é
  idêntico ao bloco da árvore em integração; a extração de catálogo não foi
  executada nesse CI.
- `cms/scripts/provision-db.ts` estabelece roles sem superuser/INHERIT. Admin
  pode executar SET ROLE para migrator, runtime e control, mas não herda seus
  privilégios. Migrator não pode tornar-se control. Control já tem CREATE no
  schema: acrescentar esse privilégio não resolveria o conflito.
- `migrationOwnedProtocolDDL()` remove as transferências de ownership dos
  builders. Assim, as funções criadas sob migrator continuam migrator-owned.
  Após `RESET ROLE`, o finalizer tenta transferi-las como admin.
- PostgreSQL 16 exige que o current user tenha os privilégios do owner antigo,
  possa tornar-se o novo owner e que este tenha CREATE no schema. Admin falha na
  primeira condição; migrator falharia na segunda se o RESET fosse apenas movido.
  Ownership do banco/schema não implica ownership das funções contidas.

## Hipóteses não confirmadas

A primeira transferência, de `owner_news_mutation_guard_stmt()`, é a explicação
mais forte para o erro observado. O contrato de observer também pode lançar
`42501` explicitamente. Sem discriminação da query, não se afirma qual instrução
o servidor recusou nesse run.

## Divergências resolvidas

- O GRANT redundante de schema USAGE feito por migrator sem grant option tende a
  produzir warning/no-op porque ele já possui privilégios nesse schema. Não é
  causa `42501` demonstrada.
- Cinco identificadores de operação bastam para o próximo diagnóstico:
  `runtime-grants`, `observer-relation-grants`, `admin-role-reset`,
  `ownership-transfer`, `observer-privileges-verify`.
- O batch de cinco ALTERs deve permanecer intacto. A falha do primeiro interrompe
  o batch; não existe evidência de cinco falhas executadas. Separação adicional
  só será necessária se a nova evidência exigir discriminação por função.
- O builder de observer que revoga CONNECT no Portal não participa desta fase:
  o finalizer usa normalização de relações. A revogação sem autoridade também
  pode ser warning/no-op se PUBLIC TEMPORARY continuar disponível; não foi
  classificada como falha determinística desse run.

## Riscos residuais

Sob o fluxo e contratos atuais:

1. `verifyInstalled()` lê o head como admin, que não tem SELECT no head
   migrator-owned. Isso afeta reentrada e verificação V1 antes do upgrade.
2. O runner manual ainda usa admin para SELECT FOR UPDATE/UPDATE de coverage.
   Sua substituição pela fixture CAS canônica é um incremento separado.
3. Replay de `--grants` como migrator tenta REVOKE em funções que, após uma
   instalação correta, pertencem a control. A normalização de funções precisa
   respeitar o owner.
4. O harness `protocol-finalizer.mjs` tem instrumentação de event trigger como
   admin não-superuser e fixture V1 criada sob admin. Esses caminhos não provam
   fidelidade ao contrato atual. Trocar apenas o instalador do event trigger
   também não resolve o conflito com o inventário restrito de ownership.
5. Os doubles atuais aceitam ALTERs e retornam owner esperado sem reproduzir as
   permissões PostgreSQL. Testes role-aware serão regressões de modelo, não
   qualificação do servidor.

## Plano de verificação

O diagnóstico opcional deve ser vinculado à fase e à allowlist, capturado antes
do rollback e transportado pelo formatter, wrapper manual e extrator TAP reais.
Regressões devem cobrir cada fronteira, primeira falha preservada, nenhum COMMIT
ou avanço após recusa e rejeição de accessors, valores arbitrários e conteúdo
privado. Nenhuma query adicional será executada na transação já abortada.

Depois da revisão e do verify do snapshot exato, o CI PostgreSQL 16 identifica a
operação recusada. A futura correção funcional exige provas nativas de cold
install, upgrade V1 legítimo, reentrada V2, replay de grants e rollback atômico.
Um PASS em mocks não substitui essas provas.

## Condições para implementação

A execução contínua autoriza o diagnóstico delimitado. A correção funcional
continua condicionada a um ordenamento revisado e à evidência subsequente:

- Migrator cria relações/ledger, aplica grants de dados e instala triggers.
- Control cria funções diretamente sob seu owner final e normaliza suas ACLs.
- Admin orquestra com os memberships SET já existentes.
- Leituras de head usam uma identidade já autorizada e restauram a identidade
  esperada; não acrescentam grants amplos a admin.
- Finalizer mantém coverage 0; qualificação CAS e admissão produtiva são distintas.

A criação de triggers exige EXECUTE nas funções. Usar o EXECUTE PUBLIC padrão
somente enquanto as funções recém-criadas ainda estão na mesma transação não
commitada, revogando-o antes de verificar/commitar, é uma **proposta de ordenamento**.
Ela ainda precisa de revisão e prova PG16: não há autorização para substituir
isso silenciosamente por grants extras, memberships, INHERIT ou superuser.

## Fontes e limite da evidência

- [Run manual](https://github.com/OWNERINC/portal_ownerinc/actions/runs/41550800535)
- [PostgreSQL 16 ALTER FUNCTION](https://www.postgresql.org/docs/16/sql-alterfunction.html)
- [PostgreSQL 16 role membership](https://www.postgresql.org/docs/16/role-membership.html)
- [Checagem de ownership no PostgreSQL 16](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/commands/alter.c)

Fonte e documentação sustentam a incompatibilidade de permissões; o CI original
sustenta somente a falha agregada exportada. Nenhuma execução PostgreSQL local,
mutação produtiva ou alteração de roles foi realizada nesta análise.

## Evidência posterior — batch identificado

O run manual [41559359225](https://github.com/OWNERINC/portal_ownerinc/actions/runs/41559359225)
executou `1310efcf9efbc47ce7a159c89e336f89a5122b0f`, depois da publicação do
diagnóstico finito e de verify isolado PASS. Terminou FAIL com:

```text
phase=protocol-grants reason=database_error sqlstate=42501 operation=ownership-transfer
```

O runner informou serviços próprios parados e evidência privada retida. Essa
observação localiza a recusa no batch de ownership; não demonstra cinco ALTERs
executados, nem identifica a falha da fixture browser. Os riscos de leitura do
head, replay de grants e harness V1 continuam distintos. O próximo reparo exige
ordenamento owner-scoped revisado e qualificação PG16 exclusivamente em CI.

## Decisão posterior — reparo owner-scoped autorizado

Duas análises Astra xhigh independentes e uma rodada cruzada concluíram o desenho.
O plano de implementação é
[`2026-11-03-protocol-owner-source-repair.md`](../superpowers/plans/2026-11-03-protocol-owner-source-repair.md).
A autorização cobre fonte e CI descartável, conforme a execução contínua; a
qualificação PostgreSQL e o aceite operacional continuam gates separados.

### Decisão e divergência resolvida

A proposta histórica de depender do EXECUTE PUBLIC padrão foi substituída por
uma política explícita e restrita. No cold install, control cria as funções sob
seu owner final e revoga PUBLIC. Na mesma transação, concede EXECUTE sem grant
option somente a migrator em `owner_news_mutation_guard_stmt()`,
`owner_news_mutation_capture_row()` e `owner_news_migration_item_binding_guard()`.
Migrator instala os triggers; control revoga os três grants antes da verificação
final e do COMMIT. Seal/bootstrap não recebem esse grant; upgrade V1 e reentry V2
também não o executam. Não há fallback PUBLIC, mudança de default ACL, membership,
INHERIT, CREATE adicional ou elevação de atributos.

Os builders passam a expor fragmentos explícitos por owner. Agregados históricos
e bytes canônicos permanecem; o caminho operacional deixa de executar qualquer
transferência de ownership. A leitura administrativa do head usa `cms_runtime`,
conferindo identidade e restauração para admin. O observer mantém leitura direta,
read-only e sem SET/RESET.

### Replay delimitado e riscos residuais

`--grants` permanece pure-migrator e adquire `7194030` antes da classificação.
Normaliza somente relações/sequences/colunas/defaults relacionais; verifica as
ACLs de funções e recusa drift com rollback, sem reparo ou credencial alternativa.
A classificação é aplicabilidade de ACL: absent, V1-shaped ou V2-shaped. Inspeciona
namespace `owner_news_`, assinaturas, owners, ACLs, overloads e relações necessárias;
não certifica corpos/triggers completos e não impõe coverage 0, população vazia ou
barrier open. NULL ACL usa os defaults reais do PostgreSQL.

V1 legítimo recebe apenas bootstrap e nove grants INSERT-column. Reentry V2 é
verification-only. O harness Desktop existente requer superuser/`pg_control_system()`
como admin e cria event triggers/V1 sob identidades incompatíveis. A qualificação
será um driver Linux PG16 CI com CLI real e fault injection em cliente PG real,
sem novos objetos de instrumentação ou privilégios para acomodar o harness.

### Verificação e condição de aceite

Regressões role-aware, comparação independente com bytes publicados, transporte
de diagnóstico finito, revisão fresca e verify do pacote exato precedem publicação.
CI deve provar cold V2, upgrade V1 com OIDs/dados preservados, reentries, replay
incluindo coverage 1 populado, drift/rollback, restauração de identidade e triggers
funcionando após remover EXECUTE temporário. Essa execução ainda está pendente.
CAS manual/browser, H1 físico e recuperação ativa permanecem trabalhos distintos.

### Ampliação delimitada durante implementação

O implementador encontrou em `observerRelationProvisioningSQL()` uma revogação
de defaults de funções, além dos grants relacionais. O primário conferiu o helper
e seu verificador e autorizou somente o arquivo adicional
`cms/scripts/news-protocol-observer-contract.ts`: extrair um fragmento relacional
explícito, preservando API/bytes do agregado histórico para os demais consumidores.
Finalizer e `--grants` usarão o novo fragmento. Drift de defaults de funções do
observer deve continuar sendo recusado pelo verificador, com rollback; não será
normalizado silenciosamente. A restrição de privilégios aprovada permanece.

O primeiro foco do implementador ainda tinha sete falhas de testes e um erro de
tipagem; o pacote não foi entregue como concluído. Comparações independentes dos
agregados/corpos/80 triggers passaram no worker, mas a repetição primária e a
revisão fresca dependem da conclusão das correções. Baseline do arquivo adicional
retido em `.openchamber/reviews/protocol-owner-before/observer-scope-amendment.json`.

## Entrega e repetição primária do reparo

O implementador concluiu 14 arquivos de delta relativo ao baseline preservado,
incluindo o helper puro de funções e seu teste. Primário reconferiu os 14 hashes
e LF, leu o diff de orquestração/provisionamento/fragmentos e repetiu os 11 arquivos
focais: **612 PASS /0 FAIL /0 SKIP**, 17,6 s, em
`sh_19f4d2e410017JceRSZ01RZcPi`. Typecheck CMS sem cache incremental também **PASS**.
Isso supera as sete falhas e o erro de tipagem do primeiro foco incompleto.

Os checks incluem 45 fronteiras de queries cold e 26 upgrade, em 142 execuções
injetadas com rollback normal/falho, além dos contratos de ACL, identidade e
compatibilidade. Os agregados mutation/bootstrap/binding preservam respectivamente
40.075 /5.274 /2.751 bytes; cinco corpos e o mapa dos 80 triggers são idênticos às
expectativas independentes de `1310efc`. APIs observer históricas permanecem
byte-identical para `ownerinc` e `portal_main`.

A revisão fresca `ses_e60b24301ffejP4zp7k7TrwrNe` recebeu **ship de fonte** sobre
o delta relativo de 14 arquivos. Não executou testes e não revisou o pacote
posteriormente extraído. Manifest e diff desse delta estão em
`.openchamber/reviews/protocol-owner-source/`, patch SHA-256
`cc26e95c1308d0f1b77697824a32ae5bc39efe3b60c39b9175a67f68483afef9`.
O primário prepara o pacote sobre `75a83b8`: binding/fragmentos voltam ao local
publicado dentro do finalizer; a extração runtime-catalog WIP não será dependência.
Verify e revisão do pacote exato ainda pendem; qualificação PG16 continua não executada.

O foco primário da extração sobre `75a83b8` passou: **322 PASS /0 FAIL /0 SKIP**
em quatro arquivos, `sh_19f53ea2c001pKIotIUHv83y2v`, incluindo os hashes históricos
e os testes de orquestração/replay. A tentativa anterior foi iniciada na raiz do
clone e não resolveu `tsx`; repetir no diretório `cms/` corrigiu a invocação, sem
instalação de dependências nem mudança de fonte. O catálogo WIP permanece ausente
da extração; o binding e seus fragmentos ficam locais no finalizer publicado.
