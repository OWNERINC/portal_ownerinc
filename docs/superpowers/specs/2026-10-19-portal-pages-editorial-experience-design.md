# Task 5 — experiência editorial das páginas modulares

Data: 2026-10-19. Base revisada: `583cba5a22eae9b4ecf6f76bd2f369508c4611be`.
Status: especificação da abordagem aprovada; este documento não implementa a tarefa.

## 1. Decisão e fronteiras

Estender o editor nativo de `PortalPages` no Payload **3.90.2**. Manter campos,
Lexical, blocos, arrays de galeria, validação, rascunhos, autosave de 2 segundos e
Versions sem limite. Acrescentar controles de salvamento explícito, prévia exata,
publicação/despublicação com compare-and-swap (CAS) e upload em chunks integrado
aos campos de mídia. Não criar outro editor nem exigir uma passagem manual pela
coleção de mídia.

Alternativas consideradas: editor próprio duplicaria o estado de formulário e
Versions; painel global com escolha de caminhos de destino exigiria coordenar
índices de blocos móveis. Escolhemos controles no editor e um wrapper reutilizável
de campo de relacionamento, com painel de upload local ao campo. Isso mantém o
destino inequívoco mesmo em galerias e reutiliza o seletor nativo.

Referências: `docs/architecture/portal-pages-content.md`, `PortalPages.ts`,
`portal-pages/{contracts,validation,persistence,native-blocks,reader}.ts`,
`endpoints/portal-page-uploads.ts` e `portal-pages/upload-service.ts`. Tasks 1–4
continuam sendo a autoridade sobre DTO, referências, permissões, armazenamento e
leitura. Não alterar Owner News, seus controles, parser, agenda ou autoridade.
Não alterar deploy, executar serviços ou implementar navegação/leitor público do
Portal nesta tarefa. A prévia descrita abaixo é exclusivamente editorial.

## 2. Significado de rascunho, snapshot e publicação

- **Autosave** é recuperação de trabalho. Pode atualizar a mesma Version com
  `autosave: true`; seu UUID sozinho não identifica conteúdo imutável.
- **Salvar versão** cria uma nova Version nativa com `autosave: false`, inclusive
  quando o conteúdo coincide com o último autosave. O documento publicado não é
  alterado. Campos de conteúdo desse snapshot nunca são reescritos; o marcador
  nativo `latest` pode mudar.
- **Publicar versão** publica exclusivamente o conteúdo do snapshot confirmado.
  Requer que ele ainda seja a Version `latest: true, autosave: false` do documento.
  Um autosave posterior, inclusive de outra aba, invalida a autorização CAS. Não
  procurar a última versão não-autosave ignorando versões posteriores.
- **Despublicar** retira a página da leitura normal, preservando versões e mídia.
  Exige o mesmo CAS e deixa como rascunho o conteúdo da versão explícita escolhida,
  sem descartar silenciosamente um rascunho mais recente. Não é excluir.

Conteúdo editável é o documento **nativo**: `title`, `slug`, `summary`, `cover`,
`coverAlt`, `categories`, `body`. Não gravar o DTO projetado no campo `body`.
IDs de linhas/blocos nativos são preservados; relações são normalizadas para IDs.
Campos `_status`, autores, datas, ID principal e metadados de Version são sempre
controlados pelo servidor. O `publishedAt` é estabelecido pela publicação e
zerado pela despublicação, como nos hooks existentes.

## 3. Endpoints editoriais

Registrar endpoints próprios em `cms/src/endpoints/portal-page-editorial.ts`, no
prefixo externo `/editorial/api/portal-page-editorial`. Não reutilizar os POSTs
internos `/portal-pages/{list,categories,detail,preview,asset}`, cujo acesso por
browser é proibido. Respostas usam `Cache-Control: private,no-store` e
`X-Content-Type-Options: nosniff`.

### Autenticação e CSRF

Toda operação revalida a sessão editorial V2 pelo fluxo existente, exige usuário
`portal-editors`, identidade UID válida, sessão não expirada e `manageKnowledge`
por `canManagePortalPages`. Usar a mesma verificação de ator/expiração do ingress
de uploads, extraindo helper page-local compartilhado quando necessário; não
introduzir permissão baseada apenas em um UID enviado pelo cliente. Não exigir
permissões de News de um editor V2 de conhecimento.

