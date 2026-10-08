# Payload Owner News — checks e preparação do aceite

Estado desta entrega: wiring offline, guard portátil, finalizer one-shot e comando
de auditoria instalada somente leitura estão implementados. A fatia observacional
do protocolo Owner News foi executada com PASS em fixture PostgreSQL 16 isolada;
o escopo e os limites estão no [relatório da auditoria](../reviews/2026-10-08-owner-news-protocol-observer-audit.md).
A suíte real Task15 e seu fluxo portátil de preparação/integração ainda estão
incompletos. Esse PASS delimitado não equivale a prontidão, certificação, aceite
integrado ou autorização de produção. Resultados por cenário ficam na
[matriz de aceite](../reviews/2026-10-02-payload-owner-news-acceptance.md).
O PASS observado antes desta atualização não valida o novo RPC V2 nem substitui
as duas fixtures novas descritas abaixo.

## Checks separados

Com Node 24 e autorização para instalar dependências, `npm run bootstrap` instala
API, cron e CMS a partir dos lockfiles. Em checkout compartilhado, instalação,
audit, build, typecheck e geração exigem execução exclusiva coordenada.

| Comando | Escopo |
|---|---|
| `npm run verify` | Sintaxe JS/MJS, unit Portal/CMS, typecheck CMS, scanner, DHO e Compose read-only quando disponível |
| `npm test` | Unit Portal/CMS, sem integração real |
| `npm run typecheck:cms` | TypeScript sem emitir arquivos nem cache incremental |
| `npm run test:cms` | Somente unit CMS |
| `npm --prefix cms run build` | Build Next separado; requer `CMS_BUILD_ONLY=true` no processo de build |
| `npm run security` | Audit produção API/cron/CMS, falha em high/critical |
| `npm run sbom` | SPDX por lockfile: api, cron, cms |
| `npm run test:payload` | Guard + bloqueio explícito enquanto a suíte real estiver incompleta |

O audit CMS mantém opcionais no escopo; API/cron preservam a política anterior
`--omit=dev --omit=optional`. SBOM inclui a árvore do lockfile, não somente a imagem
instalada. Nenhum desses recortes equivale a audit completo com dev dependencies.
O snapshot histórico de 05/10/2026 registrou CMS 17 pacotes afetados
(5 high/10 moderate/2 low); não é audit atual. Remediação requer análise atual por
caminho transitivo, atualização deliberada e repetição dos checks atingidos. Não
usar ignore global ou force/downgrade automático para produzir verde.

### Auditoria do protocolo Owner News instalado (read-only)

`npm --prefix cms run audit:news-protocol` executa
`cms/scripts/verify-news-protocol.ts` com `--audit-protocol`. Requer exclusivamente
`CMS_OBSERVER_DATABASE_URL`, apontada explicitamente como `cms_observer` para o
database `ownerinc_cms`. Não consulta `.env`, não usa `CMS_ADMIN_DATABASE_URL`,
`CMS_RUNTIME_DATABASE_URL`, `CMS_DATABASE_URL` ou `DATABASE_URL` como fallback e
não cria nem altera a role. O parser recusa query/fragmento na URL para impedir
overrides de sessão.

O usuário deve fornecer uma role já provisionada segundo o contrato
`buildNewsProtocolObserverProvisioningSQL` em
`cms/scripts/news-protocol-observer-contract.ts`. Esse builder retorna SQL
privilegiado, é somente um contrato para revisão/provisionamento explícito e não é
importado pelo CLI. A role deve ser criada por procedimento separado e aprovado;
uma role preexistente não é alterada automaticamente.
O builder não altera ACLs públicas dos catálogos PostgreSQL.

