# Owner News — base de importação Payload (Task11 em integração)

Esta entrega implementa a base local da Task11 e um preflight real somente leitura.
Não oferece CLI de aplicação nem prova de cutover. O contrato compartilhado do bundle pertence a
`scripts/owner-news-payload/bundle.mjs`; o importador não aceita o bundle A1/A2 como
se fosse esse formato.

## Preflight local (somente leitura)

Com Node/dependências já existentes, execute da raiz do repositório:
`node --import tsx cms/scripts/import-owner-news.ts --bundle <manifest-absoluto>`.
`--dry-run` é opcional e padrão. Configure privadamente
`OWNER_NEWS_SOURCE_DATABASE_URL`, `OWNER_NEWS_TARGET_DATABASE_URL`,
`OWNER_NEWS_SOURCE_ID`, `OWNER_NEWS_SOURCE_UPLOAD_DIR` e
`OWNER_NEWS_TARGET_UPLOAD_DIR`. Não usa `.env`, `DATABASE_URL` nem
`CMS_DATABASE_URL`. URLs precisam ser loopback e databases `dev`, `local` ou
`test`; origem/destino precisam ser bancos físicos distintos. O preflight confere
cluster+database via system identifier PostgreSQL e OID, schemas Legacy-only e
Payload-only, autoridade frozen/epoch e não sobreposição dos roots privados do
bundle, uploads e destino. Sem permissão para `pg_control_system()`, falha fechado.
Credenciais, connection strings e caminhos não são impressos.

O `loadBundle` da Task10 valida bytes exatos de manifesto/revisões/assets e as
assinaturas. Contagens representam inventário esperado, não o banco de destino.
O resultado indica explicitamente que reconciliação do destino NÃO foi feita; o
fingerprint da origem ainda é o declarado no bundle até a reexportação real.
`--apply` retorna `import_apply_not_ready` após os probes read-only: não cria run,
não grava arquivos/dados, não aplica migration e não inicia jobs.

## Implementado

- `cms/src/news/import-article.ts` conserva IDs apenas no adapter de importação e
  compõe a transação recebida, sem abrir/comitar uma unidade independente.
- `cms/src/migration/transaction.ts` exige transação viva e lock7194030. Transações
  próprias exigem confirmação durável após COMMIT. O adapter instalado pode
  absorver erros de COMMIT; sua Promise resolvida não comprova persistência.
  Confirmação ausente/divergente/indisponível produz `commit_outcome_unknown`.
- `migration/staging.ts` valida bytes/SHA/MIME/tamanho, reserva nome UUIDv4 em
  journal privado e promove por hard link exclusivo, sem overwrite. O UUID público
  do asset é preservado separadamente. Não existe limpeza automática destrutiva.
- `migration/plan.ts` consome os validadores reais da Task10 e mantém publicação,
  draft incompleto, histórico e snapshot separados. As agendas permanecem
  suspensas; ator desconhecido e instante vencido são exceções explícitas.
- `migration/reconcile.ts` compara itens por identidade e hash; assets requerem
  observação de bytes verificados. Este comparador puro não comprova leitura de
  banco/volume. `contentReadyForSeal` não é aprovação de cutover.
- `migration/preparation-run.ts` lê/trava o run durável e exige identidade/epoch
  exatos, preparação aberta, estado preparando e COMMIT reconhecido. A autoridade
  Portal/ator/capability é responsabilidade da integração Task12 anterior à leitura.

O plano interno contém conteúdo privado. Somente `summarizeImportPlan` pode ser
usado como saída de relatório. Datas originais permanecem strings; precisão além
de milissegundos gera exceção explícita até fechar a política nativa. Título e
categoria históricos vêm do snapshot do documento e mantêm metadataBasis honesta.
Hashes históricos e hashes de snapshots em Blocks nativos não são intercambiáveis.

## Staging, backup e recuperação

Sob o volume CMS privado, o journal fica em
`.owner-news-import/<manifestSHA>/<assetUUID>/`. Inclui `intent.json`, `bytes`,
recibos de staging/promoção e recibos append-only de COMMIT desconhecido ou
reconhecido. Nomes `.attempt-UUID` podem permanecer após interrupção; não apagar
por idade ou porque um recibo de sucesso não existe.

