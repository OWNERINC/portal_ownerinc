# Runtime Payload e recuperação coordenada

Estado: preparação inativa reportada instalada na VPS em 2026-10-08: receiver
comum, guard, overlay de rede e configuração privada CMS. A evidência histórica
da VPS registra `runtime/payload-control` ausente e nenhum runtime, banco ou
worker CMS iniciado. O adapter e seus helpers existem agora **somente neste
checkout**: não foram instalados, revisados independentemente nem aceitos em
runtime. Evidência histórica e limites: [preparação da VPS](../reviews/2026-10-08-cms-vps-infrastructure-preparation.md).
Não executar deploy, comandos SSH, cutover ou alterações de serviços sem autorização.

## Stack opcional e credenciais

`docker-compose.payload.yml` é acrescentado à stack Portal. Sem esse arquivo,
API/cron continuam independentes do CMS em autoridade `legacy`. A API recebe
`CMS_INTERNAL_URL`; o CMS consulta o Portal por HTTP privado, nunca pelo PortalDB.
`cms-postgres` usa PostgreSQL16, banco `ownerinc_cms`, sem porta publicada.
Persistência: `cms_postgres_data` e `cms_uploads_data`, separadas dos volumes antigos.

`cms-provision` recebe somente credencial administrativa e senhas de migrator/runtime;
`cms-control-roles` é um serviço one-shot isolado por profile e recebe a credencial
`cms_controller` junto das credenciais necessárias à verificação. CMS web/worker
recebem somente `cms_runtime`. A preparação privada gera a senha distinta do
controller. Os deploys verificam as roles com `--verify-control` e, somente se a
verificação falhar, executam o bootstrap estrito antes da migration nativa; roles
existentes nunca têm atributos/senhas alterados. Bootstrap rejeita ownership ou ACLs
nativas inseguras, e a verificação de release continua obrigatória. Provisionamento
revoga CREATE/PUBLIC e concede privilégios existentes/defaults. Startup verifica
identidade/grants sem DDL. Migrations CLI terminam antes de web/worker. `push:false`
e ausência de `prodMigrations` permanecem obrigatórios; nenhum autoRun no web.

Imagem única `ownerinc-portal-cms@sha256:...` para todos os processos CMS. Dockerfile
multi-stage Node24 preserva CLI, tsx, configs e migrations; executa como `node`.
Volume CMS `/var/lib/ownerinc-cms/media` nasce com proprietário node e modo0700;
fica fora de `/app`, que é a raiz do código para o guard de storage, inclusive
quando Next muda `import.meta.url` no bundle. API legada mantém `/app/uploads`.
O journal de importação fica em `/var/lib/ownerinc-cms/media/.owner-news-import/`.
Volumes existentes
não são corrigidos por chmod/chown destrutivo automático. Validar permissões no
ensaio. Código compartilhado API/cron mantém APIs Node18, sem alegar que CMS seja
compatível com Node18. Arquivos Linux usam LF.

Build usa **contexto raiz** e `--file cms/Dockerfile`; preserva `/app/cms`,
`/app/scripts` e `/app/api`, com `WORKDIR /app/cms`. O ignore específico
`cms/Dockerfile.dockerignore` usa allowlist e tem precedência sobre `.dockerignore`
da raiz, que continua excluindo scripts para as outras imagens. Não usar contexto
`cms` nem `COPY . .` da raiz. Os módulos de bundle/export/import legado, validators
API e hashes CMS são copiados nos paths originais. `createRequire(api/package.json)`
resolve o grafo **API** instalado explicitamente por seu lockfile (`sharp`/`pg`);
não depende de hoisting do CMS nem de symlink entre grafos.

O guard de storage considera localização do módulo e cwd: com cwd `/app/cms`,
`runtimeCheckout` é `/app`, portanto `/app/uploads` também é inválido para os
assets CMS, inclusive quando Next altera `import.meta.url` no bundle. O volume CMS
fica fora desse root; `.owner-news-import/` fica dentro de
`/var/lib/ownerinc-cms/media`, junto aos bytes promovidos/ambíguos. Uploads Portal
continuam em `/app/uploads`. Nome de volume mantido; nenhuma movimentação de dados
ou mudança de container ocorreu nesta alteração de fonte.

O estágio runtime executará `scripts/check-runtime-packaging.mjs`: imports puros
de producer/consumer e decoding PNG sintético com sharp, sem inicializar Payload
ou conectar ao banco. O build/container real ainda exige lease; smoke local da
closure com dependências instaladas não comprova binários Linux nem imagem final.
CI/SBOM precisa abranger os dois grafos npm contidos na imagem CMS.

O overlay usa build de produção (`NODE_ENV=production`); sessões locais integradas
precisam de origem HTTPS/ingress local autorizado. Não habilitar cookie insegura
de produção para contornar isso. Firebase Emulator pode continuar sendo a fonte
de identidade sintética; o primary deve coordenar TLS e portas do ensaio.

Os placeholders em `.env.example` servem para **parse**, não execução. O
provisionador recusa senhas placeholder. Não imprimir `docker compose config`
com credenciais reais: usar `--quiet` ou parser com ambiente sintético.

## Proxy e CSP

Next16 `src/proxy.ts` gera nonce por request, sobrescreve headers não confiáveis
e entrega a mesma CSP ao request Next e à resposta. Preserva Origin em ações e
exceção service-only estreita. Nginx não emite segunda CSP editorial e mantém a
política do Portal nos demais paths. Headers comuns continuam herdados.