O audit começa com `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`,
aplica `SET LOCAL statement_timeout = '5s'` e fixa o `search_path` local como
`pg_catalog, public`; então valida identidade e catálogo. Não toma advisory lock.
Entre as relações da aplicação, permite somente
`SELECT` sobre `payload_migrations` e `owner_news_mutation_head`; leituras padrão
dos catálogos PostgreSQL e de `information_schema` são necessárias para a própria
auditoria. Não permite DML persistente nem sequence access. A única exceção é
`UPDATE` na view canônica `pg_catalog.pg_settings`: no PostgreSQL 16, isso é
equivalente a `SET` para a sessão, não a uma atualização persistente de linhas.
Essa exceção é limitada pela identidade OID qualificada e por `relkind='v'`; não
abrange `INSERT`, `DELETE` ou outros privilégios da view nem objetos de mesmo nome.
O audit exige ausência de membership e de schema CREATE/uso alheio, rejeita grants
`PUBLIC` em relações/colunas de aplicação e execução de funções de protocolo/
SECURITY DEFINER. Os queries de privilégio nomeiam explicitamente `cms_runtime`;
nenhuma troca `SET ROLE` é usada.

O relatório observa o estado instalado com `observedProtocolVersion: 1 | 2`,
derivado da assinatura/identidade exata dos catálogos, e
`observedCoverageVersion: 0 | 1` como campos independentes. Observa também
sequência e barrier sem ler artigos, mídia, schedules, jobs, históricos ou eventos
do ledger.
Sempre indica `ready=false`, `admissionActivated=false` e certificações de release,
coverage e drain como falsas. `coverage_version=1` é somente valor observado, não
certificação de cobertura, seal, destination reconciliation ou cutover. Antes da
consulta de ownership, exige que `current_user` tenha `SELECT` efetivo em
`pg_catalog.pg_shdepend`; se faltar acesso, falha sem fallback ou concessão de
grants. Reutiliza as dependências de ownership PostgreSQL: `cms_observer`
deve não possuir objeto algum em qualquer `dbid`; `cms_control`/`cms_controller`
seguem o escopo canônico do finalizer (database atual e objetos compartilhados).
O literal `pg_authid` é usado somente como OID de `refclassid`; o catálogo de
autenticação e password presence não são lidos. O CLI sozinho verifica o nome do
database, não a identidade física do cluster. No harness registrado no relatório
da auditoria, essa identidade foi confirmada separadamente no fixture PostgreSQL 16;
isso não estende a verificação de identidade a outros destinos.

