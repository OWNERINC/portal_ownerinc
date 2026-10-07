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

## Integração ainda necessária

### Bootstrap de roles de controle — fase 1 somente

Depois do provisionamento CMS já existente (`--provision`) e antes da migration
nativa, a preparação autorizada de roles usa a conexão
`CMS_DATABASE_URL` apontada explicitamente para `ownerinc_cms` como `cms_admin`.
`--bootstrap-control` exige que essa role seja superuser: `CREATE ROLE` precisa de
`CREATEROLE` (ou superuser), mas os grants mínimos também precisam ser concedidos
no banco e no schema `public`, atualmente de propriedade do migrator. A checagem
superuser é intencional e evita presumir grant options que não foram verificadas.

Forneça `CMS_CONTROLLER_PASSWORD` apenas ao processo one-shot de bootstrap. O valor
precisa passar as mesmas regras de tamanho/placeholder/caracteres do provisioner e
ser distinto do runtime, migrator, senha PostgreSQL/admin e demais segredos/URLs de
banco presentes no ambiente. O provisioner cria somente roles ausentes: `cms_control`
NOLOGIN e `cms_controller` LOGIN, ambas sem poderes elevados, `NOINHERIT` e sem
membership. Roles existentes nunca recebem `ALTER ROLE` ou rotação silenciosa; se
atributos, password-presence ou memberships em qualquer direção não baterem, a
transação falha e é revertida. Além disso, o bootstrap pré-finalizer recusa roles
de controle que já possuam objetos ou privilégios efetivos em tabelas/sequences
nativas; esse guard estrito não é reutilizado depois da instalação legítima.
`controlRolesVerificationSQL` é read-only e reutilizável pelo finalizer futuro.

Grants da fase 1 ficam limitados a CONNECT no database; `cms_control` recebe USAGE
e CREATE em `public`, e `cms_controller` recebe somente USAGE. `CREATE` em schema é
pré-requisito do PostgreSQL para transferir ownership de uma função para
`cms_control`; `ALTER FUNCTION ... OWNER` também exige que o ator seja o dono atual
da função ou superuser (esta divisão designa o admin one-shot como ator; não se
concede membership ao migrator/control). Nenhum CRUD em tabelas ou sequences é
concedido por este bootstrap.

Com configuração privada já fornecida, as chamadas explícitas são
`node --import tsx scripts/provision-db.ts --bootstrap-control` antes da migration
nativa e `node --import tsx scripts/provision-db.ts --verify-control` para conferir
identidade das roles em qualquer fase. Ambas exigem URL/identidade atuais de
`cms_admin`, database `ownerinc_cms` e o mesmo `CMS_CONTROLLER_PASSWORD`; a
verificação executa um controller login probe sem imprimir a credencial. CREATE
ROLE é cluster-global no PostgreSQL; por isso o bootstrap não é embutido em
migration Payload nem executado pelo migrator. Senhas e URLs não são impressas.

Handoff para o finalizer: `controlRolesVerificationSQL` verifica atributos
explícitos, login esperado, password presence, zero membership nas duas direções,
CONNECT e privilégios mínimos de schema. É phase-agnostic e não inspeciona
ownership, ACLs de protocolo, funções ou readiness; portanto `--verify-control`
**não** é verificação integral do protocolo. `controlRolesOwnershipVerificationSQL`
e `controlRolesNativePrivilegesVerificationSQL` são guardas bootstrap-only:
recusam qualquer ownership inicial e CRUD/sequences em objetos nativos antes de
criar as roles. `controlRolesBootstrapSQL(password)` cria apenas roles ausentes e
concede somente os grants de database/schema acima; não altera atributos/password
de roles existentes. `run('--bootstrap-control')` e `run('--verify-control')`
exigem admin superuser + alvo explícito. O finalizer ainda não implementado deve
validar ownership por allowlist estrita (incluindo apenas as funções SECURITY
DEFINER aprovadas), objetos/ACLs/triggers canônicos e demais invariantes; até essa
validação existir, a verificação integral fica PENDENTE. Não reutilizar os guards
bootstrap-only depois que `cms_control` possuir funções de protocolo.

Isto conclui apenas bootstrap de principals. A migration nativa continua usando
`cms_migrator` sem `CREATEROLE` ou memberships. Um finalizer admin one-shot separado
deve ser implementado pelo responsável da integração e importar os builders
canônicos; ele ainda não existe nesta alteração. Este bootstrap **não** instala
ledger/functions/triggers, não verifica runtime readiness, não habilita writes e
nunca promove `coverage_version`: ela deve permanecer **0**, inclusive depois do
futuro finalizer, até aceite separado de writes nativos/jobs, finalização/drain e
prova durável verificada pela autoridade primária.

As coleções `NewsMigrationRuns`/`NewsMigrationItems` estão definidas, mas não
registradas/migradas. Seus hooks negam inclusive writes com override até chegar o
guard real de preparação/controle. Não habilitar as coleções removendo o guard.
Task12 deve vincular run/manifesto/epoch em frozen, instrumentar a sequência de
todas as mutações e selar a mesma linha de run antes da ativação Portal.

Faltam o bootstrap protegido, escritor por unidade documental com auditoria,
reconciliação real de destino, registro nativo de mídia staged e schemas de agenda
suspensa/materialização pós-ativação. Também são necessárias integração serial de
config/tipos/migrations e evidência real de rollback externo/COMMIT perdido/Linux.
Nenhuma migração de banco ou ativação é implícita nesta base.
