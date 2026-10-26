# Owner News — ponte de leitura, prévia salva e composição dual

Este documento descreve o **PR 1 implementado** até o commit de compatibilidade de
runtime `db9e160`. A entrega é local e não faz cutover. **Solicitar autorização
antes de qualquer deploy na VPS.** O runtime manual-only do PR 2, o caminho de
cutover do PR 3 e o cutover operacional real ainda não estão ativos. Nenhuma
configuração de deploy/Nginx foi alterada e a autoridade de escrita existente
permanece como estava.

## Interfaces

- `createAnnouncementsRouter({backend,authenticate,pollsRouter})` mantém o export
  padrão e `/polls` primeiro. As listas públicas continuam como array; emitem
  `X-Owner-News-Read-State: complete|degraded`, `X-Owner-News-Next-Cursor` somente
  quando existe continuação completa e `X-Total-Count` somente quando o total
  informativo é comprovadamente exato. Detalhe/home/navegação mantêm seus envelopes.
- `createNewsBackend({pool,payloadClient})` resolve `owner_news_authority` a cada
  operação, mas autoridade de escrita não seleciona mais uma única origem de leitura.
  Lista, categorias, navegação e home compõem legado + Payload; detalhe, asset e
  prévia são source-directed e nunca consultam a outra origem. Internamente cada
  operação retorna `{value,readState}`; somente a rota converte `readState` em header.
  Controle ilegível falha antes de consultar fontes. Uma primeira página pode usar a
  origem saudável como `degraded`; dupla falha retorna `503 news_unavailable` e uma
  continuação por cursor/offset que perde fonte configurada retorna
  `503 news_page_restart_required`. Nenhum desses estados muda autoridade ou writer.
- `createPayloadNewsClient({baseURL,secret,fetchImpl,timeoutMs=5000})` expõe
  `query(action,input,actor,{signal,requestId}={})` e `asset(input,actor,options)`.
  `requestId` é uma extensão opcional para correlação; ausente/inválido gera UUID.
  A configuração padrão é lazy: `CMS_INTERNAL_URL` (somente origem HTTP(S), sem
  path/query/credenciais) e `PORTAL_TO_PAYLOAD_SECRET` não são exigidos no boot
  legado. Segredos são exclusivamente server-side e distintos nas duas direções.
  Em `legacy`/`frozen`, ambos ausentes significam Payload intencionalmente inativo
  (saudável-vazio); configuração parcial sempre falha. Em `payload`/`payload_frozen`,
  ausência também falha fechada. Um client injetado conta como configuração ativa.
- Sete POSTs somente leitura sob `/editorial/api/portal-news`: `list`, `detail`,
  `categories`, `navigation`, `home`, `preview`, `asset`. Corpo exato `{actor,input}`,
  Authorization Bearer dedicado, `X-Request-ID`. Sem encaminhar cookie, token do
  navegador ou headers arbitrários. Actor vem de `req.user` + política atual
  `manageKnowledge`. Prévia exige editor, documento/revisão UUID e
  `source=payload|legacy` (default payload); `version` é obrigatório.
- No POST privado, `kind` e `source` exigem strings primitivas com enum exato.
  Arrays, objetos e valores coercíveis retornam 400 antes de consultar conteúdo
  ou selecionar a fonte de prévia; não há coerção via `String(...)`.
- A compatibilidade pública de bookmark sem `source` é somente o detalhe legado:
  `/announcements.html?id=<uuid>` resolve como `legacy`. O endpoint de navegação
  conserva um default defensivo legado, mas o frontend source-aware sempre propaga
  a origem e não publica bookmark de navegação. `source` explícito em
  detalhe/navegação/asset e a origem da prévia dirigem uma única fonte; `404`/`403`
  não acionam fallback.
- Tipos CMS: `src/contracts/news.ts`; API: validação JSON independente de Next e
  Payload em `payload-dto.js`. Formatos nativos nunca atravessam a fronteira.