Somente criação news-media aceita51MiB; JSON editorial6MiB. Endpoints privados
com/sem barra e `/_next/image` estão bloqueados; `^~ /_next/` evita captura pelas
locations estáticas. Bytes privados/HTML/APIs continuam no-store.

**Pendente lease do primary:** build produção, Nginx real, nonce efetivo nos scripts
HTML/RSC/Server Actions, Firebase Emulator, logout/BFCache, uploads privados/Range,
Monaco/Lexical/worker CSP e restart. Unit não demonstra hidratação. Browsers
suportados ainda precisam de decisão/evidência; não existe matriz inventada aqui.

## Release e formato de backup

`.ci-images`: exatamente duas linhas API/cron para legacy; três API/cron/CMS para
Payload. `.image-env`: API_IMAGE/CRON_IMAGE, e para CMS também CMS_IMAGE e
RELEASE_FORMAT=payload-v1. Parser recusa duplicados, campos desconhecidos,
referências mutáveis ou CMS parcial. Não carregar manifesto por source/eval.

Conjunto legacy preservado: postgres.dump/uploads.tar.gz e manifest.sha256.
Conjunto payload-v1:

1. postgres.dump — PortalDB, autoridade e sessões;
2. uploads.tar.gz — todos os uploads legados;
3. cms-postgres.dump — conteúdo, jobs, versões, import/mutation ledgers;
4. cms-uploads.tar.gz — **todo** CMS_UPLOAD_DIR, inclusive `.owner-news-import/`,
   staging, promoções, órfãos e bytes com COMMIT desconhecido;
5. release.images, operations-proof.json e backup.format — metadados verificados;
6. manifest.sha256 — sete entradas exatas, incluindo todos os metadados acima.

Backup diário e pré-release usam o mesmo contrato. CMS não aplica expurgo automático
enquanto política coordenada/ambiguidades estiver pendente; legacy mantém14dias.
S3 só copia conjunto verificado; erro preserva cópia local. A agenda diária continua
com S3 desativado. Não alegar recuperação de perda da VPS por backup no mesmo host.

## Lease e barreira externa

`runtime/deploy.lock` é único para release/backup/restore/import/manutenção.
Coordenador abre fd9 e adquire flock antes de qualquer transação DB; filhos recebem
o descriptor e conferem inode, sem readquirir recursivamente. O wrapper diário já
é o coordenador e passa fd9 ao helper. Nunca remover/substituir esse lock.

Import/manutenção externos precisam entrar por `ops/payload-writer.sh`, em foreground,
antes de conectar ao banco. O wrapper confere o journal assinado em estado `open`
e o sentinel após adquirir o lock. Seus filhos não podem daemonizar/fechar fd9 cedo.
A integração desses callers com threads3/4 ainda é necessária; até lá, não executar
import/finalizer junto com a instalação fria. Um caller que ignore o lock ainda
pode abrir uma corrida depois da última observação e invalida a garantia.

`ops/payload-operations-guard.sh` fecha admissão por sentinel no mesmo runtime e
recusa containers/one-shots inesperados. Os serviços nginx/api/cron/cms são parados
e aguardados; `cms-worker` não é iniciado nem retomado, e worker ainda ativo bloqueia
o preflight. Depois o adapter inspeciona `pg_stat_activity` nos bancos envolvidos
e recusa conexões de cliente restantes antes do capture/restore. Essas checagens
não executam finalizer, não inspecionam ledger de cutover/selo e não substituem a
integração futura dos writers externos. A lease operacional permanece durante
dumps sequenciais. Falha conserva evidência e admissão fechada; estado de serviços
deve ser inspecionado antes de recuperação explícita.

O controle de banco nesta fase valida Portal schema/autoridade/grants e catálogo
CMS nativo ausente, sem transação Portal→CMS nem DDL de protocolo. Não alegar
reconciliação de `COMMIT` desconhecido, aprovação de coverage ou selo de cutover.

## Adapter de controle: fonte Task 2, aceitação runtime pendente

`ops/payload-control`, `ops/payload-control-runtime.py`,
`ops/payload-control-state.py` e `ops/payload-control-inventory.py` implementam nesta fonte o controller limitado à
fase `preauthority`. O guard falha se os artefatos não estiverem instalados no
runtime. A implementação local ainda não comprova PostgreSQL, Docker, `flock`
Linux, arquivos de produção ou recuperação real; não instalar nem ativar sem
revisão e aceitação separadas. A ausência do adapter no host continua sendo o
estado da evidência histórica da VPS, não uma afirmação sobre este checkout.

O inventário operacional protegido (`runtime/payload-control-inventory.json`)
é root:root 0600, validado canonicamente e incluído na identidade assinada do
estado/provas. Ele fixa projeto, runtime/release/lock, raízes de backup e as
quatro identidades/labels/mounts Docker. O runtime não aceita troca de projeto,
override de ambiente/Compose/backup nem endpoint Docker por variável. A instalação
deriva os caminhos dos defaults do preparador e recusa um inventário existente
que difira deles. O preparador instala também `runtime/payload-control-inventory.py`;
não instalar isoladamente os três helpers.