POST exige `assertEditorialOrigin(headers, readPortalPublicURL(...))`: Origin
exatamente autorizado, ausente/null rejeitado e `Sec-Fetch-Site: cross-site`
rejeitado. JSON obrigatório, credenciais same-origin, sem CORS permissivo. Essa é
a proteção CSRF junto da sessão existente; não inventar token CSRF em storage.
GET não exige Origin (navegação normal pode omiti-lo), mas rejeita cross-site e
continua autenticado. Nenhum GET escreve rascunhos, Versions ou publicação.

### Consulta de revisão — `GET /revision?id=<uuid>`

Ler sob transação/lock CMS e lock da página, retornando 200:

```json
{
  "id": "uuid",
  "document_status": "published",
  "latest": {
    "version_id": "uuid",
    "autosave": true,
    "saved_at": "ISO-8601",
    "snapshot_hash": "sha256-hex",
    "editable_hash": "sha256-hex"
  },
  "explicit": {
    "version_id": "uuid",
    "saved_at": "ISO-8601",
    "is_latest": false
  }
}
```

`latest`/`explicit` podem ser null. `explicit` é a última Version não-autosave,
somente informativa quando `is_latest: false`. Consulta determinística por
`updatedAt DESC, id DESC`; rejeitar múltiplos registros `latest` como estado
indisponível. `document_status` vem do documento principal, não do draft.
`snapshot_hash` cobre pai, UUID, flag autosave, updatedAt da Version e conteúdo
nativo normalizado; captura inclusive alteração in-place de autosave.
`editable_hash` cobre somente os sete campos editáveis canonicamente serializados
(chaves ordenadas, ordem dos arrays preservada, valores opcionais normalizados).
Compartilhar essa canonicalização entre cliente e servidor; não incluir datas,
autores ou marcador `latest` no hash editável.

### Salvamento explícito — `POST /save`

Duas variantes estritas, sem mistura ou chaves extras:

1. Documento existente: `{id, expected_latest_version_id, expected_snapshot_hash}`.
   UUIDs obrigatórios; hash SHA-256 hexadecimal. Não aceita conteúdo de browser.
2. Primeiro salvamento: `{id: null, data: {title, slug, summary, cover, coverAlt,
   categories, body}}`. Cria um draft e sua primeira Version não-autosave.
   Os opcionais têm defaults explícitos iguais aos campos nativos.

Limite de corpo 16 KiB para variante existente; primeiro salvamento limitado por
leitura incremental a 8 MiB de JSON nativo e pelo limite de 5 MiB do conteúdo
projetado. O cliente informa esses limites antes de enviar. Esta margem nativa
não altera o limite público. Validar schema completo, referências e nomes de
blocos; sem leitura integral ilimitada baseada só em Content-Length.

Para existente: adquirir `CMS_REFERENCE_LOCK` e row lock da página; reler a
Version latest, conferir ID **e** snapshot_hash. Copiar seus sete campos via
Local API `update`, `draft: true`, `autosave: false`, `_status: 'draft'`, mesma
requisição transacional. Para criação usar Local API `create` com draft e
autosave false. Aplicar hooks e validação page-local. Resolver o UUID da nova
Version dentro da mesma transação; o ID retornado por `update` é ID do documento,
não ID da Version. Exigir nova identidade, pai correto e autosave false.

201 retorna `{id, version_id, saved_at, editable_hash, document_status}`. Após
criação navegar para a rota nativa de edição do ID retornado. O endpoint não
publica nem aceita `expected_version_id` como substituto do hash de autosave.

### Transição — `POST /publication`

Corpo exatamente igual ao contrato existente:
`{id, expected_version_id, operation: 'publish' | 'unpublish'}`. Máximo 16 KiB.
Usar `validatePortalPagePublicationInput` e `withExpectedPortalPageVersion` sem
enfraquecer seu teste `latest === true && autosave === false`.

200 retorna `{id, operation, source_version_id, resulting_version_id,
document_status, published_at}`; `published_at` é ISO ou null. O ID fonte não é
confundido com o novo ID publicado, que será usado pelo leitor normal da Task 4.
A resposta é recibo da transição, não garantia de que nenhuma edição ocorreu
depois dela. Reconsultar revisão após sucesso.

