# Owner News — Gate E de autoridade e cutover protegido

Gate E está **implemented**, não executado. Nenhum estado de produção foi
alterado por esta entrega. Evidência PostgreSQL/Linux real, aprovação de
Environment e execução da janela permanecem pendentes.

## Fonte e escritores

| Modo | Leitura Owner News | Escrita normal |
|---|---|---|
| legacy | Legado | Legado |
| frozen | Legado | Nenhuma |
| payload | Payload | Payload |
| payload_frozen | Payload | Nenhuma |

O backend não faz fallback para legado se Payload falhar. A API consulta a
autoridade corrente, sem cache duradouro. Ausência de autoridade falha fechada.

O único grafo é `legacy -> frozen -> payload -> payload_frozen -> payload`.
Não existe rollback estrutural para `legacy`, inclusive quando alguém alega que
não houve edição. Estado desconhecido fecha ambos os writers. Em `payload`, o
writer Payload continua fechado até `observe` persistir
`activation_observed_at` depois de observar a ativação em outra conexão.

## Protocolo one-shot

Os executáveis privados estão dentro da release API em
`api/scripts/owner-news-cutover.js` e `api/scripts/owner-news-gate-e-observe.js`.
Eles não registram endpoint HTTP. O único entrypoint exposto ao runner é o
wrapper fixo `/usr/local/sbin/payload-gate-e-guard`, executado como usuário
não-root dedicado. O wrapper abre a chave privada do host somente em FD 9; a
chave e o conteúdo dos receipts nunca entram no workspace, artifact ou output do
GitHub. O guard resolve os scripts Node pela `candidateRelease` autenticada do
journal, nunca por caminho fornecido pelo runner.

O preflight anterior ao freeze valida autoridade/epoch, migration 037, catálogo,
grants, readiness, modo manual, Payload vazio e ledger aberto/zero. O **primeiro
cutover continua exigindo Payload vazio também depois do freeze**. Quando há
manifest/run, ele precisa representar uma migração sem conteúdo: counts editoriais
zero, run reconciliado/acknowledged, barrier `sealed`, baseline ledger exata e seal exato.
Manifest ausente, divergente ou associado a qualquer conteúdo recusa activation.
Ambos
exigem ausência de worker/schedules/autosave/versions, B1 real vinculado,
release/imagem/rota instaladas e dual feed; o segundo exige também seal CMS e
drain real. `freeze`
faz CAS auditado `legacy -> frozen`. `activate` repete o preflight em `frozen`,
faz CAS auditado e vincula manifest, seal, release digest, image digest e request
ID. `observe`, em processo/conexão novos, compara o estado exato e somente então
grava a observação que abre o writer Payload. Os comandos de recuperação nunca
retornam a `legacy`.

Não existe proof autodeclarada. Inputs do workflow são apenas identificadores
esperados. O guard abre pelo mesmo FD arquivos privados regulares, owner
allowlisted, mode `0600` (`0400` para receipt imutável de rota), `nlink=1`, com
`O_NOFOLLOW`; valida bytes canônicos, HMAC, hash, freshness, commit,
candidate/release/image, epoch, request, editor/operator e deadline. Ele abre e
verifica o B1 real, o journal C/D e o receipt da geração de rota promovida. Os
producers read-only consultam as duas fontes do feed e exercitam o cursor v1; em
`frozen`, consultam o run CMS realmente selado e observam atividade/locks dos
writers. Só então o guard assina o evidence bundle privado.

O CLI recebe `--evidence-file`, `--receipt-file` e `--deadline`. Leituras usam o
FD aberto com `O_NOFOLLOW` e `fstat`, sem `lstat/read` separado. Escritas usam
tempfile `O_EXCL 0600`, `fsync`, hard-link sem overwrite, remoção do tempfile e
`fsync` do diretório. Cada transação configura `SET LOCAL` para `lock_timeout`,
`statement_timeout` e `idle_in_transaction_session_timeout`, todos abaixo do
tempo restante. O advisory lock fica coberto pelo statement timeout.

Cada edge grava request, action, editor, operator, modos, epochs e evidence hash
em `owner_news_authority_transitions` na mesma transação. O audit row correspondente
repete essa identidade e os bindings manifest/seal/release/image. Falha ou timeout
depois do envio de `COMMIT` nunca dispara replay: um **novo processo read-only**
exige autoridade, transição e audit row exatos. `payload` só é reportado como
operacional quando a transição `observe` exata também existe e
`activation_observed_at` está preenchido. `payload` não observado retorna
`activation_reconciliation_required` e mantém o writer fechado; ausência,
duplicidade ou divergência de audit/transição falha fechada.

`freeze-payload` limpa a observação. `resume-payload` grava request/editor/operator
da retomada, muda `payload_frozen -> payload` e mantém
`activation_observed_at=NULL`. Um `observe` separado, em nova conexão, confirma
transição e audit exatos antes de reabrir o writer. Falhas deixam o sistema em
`payload_frozen` ou `payload` não observado/read-only, nunca em `legacy`.
Antes da retomada, o CMS executa novo preflight completo e read-only, vinculado ao
request e deadline da retomada: readiness, modo manual, worker/schedules/autosave/
versions desligados, catálogo/grants, authority `payload_frozen`, manifest, seal,
release/image digests da ativação existente e ledger seguro. O receipt anterior
não substitui essa leitura fresca imediatamente antes da transição.

