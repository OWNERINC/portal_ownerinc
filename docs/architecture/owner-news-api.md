# API editorial da Owner News

Todas as rotas de leitura exigem sessão autenticada. Lista, categorias e
navegação usam as mesmas publicações validadas (blocos, editorial e mídia), com
rechecagem da revisão publicada antes da resposta. A ordem é publicação
decrescente, atualização decrescente e ID. Rascunhos não participam da seleção.

- `GET /api/announcements`: preserva array e `X-Total-Count`; aceita `limit`,
  `offset`, `category` e `kind=article|edition`. Filtros precedem contagem/paginação.
- DTO de lista/detalhe: `id`, `title`, `category`, `published_at`,
  `content_blocks`, `editorial` (objeto ou null) e `read_time_minutes` (inteiro ou
  null). Edições têm tempo null. A estimativa usa texto nativo a 200 palavras/minuto.
- Conteúdo legado com PDF é edição; sem PDF é matéria. Editorial explícito
  determina a classificação quando presente.
- `GET /api/announcements/categories`: mantém string[]; aceita `kind` e
  `with_counts=true|false`. Com true retorna `{ total, categories: [{name,count}] }`.
  O total inclui publicações sem categoria; nomes vazios não aparecem na lista.
- `GET /api/announcements/:id/navigation?category=...`: vizinhos da lista completa
  de matérias, `{previous,next}`, cada qual `{id,title}` ou null. Uma edição válida
  retorna ambos null. Publicação ausente/inválida ou matéria fora do filtro: 404.
- `GET /api/announcements/:id`: preserva acesso a edições. UUIDs são normalizados
  para minúsculas; queries desconhecidas, duplicadas ou inválidas retornam 400.

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
