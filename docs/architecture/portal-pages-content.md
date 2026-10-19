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
(`useTempFiles:false`, limite de 50 MiB); leitura autenticada de mídia permanece
uma entrega posterior.

O leitor de vídeo/PDF usará cookie de sessão de mídia HttpOnly, SameSite=Strict,
curta e escopada à futura rota de assets. Segredos Firebase ou de serviço nunca
serão colocados em URLs. Tipos de arquivo no escopo são JPEG, PNG, WebP, PDF,
MP4 e WebM; MOV/QuickTime não é suportado.

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
projeção de drafts nativos, persistência/relações, endpoints, interface, ingress
de upload, serviço de mídia e deploy são entregas posteriores. A implementação
da fundação não altera Owner News, `api/`, parser global, migrations ou serviços
em execução.