Timeout, nonzero ou stdout ausente em `freeze` também abre processo novo de
reconciliação read-only e bounded. Só reporta `frozen` quando authority, transition
e audit exatos pertencem ao mesmo request/editor/operator/epoch. `legacy` sem
transition/audit retorna `freeze_not_committed`; qualquer outro estado diverge e
falha fechado.

Migration 037 é rerunnable. Constraints são criadas condicionalmente. A
constraint do contrato Payload novo nasce `NOT VALID`: preserva instalações que
já estavam em qualquer um dos quatro modos, mas PostgreSQL a aplica a todo novo
INSERT/UPDATE. O verifier exige explicitamente esse estado staged; a validação
global futura só pode ocorrer após precondition/reconciliação dos rows antigos.

O workflow usa exatamente a concurrency de deploy/install
`portal-ownerinc-production`, `cancel-in-progress: false`, dois Environments e
`timeout-minutes: 60`. Após o approval de activation faz novo checkout de
`main`, exige que HEAD e `GITHUB_SHA` sejam o commit aprovado e chama novamente
o host guard. O guard refaz journal/rota/B1/feed e, depois do freeze, produz drain
e seal fresh dentro do deadline absoluto aprovado (máximo 60 minutos). Não há
artifact de proof, signing secret, rollback, deploy, Docker, SSH ou promoção de
rota no workflow.

O limite vigente de **até 60 minutos** substitui, somente para execução do Gate E,
os drafts acelerados históricos de 23 e 26 de outubro que mencionavam 30 minutos.
Esses documentos foram mantidos e marcados como superseded, sem reescrever seu
conteúdo histórico.

## Matriz de writers baseada em evidência

| Caminho | Tabelas/domínio mutado | Gate E |
|---|---|---|
| `/api/cms/documents*` announcement | `cms_documents`, `cms_revisions` Owner News | fenced dentro da transação |
| `/api/cms/owner-news/home*` | `owner_news_home` editorial | fenced nos helpers transacionais |
| importadores legacy/bundle | documentos/assets editoriais | fenced antes de documento/arquivo |
| cron/read-side schedule promotion | revisions announcement | anúncio excluído quando não-legacy |
| Payload article/media/home | tabelas nativas News | requer `payload` e activation observada |
| polls administrativos e votos | `owner_news_polls*` | não fenced: produto interativo separado do corpus migrado |
| assets compartilhados/retention | `cms_assets` e bytes compartilhados | não bloqueado globalmente; grants News fecham e retenção preserva referências |
| knowledge/academy/benefit/reminder | domínios CMS não-News | não fenced |

Polls e assets não foram inferidos como writers do corpus apenas pelo prefixo ou
pela tela. Os testes demonstram isolamento por tabela/referência.

## Feed durante a transição

A identidade é sempre `(source,id)`. Cursor v1 carrega filtros e boundary
source-aware, ordena `published_at` com null por último, depois `legacy` antes de
`payload`, e então UUID. Bookmark de detalhe sem `source` permanece legacy por
compatibilidade. Listagem recusa qualquer `offset != 0`; continuação usa cursor.
Uma falha de fonte em página com cursor exige restart e nunca reaproveita ID da
outra fonte. Na primeira página degradada, count/cursor são removidos.

Rotas de criação, draft, publicação, agenda, cancelamento, retirada e exclusão de
revisão announcement consultam autoridade dentro da transação, depois do lock
7193029 e antes dos locks de documento/revisão. Home usa o mesmo protocolo nos
helpers, também quando chamados fora do router. A transação é do chamador.
Mutação explícita bloqueada devolve409/news_read_only. Os dois importadores
legados recebem o mesmo bloqueio antes de escrever arquivos ou registros.

O promotor pula announcement fora de legacy ANTES de validar/promover/arquivar
agendas. Chamadas de leitura em frozen continuam funcionando. O cron sem filtro
continua outras áreas e usa somente SELECT na autoridade sob7193029. É necessário
copiar api/owner-news/authority.js na imagem cron; não conceder UPDATE ao cron.

Referências legadas de notícia continuam retendo os arquivos. Em payload e
payload_frozen elas não concedem leitura por /api/cms/assets/:id, nem mesmo por
um grant de editor legado. Grants independentes válidos de Knowledge/Academy e
outras áreas continuam funcionando; a leitura de notícia usa o endpoint próprio
da fonte ativa. Assets referenciados não podem ser removidos; a API não oferece
substituição de bytes/metadados de um asset existente. Upload novo independente
continua permitido. Respostas de arquivos legados usam private,no-store.

## Evidência

Os testes unitários/Express com doubles exercitam negações, ordem dos locks,
promotor seletivo, grants compartilhados, CAS e erro de COMMIT. Não comprovam
concorrência PostgreSQL, runner nativo, snapshot de filesystem, restore ou aceite
de produção. Essas provas e verify/build integrados pertencem ao coordenador.
