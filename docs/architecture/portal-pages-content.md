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

Publicação futura recebe somente `{id,expected_version_id,operation}`. A mutação
deverá comparar `expected_version_id` com a versão salva mais recente antes da
transição. Rascunhos e Versions retidos, capas e imagens de galeria contam como
referências para impedir exclusão prematura de mídia.

## Edição e autorização

A edição usa a sessão editorial V2 já existente e a capacidade `manageKnowledge`.
Ela é independente dos modos de autoridade da Owner News. Não se deve afrouxar
`canReadNewsArea`, `assertCmsWriteAuthority` ou os locks nativos da News para
habilitar páginas; autorização e escrita das páginas terão sua própria fronteira
nas tarefas posteriores.

## Mídia e uploads

O ingress privado do editor usa `POST /portal-page-uploads/init`, chunks
`PUT /:id/chunks/:index` de 5 MiB e endpoints autenticados de conclusão/cancelamento.
Imagens têm limite de 15 MiB, PDF 100 MiB e MP4/WebM 500 MiB; no máximo 100 chunks,
dois envios ativos por editor e oito no total. A reserva exige 1 GiB livre além de
duas cópias dos envios ativos. Manifests e partes ficam sob
`CMS_UPLOAD_DIR/portal-pages/.incoming`, são privados e expirados após 24 horas.
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
domínios da Owner News.

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
`/editorial/api/portal-pages/{list,categories,detail,preview,asset}`. Essa lista de
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

## Conteúdo e evolução

Galerias exigem lightbox no leitor. A exposição de navegação depende da
disponibilidade do conteúdo e será gated. Migrações podem fazer alterações
aditivas e estreitas em relações internas do Payload, mas não podem modificar
dados nem schema de domínio da Owner News.

O contrato público limita conteúdo a 100 blocos e a 5 MiB de JSON UTF-8 da lista
normalizada. Ricos são texto seguro estruturado, não HTML arbitrário. Cada bloco
tem allowlist explícita; mídia editorial é referenciada por UUID e imagens de
galeria são ordenadas.

## Escopo desta decisão

Esta fundação define primitivos, tipos, validação e a fronteira de DTO. Coleções,
projeção de drafts nativos, persistência/relações, ponte de leitura e ingress de
upload foram adicionados em tarefas próprias. A interface, publicação, deploy e
aceite contra serviços reais continuam posteriores. Essas entregas não alteram
Owner News, seu parser global, migrations de domínio ou serviços em execução.