Dentro do callback do helper, extrair **todos** os campos editáveis de
`versionRecord.version` (incluindo listas vazias e nulls explícitos), validar pai,
projeção, categorias, referências e MIME por uso. Publicação exige mídia completa.
Copiar esse conteúdo pela Local API com `draft: false, autosave: false` e status
da operação. Não enviar apenas `_status`, não combinar com valores do formulário
nem confiar no draft/documento atual. O hook de publicação mantém autoria e
datas server-owned. A comparação, cópia do conteúdo, escrita do principal e
criação da Version resultante são uma transação única na mesma sessão.

Para despublicar usar `_status: 'draft', draft: false, autosave: false` dentro do
escopo autorizado; **não** usar `unpublishAllLocales: true`: no Payload 3.90.2
essa opção pode chamar `updateLatestVersion` e reescrever o snapshot fonte.
Copiar o snapshot explícito para o principal e criar uma nova Version de draft;
preservar slug canônico e todos os snapshots anteriores. Despublicar página já
em draft retorna 409 `portal_page_not_published`. Republicar é permitido quando
existe uma versão explícita latest confirmada; cria novo recibo/Version e data.

Em ambas as mutações, confirmar a persistência da Version resultante em sessão
nova, sem transactionID herdado, antes de declarar sucesso. O adapter Drizzle
pode ocultar rejeição tardia de commit (evidência já registrada na Task 3).
Conferir pai, conteúdo esperado, autosave false e metadados da transição; uma
Version posterior legítima não invalida o recibo já persistido. Não exigir que o
resultado ainda seja latest nessa confirmação. Falha/ambiguidade retorna 503,
sem repetir automaticamente mutação. Nunca compensar apagando versões.

### Erros e reconciliação

Formato sanitizado `{error: 'codigo_estavel', message: 'Mensagem em português'}`;
validação pode acrescentar `fields: [{path, message}]`, sem valores sensíveis.
400 dados inválidos; 401 sessão expirada; 403 permissão/Origin; 404 página/versão
inexistente; 409 conflito de versão ou estado; 413 limite; 503 indisponibilidade
ou confirmação de commit incerta. Não retornar SQL, stack, paths ou tokens.

409 nunca faz fallback para outra versão. Limpar confirmação/link ativo e mostrar
“A página mudou desde a conferência. Seus campos foram preservados. Confira e
salve uma nova versão antes de publicar.” O usuário deve reconciliar o documento
e confirmar novamente. Não atualizar automaticamente o expected ID e repetir.
Em perda de resposta/503: “Não foi possível confirmar a operação. Consulte o
estado antes de tentar novamente.” Reconsultar; nunca repetir POST save/create
automaticamente. Criação ambígua exige verificar lista/slug antes de nova criação.

## 4. Coordenação do formulário e prevenção de versão obsoleta

`PortalPageEditorialControls` usa os mesmos hooks públicos empregados em
`SavedPreview`/`ScheduleRevision`: `useDocumentInfo`, `useForm`,
`useFormModified`, `useFormProcessing`, `useFormBackgroundProcessing`,
`useFormInitializing` e `useModal`. Usar também assinatura seletiva de campos via
`useFormFields` quando necessário; não usar `form.fields` desatualizado.

No documento existente, “Salvar versão” aguarda o autosave terminar e o formulário
ficar não-modificado. Mostrar “Aguarde o salvamento automático para salvar uma
versão.” Não promover silenciosamente um snapshot que não corresponda à tela:
ler revisão, comparar editable_hash com os dados obtidos de `form.getData()` e
rever estado/geração após cada await. Se divergir, bloquear e pedir reconciliação.
Isso evita adotar como base uma edição remota enquanto os campos locais diferem.
Para documento novo, validar com `form.validateForm()` e enviar somente os sete
campos permitidos; o autosave nativo não cria documento sem ID.

Durante a solicitação explícita, usar `form.setProcessing`/`setDisabled` com
restauração em finally e mutex local. Esses hooks são coordenação de UI, **não**
um lock contra o timer nativo ou outras abas. O ID+hash no save e o CAS na
publicação continuam obrigatórios. Se um autosave atrasado entrar depois do save,
ele torna a versão explícita não-latest; publicar falha fechado até novo save.

