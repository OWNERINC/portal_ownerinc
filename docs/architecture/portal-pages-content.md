# Páginas modulares do Portal — fronteiras e decisões aprovadas

## Domínio e documento Payload

Páginas modulares são conteúdo próprio do Portal e usam contratos page-local em
`cms/src/portal-pages/`. O `PortalPageDTO` é a projeção pública normalizada; não é
um documento nativo Payload e não importa nem representa `NewsDTO`. O documento
Payload e seu editor podem conter IDs, nomes, campos de workflow e estrutura
nativa que nunca atravessam essa projeção. Normalizadores rejeitam chaves
desconhecidas e entregam somente o shape público permitido.

O DTO usa `content_version: 1`, `asset_scope: portal-pages|portal-pages-preview` e
`revision: {id,status}`. Em escopo normal, `revision.id` identifica a revisão
publicada retornada e o status é `published`. Em preview, o ID identifica a
versão salva exata retornada e o status pode ser `draft` ou `published`; não é
uma afirmação sobre qual versão está publicada. Ativos públicos se vinculam à
revisão publicada; ativos de preview se vinculam à versão salva exata e à
identidade do editor.

As rotas editoriais do CMS são
`/editorial/api/portal-page-editorial/{revision,save,publication}`. A consulta de
revisão lê sob `CMS_REFERENCE_LOCK` e lock da página; ela separa o status principal
da versão `latest`, calcula um hash de snapshot que inclui UUID, pai, autosave,
`updatedAt` e conteúdo nativo, e informa separadamente a última versão explícita.
Múltiplas versões `latest` falham fechadas.

O salvamento explícito de documento existente aceita somente o UUID e o par
`expected_latest_version_id`/`expected_snapshot_hash`; compare-and-swap rejeita
inclusive uma autosave alterada in-place. O primeiro salvamento aceita os sete
campos nativos editáveis, sem metadados de servidor. O limite de corpo é 16 KiB
para salvamento existente, 8 MiB para criação e 5 MiB para o conteúdo projetado.
Ambas as mutações criam snapshots nativos não-autosave pela Local API do Payload.
IDs de linhas nativas de blocos e galerias usam o formato gerado por
`baseIDField` do Payload 3.90.2 (24 caracteres hexadecimais minúsculos). Na
primeira criação, a comparação com a Version persistida desconsidera somente
esses IDs nas linhas em que o envio os omitiu; IDs enviados e todos os demais
campos, tipos, nomes e ordens continuam comparados. O hash retornado é calculado
do conteúdo exato persistido e confirmado depois do commit.

A publicação/despublicação recebe somente `{id,expected_version_id,operation}` e
exige que a versão esperada ainda seja a versão `latest` explícita. A transição
copia todos os sete campos do snapshot nativo escolhido dentro da mesma transação;
despublicar grava um novo draft e não reescreve a versão fonte. Respostas de
mutação só são entregues depois de reler a Version exata em uma sessão Payload
nova e comparar pai, conteúdo, autores, status, autosave e datas. A confirmação
não depende de a versão ainda ser `latest`, pois outra edição legítima pode ocorrer
após o commit. POSTs exigem Origin igual à origem configurada e rejeitam
`Sec-Fetch-Site: cross-site`; GET de revisão permite navegação sem Origin, mas
também rejeita cross-site. A autenticação editorial exige sessão V2 com
`manageKnowledge` e UID/expiração correspondentes. Rascunhos e Versions retidos,
capas e imagens de galeria contam como referências para impedir exclusão prematura
de mídia.

## Edição e autorização

A edição usa a sessão editorial V2 já existente e a capacidade `manageKnowledge`.
Ela é independente dos modos de autoridade da Owner News. Não se deve afrouxar
`canReadNewsArea`, `assertCmsWriteAuthority` ou os locks nativos da News para
habilitar páginas; autorização e escrita de páginas permanecem na fronteira
própria de `portal-pages` e dos endpoints editoriais.

## Mídia e uploads

