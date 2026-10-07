# Owner News — ponte de leitura e prévia salva (Tasks 7–8)

Esta entrega é local e não faz cutover. **Solicitar autorização antes de qualquer
deploy na VPS.** Não ativar Payload para leitores reais antes das tarefas de
migração/aceite. Escritas legadas e freeze de mutações continuam na Task 12.

## Interfaces

- `createAnnouncementsRouter({backend,authenticate,pollsRouter})` mantém o export
  padrão, `/polls` primeiro, array + `X-Total-Count`, `{content}` e `{previous,next}`.
- `createNewsBackend({pool,payloadClient})` resolve `owner_news_authority` a cada
  operação. `legacy`/`frozen` usam o leitor legado; `payload`/`payload_frozen` usam
  exclusivamente Payload. Controle ausente ou dependência indisponível: **503
  `news_unavailable`**, sem fallback. A prévia legada antes do cutover consulta a
  revisão exata no banco legado; após o cutover consulta a coleção de histórico.
- `createPayloadNewsClient({baseURL,secret,fetchImpl,timeoutMs=5000})` expõe
  `query(action,input,actor,{signal,requestId}={})` e `asset(input,actor,options)`.
  `requestId` é uma extensão opcional para correlação; ausente/inválido gera UUID.
  A configuração padrão é lazy: `CMS_INTERNAL_URL` (somente origem HTTP(S), sem
  path/query/credenciais) e `PORTAL_TO_PAYLOAD_SECRET` não são exigidos no boot
  legado. Segredos são exclusivamente server-side e distintos nas duas direções.
- Sete POSTs somente leitura sob `/editorial/api/portal-news`: `list`, `detail`,
  `categories`, `navigation`, `home`, `preview`, `asset`. Corpo exato `{actor,input}`,
  Authorization Bearer dedicado, `X-Request-ID`. Sem encaminhar cookie, token do
  navegador ou headers arbitrários. Actor vem de `req.user` + política atual
  `manageKnowledge`. Prévia exige editor, documento/revisão UUID e
  `source=payload|legacy` (default payload); `version` é obrigatório.
- No POST privado, `kind` e `source` exigem strings primitivas com enum exato.
  Arrays, objetos e valores coercíveis retornam 400 antes de consultar conteúdo
  ou selecionar a fonte de prévia; não há coerção via `String(...)`.
- Tipos CMS: `src/contracts/news.ts`; API: validação JSON independente de Next e
  Payload em `payload-dto.js`. Formatos nativos nunca atravessam a fronteira.

As exceções de Origin existem **tanto no proxy Next quanto no boundary REST**,
somente nos sete paths exatos e método POST com segredo válido, sem Origin,
Cookie ou Sec-Fetch-Site. Não autenticam coleções genéricas, admin ou Server Actions.
Chamadas privadas também validam segredo/actor/input no handler. Corpo de entrada
tem teto de 16 KiB. Nginx deve bloquear os paths privados no futuro rollout;
nenhuma configuração de deploy foi alterada aqui.

## Publicação, limites e falhas

Leituras Local API usam explicitamente `overrideAccess:true` apenas depois da
autenticação privada, `depth:0`, `draft:false`, filtro `_status=published` e o mesmo
`req`/transação sob lock 7194030. Editor normal também vê somente a publicação.
Prévia nativa consulta ID da versão **e parent**; prévia legada usa a identidade
composta original, sem fallback de fonte. Homepage usa o Global publicado.

O piloto varre lotes de 100, máximo 1000 lotes (exceder retorna 503), valida
conteúdo/referências/arquivos antes de contar/paginar e ordena publishedAt DESC,
updatedAt DESC, UUID ASC. Categoria vazia é filtro válido, mas não entra no catálogo
de nomes. Navegação exclui edições; uma edição retorna previous/next null. Falha
operacional de arquivo/storage/DB não é convertida em feed vazio. Apenas conteúdo
malformado ou referência com shape/tipo inválido exclui aquela publicação.

JSON de saída: detail/preview 6 MiB; home/navigation 64 KiB; categories 1 MiB e
10.000 nomes; list `(limit*6+1) MiB`, limit 1..100. Não há truncamento de categorias
nem omissão de corpos. Limites por metadata e bytes lidos; timeout cobre leitura
completa e cancela streams. Assets usam streaming (não JSON), 50 MiB, headers
allowlisted, Range simples para PDF/vídeo, 416 com Content-Range e cancelamento
no disconnect. Falha depois de começar os bytes encerra a conexão, sem JSON
interno no stream. O client não segue redirects nem faz retry.

