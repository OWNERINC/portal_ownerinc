# API editorial da Owner News

Todas as rotas de leitura exigem sessão autenticada. Lista, categorias, home e
navegação compõem publicações validadas das fontes `legacy` e `payload`; autoridade
de escrita não escolhe uma fonte exclusiva de leitura. Detalhe, asset e prévia são
source-directed e nunca fazem fallback. A ordem global é `published_at` decrescente
(null por último), fonte (`legacy` antes de `payload`) e UUID lowercase crescente.
Rascunhos não participam da seleção pública.

- `GET /api/announcements`: preserva o array e aceita `limit`, `offset`, `category`,
  `kind=article|edition` e cursor opaco. O cursor contém a fronteira source-aware e
  os filtros normalizados; com cursor, `offset` deve estar ausente ou ser zero.
  Offset sem cursor é somente compatibilidade limitada; a travessia autoritativa do
  feed dual usa cursor.
- Toda resposta composta informa `X-Owner-News-Read-State: complete|degraded`.
  `X-Owner-News-Next-Cursor` existe somente em página completa com continuação.
  `X-Total-Count` é informativo e opcional: aparece somente quando todas as fontes
  comprovam o total exato filtrado/validado; lookahead limitado e degradação o omitem.
- DTO de lista/detalhe: `source`, `id`, `title`, `category`, `published_at`,
  `content_blocks`, `editorial`, `read_time_minutes` e `asset_scope`. A fonte é
  `legacy|payload`; `asset_scope` publicado é `legacy|owner-news` e a prévia usa
  `owner-news-preview`. Edições têm tempo null. A estimativa usa texto nativo a
  200 palavras/minuto.
- Conteúdo legado com PDF é edição; sem PDF é matéria. Editorial explícito
  determina a classificação quando presente.
- `GET /api/announcements/categories`: mantém string[]; aceita `kind` e
  `with_counts=true|false`. Com true retorna `{ total, categories: [{name,count}] }`.
  O total inclui publicações sem categoria; nomes vazios não aparecem na lista.
- `GET /api/announcements/:id/navigation?source=...&category=...`: vizinhos globais
  da lista de matérias, `{previous,next}`, cada referência com `{source,id,title}`
  ou null. Uma edição válida retorna ambos null. O item corrente é confirmado apenas
  na fonte solicitada; publicação ausente/inválida ou fora do filtro retorna 404.
- `GET /api/announcements/:id?source=...`: preserva acesso a edições e dirige uma
  única fonte. Por compatibilidade de bookmarks, omitir `source` em detalhe ou
  navegação significa somente `legacy`; não há tentativa automática em Payload.
  UUIDs são normalizados para minúsculas; queries desconhecidas, duplicadas ou
  inválidas retornam 400.
- Assets publicados/prévios aceitam `source=legacy|payload`; a origem e o
  `asset_scope` do DTO determinam qual rota deve ser usada, sem fallback entre
  storages.

Uma fonte configurada indisponível na primeira página pode produzir a fatia da fonte
saudável com estado `degraded`, sem total ou cursor. Em qualquer continuação por
cursor ou offset não zero, perder uma fonte retorna `503 news_page_restart_required`;
falha dupla ou autoridade ilegível retorna `503 news_unavailable`. Quando Payload
está intencionalmente inativo antes do cutover, a paginação offset legacy-only e seu
total exato permanecem compatíveis.

## Abertura editorial

`GET /api/announcements/home` retorna `{content: HomeDTO|null}` apenas da coluna
publicada. HomeDTO tem exatamente `version:1`, `eyebrow` (80), `headline` (160) e
`summary` (600 caracteres). Textos são não vazios e sem HTML; só headline aceita
quebra de linha. Ausência ou conteúdo publicado inválido retorna null.

Administração exige `canManageCms(user, 'announcement')` em todas as rotas:

- `GET /api/cms/owner-news/home`: `{version,draft,published,published_at}`.
- `PUT /api/cms/owner-news/home/draft`: `{expected_version,content}`.
- `POST /api/cms/owner-news/home/publish`: somente `{expected_version}`.

O versionamento da linha é separado da versão 1 do HomeDTO. Cada mutação incrementa
a versão inteira da linha; versão obsoleta retorna 409 `version_conflict`.
Publicar sem rascunho retorna 409 `draft_required`. Publicação valida o rascunho
sob lock, copia-o para published e limpa draft. Mutações e auditoria compartilham
a transação `withAudit`; falha de auditoria também desfaz a alteração. Auditoria
registra a versão, não o conteúdo. Erros de validação retornam 400 `invalid_home`.
Erros das novas rotas incluem `{error,reason,requestId}` com mensagem pt-BR.

Verificação: `node --test tests/unit/owner-news-api.test.mjs tests/unit/owner-news-home.test.mjs`
e `scripts/test-owner-news-integration.mjs` em PostgreSQL descartável local, além
de `npm run verify`. O reader continua dependendo apenas do módulo editorial já
incluído no cron; a home é dependência exclusiva das rotas da API.