O ingress privado do editor usa `POST /portal-page-uploads/init`, chunks
`PUT /:id/chunks/:index` de 5 MiB e endpoints autenticados de conclusão/cancelamento.
Imagens têm limite de 15 MiB, PDF 100 MiB e MP4/WebM 500 MiB; no máximo 100 chunks,
dois envios ativos por editor e oito no total. A reserva exige 1 GiB livre além de
duas cópias dos envios ativos. Manifests e partes ficam sob
`CMS_UPLOAD_DIR/portal-pages/.incoming` e são privados. Um envio incompleto torna-se
elegível para reconciliação quando atinge 24 horas; isso é um limite de elegibilidade,
não um prazo de remoção.
O Nginx limita somente o ingress de chunks a 6 MiB com buffering de request
desabilitado. Não existe rota pública `/uploads` para essas mídias.

Linhas `uploading` não são selecionáveis em conteúdo: só a conclusão marca a mídia
como `complete`, após validar bytes e persistir hash SHA-256 e `completedAt`.
Esta decisão não altera o contrato global do parser Payload da News
(`useTempFiles:false`, limite de 50 MiB). A leitura privada de páginas modulares
usa o endpoint independente descrito em “Ponte de leitura” abaixo.

O manifest privado continua sendo a autoridade para estado, caminho e hash dos
bytes. A tabela interna `portal_page_upload_cleanup` é somente um índice durável
de trabalho: a criação da mídia e o enqueue inicial compartilham transação; a
conclusão agenda reconciliação na mesma transação da atualização do hash; o
cancelamento mantém mídia/manifest enfileirados até a remoção verificada terminar.
Cada passagem de inicialização repara e processa no máximo 32 IDs distintos, em
ordem estável (`next_attempt_at`, `upload_id`), com `SKIP LOCKED`, savepoint por
item e backoff exponencial limitado a 24 horas. Falhas recebem apenas códigos
sanitizados e não bloqueiam uploads não relacionados; a admissão continua
fail-closed para quota, disco e enqueue obrigatório. Tombstones `done` evitam
re-enfileirar mídias concluídas já limpas. Esta tabela não referencia nem consulta
domínios da Owner News. A passagem é disparada pelo tráfego de um `init` posterior;
não há scheduler/cron para essa fila e não existe garantia de conclusão em tempo de
relógio. Itens problemáticos são isolados e reagendados com backoff, mas só serão
tentados quando uma passagem posterior os reivindicar.

Operações de upload preservam a ordem de lock `CMS_REFERENCE_LOCK` → advisory
transacional por upload → ownership do arquivo. O par de chaves int32 é derivado
dos oito primeiros bytes do SHA-256 de
`ownerinc.portal-page-upload.advisory.v1\0` concatenado aos bytes do UUID
validado; isso separa o namespace de outros advisory locks e mantém o SQL
parametrizado. Init adquire ambos os ownerships antes do commit de mídia/queue e
mantém o ownership de filesystem até publicar atomicamente o manifest. Assim,
cleanup que encontra esse owner ativo adia o item em vez de apagar um init entre
commit e manifest; após crash, a identidade de processo permite recuperar o lock
e o índice durável reencontra o trabalho. Cancelamento mantém o ownership de
filesystem através da transação final e da confirmação fresca. Essa fase readquire
CMS/advisory nessa ordem enquanto já possui o arquivo; competidores nunca esperam
por ownership de arquivo segurando locks DB, pois deferem/falham rapidamente.