Verbos invocados com `(ação, releaseAbsoluta, evidênciaOpcional)`: release-preflight,
close-admission, quiescence-proof, backup-metadata, restore-preflight, prepare-restore,
portal-restore-intermediate, verify-restored, verify-release, rollback-check,
open-admission.

### Grants do Portal e sessão administrativa v2

Uma leitura PostgreSQL read-only reportada pelo primary confirmou no host a
migration `036_payload_editorial_control`, as colunas `token_hash`, `user_uid`,
`expires_at`, `revoked_at`, `created_at`, chave primária em `token_hash` e índice
de expiração válido. O mesmo relato confirmou que `portal_api` não tem nenhum dos
sete privilégios de tabela em `cms_editor_sessions`, e `portal_cron` também não
tem nenhum. Isso é um **floor legado observado**, não prova de grants nem aceite
de sessão v2.

O preflight frio admite somente esse floor antigo, com todos os sete privilégios
efetivos ausentes para ambos os papéis; essa exceção existe apenas antes da
provisão v2, no início da instalação fria. Ela não relaxa os gates pós-provisão.
Após o backup legado coordenado e ainda sob `runtime/deploy.lock`, o fluxo padrão
deve executar o `migrate` normal, que chama `grantRuntimeAccess`, seguido de
`verify-migrations.js`, antes de iniciar a API candidata. O floor pós-provisão
exige exatamente `SELECT`, `INSERT`, `UPDATE` e `DELETE` para `portal_api` em
`cms_editor_sessions`, nenhum `TRUNCATE`, `REFERENCES` ou `TRIGGER`, e nenhum dos
sete para `portal_cron`; o verificador de migration também valida os grants de
`owner_news_authority`. O controller recusa grants parciais ou o floor antigo em
gates estritos. Se a provisão/verificação falhar, não iniciar a API v2, manter a
admissão fechada e preservar o backup para revisão. Não contornar privilégios nem
concedê-los manualmente fora do fluxo revisado. Se a ordem do deploy exigir um
estágio direcionado separado, ele deve ocorrer sob o mesmo lock e somente depois
de um backup real com metadados capturados; essa mudança operacional ainda não
foi executada no host.

- backup-metadata assina prova JSON canônica privada com fase, authority/epoch,
  imagens, identidade/OID das bases, migrations verificadas, protocol ausente,
  fingerprints de dados e hash/tamanho dos dois artefatos legacy ou quatro
  artefatos Payload. Não grava credenciais nem conteúdo. A prova não é selo de
  cutover.
- restore-preflight valida manifesto, prova/assinatura, arquivos e tar seguro,
  floor/catalog e identidade atual do alvo. `prepare-restore` repete a checagem de
  intent/alvo e sessões PostgreSQL imediatamente antes de cada etapa destrutiva;
  não compara identidades de clone com as identidades da origem.
- Depois do `pg_restore` Portal, `portal-restore-intermediate` repete proof, lease,
  identidade, shape/quiescência e exige somente os dois floors de grants completos
  conhecidos, além do fingerprint Portal restaurado. O coordenador então executa o
  `migrate`/`verify-migrations` padrão sob o mesmo lock; o próximo `prepare-restore`
  exige grants v2 estritos antes de tocar o CMS. Falha em reprovisionamento ou no
  gate estrito conserva admissão fechada e não inicia a próxima destruição.
- verify-restored compara fingerprints de ambas as bases e árvores de arquivos,
  além de authority, migrations e catálogo CMS esperado, antes de reabrir admissão.
- rollback-check limita a primeira instalação a rollback de aplicação, condicionado
  à prova do backup legado e ao Portal ainda em authority legacy/1; não restaura nem
  apaga volumes/banco CMS, mantém CMS web/worker parados e nunca inicia o worker.
  O container de banco CMS pode continuar executando, sem acesso público. Após a fase migrada, só aceita o
  mesmo floor CMS preauthority, sem fallback de dados para legacy.
- verify-release verifica imagens/processos e o catálogo CMS nativo read-only;
  não prova a aceitação de browser/sessão v2 nem inicia job, import ou finalizer.

### Aceitação de recuperação descartável Task 3 — código pronto, CI pendente

`scripts/test-payload-preauthority-recovery.mjs` e os fixtures
`scripts/integration/payload-preauthority-*` preparam projetos/volumes com nomes
aleatórios fora do namespace de produção, inventários independentes e registros,
arquivos e credenciais sintéticos. O alvo recebe confiança explicitamente pelo
identificador do inventário da origem e pela cópia host-a-host da chave de fixture;
a chave não integra os conjuntos de backup. O runner chama o coordenador e o adapter
reais sob lock herdado, testa rejeições pré-destrutivas e compara dumps completos,
schemas/catálogos, sequências e árvores de arquivos após dois restores, preservando
o anúncio legado pelo UUID exato da origem (e confirmando ausente o seed do alvo),
authority `legacy/1`, protocolo ausente e worker parado.
O setup CMS descartável também reproduz a sequência de produção: depois de
`cms-provision`, executa o serviço perfilado `cms-control-roles` com uma senha
`cms_controller` sintética e privada, sobrescrevendo o comando com `--bootstrap-control`
antes de `cms-migrate`. Isso cria e verifica somente as roles baseline
`cms_control`/`cms_controller` e seus grants mínimos; não instala o protocolo nem
relaxa a checagem de roles. O `verify-release` continua exigindo esse contrato, então
roles ausentes/inseguras falham antes da verificação do protocolo/catálogo.
Somente o overlay descartável define `CRON_BOOTSTRAP_ONLY=true`; o runner confere
o ambiente efetivo do container cron, aguarda sua healthcheck real e repete snapshots
com os writers parados. Para a identidade dessas comparações (não para os backups
assinados), remove somente o par de linhas `\restrict KEY`/`\unrestrict KEY` no
prologue/rodapé do `pg_dump`; conteúdo de dados, sequências e demais linhas permanece.