Não chamar `setModified(false)` para esconder alterações. No save existente o
conteúdo não muda, portanto não resetar o formulário; atualizar indicadores e
reconsultar revisão. Se uma resposta chegar após mudança de página, edição,
upload, início de autosave ou desmontagem, descartá-la usando AbortController e
geração da solicitação. Abortar fetch não significa rollback do servidor.

Prévia/publicação usam o ID retornado pelo save ou descoberto por GET quando
`latest.autosave === false`, `explicit.is_latest === true` e o hash editável
corresponde ao formulário. Bloquear em modified, processamento, inicialização,
upload, formulário disabled, lock ou outro modal. Verificar novamente antes de
abrir confirmação; mostrar título, ID e horário da versão. “Publicar esta versão”
e “Despublicar esta versão” exigem confirmação explícita; POST continua a ser a
autoridade final. GET não é uma reserva de versão.

Preservar a tela nativa de Versions e seus diffs. Restore direto continua negado
pelos hooks; não adicionar bypass nem anunciar restauração histórica como ação
disponível nesta tarefa. Publicar versão histórica exige primeiro reconciliá-la
como novo draft explícito em trabalho posterior, não mudar o contrato CAS.

## 5. Prévia editorial exata e assets

URL escolhida: `/editorial/portal-pages/preview/<pageId>?version=<versionId>`.
É uma view editorial autenticada, read-only, fora de `public/`, sem navegação do
Portal. Nunca omitir `version`, usar slug como substituto ou redirecionar para a
publicação atual. Abrir por link real `target="_blank" rel="noopener noreferrer"`
com rótulo “Abrir prévia desta versão em nova aba”.

A view server-side autentica o editor e chama o leitor page-local da Task 4 para
essa Version. Renderizar somente o DTO normalizado, texto estruturado seguro e
blocos permitidos; sem HTML arbitrário. Mostrar título “Prévia editorial”, UUID,
horário e aviso “Esta prévia não publica a página”. O status da revisão é o do
snapshot, não uma afirmação sobre o principal. Versão ausente/inválida ou perda
de permissão produz estado de erro, nunca fallback. Uma prévia já aberta continua
representando o snapshot antigo mesmo quando o editor muda; não se atualiza
automaticamente para outra versão.

O CMS não possui necessariamente ID token Firebase do browser. Portanto não
trocar cookie editorial por sessão Firebase nem chamar media-session fingindo
ser o Portal. Para esta view, adicionar GET editorial
`/editorial/api/portal-page-editorial/preview-assets/<pageId>/<versionId>/<assetId>`:
sessão editorial HttpOnly existente, revalidação de manageKnowledge **em cada
GET**, UUIDs estritos, rejeição cross-site, referências/MIME conferidos contra o
DTO exato e stream privado por helpers da Task 4. Reutilizar resolução de mídia,
descriptor seguro, Range para PDF/vídeo, backpressure e cancelamento; não duplicar
armazenamento. Nunca expor storageKey, path, token ou URL pública de upload.
Não permitir leitura de arquivo que apenas esteja completo mas não referenciado.
Respostas private,no-store, nosniff e sem credenciais em URL; sessão expirada
interrompe novas leituras e a view orienta reautenticação.

O contrato externo permanece exatamente o da Task 4: futura view do Portal usará
`GET /api/contents/preview/:pageId?version=<uuid>`, ID token para emitir a sessão
de mídia de cinco minutos e URLs com escopo `portal-pages-preview`, página,
revisão e asset. Esse cookie é credencial de identidade, **não** reserva da versão;
cada asset revalida o snapshot e a permissão. Não implementar esse frontend ou
alterar o TTL/caminho dos cookies nesta tarefa.

## 6. Componentes e integração Payload

Arquitetura pequena em `cms/src/admin/portal-pages/`:

1. `PortalPageEditorialControls.tsx`: save, consulta, prévia, confirmações CAS;
   instalado em `admin.components.edit.beforeDocumentControls` de PortalPages.