`@payloadcms/drizzle` pode resolver a sessão sem propagar uma falha tardia da
Promise de conclusão Drizzle: o `catch` de `beginTransaction` chama o reject da
Promise de prontidão já resolvida e retorna normalmente. Portanto, retorno bem-
sucedido do helper de mutação não prova commit. Init, conclusão e cancelamento
confirmam o resultado em uma sessão Payload nova (com `transactionID` de entrada
removido), sob `CMS_REFERENCE_LOCK` → advisory do upload, lendo mídia e fila pela
mesma sessão. Init só publica manifest/token após confirmar a linha uploading e
a fila pending; uma deferral sanitizada de cleanup ocorrida durante o ownership
de init continua válida. Conclusão confirma linha completa, hash, instante e o
snapshot exato da fila agendada para o limite de retenção de 24 horas antes de
limpar chunks. Cancelamento mantém o ownership de arquivo
durante a transação final e confirma, em sessão nova, ausência da mídia, da fila
e dos caminhos derivados antes de informar sucesso. Se a confirmação divergir,
a operação falha fechada e deixa o reconciliador resolver estado ambíguo.

O corpo bruto de cada chunk é recebido sem transação, sessão Payload ou lock
advisory. Ingress tem três fases: autenticar e adquirir ownership em transação
curta; transmitir com backpressure para o caminho canônico
`<uuid>-<índice>.part` com `open('wx')` sob ownership exclusivo; e revalidar/promover
em outra transação curta, seguida da confirmação fresca do destino, tamanho e
hash. Competidores que encontram um filesystem owner vivo (cleanup, conclusão,
cancelamento ou outro chunk) falham/deferem rapidamente, sem esperar por ele
enquanto seguram o lock CMS. Se o processo cai durante a transmissão, o lock
permanece; após a identidade do processo provar que o owner canônico está morto,
o próximo owner pode remover somente o `.part` regular derivado daquele UUID e
índice antes de recriá-lo exclusivamente. Falha de `wx` não remove arquivo que a
requisição atual não criou. Nenhuma enumeração ou limpeza de entradas `.incoming`
desconhecidas é adicionada.

Ao provar por identidade de processo que `u-<uuid>.lock` ficou stale, o reclaimer
cria primeiro o hard link exato `r-<uuid>.lock` para preservar essa evidência e
só então remove o caminho de lock antigo. Com o novo ownership de filesystem, a
mesma rotina percorre apenas os índices declarados pelo manifest validado
(1–100), valida cada `<uuid>-<índice>.part` por `lstat` como arquivo regular
privado sem symlink e remove esses corpos incompletos. Em estados `receiving` e
`assembling`, também pode remover o scratch exato `.assembled.part`, que pode ser
reconstruído dos chunks; nos estados `ready_to_rename`/`renamed`, esse arquivo
validado é preservado como fonte de recuperação. Chunks canônicos `.chunk`,
manifest e arquivo final nunca são removidos por essa reconciliação. Cleanup faz
essa passagem antes de reagendar um receiving não expirado; chunk, complete,
cancel e init que forem os primeiros reclaimers usam a mesma rotina. O marker só
é removido depois de todas as verificações/remoções e sync de diretório. Se uma
verificação, remoção ou sync falhar, ele sobrevive à liberação do owner e permite
uma nova tentativa limitada; caminhos desconhecidos, inclusive outros nomes
`.part`, não são enumerados nem tocados. A rotina também remove somente o
`m-<uuid>.tmp` exato, que nunca é fonte autoritativa; o `u-<uuid>.tmp` da
publicação do lock já é validado/reconciliado pelo próprio acquire do lock.

Completion valida somente os caminhos de chunks e partes derivados de `id` e
`chunkCount` do manifest validado (no máximo 100 índices), via `lstat` e sem
seguir symlinks. A contagem total de entradas em `.incoming` não participa da
conclusão; arquivos desconhecidos não são fonte de estado nem são removidos por
essa validação.

## Ponte de leitura privada (Task 4)

O Portal lê por `GET /api/contents/`, `/api/contents/categories` e
`/api/contents/:slug`, sempre com Firebase Bearer auth e revalidação do usuário
ativo. Paginação usa `limit` 1–50 e `offset` 0–1.000.000; lista, detalhe e
categorias são `private,no-store`. O catálogo, contagens, ordem
`publishedAt DESC, id DESC` e detalhe usam somente páginas publicadas elegíveis.
A API valida independentemente cada `PortalPageDTO`; a lista retorna array e
`X-Total-Count`, limitada a 50 DTOs de até 5 MiB normalizados cada e 16 MiB agregados.