O CI segue: build/teste/scans de imagens e dependências → publish dos três digests
imutáveis do mesmo SHA → recuperação real nesses digests exatos → manifesto de
candidato qualificado separado, que vincula run/SHA/digests ao SHA-256 do relatório
redigido. A publicação do candidato e seu manifesto de digests **não** são
qualificação nem deploy. Relatórios de falha são artifacts redigidos; o fixture
privado fica somente no host descartável durante a vida do runner. O recovery não
é iniciado por `npm run verify` e não foi executado nesta entrega porque o Docker
local não está disponível. Só um relatório real com `status=passed` gera o artifact
qualificado; até esse run, Task 3 permanece sem aceite runtime.

Em falhas de comando, o relatório inclui um subpasso estático, exit code, SQLSTATE
identificador de erro PostgreSQL e identificador de erro do adapter somente quando
reconhecidos. Comando, argumentos, stderr/stdout e valores SQL não são serializados
nem impressos. O campo plano `sqlState` só é interpretado nas chamadas `psql` de seed
marcadas e configuradas com `VERBOSITY=sqlstate`; apenas a linha completa `ERROR:
<código conhecido>` em maiúsculas é aceita. Nos contextos explícitos `release-preflight` e
`verify-release`, o adapter Python emite o motivo fixo como uma linha simples em
stderr; runtime, state e inventário são limitados a uma allowlist finita de códigos.
Quando `cms-preauthority-verify` rejeita o catálogo, uma linha estruturada preserva
somente stage, motivo enumerado e SQLSTATE validado. Uma segunda linha opcional para
mismatch de constraints preserva categoria enumerada, identidade escolhida apenas do
inventário esperado da release candidata já validada pelo adapter (manifesto protegido
e arquivos regulares, sem symlink/hardlink e com owner protegido); não consulta o
checkout do controller nem aceita um caminho arbitrário por variável de ambiente.
Contagens e SHA-256
das definições são preservados; SQL e nomes observados não são impressos. O relatório de recuperação mantém esse resumo sob
`nativeCatalogVerifier.constraintMismatch`. Falha de execução sem essa linha e falha
de inicialização local do Compose recebem identificadores/stages distintos da rejeição
do catálogo. Mensagens fixas do guard são mapeadas apenas no contexto próprio e em
correspondência da linha inteira. Códigos desconhecidos, linhas com texto adicional e
stderr fora desses contextos não viram identificadores; conteúdo bruto permanece
somente no arquivo privado do fixture.

Diagnóstico do run Linux `37889449231` (fonte `427f974`): readiness inicial/restart
da origem e snapshots quiescentes passaram, mas `verify_release_source` recusou o
CHECK `legacy_news_revisions_metadata_basis_check`, antes de qualquer aceite de
restore. O SHA observado `d745997d2ddc6747dcdaf1d922d92b00366775f74f38caad50e48620dc5239f4`
foi reproduzido exatamente localmente com as seis migrations reais, compiladas
pelo `PgDialect` do Drizzle e executadas em PGlite 0.2.17/PostgreSQL 16.4 WASM:
`pg_get_constraintdef` acrescenta whitespace aos literais JSONB. O esperado continua
derivado da migration, não do catálogo observado. A comparação canônica agora trata
somente objetos JSONB planos com valores string (sem perder valores/chaves, sem
arredondar números e recusando duplicatas), expansão de `BETWEEN`, a representação
`NOT (IS DISTINCT FROM)` e literais bigint→numeric canônicos dentro do limite int8.
Não remove casts arbitrários, não ignora CHECKs e não aceita apenas pelo nome.

A mesma inspeção local cobriu todos os 24 CHECKs, cujas definições renderizadas estão
em `cms/tests/fixtures/native-checks-pg16.ts` como entradas observadas de regressão.
Também identificou duas regex históricas, em `source_identity` e
`import_provenance_shape`: o `\.` escrito no template JavaScript da migration é
cozido como `.` antes de chegar ao PostgreSQL (portanto casa qualquer caractere,
não somente ponto). A extração do esperado reproduz essa semântica do SQL realmente
executado, somente na fonte; não reescreve regex observada. As migrations permanecem
intactas. Corrigir a restrição histórica exigiria decisão/migration separada antes
de confiar nela como validação estrita de timestamp; não faz parte deste reparo.

Isso é evidência local de parser/catálogo, **não** aceite PG16.14/Linux ou recuperação.
Após revisão independente, o primary deve conferir todos os 24 CHECKs no ambiente
Linux descartável com as seis migrations, sem parar no primeiro mismatch, e então
executar os gates reais de recuperação. Nenhum restore bem-sucedido é alegado aqui.