2. `PortalPageMediaField.tsx`: wrapper de `RelationshipField` público, preservando
   props/validação/path/filterOptions, mais botão e Drawer de envio. Instalado
   apenas em cover e nas relações asset dos blocos image/gallery/video/pdf.
3. `PortalPageUploadPanel.tsx`: input de arquivo, protocolo, progresso, cancelar,
   retry e resultado; recebe MIME permitido e callback de conclusão. Um upload
   ativo por painel; enquanto ativo o uploadStatus do documento bloqueia iniciar
   outro painel nesse editor. Limites do servidor continuam soberanos.
4. Helpers `editorial-state.ts` e `upload-client.ts`: contratos, validação de
   respostas, canonicalização/estados e requests testáveis sem React.

O wrapper usa `useField({path})` para aplicar `setValue(mediaID)`; não inventa
IDs, não despacha mudanças em caminhos arbitrários de formulário. Depois de
complete bem-sucedido, buscar novamente o registro pela API de leitura da coleção
`portal-page-media`, conferir ID, state complete e MIME permitido. Recriar somente
o seletor `RelationshipField` por uma chave de refresh local para eliminar opções
em cache, mantendo o valor no estado Payload; apresentar “Usar este arquivo”.
Só essa ação seleciona o ID confirmado. Fechar painel sem selecionar mantém o
arquivo disponível na biblioteca e não altera o campo.

Se a linha do bloco/galeria for removida, reordenada ou o path mudar durante o
envio, invalidar o destino original e não aplicar resultado automaticamente ao
novo índice. Desmontagem aborta a UI; conclusão pode ser reencontrada no seletor.
A seleção altera o draft e invalida a confirmação de publicação, como qualquer
edição. Não preencher alt/title com nome de arquivo como se fosse texto acessível;
manter os campos nativos obrigatórios. Galeria continua exigindo 2–20 itens e
ordenação nativa, um relacionamento por item.

Coleção continua com `allowCreate: false, allowEdit: false` nos seletores.
Não usar REST/GraphQL direto para criar/editar mídia. Publicação REST direta,
restoreVersion e `_status` arbitrário continuam barrados no servidor.

Suprimir controles nativos de publish/unpublish/preview somente em PortalPages
por seus slots públicos `PublishButton`, `UnpublishButton`, `PreviewButton`, com
componente vazio, pois as ações ficam no controle integrado. Não esconder por CSS
ou DOM. **SaveDraftButton não resolve o problema**: no 3.90.2 ele só aparece com
autosave desabilitado. Registrar os novos componentes no import map gerado em
`cms/src/app/(payload)/editorial/admin/importMap.js`, preservando entradas existentes.

Feasibilidade conferida contra tipos instalados de `@payloadcms/ui` (Form,
DocumentInfo, RelationshipField) e slots de CollectionConfig. Não importar
internals do UI, monkey-patch de autosave, querySelector, simular cliques ou ler
inputs do DOM. Backend pode usar Local API pública e helpers transacionais do
repo; testes reais precisam verificar a semântica de Versions no adapter fixado.

## 7. Protocolo de upload no browser

Usar os endpoints existentes em `/editorial/api/portal-page-uploads`, sessão
same-origin e Origin natural do browser. Apenas **um chunk em voo** por upload;
chunks paralelos do mesmo ID competiriam pelo ownership do filesystem.

1. Validar arquivo local e enviar `POST /init` JSON
   `{originalName: file.name, mimeType, bytes: file.size}`. Resposta 201:
   `{id, token, chunkSize, chunkCount, bytes, mimeType}`. Validar UUID, token,
   chunkSize = 5242880, count = ceil(bytes/chunkSize), tamanho e MIME esperados.
2. Para índices zero-based 0 até count-1: `PUT /<id>/chunks/<index>` com
   `Content-Type: application/octet-stream`, header `x-portal-page-upload-token`
   e corpo `file.slice(start, end)`. Browser calcula Content-Length quando
   disponível; JavaScript não tenta definir esse header proibido. Aceitar resposta
   `{id,index,received:true,duplicate,...sha256}` após validar ID/índice.
3. `POST /<id>/complete`, JSON `{token}`. Validar
   `{id,state:'complete',mimeType,bytes,sha256,completedAt}` antes de habilitar uso.
   100% dos chunks não significa mídia pronta; exibir “Validando arquivo…”.