`GET /api/contents/preview/:pageId?version=<uuid>` exige `manageKnowledge` e lê a
Version salva exata, sem substituir sua identidade pela versão atual. DTO normal
identifica a Version publicada atual; a resolução de asset confere esse mesmo ID
e rejeita links de uma publicação anterior. Se a projeção salva publicada divergir
do documento principal, o CMS falha fechado em vez de fabricar uma revisão.

O serviço mantém POSTs internos somente leitura em
`/editorial/api/portal-pages/{list,categories,availability,detail,preview,asset}`. Essa lista de
paths e o segredo `PORTAL_TO_PAYLOAD_SECRET` são próprios das páginas modulares;
não compartilham allowlist nem autoridade da Owner News. O CMS recusa `Origin`,
`Cookie` e `Sec-Fetch-Site`; o Nginx responde 404 para os paths internos públicos.
Nenhuma mídia de páginas é servida por `/uploads`.

`POST /api/contents/media-session` usa o ID token Firebase já autenticado para
emitir cookie Firebase de exatamente cinco minutos, sem aceitar body ou retornar
token/identidade. Produção usa `__Secure-ownerinc-content-media`, `Secure`,
`HttpOnly`, `SameSite=Strict` e `Path=/api/contents/assets`; desenvolvimento usa
`ownerinc-content-media-dev` somente em localhost HTTP. POST e DELETE exigem Origin
igual a `PORTAL_PUBLIC_URL` e rejeitam `Sec-Fetch-Site: cross-site`. Cada asset GET
verifica a sessão Firebase com revogação, carrega novamente o usuário ativo e, em
preview, revalida `manageKnowledge`. Cookie ausente, duplicado, inválido, expirado
ou revogado não autoriza bytes.

Asset URLs contêm somente UUIDs de página, revisão e mídia. A allowlist de mídia é
JPEG, PNG, WebP, PDF, MP4 e WebM; MOV/QuickTime não é suportado. Sob a
transação/lock de referências CMS, a mídia precisa estar referenciada pelo DTO
exato e cumprir MIME por uso (capa/imagem/galeria, vídeo ou PDF) antes de abrir o
descriptor privado.
O leitor envia chunks de 64 KiB com backpressure/cancelamento e nunca revela
`storageKey` ou caminho local. Imagens recebem resposta integral; PDF e vídeo
suportam um único Range, inclusive sufixo/aberto, com 416 para intervalos inválidos.
O máximo por arquivo é 500 MiB. O cliente API limita tempo até headers e timeout de
inatividade por leitura, sem um timeout total durante reprodução.

Nginx tem `location ^~ /api/contents/assets/` antes do proxy genérico, bloqueio
cross-site, corpo máximo de 1 KiB, buffering de request desligado e quota
`media_reads`. Essas rotas não ativam o frontend nem qualquer mutação/publicação;
deploy e teste contra Firebase/Nginx reais continuam separados.

## Prévia editorial privada no CMS

O editor Payload registra controles próprios de salvar/publicar/despublicar e
substitui os slots nativos de publicação e preview por componentes vazios somente
em `portal-pages`; autosave nativo de dois segundos, Versions sem retenção máxima,
diff e histórico permanecem disponíveis. O salvamento explícito cria uma Version
imutável pela Local API e a publicação exige confirmação contra a mesma Version
explícita ainda `latest`; não existe ação de restaurar uma revisão histórica.

`/editorial/portal-pages/preview/{pageId}?version={versionId}` é uma página
dinâmica e `private, no-store`, renderizada do DTO normalizado da Version exata.
Ela revalida a sessão V2 `manageKnowledge` e nunca troca UUID ausente, inválido ou
de outro pai pelo documento publicado/atual. O aviso deixa explícito que abrir a
prévia não publica a página. Texto, rich text, embeds e todos os tipos de bloco
passam pelas allowlists do DTO; a página não usa o shell público do Portal.
O DTO de prévia e seu `savedAt` são lidos juntos em snapshot exportado
`REPEATABLE READ, READ ONLY`, sem `CMS_REFERENCE_LOCK` ou `FOR SHARE`; uma mudança
concorrente depois desse snapshot não altera parcialmente a resposta.