Backup inclui esse diretório inteiro, os arquivos finais, ledger CMS, PortalDB e
uploads legados, depois da drenagem de importações, manutenção e workers. Restore
deve preservar recibos de resultado desconhecido e reconciliar linhas + bytes.
ACK posterior não elimina o recibo desconhecido anterior.

`resumeStagedImportAsset` revalida o journal e os bytes contra as expectativas do
manifesto, sem depender da árvore original estar online. Nunca usar o próprio
journal como a única fonte do hash esperado. Resultado de COMMIT desconhecido
exige reconciliação em request novo; não repetir mutação cegamente.

Em Linux, arquivos e diretórios são sincronizados antes de declarar durabilidade.
No Windows, ausência de fsync de diretório retorna `directorySynced=false` e
`assertDurablePromotion` bloqueia aplicação. Testes Windows de bytes/restart não
são evidência de recuperação após perda de energia em Linux.

## Bootstrap de roles de controle — Gate B

`cms-cluster-bootstrap` é o único criador e reconciliador das seis roles CMS. Ele
usa a credencial separada do administrador do cluster e reconcilia exatamente:
`cms_admin`, `cms_control`, `cms_controller`, `cms_migrator`, `cms_runtime` e
`cms_observer`. As cinco roles de login recebem senhas protegidas e distintas;
`cms_control` permanece `NOLOGIN`. Todas permanecem `NOSUPERUSER NOCREATEDB
NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`, `CONNECTION LIMIT -1`, sem
expiração e sem configuração persistente por role; cada reconciliação executa
`RESET ALL`. Essa exclusividade é somente CMS: `api/db/provision.js` permanece o
domínio separado que cria/reconcilia `portal_api` e `portal_cron`; o bootstrap CMS
não cria nem altera essas roles Portal.

`cms_admin` recebe somente memberships em `cms_control`, `cms_migrator` e
`cms_runtime`, sempre com `ADMIN FALSE, INHERIT FALSE, SET TRUE`. Isso permite o
`SET ROLE` necessário ao DDL e a transferência posterior de ownership sem dar
autoridade para criar roles ou herdar privilégios no login. `cms_controller` e
`cms_observer` não recebem memberships. Qualquer membership extra é removida pelo
bootstrap e rejeitada pelas verificações.

O nome do database Portal é obrigatório em `CMS_PORTAL_DATABASE_NAME`, validado
como identificador PostgreSQL simples e sem default dentro do código. O Compose
produtivo o deriva de `${POSTGRES_DB:-portal}`; preview deriva `portal_test` de
`POSTGRES_DB=portal_test`. Database ausente ou nome inválido falha antes da
reconciliação. O bootstrap usa quoting de identificador e revoga `CONNECT` nesse
database configurado de todas as roles CMS e de `PUBLIC`; as roles Portal continuam usando seus grants explícitos. No database
`ownerinc_cms`, somente os grants necessários são reaplicados. `cms-provision` e
`--bootstrap-control` não criam nem alteram roles: aplicam apenas grants locais.
`--verify-control` confere o contrato local e faz o login probe do controller sem
imprimir credenciais. `CMS_OBSERVER_PASSWORD` e `CMS_OBSERVER_DATABASE_URL` são
obrigatórias nos ambientes que executam bootstrap/auditoria e permanecem fora do
web runtime, migrator e provisionador comum.

O cluster bootstrap instala em `ownerinc_cms` o helper bounded
`cms_cluster_guard.verify_cms_ownership_contract()`. Seu corpo `SECURITY DEFINER`,
com owner cluster-admin e `search_path=pg_catalog`, enumera em `pg_shdepend` todas
as dependências de ownership cujo `dbid` é o database atual, sem lista frágil de
classes, além da linha de ownership do próprio database. Ele devolve somente
contagens agregadas e o booleano allowlisted; não expõe OIDs, nomes, outros
databases nem acesso genérico ao catálogo. Somente `cms_admin` e `cms_observer`
recebem `USAGE` no schema dedicado e `EXECUTE` nessa função. O finalizer limitado
chama o helper e não lê diretamente `pg_authid` ou `pg_shdepend`. Password presence
é verificada apenas pelo cluster-bootstrap privilegiado; o finalizer valida os
atributos integrais, database owner, as três memberships exatas e ausência de
`CONNECT` ao Portal.