4. Cancelar: abortar request em voo e depois `DELETE /<id>` JSON `{token}`.
   Resposta `{id,cancelled:true}` confirma cancelamento. Se retornar
   `media_already_complete`, consultar mídia e informar “O arquivo já foi
   concluído”; não excluir mídia completa por outra API.

Progresso calculado por bytes de chunks confirmados, sem inventar progresso de
rede do fetch: “Enviando bloco 3 de 20 — 10 MiB de 100 MiB”. `progress` com total
de bytes e status separado de validação. Não ler arquivo inteiro para hash,
base64, ArrayBuffer, FileReader ou FormData. Manter File e apenas o Blob.slice
ativo (5 MiB, último menor); liberar referências ao concluir/cancelar. Um vídeo
de 500 MiB produz até 100 chunks, não 500 MiB de buffers JavaScript. Não gerar
thumbnail/decodificação integral de vídeo/PDF nem hash cliente do arquivo inteiro.

Retries: chunks repetem **mesmo índice e mesmos bytes**, até três novas tentativas
com backoff 1s/2s/4s e pequeno jitter, somente erro de rede, upload_busy, 429 ou
503 transitório. Complete pode repetir com o mesmo token/id, em igual limite,
pois o servidor reconcilia conclusão já confirmada. Cancel segue o mesmo limite
para busy/rede; depois exibe pendência. `chunk_conflict`, token inválido, 400,
401/403, 404, 413/415 e 507 não geram retry automático. Init não é idempotente:
não repetir automaticamente após resposta perdida; informar possível reserva
pendente e permitir nova tentativa consciente, sujeita às quotas. Sem endpoint
de resume/status inventado; retry manual mantém token e último índice enquanto
o componente permanece montado.

Token somente em ref/estado privado do componente/protocolo; nunca em URL,
localStorage, sessionStorage, IndexedDB, logs, analytics ou mensagem de erro.
Apagar ao concluir/cancelar/desmontar. Não prometer retomada após reload.
Em fechar Drawer ativo, perguntar “Cancelar envio?”; cancelar antes de fechar
quando possível. `beforeunload` só durante upload avisa sobre saída; em unmount
abortar e tentar cancelamento best-effort se ainda houver token. sendBeacon não
substitui DELETE autenticado. Fechamento/crash/browser suspenso pode impedir
cleanup; envios incompletos tornam-se elegíveis para reconciliação após 24h, mas a
passagem é disparada por tráfego em um `init` posterior e não tem garantia de
conclusão em tempo de relógio. A fila durável não é um scheduler. Cancelamento
incerto não é exibido como sucesso.

Allowlist visível e no `accept`: JPEG `.jpg,.jpeg`, PNG `.png`, WebP `.webp`
(15 MiB); PDF `.pdf` (100 MiB); MP4 `.mp4`, WebM `.webm` (500 MiB). Cover/image/
gallery permitem apenas imagens, video apenas MP4/WebM, pdf apenas PDF. Rejeitar
arquivo vazio, extensão incompatível e MIME declarado incompatível; se File.type
vier vazio, inferir somente dessa tabela fechada. Não aceitar MOV/QuickTime,
SVG, GIF, HTML ou MIME genérico como permissão para qualquer extensão. O servidor
continua validando bytes reais, metadados e limites; `accept` é orientação, não
segurança. Explicar quotas de dois uploads ativos por editor/oito globais quando
o servidor retornar upload_limit_reached.

## 8. Estados, acessibilidade e aparência

Usar componentes, espaçamento e cores do admin existente; sem redesign genérico,
novos temas, animação decorativa ou dependência de biblioteca visual. Estados de
editor: “Aguardando salvamento automático”, “Salvando versão…”, “Versão salva”,
“Conferindo versão…”, “Publicando…”, “Página publicada”, “Despublicando…”,
“Página despublicada”, conflito, sessão expirada e erro recuperável. Upload:
“Escolha um arquivo”, “Preparando envio…”, “Enviando…”, “Validando arquivo…”,
“Arquivo pronto para selecionar”, “Cancelando…”, “Envio cancelado” e erro.