Cada URL privada de mídia inclui UUID de página, Version e mídia. O novo GET
editorial revalida a sessão em toda requisição, confirma a referência e o MIME
específico do bloco sob `CMS_REFERENCE_LOCK` e lock de linha, abre o descriptor
seguro antes do commit e o entrega somente após a transação, devolvendo
`private,no-store`/`nosniff`. Imagens são integrais; PDF e vídeo mantêm a faixa
única (inclusive aberta e sufixo), backpressure de 64 KiB e cancelamento do leitor
existente. A URL e o DTO não contêm caminho de disco, `storageKey` ou token. Os
bytes já transmitidos não podem ser revogados retroativamente; uma nova requisição
Range sem sessão válida é negada.

Os controles de capa, imagem, galeria, vídeo e PDF continuam usando os campos
Relationship nativos; o wrapper de upload só permite selecionar mídia completa
depois da releitura autenticada. A confirmação de versão é invalidada por edição,
upload, autosave concorrente, troca de documento ou outra operação/modal. A
documentação operacional e a matriz por execução ficam em
[`docs/operations/portal-pages-editorial.md`](../operations/portal-pages-editorial.md)
e [`docs/reviews/2026-10-19-portal-pages-editorial-acceptance.md`](../reviews/2026-10-19-portal-pages-editorial-acceptance.md).

## Leitor publicado do Portal (Task 4)

O leitor está em `/contents.html`, integrado ao shell persistente, e consome
`GET /api/contents/`, `/categories` e `/:slug`. A API exige usuário Portal ativo
em cada leitura, retorna apenas conteúdo publicado elegível e mantém respostas
`private,no-store`. A disponibilidade usa `GET /availability` e responde somente
`{available:boolean}`: `false` representa ausência de publicações; 503 representa
dependência indisponível. O gate oculta/mostra o link da sidebar após validação
da identidade, mas não é uma barreira de autorização da rota nem substitui a
validação por requisição. Falha de categorias não apaga cards carregados.

As leituras JSON têm budget total de 4,2 s no pedido da API; o cliente API que chama
o CMS também tem seu próprio limite de espera por headers/resposta e aborta o fetch
upstream. O limite de 4 s do CMS é um prazo cooperativo de admissão e budget
restante, não um teto rígido para a duração da conexão, transação ou snapshot. As
guardas impedem que novas operações leitoras de dados comecem depois de observar
expiração e, após o setup, fornecem valores decrescentes de `lock_timeout` e
`statement_timeout` transaction-local para operações PostgreSQL seguintes. Antes e
depois de cada SQL guardada, e das operações da Local API Payload que podem emitir
várias instruções, o CMS verifica abort/deadline; os timeouts não aumentam dentro da
transação. Um timeout/abort/falha é convertido em 503 sanitizado quando o controle
retorna ao handler; catálogo e categorias nunca retornam resultado parcial. As
configurações são `SET LOCAL`/`set_config(..., true)` e não sobrevivem ao
rollback/commit.

O prazo cooperativo não cancela uma chamada já em voo a `pool.connect`, `BEGIN`,
`SET LOCAL` inicial, importação de snapshot ou refresh dos timeouts. A corrida do
início de transação limita a espera do caller e, se o ID chegar tarde, agenda um
rollback sem iniciar leitura; isso não encerra o `BEGIN` no servidor. Uma conexão
e, depois de criado, um snapshot podem permanecer retidos até o driver/servidor
resolver a operação em voo; o cleanup/rollback ocorre quando o fluxo recupera o
controle. O abort de headers/resposta do cliente API limita a espera do caller, mas
não prova cancelamento do trabalho PostgreSQL. Esses caminhos JSON não adquirem
`CMS_REFERENCE_LOCK`, inclusive enquanto aguardam setup ou cleanup. Os caminhos
travados de asset e mutação mantêm seu comportamento existente e não são alterados
por este contrato.