- DTOs públicos do bridge Payload carregam obrigatoriamente `source: 'payload'`;
  referências `previous`/`next` também carregam a origem. O `source` opcional de
  `preview_revision` identifica a revisão salva e não substitui a origem pública
  Payload do documento.
- DTOs legados publicados carregam `source: 'legacy'`, `asset_scope: 'legacy'` e
  `published_at` canônico ISO (ou null). Tipos/data inválidos falham fechados antes
  de comparador ou cursor. Referências legadas de navegação também carregam origem.
- Toda resposta pública autenticada do router usa
  `Cache-Control: private,no-store`. O edge nega com `404` tanto o path privado
  exato `/editorial/api/portal-news` quanto seu prefixo `/editorial/api/portal-news/`;
  somente a API server-side chama os sete POSTs privados.

### Fronteira source-aware da lista

O Portal usa ordem canônica por `published_at` decrescente (datas nulas por último),
depois origem `legacy`/`payload` e UUID lowercase crescente. O cursor público é
base64url, versão 1, tem no máximo 1024 caracteres e contém exatamente a fronteira
e os filtros normalizados: `{v,published_at,source,id,category,kind}`. Categoria e
tipo ausentes são serializados como `null`; replay sob filtros diferentes falha com
`invalid_request`. Somente a fronteira tipada `{published_at,source,id}` atravessa o
POST privado. O CMS a valida novamente, filtra antes do limite e ordena Payload por
`publishedAt` e UUID; o cursor opaco nunca é enviado ao CMS. O limite público segue
em 100, enquanto a lista privada de cada fonte aceita no máximo 101 itens para obter
o lookahead necessário sem produzir uma página terminal falsa.

Cursor exige `offset` ausente ou zero; combinar cursor e offset não zero retorna
`400 invalid_request`. Offset sem cursor permanece compatível, mas é continuação:
perder qualquer fonte configurada exige reinício, nunca uma fatia parcial. Quando
Payload está intencionalmente inativo (`legacy`/`frozen` e ambos os envs ausentes),
o offset legado e seu total exato permanecem intactos. Em composição dual, o cursor
é o contrato autoritativo. A UI do PR 1 já usa Anterior/Próxima, guarda uma pilha de
cursores canônicos por categoria/tipo em `history.state`, invalida a pilha ao trocar
filtro e restaura URL/foco em Voltar/Avançar. Um cursor vindo diretamente na URL
não fabrica página anterior; `news_page_restart_required` remove o cursor e reinicia
atomicamente na primeira página.

O adapter legado consulta chunks crus determinísticos com `LIMIT 101` e keyset
`published_at/id`. No SQL, seleção, ordenação e todos os predicados de fronteira usam
`date_trunc('milliseconds', d.published_at)`; assim storage, DTO/cursor e comparador
global compartilham a mesma precisão, com null por último e UUID crescente. O leitor
valida revisão e mídia, faz o recheck estável sob lock e avança
até preencher apenas o lookahead válido pedido. São no máximo 1.000 chunks/101.000
linhas cruas por operação; exceder falha fechado. Leituras limitadas não varrem o
restante para fabricar total: quando alguma origem não prova total exato, a rota
omite `X-Total-Count`. Categorias e o modo legado intencionalmente inativo continuam
calculando totais exatos dentro do mesmo limite operacional.

As exceções de Origin existem **tanto no proxy Next quanto no boundary REST**,
somente nos sete paths exatos e método POST com segredo válido, sem Origin,
Cookie ou Sec-Fetch-Site. Não autenticam coleções genéricas, admin ou Server Actions.
Chamadas privadas também validam segredo/actor/input no handler. Corpo de entrada
tem teto de 16 KiB. O Nginx existente já bloqueia o path exato e seu prefixo;
nenhuma configuração de deploy foi alterada aqui.

### Privacidade, degradação e limite do writer