O run seguinte `37897903239` (fonte `7bd24fa`) passou pelos CHECKs e recusou o
inventário em `native_types`. A causa reproduzida localmente não foi enum extra:
as seis migrations geraram exatamente os 61 enums do snapshot, incluindo os enums
internos do Payload. A consulta agregava `pg_enum.enumlabel` como `name[]` (OID
1003); o driver `pg` instalado devolve esse tipo como string, e o mapper anterior
a substituía por `[]`. PGlite sozinho decodifica esse array, portanto um teste que
usasse apenas seu decoder esconderia a falha. A consulta agora agrega `::text`
com fallback `text[]` (OID 1009), decodificado pelo `pg`, e recusa explicitamente
labels que não sejam array de strings. Nomes, schemas, valores e ordem dos labels
continuam comparados exatamente com o snapshot, nunca aprovados a partir do observado.

O filtro de tipos exclui somente rowtypes ligados à própria relação e arrays
automáticos com binding recíproco `typelem`/`typarray` e dependência interna no
catálogo. Não usa prefixo de nome nem allowlist de `typtype` para descartar tipos:
composites standalone, domains, enums, ranges/multiranges e tipos base/shell extras
permanecem sujeitos à rejeição. O fixture estático
`cms/tests/fixtures/native-types-pg16.ts` preserva os 61 payloads capturados para
regressão com o decoder real de `pg`; não contém dados de usuários ou credenciais.

Depois desse reparo, a sequência **nativa completa** de consultas do verificador
(relações, colunas/defaults, índices, constraints e tipos) passou nas seis migrations
executadas em PostgreSQL 16.4/WASM local, com parsers do `pg` aplicados aos OIDs reais.
DDL real de teste para composite standalone, domain, enum, range/multirange, shell,
base type e enum em outro schema foi rejeitado; cada caso foi revertido e o catálogo
original voltou a passar. A consulta final das 39 tabelas de mutação retornou zero.
Isso não executou conexão/autenticação, provisão de roles, Docker nem restore.
O relatório Linux ainda não contém catálogo bruto para comparar; aceite PG16.14,
recuperação dos quatro stores e revisão independente do patch continuam pendentes.

A revisão seguinte identificou um bypass nos filtros de schema: `_` em SQL `LIKE`
é wildcard, portanto `NOT LIKE 'pg_toast%'` / `NOT LIKE 'pg_temp_%'` escondia schemas
legais como `pgxtoast_hidden` e `pgxtempyhidden`. As quatro consultas nativas de
relações, índices, constraints e tipos agora excluem somente `pg_toast`,
`pg_toast_temp_<dígitos>` e `pg_temp_<dígitos>` por regex ancorada, além dos nomes
exatos `pg_catalog` e `information_schema`. Nenhum lookalike é classificado como
namespace interno por prefixo aproximado.

`cms/tests/unit/preauthority-catalog-pg16.test.ts` executa as seis migrations e as
consultas **reais**, com decoder `pg`, em PGlite em memória quando esse módulo de
teste já estiver disponível. Pode-se apontar `CMS_TEST_PGLITE_MODULE` para o caminho
absoluto de um módulo PGlite existente; não instala dependências, abre conexão de
rede nem usa arquivos de banco. Sem módulo, registra skip explícito; um caminho
fornecido inválido falha, não vira skip. Nesta revisão o teste foi executado com o
módulo local PG16.4/WASM: enum, domain, composite standalone e tabela com índice/CHECK
foram criados em **ambos** os schemas lookalike e rejeitados. Cada consulta afetada
foi executada diretamente, inclusive índices/constraints que o fail-fast de relações
normalmente impediria alcançar. Uma tabela temporária real confirmou as exclusões
de `pg_temp_N`/`pg_toast_temp_N`, e o inventário completo voltou a passar após cada
rollback. Esse teste não substitui o gate Linux PG16.14 nem o restore real.

A parada de `api`, `cron` e `cms` mantém `docker compose stop --timeout 120` por
writer. O deadline do subprocesso agora cobre o pior caso serial de todos os
writers selecionados mais 30 s de margem (390 s para os três), sem remover nem
encurtar o timeout do Docker. O snapshot só começa após `stop` terminar com sucesso
e uma consulta confirmar que nenhum writer continua em execução; timeout continua
sendo falha fechada, nunca autorização para capturar estado parcialmente ativo.

Falhas de readiness incluem apenas motivo enumerado, estado/health/exit code do
container e, para CMS, o status HTTP numérico de `/editorial/ready`; o corpo nunca é
lido. Stderr de comandos diagnósticos fica, quando disponível, em arquivo 0600 sob
diretório 0700 dentro do fixture root efêmero. O workflow publica somente o relatório
redigido, nunca esse arquivo privado. O relatório também registra progresso por
papel fixo (`source`, `target`, `leaseTarget`): readiness CMS inicial, readiness dos
writers após restart e estado da comparação de snapshots (`not_started`, `running`,
`passed`, `failed`). Isso mantém visível uma comparação concluída mesmo se a
restauração dos writers falhar depois.
Se a comparação e a restauração falharem na mesma passagem, o relatório mantém
os dois resumos estáticos separados em vez de deixar a falha de restart ocultar a
falha de snapshot. O `verify-release` seguinte à comparação usa stage por papel e
subpasso fixo `payload_control_verify_release`; stderr da chamada fica somente no
arquivo privado do fixture quando houver conteúdo.
O runtime exige UID 0 (`owner_root=True`) nos arquivos protegidos; não há variável
de owner configurável nem comparação com um valor `uid:gid`. O fixture confirma
UID 0 em inventário, lock, ambiente e overrides, preservando o GID existente, e
inclui uma negativa pelo `verify-release` real com lock temporariamente não-root.
Uma única lease herdada (`fd 9`) permanece aberta durante a troca de UID, chamada
do guard/adapter e restauração por `EXIT` trap; o script confirma que o caminho e
o descritor continuam apontando ao mesmo device/inode e que UID/GID retornam aos
valores protegidos antes de liberar a lease. A negativa só é descartada após o
stderr exato `unsafe_required_owner` e a restauração serem confirmados. Em falha
inesperada, stderr de mutação/adapter/restauração permanece apenas nos arquivos
privados do fixture, e o relatório redigido conserva o diagnóstico primário do
adapter mais o subpasso/status secundário e os indicadores da restauração, sem
texto bruto.