Catálogo, disponibilidade e agregação de categorias compartilham uma validação de
elegibilidade: status publicado, documento principal válido, Version publicada
salva exata ainda correspondente aos campos públicos atuais e todas as referências
de categoria/mídia resolvidas e válidas. Drift, Version ausente/malformada,
projeção inválida e referência quebrada tornam a página inelegível e não entram no
total; falha de banco, timeout/abort e falha operacional continuam falhando toda a
requisição com 503. Detalhe publicado mantém a semântica fail-closed para drift.
Paginação e `offset` são aplicados sobre a ordem determinística dos candidatos,
mas contagem/offset são de páginas elegíveis, não de linhas brutas publicadas.
Uma consulta de catálogo pode examinar até 100.000 candidatos em keyset batches de
até dez. O cursor de `publishedAt` preserva a precisão de microssegundos do
PostgreSQL em UTC; não passa por `Date` antes da próxima comparação/keyset, evitando
lacunas quando vários candidatos diferem apenas abaixo do milissegundo. Exceder o
limite ou o budget falha por inteiro.

Para dar consistência, catálogo, disponibilidade, categorias, detalhe publicado e
JSON de prévia editorial usam um holder PostgreSQL `REPEATABLE READ, READ ONLY`,
sem `CMS_REFERENCE_LOCK`, exportam um snapshot; cleanup tenta rollback após as
operações aguardadas se resolverem. Cada transação de projeção importa esse
snapshot antes de qualquer leitura de dados e
não adquire o advisory global nem `FOR SHARE`: elegibilidade e referências são
avaliadas pelo mesmo estado MVCC, sem serializar scans com publicação/mutação.
Transações de projeção instalam `SET LOCAL statement_timeout` e `lock_timeout`
finitos, depois definem isolamento read-only e importam o snapshot antes de SQL de
dados. A disponibilidade conserva o early exit no primeiro DTO elegível e não
calcula contagem nem monta catálogo. O holder usa o mesmo prazo cooperativo de até
4 s para admissão/remaining budget, não um limite rígido de vida: um comando de
setup ou refresh em voo pode reter conexão e horizonte MVCC até resolver, podendo
atrasar vacuum de tuplas mortas. Operação deve medir e monitorar transações antigas,
conexões ocupadas e autovacuum, e avaliar salvaguardas de infraestrutura/banco
apropriadas; o cleanup tenta rollback quando a operação pendente se resolve. Abort,
deadline e falha impedem trabalho leitor subsequente após o controle retornar, sem
resultado parcial, mas não garantem encerramento do holder em 4 s.

As leituras JSON representam a elegibilidade no snapshot exportado, não uma
autorização futura de bytes. Cada request de asset revalida a revisão e referências
exatas sob `CMS_REFERENCE_LOCK` e locks de linha antes de abrir o descriptor;
publicação/despublicação ou alteração de referência entre a projeção e o request
posterior pode fazer a URL de asset retornar 404.

O browser valida estritamente a forma pública antes de montar DOM: até 100 blocos,
10.000 nós, 5 MiB de conteúdo JSON, 6 MiB por detalhe, 16 MiB por coleção,
catálogo de 12 itens, offset máximo de 1.000.000 e 100.000 como total máximo.
Layout por bloco é `content|wide|full|left|right`; o conteúdo permanece no espaço
do `.main-content`, com quebra segura de texto e sem breakout horizontal. Rich
text e links usam allowlists; DTO inválido falha por inteiro, sem renderização
parcial ou interpretação de HTML.
Links de blocos e rich text aceitam somente HTTPS sem credenciais e limitam a URL
a 2.048 unidades UTF-16 (`String.length`), incluindo antes e depois da
normalização; a validação CMS/API/browser usa o mesmo limite.