O finalizer one-shot é outro comando e tem fronteira mutável distinta:
`node --import tsx cms/scripts/finalize-news-protocol.ts --finalize-protocol`
requer `CMS_ADMIN_DATABASE_URL`; instala protocolo V2 em cold start, verifica V2
sem DDL e, em V1, falha fechado com `protocol_upgrade_required` sem DDL. Um upgrade
V1→V2 precisa da escolha explícita e separada
`node --import tsx cms/scripts/finalize-news-protocol.ts --upgrade-protocol-v1-to-v2`.
O comando não pré-semeia um run: somente a chamada controller-only ao RPC
`owner_news_bootstrap_run` cria a primeira linha. Os seis arquivos de migration
Payload e o snapshot nativo permanecem inalterados; `source_instance` mantém a
identidade de origem, distinta da identidade física target que um futuro cliente
deverá verificar. Nunca use esse finalizer para uma inspeção read-only. Leia
[o runbook de migração](./owner-news-payload-migration.md#finalizer-one-shot-e-auditoria-instalada)
antes de provisionar ou executar qualquer um deles.

Esta compatibilidade de catálogo e os testes offline não são aceitação de banco.
Cold install V2 e upgrade V1→V2 precisam de duas novas fixtures PostgreSQL 16 e
leases one-shot independentes, após autorização separada; não reutilize a fixture
do observer, leases anteriores, bancos existentes, serviços ou destinos remotos.
Os dois cenários explícitos do harness `cms/tests/integration/protocol-finalizer.mjs`
estão implementados e têm guards offline. A preparação/execução PostgreSQL não foi
feita nesta alteração: requer revisão fresca e autorização explícita da sessão
primária. Com Node 24, dependências CMS já instaladas, Docker local e PostgreSQL 16
em cache, a sequência autorizada é:

```sh
node cms/tests/integration/protocol-finalizer.mjs --prepare-lease --scenario fresh-v2
node cms/tests/integration/protocol-finalizer.mjs --execute --scenario fresh-v2 --lease "<lease privada recém-preparada>"
node cms/tests/integration/protocol-finalizer.mjs --prepare-lease --scenario upgrade-v1
node cms/tests/integration/protocol-finalizer.mjs --execute --scenario upgrade-v1 --lease "<outra lease privada recém-preparada>"
```

Cada `--prepare-lease` somente inspeciona o contexto local, a imagem PostgreSQL 16
em cache, colisões UUID, porta loopback e parent privado, e grava a lease privada;
não cria recursos Docker ou databases nem conecta ao PostgreSQL. Cada lease é
one-shot e amarrada ao cenário. `--execute` cria
um container/volume e database novos, verifica identidade física antes de DDL,
preserva a fixture e, depois da claim one-shot, grava relatório em sucesso ou
falha; não faz cleanup automático.
`fresh-v2` prova as seis migrations existentes, ausência inicial de runs, cold
install V2, reentrada sem mudança, observer read-only pré-bootstrap e o contrato
RPC controller (evento único do trigger, retry sem DML, negações, barreira e ordem
de locks). `upgrade-v1` constrói o V1 exato com os builders canônicos, prova a
rejeição ordinária sem mutação e rollback transacional do upgrade, então atualiza
para V2, verifica reentradas e testa o RPC. Nenhum desses cenários certifica
Portal/Payload, readiness ou cutover. A revisão offline não substitui os dois
aceites reais autorizados.

### Harness isolado do audit `cms_observer` no PostgreSQL 16

O runner offline/lease-gated está em
`cms/tests/integration/news-protocol-observer-audit.mjs`; não integra `npm test`,
`test:unit` ou `npm run verify`. São duas ações deliberadamente separadas:

```sh
node cms/tests/integration/news-protocol-observer-audit.mjs --prepare-lease
node cms/tests/integration/news-protocol-observer-audit.mjs --execute --leasepath "<leasePath impresso na preparação>"
```

`--prepare-lease` valida a identidade do Docker local, a versão, a imagem
PostgreSQL 16 já em cache, colisões de namespace e uma porta IPv4 loopback livre;
depois grava uma lease privada one-shot. Não puxa imagem, cria container/volume,
conecta ao banco, nem inicia serviço. O parent padrão existente é
`%LOCALAPPDATA%\Temp\opencode` no Windows e `$HOME` em POSIX. Se esse local não
for externo a todo checkout Git, não tiver ACL/owner aceitável, ou não existir,
a preparação falha sem fallback. Um parent alternativo existente pode ser
fornecido por `OWNERINC_AUDIT_PRIVATE_PARENT`; ele passa pelos mesmos checks
de caminho absoluto, ausência de symlink/reparse point e fronteira Git, além da
validação de ACLs/ownership (Windows) ou owner e ausência de escrita por grupo/
outros (POSIX). Diretórios de lease e arquivos são exclusivos e privados
(ACL restrita no Windows; `0700`/`0600` em POSIX). Não reutilize lease anterior.

`--execute --leasepath` consome a lease uma vez e cria um container e volume
PostgreSQL 16 novos no namespace UUID da lease, com label vinculada ao nonce,
mount único e porta publicada somente em `127.0.0.1`. Usa a imagem em cache por
ID, `ownerinc_cms`, senhas hex aleatórias distintas e Node 24/dependências CMS
já instaladas no host; não instala pacotes nem usa imagem CMS antiga, Next, API
ou Firebase. Aplica apenas as seis
migrations nativas existentes, valida a ledger, faz bootstrap/verify de
`cms_controller`, executa o finalizer one-shot em `ownerinc_cms` recém-criado,
e então provisiona `cms_observer` pelo builder revisado. Não aplica rollback de
fixture nem migration sintética.
O segredo inicial de `cms_admin` fica em arquivo bind-mounted privado com
ACL/owner restritos; `Config.Env` do container contém apenas o caminho do arquivo,
nunca o valor do segredo.

O cenário comprova no cluster descartável e separado: leitura real de
`pg_shdepend` pelo observer; auditoria read-only com snapshots de digest dos
catálogos públicos (metadados apenas), migrations e head antes/depois; `SELECT
... LIMIT 0` negado com SQLSTATE `42501` para artigos, mídia, schedules, jobs e
eventos do ledger; e ausência de `EXECUTE` em `owner_news_seal_run` sem invocar
a função. Nenhum conteúdo de publicação é consultado. Não injeta linhas para
forçar cobertura, não altera barrier e não conclui cobertura, CRUD, drain,
certificação ou prontidão. O relatório registra somente hashes/contagens,
identidades do fixture, fases e códigos sanitizados; URLs e credenciais não são
exibidos. Container, volume e relatório são preservados, inclusive em falha;
não há cleanup automático.

O harness cria infraestrutura local descartável e executa migrations, finalizer
e provisionamento de role no fixture; somente o CLI de auditoria e os probes de
negação são observacionais/read-only. Uma execução PG16 real foi concluída em
08/10/2026, run `1e852687-435d-4d09-b56d-7a6b2f375569`; consulte o relatório
delimitado e o JSON sanitizado ligado acima. Isso fecha apenas a evidência da
auditoria observacional `cms_observer`, não a suíte Task15, o aceite integrado ou
qualquer verificação de produção. Runs falhos anteriores e seus artefatos foram
preservados; não se afirma limpeza nem expiração de seus fixtures.

### Preflight offline do harness Task9

O launcher `cms/tests/integration/run-task9.mjs` constrói o ambiente filho por
`task9-environment.mjs` por allowlist fechada. A configuração salva só pode
fornecer `NODE_ENV`, `NEXT_TELEMETRY_DISABLED`, os três segredos Payload/Portal,
os dois URLs Portal e as identidades CMS/Portal DB já fixadas. Configurações
legadas conhecidas de `LOCALAPPDATA`, pasta privada/uploads, opção webpack e
ambiente Windows são ignoradas; nomes desconhecidos ou variáveis de execução
injetáveis rejeitam o snapshot com código fixo, sem ecoar chave/valor.
`NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `BASH_ENV` e
`PYTHONPATH` nunca são propagados; não há Node options confiáveis configuradas.
`PATH`, `SystemRoot`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`, `ComSpec`,
`PATHEXT`, `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `SystemDrive`, `USERDOMAIN`,
`USERNAME` e `WINDIR` vêm somente do launcher confiável. Os sete últimos são
variáveis padrão que o Windows expõe no processo Node filho mesmo quando não
estão na lista passada a `spawn`; são copiadas explicitamente da origem confiável
e validadas no limite real do processo. `LOCALAPPDATA`, `TASK9_PRIVATE_DIR` e
`CMS_UPLOAD_DIR` são substituídos explicitamente após qualquer merge. O runner
valida antes de criar recursos e repassa esse mesmo ambiente ao Next. O
`task9-environment-preflight.mjs <diretório-privado>` usa o builder de produção
e também inicia somente um Node filho de prova que importa o guard puro com o
ambiente final de spawn; não inicia Next/Express/browser nem acessa DB/rede. O
preflight imprime apenas reason codes fixos e booleans. No aceite de destinos,
o retorno usa o link CMS→Payload ou uma
entrada normal nova seguida do setup direto do documento existente; não há
fallback de histórico. Identidades loopback/porta/projeto/role continuam obrigatórias;
URLs PostgreSQL com query/fragmento são rejeitadas para impedir overrides de
conexão.

### Diagnóstico offline do bootstrap Owner News

O diagnóstico de destinos captura uma observação pública do leitor imediatamente
após a chegada a `/announcements.html`, antes de aguardar o heading, e outra na
trilha de falha. Registra somente existência/texto esperado do heading como
booleano, presença de `data-route-pending`, buckets de `display`/`visibility`,
retângulos positivos, `document.readyState`, e categoria de auth derivada de
`documentElement.dataset` (`signed-in`, `signed-out`, `loading` ou `unknown`). O
estado interno do módulo router não é exposto e permanece `not-exposed`. Falha ao
coletar observação secundária não substitui a falha original.

O evento same-origin inclui status e tipo MIME reduzido (`text/html`, `js`, `json`
ou `other`) apenas para rotas/arquivos de leitor explicitamente allowlisted; query,
headers e body não são registrados. Erros de console, page error e request failure
são classificados localmente em enums fechados. O artefato mantém contadores de
erros desconhecidos, nunca mensagem, stack ou URL arbitrária; origem de page error
só aparece como caminho de módulo público allowlisted com linha/coluna inteiras.
Os callbacks avaliados pelo browser são autossuficientes e têm regressões executadas
em VM Node sem closure do processo.

Auditoria estática da navegação: `router-bootstrap.js` chama `startRouter()`; o
bootstrap aguarda `getCurrentUserDoc()` e a importação da rota, confirma usuário e
rota, e então chama `mountPage()`, que remove `data-route-pending`. A página real
declara o heading `Owner News` no HTML inicial. O double `GET /js/firebase-config.js`
fornece `auth`, `authStateReady`, `onAuthStateChanged`, `signOut` e `updateProfile`;
por isso o import CDN `firebase-auth.js` interceptado reexporta APIs fornecidas, e
`firebase-app.js` não é requerido por essa configuração substituta. O double também
implementa `GET /api/users/me`. Ele **não** implementa os endpoints de conteúdo
`/api/announcements/*`; esses requests podem falhar no harness, mas os loaders do
feed são assíncronos e tratam suas próprias falhas, sem bloquear a montagem do
heading. Não adicionar fixture/headings artificiais nem alterar CSS/produto por essa
limitação. Ela também significa que esse cenário não aceita o carregamento do feed.

Uma resposta 200 do arquivo estático e o teste offline do middleware não provam que
o router do browser montou a página ou identificam a causa de timeout anterior.
Esse diagnóstico é somente instrumentação para uma eventual execução reader-only
separadamente autorizada; não é autorização para iniciar runtime.

CI `validate` inclui cache CMS, bootstrap ampliado, verify e build sintético CMS.
Integração real, migrations CMS repetidas, grants runtime, imagem/scan CMS e o
contrato de digest/release aguardam integração com infraestrutura/operação.
Os contratos de publish/backup não são definidos uma segunda vez neste documento.

## Guard portátil implementado

`scripts/test-payload-integration.mjs` não lê `.env`, state/env privados dos antigos
runners, nem abre conexão, inicia Docker ou aplica migration. Exige:

| Variável | Contrato |
|---|---|
| `MIGRATION_TEST_DISPOSABLE` | Literal `true` |
| `NODE_ENV` | `test` ou `development` |
| `PAYLOAD_TEST_PORTAL_DATABASE_URL` | URL PostgreSQL explícita do banco Portal descartável |
| `PAYLOAD_TEST_CMS_DATABASE_URL` | URL PostgreSQL explícita de outro banco CMS descartável |
| `PAYLOAD_TEST_UPLOAD_DIR` | Diretório absoluto existente, privado, fora do checkout |
| `PAYLOAD_TEST_EVIDENCE_DIR` | Diretório absoluto existente e separado dos uploads |
| `PAYLOAD_TEST_RUN_ID` | UUID v4 sintético para namespace de fixtures/evidências |

Os URLs deste primeiro runner host-side aceitam apenas localhost/127.0.0.1/::1,
sem query/fragmento; database em minúsculas com segmento `test` ou `dev`. Identidade
de banco ignora usuário, esquema URI e alias loopback: mudar credencial não isola
o mesmo banco. Não há fallback para `DATABASE_URL`. URLs nunca entram na saída.
Nomes marcados são uma barreira adicional, não prova de que o banco está vazio
ou autorizado. Preparação futura deve conferir estado real antes de escrever.

Diretórios não podem sobrepor-se nem ser ancestrais do checkout; symlinks/junctions
na cadeia são recusados. Outro checkout no caminho também é recusado. Para scratch
sob a raiz temporária do SO, um repositório de dotfiles acima dessa raiz não impede
uso; checkouts dentro do temporário continuam proibidos. Operador deve garantir
permissões privadas e o vínculo real entre storage fornecido e runtime.

Após fornecer as variáveis privadamente:

```sh
node scripts/test-payload-integration.mjs --check-config
```

Código 0 significa apenas `CONFIG_VALID`, com `acceptance NOT_EXECUTED`. Não testa
conexão, schema, credencial, serviço ou propriedade exclusiva do storage. Chamada
sem argumento retorna **2 / acceptance_suite_not_implemented** após o preflight;
guard inválido retorna **1**, com código sanitizado. Não existe modo `--prepare`.

## Preparação separada — integração pendente

Sequência obrigatória futura, em ambiente novo explicitamente autorizado:

1. Coordenador reserva par de bancos/roles, portas, namespace Firebase Emulator,
   uploads, evidências e checkout/build exclusivos. Nunca reutilizar Task9 ou amostra.
2. Preparador dedicado confirma bancos vazios/descartáveis e storage próprio;
   provisiona roles migrator/runtime e aplica migrations explicitamente. Registrar
   primeira aplicação e repetição, grants e negação DDL de runtime. Não apagar
   tabelas/volumes para fabricar precondições. Este preparador ainda não está pronto.
3. Runtime é iniciado separadamente pelo responsável autorizado: build/start Next,
   Express, PostgreSQL, Firebase Emulator real e Nginx. Configuração sintética de
   build nunca é usada como runtime. Registrar readiness e versão de cada camada.
4. Suporte de fixtures reais, ainda não implementado neste runner, cria somente
   identidades/conteúdo sintéticos próprios, usando login no Emulator, ID token,
   `/api/cms/session`, REST Payload e leitura Express. Não substituir auth por bypass.
5. Executar serialmente cenários que compartilhem authority singleton. Cleanup
   remove/revoga somente IDs do run; resultados distinguem cleanup de aceite.

Se o Emulator não suportar a operação necessária de session cookie, registrar
bloqueio e solicitar ambiente de homologação autorizado. Token/cookie/headers de
auth nunca são artefatos de relatório. Falta de suporte não autoriza double como
evidência real. Expiração, revogação e troca entre abas exigem browser real também.

## Operação editorial e limites

CMS central → área permitida → entidade existente (exceto announcement) → editar
→ salvar → prévia → publicar/agendar → leitor. Rascunho não publica. Prévia clássica
é embutida; Payload abre revisão salva em outra aba. Histórico importado conserva
proveniência e é distinto de Versions nativas. Mídia é privada e imutável, com
limite editorial de 50 MiB; revisão histórica/draft não autoriza leitor comum.
Rich text cru não atravessa a fronteira: DTO v2 usa árvore validada.

Owner News primeiro: outras áreas mantêm seus contratos e capacidades. Academy
CMS edita descrições/materiais/capa; estrutura, ativação, player e progresso são
domínios próprios. UI deve distinguir retorno ao CMS central, leitura Owner News
e logout; aceite deve observar destinos reais, não presumir um link já existente.
Guardar troca de documento/área, menu e entrada Payload; cancelar saída não revoga.
Sessão editorial dura duas horas; logout editorial preserva Firebase, logout Portal
revoga antes de signOut com rechecagem de UID. Falha de DELETE não é logout confirmado.

Após cutover, Owner News legado fica read-only com guards server-side, demais
áreas seguem operantes. Preparação → reconciliação → seal → ativação é o contrato
coordenado das Tasks10–12; agendas importadas ficam suspensas até ativação válida.
Ator desconhecido e agenda vencida exigem decisão explícita; não são ignorados.
Runbook operacional concreto/CLIs dependem desses handoffs, não de suposições aqui.

Backup consistente deve reunir PortalDB, CMSDB, arquivos legados, arquivos CMS,
staging e ledger de promoção, com escritores quiescidos. Restore é ensaiado em
outro ambiente. Após qualquer edição/efeito registrado, rollback não é um toggle
para legacy: preservar schema/serviços/autoridade compatíveis. Implementação e
contratos de release/backup pertencem à infraestrutura/operação. VPS exige nova
aprovação explícita, inclusive quando publicação de branch/main dispararia deploy.

## Evidência e paralelismo

Cada registro informa cenário, responsável, SHA/diff, comando sanitizado,
início/fim, exitCode/signal/timeout, camada real/double, esperado/observado,
PASS/FAIL/NÃO EXECUTADO, causa do bloqueio, artefatos sanitizados e cleanup.
Separar `scenarioId` de `documentId`. Não publicar env/state, bundles, corpos reais,
tokens, cookies ou URLs credenciadas. Reter runs falhos sem sobrescrever pelo retry.

Análises/pure unit podem rodar independentemente. Integrações paralelas exigem
bancos/authority, processos, portas, `.next`, fixtures e storage exclusivos.
Generated types/importMap/migrations têm único escritor. Após integração, root
verify e build final são serializados; repetir checks somente quando mudanças ou
falhas justificarem. CI verde parcial não comprova produção ou aceite Task15.