## Finalizer one-shot e auditoria instalada

O finalizer admin one-shot **está implementado** em
`cms/scripts/finalize-news-protocol.ts`. A chamada explícita
`node --import tsx cms/scripts/finalize-news-protocol.ts --finalize-protocol`
usa `CMS_ADMIN_DATABASE_URL` e `CMS_PORTAL_DATABASE_NAME`, validadas para
`cms_admin`, o database exato `ownerinc_cms` e o Portal configurado. Uma única SQL
reutilizada por provision, grants, control, verificação e finalizer exige `LOGIN`,
todos os seis atributos negativos, `CONNECTION LIMIT -1`, validade null/infinity,
`rolconfig NULL` e ownership de `ownerinc_cms`; esses caminhos apenas observam a
role e nunca a reconciliam. É uma operação potencialmente mutável: sob transação e advisory
lock 7194030 instala ledger/functions/triggers/grants **e o RPC V2** se o
protocolo estiver ausente; V2 exato é verificado sem DDL. A versão vem do
inventário de catálogos (assinaturas, contagem, corpo canônico, owner,
`SECURITY DEFINER`, `search_path` e ACL efetiva), nunca de `coverage_version`.
O login `cms_admin` precisa permanecer não-superuser. O finalizer executa o DDL
nativo com `SET LOCAL ROLE cms_migrator`, volta a `cms_admin` e transfere somente
as funções aprovadas para `cms_control`; as memberships exatas são revalidadas
antes de qualquer DDL.
Depois de `npm run migrate`, o caminho comum `provision-db.ts --grants`, sob
`cms_migrator`, revoga grants atuais e default privileges do observer sobre
tables/sequences/functions, concede `SELECT` somente em `payload_migrations` e
`owner_news_mutation_head` e executa a verificação efetiva. Receiver, initializer,
sequência manual e preview alcançam esse caminho antes do finalizer/readiness;
criação da role continua exclusiva do cluster bootstrap.

O inventário V1 exato contém `owner_news_mutation_guard_stmt()`,
`owner_news_mutation_capture_row()`,
`owner_news_seal_run(uuid,text,integer,bigint,text,text,text)` e
`owner_news_migration_item_binding_guard()`. V2 acrescenta somente
`owner_news_bootstrap_run(uuid,text,text,text,integer)`. Overloads, assinaturas,
funções ou estados parciais/mistos fora desses contratos exigem recuperação
manual; o finalizer não tenta repará-los.

Em V1, a chamada ordinária falha com o diagnóstico estável
`protocol_upgrade_required` **sem executar DDL**. A atualização é uma operação
separada e explícita:

```sh
node --import tsx cms/scripts/finalize-news-protocol.ts --upgrade-protocol-v1-to-v2
```

Ela revalida profundamente o V1 sob a mesma transação/lock `7194030`, adiciona
somente a função V2 e seus grants mínimos e verifica o V2 antes do commit. Se
V2 já estiver instalado, essa operação também é somente verificação. Nenhuma
dessas operações insere uma linha em `news_migration_runs`; no cold start a
tabela permanece sem run até uma chamada explícita ao RPC. As seis migrations
Payload aplicadas e o snapshot nativo permanecem inalterados.

`owner_news_bootstrap_run(run_id uuid, manifest_sha256 text, source_instance
text, source_fingerprint text, authority_epoch integer) RETURNS TABLE(id uuid)`
é uma função `SECURITY DEFINER` pertencente a `cms_control`, com `search_path`
fixo `pg_catalog, public`. Entre roles caller, somente `cms_controller` recebe
`EXECUTE` explícito; `cms_control` conserva a autoridade inerente a owner. A função
rejeita qualquer `session_user` diferente de `cms_controller`, inclusive uma
chamada autenticada por outra role que tente `SET ROLE`. Runtime e controller
não recebem `INSERT` na tabela. `cms_control` recebe somente `INSERT` nas nove
colunas nomeadas pela função, além dos privilégios mínimos já existentes para
consultar/serializar o ledger.