## Preparação inicial da infraestrutura de produção — inativa até nova autorização

`ops/prepare-cms-infrastructure.sh` prepara o receiver, guard, adapter e helpers,
overlay de rede/limites Payload, configuração CMS e journal/chave privada
preauthority. Não é deploy nem cutover. O histórico reportado da VPS precede esta
versão do adapter e não comprova sua instalação. O comando tem alvos fixos e aceita
somente `--check` (padrão, sem mudanças) ou `--apply`; não aceita argumento de
diretório/host alternativo.

O bundle revisado precisa manter juntos `docker-compose.payload.yml`,
`ops/prepare-cms-infrastructure.sh`, `ops/prepare-cms-infrastructure-private.py`,
`ops/deploy-from-ci.sh`, `ops/payload-operations-guard.sh`, `ops/payload-control`,
`ops/payload-control-runtime.py`, `ops/payload-control-state.py`,
`ops/payload-control-inventory.py` e
`ops/compose.payload.production.yaml`. O candidate CMS correspondente também precisa
conter `cms/scripts/verify-preauthority-catalog.ts` e sua verificação read-only
compartilhada. Antes de aplicar, confirme o bundle/commit e execute:

```sh
sudo bash ops/prepare-cms-infrastructure.sh --check
sudo bash ops/prepare-cms-infrastructure.sh --apply
```

Requer Linux, Bash, Python 3, `flock`, utilitários GNU (`install`, `sha256sum`,
`mktemp`, `mv -T`) e o plugin Docker Compose. O preparador exige que o `current-release`
continue exatamente em `d285029970c82d48cd50cc393a054af4cbfdf1e8`, com `.image-env`
API/cron de duas linhas, e que o receiver comum instalado continue root:root,
0755, SHA-256 `30be4941fe15c1c75e16175625685e2f51acc6ceaa52db146d61684cdacce0f7`.
Mudança de release/receiver, symlink, diretório/file inseguro, URL pública não
canônica, credenciais parciais/inválidas/duplicadas ou configuração Compose inválida
aborta antes da escrita.

O Compose é validado com `docker compose config --quiet`, combinando base da release
atual, `docker-compose.payload.yml` do bundle revisado, o mesmo override de produção
efetivo que o receiver selecionará (`current-release/compose.ownerinc-vps.yaml` quando
existir como arquivo regular protegido; caso contrário `runtime/compose.production.yaml`)
e o overlay Payload novo. Um override release-local existente que seja symlink, não
regular, hardlinkado ou gravável por grupo/outros é recusado, nunca ignorado em favor
do fallback. O parser recebe o arquivo de ambiente de produção em modo privado e
valores sintéticos CMS e `PORTAL_PUBLIC_URL=https://portal.ownerinc.com.br` para a
validação; não imprime configuração, URL, segredo ou comando SQL. Não há `docker pull`,
`up`, `run`, `exec`, migration, database,
container, service restart, systemd/timer ou mudança de release atual.

Com `--apply`, o preparador abre o `runtime/deploy.lock` existente sem truncar,
adquirindo `flock` antes de escrever. Preserva esse inode; nunca o remove. A
substituição atômica do `production.runtime.conf` mantém bytes anteriores, uid/gid e
modo existentes (neste host, operador uid 1000 e modo 0600); a instalação não muda
permissões de usuário. O check VPS reportado encontrou `PORTAL_PUBLIC_URL` ausente e
nenhuma chave CMS: nesse primeiro bootstrap, `--apply` acrescenta a URL canônica junto
com as nove chaves CMS na mesma substituição atômica, preservando todo o conteúdo
original. A ausência só é permitida sem qualquer chave CMS; URL explicitamente vazia
ou diferente e configuração CMS completa sem URL são recusadas, sem reparo implícito.
Sem nenhuma das nove chaves CMS exigidas, gera senhas admin,
migrator e runtime e `PAYLOAD_SECRET`/chaves de serviço com 32 bytes aleatórios
distintos. URLs usam `cms-postgres:5432/ownerinc_cms` e os roles correspondentes.
Um conjunto existente completo e válido é preservado sem rotação; qualquer conjunto
parcial, duplicado ou inválido é recusado, sem `source`/`eval` do arquivo e sem
imprimir valores.

O snapshot imediatamente anterior fica em
`/opt/ownerinc/backups/portal-ownerinc/production/cms-infrastructure-preparation-<UTC>-<UUID>`
com diretório 0700. Guarda somente o receiver anterior, o guard anterior quando
existente, o arquivo de ambiente privado (0600) e `metadata.json` com presença,
uid/gid/modo; não contém imagem, release, backup diário nem database dump. O caminho
é impresso antes da primeira instalação, também quando uma etapa posterior falhar.