Botões reais type=button, labels associados, instruções de formatos/tamanhos por
aria-describedby, foco visível e ordem natural. Input de arquivo sempre acessível
por teclado; drag-and-drop não é requisito. Drawer preserva foco/trap nativos,
retorna foco ao disparador e Escape durante envio pede confirmação em vez de
descartar silenciosamente. Não fechar modal nem mover foco a cada chunk.
Status em aria-live polite; erros finais em alert e mensagens de campo com foco
no primeiro inválido no save. Anúncios de progresso por chunk ou marco percentual,
sem inundar leitores de tela. Disabled deve ter explicação visível; cor não é
único indicador. Respeitar prefers-reduced-motion nas eventuais transições nativas
ou estilos locais. Link de nova aba anuncia esse comportamento.

## 9. Verificação e aceite da implementação posterior

Testes de contrato/unitários e testes de UI devem cobrir resultados reais, não
somente existência de nomes de componentes:

- Auth/Origin/CSRF, limites de body, chaves extras, tentativa de status/autor
  arbitrário, UUID de outra página e ausência de mídia completa por uso.
- Autosave mutável com mesmo UUID e conteúdo/hash diferente; explícito cria novo
  UUID; consulta nunca salva; CAS recusa latest autosave mesmo havendo explícita
  anterior; duas publicações concorrentes têm só um vencedor.
- Publicação usa a Version escolhida quando principal/browser divergem; snapshot
  fonte permanece íntegro; main e nova published Version projetam DTO igual.
  Unpublish cria nova draft Version, retira leitura normal, preserva histórico,
  referências e slug; nenhuma chamada unpublishAllLocales.
- Falha de transação, commit tardio e resposta perdida não exibem sucesso falso;
  confirmação pós-commit suporta outra versão legítima já posterior.
- UI rejeita resposta atrasada, hash divergente, modificação durante consulta,
  autosave após save, double click e troca de documento; não limpa campos no 409.
- Upload com último chunk parcial, 500 MiB via slices <=5 MiB, uma request ativa,
  retry duplicate, chunk_conflict, complete incerto, cancel busy/completed,
  unmount e token ausente de persistência/logs. Nenhuma seleção antes de complete
  + leitura autenticada; MIME errado, campo removido/reordenado e erro de refresh
  não inserem ID. Cobrir todos os cinco destinos.
- Prévia fixa UUID, rejeita versão de outro pai e asset não referenciado; perda
  de sessão/permissão bloqueia novos bytes, Range funciona e nenhum fallback para
  publicação atual ou armazenamento público é possível.
- Teclado e screen reader: save, confirmação, upload, cancel, selecionar e nova
  aba; status acessível e reduced motion. Regressão de blocos, autosave, Versions
  e controles existentes de News.

Executar `npm run verify` e `git diff --check`. Typecheck deve resolver componentes
e import map em 3.90.2. A semântica de CAS/Versions, serialização de updates e
confirmação de commit exige teste com Payload/PostgreSQL descartáveis; o runner
`npm run test:payload` atual não é prova dessa integração (README documenta saída
2). Preparar essa suíte real como parte do aceite de implementação, sem iniciar
Docker/serviços sem aprovação. Testes offline não autorizam afirmar persistência,
streaming em Nginx, Firebase real ou acessibilidade manual já comprovados.

## 10. Autorrevisão e riscos explicitados

Esta especificação não depende de API interna de React nem de SaveDraftButton
com autosave ativo. O upload é sequencial e limitado por chunk. Publicação não
usa dados atuais por acidente; autosave posterior impede CAS. Unpublish não
reescreve o snapshot. Seleção só usa registro completo retornado/revalidado.
Prévia editorial e sessão de assets do Portal têm autoridades distintas e
nenhuma troca implícita de credenciais. Rotas de preview editoriais são trabalho
CMS desta tarefa, não um frontend público disfarçado.

Riscos a verificar na implementação: comportamento do adapter de Versions sob
concorrência, registro de hooks na criação inicial, refresh do RelationshipField
sem perda de foco/valor e observação de debounce nativo. Esses pontos têm decisões
e critérios de teste acima; não justificam enfraquecer CAS, desabilitar autosave,
editar tabelas de Versions manualmente ou introduzir um editor paralelo.