O RPC valida UUID não nulo, hashes SHA-256 hexadecimais minúsculos, identidade
de origem com 1–128 caracteres e epoch inteiro de 1 até 2147483646. Depois de
validar a identidade de sessão, toma `7194030`, trava e valida o único head
com barrier aberto e coverage observado válido (0 ou 1), sem alterar coverage,
e só então procura os dois identificadores imutáveis: UUID
do run e hash do manifesto. Colisão cruzada ou divergência de qualquer uma das
cinco entradas imutáveis é conflito. Retry idêntico retorna o ID sem DML nem
alteração de timestamps; inclusive esse retry exige barrier aberto. Uma nova
identidade cria um run em `preparing`/`open`/`acknowledged`, com exceções `[]`,
deixando reconciliação, selagem, ativação e timestamps sob seus defaults
nativos. O trigger existente registra exatamente um evento e avança o head;
RPC não escreve evento/head diretamente. Esse bootstrap não valida/reconcilia
conteúdo de origem ou destino e não certifica coverage, readiness, drain,
admission, cutover ou publicação.

`source_instance` continua sendo a identidade **de origem do bundle**, não a
identidade física PostgreSQL de destino. Um futuro cliente/controller deve
vincular separadamente o alvo ao system identifier e database OID verificados,
comitar o RPC controller antes de Payload adquirir `7194030`, e só então abrir
outra transação Payload usando evidência Portal fresca. Esse helper/caller ainda
não faz parte desta fatia.

Importa os builders canônicos e verifica schema, history, ACLs, ownership e
triggers. Não executar o finalizer como substituto de auditoria read-only.

A cobertura continua estrita no finalizer: `coverage_version` deve permanecer
**0** e o retorno `ready` permanece `false`. O finalizer não ativa escritores,
admission, leitores, readiness ou cutover.

O comando `npm --prefix cms run audit:news-protocol` é a auditoria **somente
leitura** do protocolo instalado. Exige `CMS_OBSERVER_DATABASE_URL` explicitamente
com role `cms_observer` e database `ownerinc_cms`; não usa fallback para URL admin,
runtime, migrator ou `DATABASE_URL`, não carrega `.env` e não provisiona a role.
O builder em `cms/scripts/news-protocol-observer-contract.ts` pressupõe a role já
criada pelo `cms-cluster-bootstrap`; ele valida seus atributos e aplica somente
grants locais. Não aceita senha e não contém `CREATE ROLE` ou `ALTER ROLE`. O CLI
de auditoria nunca provisiona a role.

A auditoria inicia uma transação PostgreSQL `REPEATABLE READ READ ONLY`, limita
`statement_timeout` local a cinco segundos, fixa `search_path` local para
`pg_catalog, public` e confere a identidade efetiva, database,
membership/atributos públicos da role e seus privilégios efetivos. A
única leitura de dados fora dos catálogos permitida é `payload_migrations` e o
registro único `owner_news_mutation_head`; não lê artigos, mídia, schedules, jobs,
histórico ou eventos do ledger. ACLs efetivas também rejeitam grants `PUBLIC` sobre
relações/colunas da aplicação e execução pública de funções de protocolo (além do
baseline seguro de `gen_random_uuid`). O relatório informa
`observedProtocolVersion: 1 | 2`, derivado do catálogo, separadamente de
`observedCoverageVersion: 0 | 1`; observar V2 não ativa o protocolo. Também
informa sequência e write barrier, mas sempre mantém `ready=false`,
`admissionActivated=false`, `releaseCertified=false`,
`writeCoverageCertified=false` e `drainVerified=false`. Isso não certifica
coverage, seal, admission, destino, writes ou liberação.

Ownership é verificado pelo helper agregado instalado pelo cluster bootstrap, que
cobre toda classe registrada em `pg_shdepend` para o database atual sem revelar
objetos ou outros databases. O contrato exige que `cms_observer` não possua
objetos locais. `pg_authid`, hashes de senha e `pg_shdepend` não são lidos
diretamente pela sessão observer. O
database indicado é conferido pelo nome `ownerinc_cms`,
mas identidade física de cluster não é afirmada. Sem executar uma integração
separada e autorizada, nenhum estado remoto ou catalog foi observado.