Instala `/usr/local/libexec/ownerinc-portal-deploy` e
`runtime/payload-operations-guard` (root:root 0755), o adapter
`runtime/payload-control` (root:root 0755), os três helpers Python e
`runtime/compose.payload.production.yaml` (root:root 0644), além do manifesto
`runtime/cms-image-candidate.env` (root:root 0644). A chave/journal de controle
ficam root:root, 0600/0700, fora dos backups de dados. O snapshot anterior continua
limitado ao receiver, guard e environment; não contém o novo código, overlay, chave,
journal, imagem ou dump. Não instala um wrapper production novo, não altera
`authorized_keys` nem permissões/owner do override existente
`runtime/compose.production.yaml`.
O inventário protegido é root:root 0600, contém o projeto de produção e quatro
volumes (`postgres_data`, `uploads_data`, `cms_postgres_data`, `cms_uploads_data`)
com seus labels Compose e mounts revisados, mais paths explícitos para release,
lock, environment, overlays e raízes de backup. O diretório privado de proteção
pré-restore fica separado da raiz diária.
O manifesto de candidato contém somente `CMS_IMAGE=` para o digest revisado
`ghcr.io/ownerinc/ownerinc-portal-cms@sha256:6eaddc9a333ba682508a09a4ae8a6409d9e571abab9ec4a62829c2e9828730b0`; não é copiado para
`current-release/.image-env`, não adiciona `RELEASE_FORMAT`, nem promove release.

O receiver comum acrescenta o override novo somente para release `payload-v1` em
produção, depois do override normal, e falha se ele estiver ausente/for symlink.
Legacy API/cron e staging continuam no conjunto anterior de arquivos Compose. O
override mantém CMS/PostgreSQL/worker sem portas publicadas e somente na rede
`ownerinc-portal-backend` interna; Nginx permanece na topologia já configurada. Aplica
limites de CPU/memória, `no-new-privileges` e logs locais limitados. Não muda
autoridade, formato de backup, retenção ou agenda diária.

Mesmo após sucesso, a preparação está **inativa**: não há pull/up/run, migration,
deploy ou ativação por timer. O instalador verifica um journal existente ou cria
estado frio assinado sem conectar a banco; estado parcial/corrompido não é reparado.
O worker continua explicitamente retido. A API v2 candidata só pode ser iniciada
depois do backup coordenado, da provisão normal de grants e do verificador estrito
de migrations. O aceite CI de API/session v2 do Task 1 foi reportado como concluído,
mas não foi implantado. O helper CMS novo requer um conjunto candidato completo e
recém-construído que o contenha; o digest de imagem CMS já registrado na evidência
histórica não comprova esse helper e não deve ser combinado com imagens de outro
source SHA para alegar um release comum. O runner Task 3 e a ordem CI de publicação,
recuperação e qualificação estão implementados, mas a aceitação real continua
pendente do run Linux descartável. Nenhum sucesso de preparação equivale a deploy
ou recuperação comprovada.

### Rollback manual da preparação inativa

Use o caminho privado impresso pelo instalador como `BACKUP_DIR`. Só faça este
rollback enquanto o `current-release` ainda aponta para o SHA legacy acima, Payload
não foi implantado e nenhuma outra operação/alteração de configuração está em curso.
O comando reabre o mesmo lock, repõe receiver/guard/environment a partir dos backups
e restaura owner/mode do ambiente conforme `metadata.json`; nunca mexe no lock,
override preexistente, current-release, manifesto de imagem, banco ou serviços. Se o
guard anterior estava ausente, o guard revisado recém-instalado é deixado inerte.
Overlay e manifesto CMS novos também permanecem inertes sob o receiver antigo.
Se uma versão revisada do preparador já instalou adapter e estado privado, este
rollback não os restaura nem os remove; não apagar nem substituir manualmente a
chave/journal e confirmar que o receiver/guard restaurado não os invoca.