## Handoff explícito Task 10/11 — pré-requisito antecipado

Somente schema read-only, registro, migration e tipos gerados foram antecipados.
**Não** há exportador, importer de bundle ou view de histórico nesta tarefa.
Collection `legacy-news-revisions`, identidade única
`(legacyDocumentId,legacyRevisionId)`; ambos UUIDs públicos originais lowercase,
nunca source_id nem IDs de Versions nativas.

`LegacyNewsRevisionInput` em `contracts/news.ts` define:

| Campo | Semântica |
|---|---|
| legacyDocumentId / legacyRevisionId | Documento público e revisão originais |
| originalVersion | Inteiro positivo original |
| originalCreatedAt | Data original como texto, sem fabricar data nativa |
| originalActorUid | Ator original ou null; sem substituir pelo importador |
| originalStatus | draft / published / scheduled / archived original |
| originalTitle / originalCategory | Metadados originais do documento |
| originalPublishedAt | Data de publicação original ou null |
| originalBody / originalEditorial | JSON original validado; editorial null preservado |
| contentHash | SHA-256 canônico de title, category, body, editorial originais |
| provenanceHash | SHA-256 canônico dos IDs, versão, data, ator, status, publishedAt e contentHash |
| mediaReferences | Relações explícitas com os UUIDs de mídia presentes no body |

`historyHashes` é a função de referência: usa a mesma canonicalização recursiva
de `snapshotHash`, tolerando reordenação de chaves por JSONB sem alterar valores.
`id/createdAt/updatedAt` gerados da coleção são ingestão, **não** proveniência.
Histórico não altera draft/publicação nativos. O future importer deve criar com
Local API confiável, `legacyNewsImportContext` server-only, `overrideAccess:true`
e `withCmsTransaction`; não expor esse capability em HTTP. Create/update/delete
REST negados; update/delete também negados com overrideAccess. Leitura genérica
é editor-only. A coleção fica oculta até a view própria da Task 10/11.

Retenção de mídia varre **tanto relações quanto originalBody independentemente**,
além de artigos/Versions/snapshots. Não foi só incluída uma allowlist. Referência
bruta desconhecida falha fechada; uma relação omitida não libera o arquivo.

## Task 8 — leitor e prévia editorial

O Portal entende `rich_text` exclusivamente em `content_version: 2`. O contrato
`validateNewsBlocks(value, version=1)` preserva os onze tipos legados e rejeita o
corpo inteiro antes de montar conteúdo/mídia se qualquer nó for inválido. O limite
é 100 blocos, 5 MiB normalizados, 10.000 nós compartilhados e profundidade inline
máxima 4; links aninhados são proibidos. `renderRichContent(root,nodes)` usa DOM e
texto, nunca HTML: parágrafos, headings h2–h6, listas, strong/em/u/code e links HTTPS
sem credenciais. `newsBlocksToText` inclui rich text no resumo/estimativa, mas não
conta títulos de arquivos como leitura; edições PDF legadas continuam sem minutos.

`renderBlocks(root,blocks,{signal,assetScope='legacy'})` continua legado para
Academy/Conhecimento. `cmsAssetEndpoint(id,scope)` em
`public/js/owner-news/asset-path.mjs` (também exportado pelo renderer) aceita apenas
UUID e os três enums: `legacy`, `owner-news`, `owner-news-preview`. Reader, perfil,
capa, vídeo, PDF, catálogo e Dashboard propagam o scope do DTO; não aceitam URL
arbitrária como raiz. Cancelamento, retry local e revogação de blobs permanecem.
Task 14 deve incluir `.mjs` públicos na varredura de sintaxe; o novo helper foi
checado explicitamente nesta entrega.

`/news-preview.html?id=<UUID>&version=<UUID>&source=payload|legacy` é uma página
estática do shell (router registrado), em aba própria, sem iframe de prévia ou
alteração de CSP. `source` pode ser omitido (payload); IDs são obrigatórios,
parâmetros desconhecidos/duplicados são rejeitados. `mountNewsPreview(page)` usa
`page.bindAPI(fetchAPI)`, consulta a permissão `manageKnowledge`, revalida no foco
e busca a revisão exata por `/api/announcements/preview/:id`. A autorização real
permanece na API. Cleanup cancela solicitações, limpa conteúdo e descarta respostas
tardias, inclusive troca de conta durante JSON/blob (guard do auth existente).

**Extensão compatível opcional do NewsDTO:**