A implementação do bootstrap e a compatibilidade offline do observer não são
aceite PostgreSQL. Aceitação de protocolo V2 exige autorização separada e duas
fixtures/leases novas, independentes: uma para cold install e outra para upgrade
V1. Não reutilizar fixture/lease do observer, lease anterior, database existente,
serviço em execução ou destino remoto. O harness de
`cms/tests/integration/protocol-finalizer.mjs` contém os cenários explícitos
`fresh-v2` e `upgrade-v1`, mas sua preparação e execução continuam condicionadas a
revisão fresca e autorização explícita da sessão primária. Nenhum aceite real
RPC/evento/retry/upgrade V2 é afirmado aqui.

Com Node 24, dependências CMS previamente instaladas, Docker local e imagem
PostgreSQL 16 em cache, use somente após essa autorização e prepare uma lease nova
para cada cenário:

```sh
node cms/tests/integration/protocol-finalizer.mjs --prepare-lease --scenario fresh-v2
node cms/tests/integration/protocol-finalizer.mjs --execute --scenario fresh-v2 --lease "<lease privada recém-preparada>"
node cms/tests/integration/protocol-finalizer.mjs --prepare-lease --scenario upgrade-v1
node cms/tests/integration/protocol-finalizer.mjs --execute --scenario upgrade-v1 --lease "<outra lease privada recém-preparada>"
```

`--prepare-lease` inspeciona Docker local/cache, namespace UUID, porta loopback
e parent privado, e grava a lease em diretório privado; não cria container,
volume ou database nem conecta ao PostgreSQL. `--execute` consome a lease uma
vez, cria recursos isolados novos, vincula container/IP/system identifier,
database, catálogos e snapshots, e preserva os artefatos depois da claim mesmo
em falha. O relatório contém somente fases/códigos fixos, contagens, booleans e
hashes; não contém URLs, senhas nem conteúdo de run.
O cenário cold exige seis migrations nativas, tabela de runs vazia, V2 exato,
head aberto em sequence zero, zero eventos antes do bootstrap, observer read-only
e finalizer sem DDL/state change na reentrada. O cenário de upgrade constrói o V1
exato sem RPC, exige `protocol_upgrade_required` sem mutação, injeta apenas no
fixture um abort transacional no `ddl_command_end` do `GRANT INSERT` final: o
marcador não transacional só avança depois que o catálogo mostra o RPC owned por
`cms_control` e os nove ACLs de coluna INSERT exatos; a prova consulta o catálogo
no evento `GRANT`, sem depender de linhas de detalhe retornadas por
`pg_event_trigger_ddl_commands()`. Depois do rollback, o
harness consulta independentemente os privilégios efetivos e ACLs, ausência do
RPC, catálogo V1/head/coverage/run/event e estado nativo antes do upgrade
explícito bem-sucedido. Ambos usam conexões de rede autenticadas para provar
RPC, evento/retry e negações; `cms_controller` e `cms_runtime` também tentam o
mesmo INSERT válido em transação e exigem SQLSTATE `42501`, `ROLLBACK` e
snapshots head/run/event inalterados. A identidade de controller nunca é
simulada com `SET ROLE`.

Essa implementação/harness e seus guards offline não equivalem à execução da
aceitação. Até autorização e execução das duas leases independentes, PostgreSQL 16
continua pendente; não reutilizar o fixture/lease do observer, leases anteriores,
bancos existentes ou serviços.

As coleções `NewsMigrationRuns`/`NewsMigrationItems` estão registradas em
`cms/src/payload.config.ts`, têm definição na configuração nativa e aparecem na
migration revisada `20261006_181424_z_owner_news_native`. **Não foi confirmado aqui
se essa migration está aplicada em algum database.** Seus hooks ainda negam writes
sem as capabilities de preparação/controle; não habilitar escrita removendo o
guard. Task12 precisa vincular run/manifesto/epoch em frozen, instrumentar todas
as mutações e selar a mesma linha de run antes de ativação Portal.

Continuam pendentes o escritor por unidade documental com auditoria, reconciliação
real do destino, registro nativo de mídia staged, schemas de agenda suspensa e
materialização pós-ativação, integração serial de config/tipos/migrations e
evidência real de rollback externo/COMMIT perdido/Linux. Nenhuma migration ou
ativação é implícita nesta base.