```sh
BACKUP_DIR='/opt/ownerinc/backups/portal-ownerinc/production/cms-infrastructure-preparation-<UTC>-<UUID>'
sudo bash -s -- "$BACKUP_DIR" <<'BASH'
set -Eeuo pipefail
backup=$1
root=/opt/ownerinc/apps/portal-ownerinc-real
runtime="$root/runtime"
expected="$root/releases/d285029970c82d48cd50cc393a054af4cbfdf1e8"
[[ $backup =~ ^/opt/ownerinc/backups/portal-ownerinc/production/cms-infrastructure-preparation-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || exit 2
[[ -d $backup && ! -L $backup && -f $runtime/deploy.lock && ! -L $runtime/deploy.lock ]] || exit 2
lock_identity=$(stat -Lc '%d:%i:%h' "$runtime/deploy.lock")
[[ ${lock_identity##*:} == 1 ]] || exit 2
exec 9<>"$runtime/deploy.lock"
[[ ! -L $runtime/deploy.lock && /proc/$$/fd/9 -ef $runtime/deploy.lock && $(stat -Lc '%d:%i:%h' /proc/$$/fd/9) == "$lock_identity" ]] || exit 2
flock -n 9 || { echo 'Another coordinated operation holds the lock.' >&2; exit 3; }
[[ ! -L $runtime/deploy.lock && /proc/$$/fd/9 -ef $runtime/deploy.lock && $(stat -Lc '%d:%i:%h' /proc/$$/fd/9) == "$lock_identity" ]] || exit 2
[[ -f $root/current-release && ! -L $root/current-release && $(<"$root/current-release") == "$expected" ]] || exit 2
python3 - "$backup" <<'PY'
import json, os, shutil, stat, sys, tempfile

if os.geteuid() != 0:
    raise SystemExit('Rollback requires root.')
backup = sys.argv[1]
backup_info = os.lstat(backup)
if stat.S_ISLNK(backup_info.st_mode) or not stat.S_ISDIR(backup_info.st_mode) or (backup_info.st_uid, stat.S_IMODE(backup_info.st_mode)) != (0, 0o700):
    raise SystemExit('Unsafe private rollback directory.')
metadata_path = os.path.join(backup, 'metadata.json')
metadata_info = os.lstat(metadata_path)
if stat.S_ISLNK(metadata_info.st_mode) or not stat.S_ISREG(metadata_info.st_mode) or metadata_info.st_nlink != 1 or (metadata_info.st_uid, stat.S_IMODE(metadata_info.st_mode)) != (0, 0o600):
    raise SystemExit('Unsafe rollback metadata.')
with open(metadata_path, encoding='utf-8') as stream:
    metadata = json.load(stream)
targets = {
    'receiver': ('ownerinc-portal-deploy', '/usr/local/libexec/ownerinc-portal-deploy'),
    'guard': ('payload-operations-guard', '/opt/ownerinc/apps/portal-ownerinc-real/runtime/payload-operations-guard'),
    'environment': ('production.runtime.conf', '/opt/ownerinc/secrets/portal-ownerinc/production.runtime.conf'),
}
if set(metadata) != set(targets):
    raise SystemExit('Unexpected rollback metadata fields.')
restore = []
for key, (backup_name, target) in targets.items():
    record = metadata[key]
    if not record['present']:
        continue
    if set(record) != {'present', 'uid', 'gid', 'mode'} or not all(type(record[name]) is int and record[name] >= 0 for name in ('uid', 'gid')) or not isinstance(record['mode'], str) or len(record['mode']) != 4 or any(char not in '01234567' for char in record['mode']):
        raise SystemExit('Invalid rollback metadata record.')
    source = os.path.join(backup, backup_name)
    source_info = os.lstat(source)
    target_info = os.lstat(target)
    if stat.S_ISLNK(source_info.st_mode) or not stat.S_ISREG(source_info.st_mode) or source_info.st_nlink != 1 or (source_info.st_uid, stat.S_IMODE(source_info.st_mode)) != (0, 0o600):
        raise SystemExit('Unsafe rollback source.')
    if stat.S_ISLNK(target_info.st_mode) or not stat.S_ISREG(target_info.st_mode) or target_info.st_nlink != 1:
        raise SystemExit('Unsafe rollback target.')
    restore.append((key, source, target, record))

# Validate every source and target before changing any of them.
for key, source, target, record in restore:
    fd, temporary = tempfile.mkstemp(prefix='.cms-preparation-rollback.', dir=os.path.dirname(target))
    try:
        with os.fdopen(fd, 'wb') as output, open(source, 'rb') as saved:
            shutil.copyfileobj(saved, output)
            output.flush()
            os.fsync(output.fileno())
        os.chown(temporary, record['uid'], record['gid'])
        os.chmod(temporary, int(record['mode'], 8))
        os.replace(temporary, target)
        directory_fd = os.open(os.path.dirname(target), os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(f'Restored {key}; secret values were not displayed.')
PY
BASH
```

This file rollback restores only host preparation files; it is not a release/data
rollback and must not be used after Payload traffic or authority changes.

## Restauração e floor

Restore CMS recusa backup legacy; release legacy recusa backup CMS. Hashes e paths
de tar são conferidos antes de mutação; links/devices/traversal são recusados.
Gera backup de proteção completo sob a mesma lease, sem reaquisição/S3, restaura
ambos os bancos e ambos os storages, reaplica grants/migrations e exige prova do
adapter. CMS restaura ownership `cms_migrator`; runtime permanece sem DDL. Antes de
reabrir a API, grants estritos de sessão v2 e de autoridade devem passar novamente;
o floor legado observado não é suficiente para esse gate.
Em falha, writers ficam parados e proteção é preservada. Não reativar agendas
importadas vencidas/ator desconhecido sem revalidação/decisão formal.

Cutover só depois de floor Payload compatível instalado/ensaiado, Task9 resolvida,
prepare→reconcile→seal→activate integrado e recuperação real comprovada. Selo
vincula baseline/última mutação/epoch/manifesto; editar/desfazer também o invalida.
Não há fallback automático para legacy nem rollback parcial de dados após tráfego.

## Evidência exigida no ensaio autorizado

Bases/volumes novos distintos da amostra; migrations repetidas; DDL negado ao runtime;
Portal disponível com CMS desligado em legacy; worker único; permissões de storage;
backup/restart/restore dos quatro componentes e staging/receipts; falha no meio do
restore; COMMIT desconhecido; hashes inválidos; floor inadequado; lock ocupado;
BFCache/sessão/nonce reais. Registrar comando/exit, commit/digests/ledgers/hashes,
tempos e serviços recuperados. Doubles não provam PostgreSQL, flock/Linux ou browser.