Respostas públicas e logs são sanitizados por allowlist: DTOs, headers, erros e o
evento `owner_news_read_degraded` não expõem URL interna, segredo, stack, conteúdo
ou reason interno. O evento registra apenas código fixo, ação, fonte indisponível e
`requestId` validado. Em lista degradada, `count` e `nextCursor` são anulados antes
da rota, portanto `X-Total-Count` e `X-Owner-News-Next-Cursor` são omitidos. Mesmo
com estado `complete`, total desconhecido por lookahead limitado continua omitido.

A garantia de ausência de escrita é deliberadamente limitada ao orquestrador de
fallback/composição de `api/owner-news/backend.js`: ele observa `getAuthority`, mas
não importa/chama `assertNewsWriter`, `transitionAuthority`, `writerAllowed`, APIs
diretas de mutação ou SQL de transição. O reader legado herdado pode continuar a
promoção de schedule vencido; este PR não declara seu call graph side-effect-free.
A decisão e o sucessor desse comportamento permanecem adiados pelo design aprovado.

### Estado das dependências compatíveis

Onde o bridge executa no CMS, os seis pacotes Payload diretos permanecem alinhados
exatamente em `3.90.2` e Next em `16.4.2`, compatíveis com a imagem Node `24.21.0`
já pinada. O lock resolve os transitivos corrigidos `undici 7.30.1`,
`happy-dom 21.0.4` e `fast-uri 3.1.9`; preserva Sass `1.105.1`, DOMPurify `3.4.17`,
TSX `4.23.15` e esbuild `0.28.2`. Isso é estado de dependência, não instrução de
deploy nem evidência de imagem executada.

## Publicação, limites e falhas

Leituras Local API usam explicitamente `overrideAccess:true` apenas depois da
autenticação privada, `depth:0`, `draft:false`, filtro `_status=published` e o mesmo
`req`/transação sob lock 7194030. Editor normal também vê somente a publicação.
Prévia nativa consulta ID da versão **e parent**; prévia legada usa a identidade
composta original, sem fallback de fonte. Home prefere o Global Payload somente
quando há conteúdo publicado válido; ausência legítima usa o home legado, enquanto
falha de uma origem produz estado degradado.

O leitor Payload varre lotes de 100, máximo 1000 lotes (exceder retorna 503), valida
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

#### Entrada do painel Payload

O CMS central consulta `GET /api/cms/owner-news/authority` para manter a autoridade
legada independente da disponibilidade opcional do Payload. Também consulta o
endpoint Portal autenticado `GET /api/cms/session/availability`, que exige a
permissão atual `manageKnowledge`, mas não exige configuração opcional do bridge ou
cookie editorial. `editorial-entry.html` usa esse endpoint e revalida ao entrar.
Sem cache duradouro, a API lê a autoridade Owner News e, separadamente, verifica
`CMS_INTERNAL_URL` somente em `GET /editorial/ready`, com timeout total de 2 s,
redirects recusados, corpo limitado a 256 bytes e resposta `status: ready` exata.
Somente os modos `payload` e `payload_frozen` contam como fonte ativada; a entrada
só é permitida quando a fonte está ativada **e** o runtime responde.
`POST /api/cms/session` repete ambas as
verificações imediatamente antes de emitir a sessão editorial. Isso não muda a
autoridade nem ativa o runtime. Em `payload_frozen`, a entrada continua possível,
mas os guards de escrita da API permanecem vigentes.

O probe valida o serviço CMS e sua consulta read-only de prontidão, mas não testa
Nginx/ingress público, a rota externa `/editorial/admin`, renderização no browser,
autenticação final no Payload ou produção. Portanto, `canEnter` é uma permissão
condicional baseada nas duas observações server-side, não prova de aceite nem
garantia contra falha entre a verificação e a navegação. Diagnóstico de 502 ou
verificação operacional exige evidência separada e autorização apropriada.

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