```text
preview_revision?: {
  id: UUID da revisão solicitada,
  source: 'payload' | 'legacy',
  status: 'draft' | 'published' | 'scheduled' | 'archived'
}
```

Somente prévias emitem esse campo. Em Payload, status é `_status` da **Version
salva** (draft/published); no histórico importado é `originalStatus`; antes do
cutover legado é `cms_revisions.status`. A API valida id/source contra a consulta
e recusa metadata em DTO publicado. O banner diz “Conteúdo não publicado” apenas
para revisão draft, “Revisão salva como publicada” para published, e avisa que a
prévia pode não ser a publicação atual. `source=legacy` acrescenta “Histórico
anterior à migração”. DTO antigo sem metadata recebe o rótulo neutro “Revisão
salva”, nunca uma afirmação fabricada de status.

O controle Payload **Conferir prévia salva** usa a extensão pública
`admin.components.edit.beforeDocumentControls` e o GET read-only já existente
`/editorial/api/news-schedule?target=article&documentId=...`. Ele confirma a Version
persistida e oferece **Abrir prévia editorial em nova aba** (`noopener noreferrer`),
sem cookie/token no endereço. Não cria/salva rascunho no GET, nem troca ID por data
ou ID do documento. Campos modificados, inicialização, save/autosave, upload,
lock/desabilitado ou drawer aberto bloqueiam consulta/link; mudança de formulário
invalida consulta tardia. Um 409 preserva os inputs e pede nova consulta. Este fluxo
de duas ações evita popup bloqueado após uma consulta assíncrona.

Task 9 ainda possui entrada/logout/account-watch/brand/polls; Task 10 possui UI de
histórico; Task 15 possui aceite visual completo. Esta entrega não os antecipa.

### Verificação Task 8

```text
node --test tests/unit/owner-news-rich-content.test.mjs tests/unit/owner-news-payload-preview.test.mjs tests/unit/owner-news-reader.test.mjs tests/unit/owner-news-editorial.test.mjs tests/unit/owner-news-payload-api.test.mjs
npm --prefix cms run typecheck
npm --prefix cms run test:unit
# Build (PowerShell):
$env:CMS_BUILD_ONLY='true'; npm --prefix cms run build
npm run verify
node --check public/js/owner-news/asset-path.mjs
git diff --check
```

O harness opt-in `node cms/tests/integration/run-task8.mjs --prepare-new-task8`
cria **apenas um banco novo `cms_task8_test`** em 127.0.0.1:55441; recusa se já
existir, sem resetar bancos anteriores. Usa credenciais privadas locais, sem
logá-las. `--browser <diretório-privado>` inicia/encerra somente seus processos
Next 18088 e double interno 18089. Verifica controle nativo, Versions reais,
autosave pendente, 409, prévia em aba própria, banners draft/published e revisão
antiga imutável, com screenshots 1440×900/390/320. PostgreSQL/Next/Payload e client
API são reais; Firebase, introspecção Portal e hospedagem/roteamento Express/Nginx
do Portal são doubles explícitos. Não comprova login real nem deploy/VPS.

## Verificação local e limites de evidência

Com dependências existentes e PostgreSQL local já autorizado em 127.0.0.1:55441:

```text
node --test tests/unit/owner-news-payload-api.test.mjs
npm --prefix cms run typecheck
npm --prefix cms run test:unit
node cms/tests/integration/run-task7.mjs --prepare-disposable-task7
node cms/tests/integration/run-task7.mjs --native <diretório-privado-impresso>
node cms/tests/integration/run-task7.mjs --http <diretório-privado-impresso>
# PowerShell, build sem segredos de runtime:
$env:CMS_BUILD_ONLY='true'; npm --prefix cms run build
npm run verify
git diff --check
```

Prepare só cria/reseta `cms_task7_test`/`portal_task7_test`, recusa conexões alheias
ativas e carrega credenciais do state privado local aprovado, sem logá-las. O banco
Portal da aceitação contém somente a autoridade sintética necessária, não o schema
completo de usuários/Firebase. HTTP inicia/encerra somente seu processo Next
loopback e Express efêmero; não inicia/reinicia Docker ou serviços existentes.

Aceite real cobre Payload/Next/proxy/REST/PostgreSQL/arquivos e Express→CMS HTTP.
Introspecção Portal no seed nativo e autenticação Firebase no Express de teste são
doubles explícitos. Não comprova Firebase real, VPS, Nginx, frontend ou Linux
symlinks (teste de symlink pode ser skip por EPERM no Windows). O código novo da
API usa APIs Node 18; execução verificada com Node 24, não stack inteira Node 18.