### Mídia privada, renovação e limites

`POST /api/contents/media-session` exige Bearer válido e Origin igual à origem
configurada; não recebe body e só responde 204 após emitir cookie Firebase de
cinco minutos. Em produção usa `__Secure-ownerinc-content-media`, `Secure`,
`HttpOnly`, `SameSite=Strict`, `Path=/api/contents/assets`; HTTP loopback de
desenvolvimento usa `ownerinc-content-media-dev`. `DELETE` limpa a sessão e
também exige Origin. O cliente prepara um lease por vista que contenha assets,
renova em quatro minutos quando a página está visível ou há vídeo reproduzindo,
e mantém barreira de limpeza no logout/troca de conta. Falhas transitórias têm
backoff limitado de 5/15/30 segundos e respeitam `Retry-After` para 429. Falha
de rede entre abas invalida conteúdo local e exige nova validação da identidade.

URLs nativas usam UUIDs de página, revisão publicada e mídia. O servidor revalida
cookie Firebase com revogação, perfil ativo, referência e MIME em cada novo GET.
Imagens são integrais; vídeo/PDF permitem um Range único, inclusive aberto e
sufixo, com 206/416 segundo o intervalo. O leitor transmite em chunks de 64 KiB
com backpressure/cancelamento; o limite por ativo é 500 MiB. Não há Blob nem
download integral mantido em memória pelo JavaScript. Bytes já recebidos não
podem ser revogados retroativamente. Abas de PDF abertas fora do Portal não
renovam a cookie; se expirar, volte ao Portal e abra novamente.

Vídeos locais usam controles nativos, sem autoplay, e uma falha pode renovar a
sessão e recarregar apenas após ação de recuperação, preservando intenção de
reprodução quando ainda válida. Vimeo e YouTube usam somente URLs canônicas e
iframe sandbox fixo. O CSP Portal adiciona `https://player.vimeo.com` somente a
`frame-src`; CSP editorial e demais diretivas não mudam. Carga do iframe não
prova reprodução. PDFs e vídeos publicados continuam sujeitos às obrigações
editoriais de acessibilidade; controles nativos não fornecem legendas ou
transcrição ausentes.

A galeria usa um `<dialog>` próprio, controla foco/teclado e restaura exatamente
o estado de inert/rolagem que encontrou. Fechamento por rota/autenticação não
devolve foco a um elemento que está saindo. Saída de página/BFCache descarta
recursos privados e a restauração valida novamente identidade, disponibilidade
e emissão de mídia; o DOM anterior não é autoridade. Aceite HTTP, Range,
playback, leitor de tela e BFCache real permanecem casos de execução separados,
registrados no [runbook](../operations/portal-contents-reader.md) e na
[matriz por execução](../reviews/2026-10-20-portal-contents-reader-acceptance.md).

## Conteúdo e evolução

Galerias exigem lightbox no leitor. A exposição do link na navegação depende de
probe autenticado de disponibilidade, enquanto a rota direta é independente do
gate. Migrações podem fazer alterações aditivas e estreitas em relações internas
do Payload, mas não podem modificar dados nem schema de domínio da Owner News.

O contrato público limita conteúdo a 100 blocos e a 5 MiB de JSON UTF-8 da lista
normalizada. Ricos são texto seguro estruturado, não HTML arbitrário. Cada bloco
tem allowlist explícita; mídia editorial é referenciada por UUID e imagens de
galeria são ordenadas.

## Escopo desta decisão

Esta fundação e as tarefas seguintes definem primitivos, tipos, validação,
coleções, projeção de drafts nativos, persistência/relações, ponte de leitura,
ingress de upload e interface editorial no CMS. Deploy e aceite contra serviços
reais continuam gates separados e devem ser registrados com seus próprios
resultados. Essas entregas não alteram Owner News, seu parser global, migrations de
domínio ou serviços em execução.
