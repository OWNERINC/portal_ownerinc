# Visão Geral da Arquitetura

## Princípio

Preservar a aplicação existente e suas fronteiras. O harness organiza trabalho,
documentação e validação, mas não exige mover código para uma pasta `src/`.

## Serviços

- `nginx`: serve `public/` e encaminha `/api/` e `/uploads/` para a API.
- `api`: aplicação Express responsável por autenticação, autorização e CRUD.
- `postgres`: banco PostgreSQL inicializado por `api/db/schema.sql`.
- `cron`: processo isolado que consulta lembretes e envia notificações.

## Dependências externas

- Firebase Auth autentica usuários e valida tokens na API.
- Resend SMTP entrega emails gerados pelo serviço de lembretes.
- Z-API está prevista, mas permanece desativada.

## Decisões

- Portal e Brain permanecem em repositórios diferentes.
- API e cron continuam como pacotes CommonJS independentes.
- O frontend continua estático enquanto essa solução atender ao produto.
- Serviços só devem ser separados ou reescritos quando existir pressão real.

## Navegação persistente do frontend

- `public/js/router-bootstrap.js` inicia os links diretos e o router nativo de
  `router.js`. As URLs `.html` continuam sendo documentos estáticos completos.
  Navegações entre as 12 áreas registradas preservam o documento, sidebar,
  topbar, `.main-content` e o próprio `main#main-content`.
- A preparação obtém o HTML, importa o módulo ES em cache e aguarda as folhas de
  estilo e bibliotecas necessárias. A API valida `/users/me` antes de montar;
  Admin, CMS e ferramentas também verificam as permissões retornadas. Sólides
  exige vínculo ativo. Snapshot visual nunca fornece o perfil usado na montagem.
  Falha de preparação conserva a página anterior e oferece retry.
- Cada módulo de página exporta `mount(page)`, síncrono, com estado local novo
  por visita. `page.user` é o perfil validado; `page.bindAPI()` preserva as
  assinaturas dos helpers e associa requisições ao AbortSignal da visita.
  Respostas obsoletas rejeitam com `AbortError`, inclusive quando o transporte
  ignora cancelamento. As APIs originais de autenticação continuam independentes.
- `page.listen`, `timeout`, `frame`, `image`, `wait`, `objectURL` e `cleanup`
  registram recursos de vida limitada. `dispose()` aborta loaders, remove
  listeners, cancela timers/frames, desconecta observers registrados e revoga
  blobs. `renderBlocks(..., { signal })` limpa mídia privada explicitamente;
  seu observer também cobre substituições internas de conteúdo.
- `page.beforeLeave()` protege CMS, ferramentas e enquadramento do perfil.
  Formulários e diálogos usam as guardas de `ui.js`. Mutações pendentes bloqueiam
  navegação/logout e submissões duplicadas da mesma operação; confirmar descarte
  não autoriza abandonar uma gravação ou upload em andamento.
  O preflight `canLeavePageUI()` é livre de mutações: diálogos com assets
  temporários registram `canLeave` e `discard` separadamente. Só depois do
  consentimento e da preparação da rota, `commitPageLeaveUI()` executa e aguarda
  a remoção; falha mantém o editor aberto. Os Cards Pós mantêm baselines separados
  para Guest e Owner, atualizando apenas o conteúdo realmente salvo.
- Páginas usam `page.history.pushState/replaceState`, preservando metadados do
  router junto de seus parâmetros. `page.location` expõe a URL efetivada, para
  que loaders antigos não leiam filtros de uma entrada ainda não aceita durante
  `popstate`. Back/Forward entre áreas prepara a página
  mantendo a URL anterior até o commit; uma guarda rejeitada retorna à entrada
  original sem inserir histórico duplicado. Query/hash locais continuam com os
  loaders da página. Foco e rolagem são restaurados após os loaders, desde que o
  usuário não tenha começado outra interação.
- `generate-public-shell.mjs` gera o bootstrap e a restauração antecipada da
  sidebar em todos os HTMLs. CSS específico fica inativo fora da sua página;
  html2canvas, Lucide e jsPDF são reutilizados no documento. Admin reconcilia
  botões de abas por ID e ativa a aba antes das consultas secundárias.
  Uma intenção `?tab=solides` permanece na URL enquanto sua descoberta está
  pendente, sem substituir uma seleção posterior do usuário. Revalidação de
  autorização é processada independentemente de falhas no HTML de destino;
  revogação ou perda de sessão desmonta e remove também todos os overlays da página.

Checks de comportamento: `tests/unit/persistent-navigation.test.mjs`,
`tests/unit/navigation-review-regressions.test.mjs` e
`tests/unit/auth-stability.test.mjs`, junto dos testes existentes de CMS, perfil,
filtros, PDF, Owner News e AutoCard.

### Evidência local — 22/09/2026

- `npm run verify`: 506 testes passaram; `git diff --check` sem erros.
- Edge autenticado em 1440 × 900: duas visitas às dez áreas da sidebar, com
  zero novas navegações de documento e identidade preservada de `document`,
  `.sidebar`, `.topbar` e `.main-content`.
- Durante esse percurso, 447 frames observados e nenhum com Admin oculto.
- Verificados detalhe/voltar da Owner News, abas administrativas, Back/Forward
  entre áreas, resposta 503 na revalidação preservando a página/permissões e retry.
- Confirmados cancelamento e descarte de edições no Perfil, CMS e nos dois
  editores; cancelar Back no formulário novo do CMS conservou os campos.
- Exportações reais PNG no AutoCard e PDF nos Cards Pós funcionaram após
  navegação interna; nova visita manteve somente um canvas e um diálogo da biblioteca.
- Mobile de 390 px: drawer fecha após navegar e não há overflow horizontal.
  Nenhum erro JavaScript foi observado nos dois percursos autenticados.

## Evolução Aprovada

O alvo técnico mantém os mesmos serviços e adiciona admissão controlada,
política central de autorização, renderização segura, migrations SQL, ledger
idempotente de notificações, least privilege, readiness e deploy recuperável.
As fases e critérios estão em [`../product/roadmap.md`](../product/roadmap.md).

## CMS e conteúdo publicado

### Enquetes Owner News (P2)

- `api/owner-news/polls.js` implementa rascunho, publicação única, encerramento e
  votação; mutações recebem o client da transação de `withAudit`, sem transações
  implícitas. Alterações e votos travam a linha da enquete com `FOR UPDATE`.
  Administração exige `canManageCms(user, 'announcement')` e versão atual.
- `GET /api/announcements/polls/current` retorna `{poll}` (ou null); detalhe
  `GET /api/announcements/polls/:id` oculta rascunhos. Ambos exigem autenticação.
  Current prioriza open; depois a closed com publicação mais recente e ID no empate.
- `POST /api/announcements/polls/:id/votes` recebe somente `{option_id}` e usa
  exclusivamente `req.user.uid`. UUIDs são normalizados para minúsculas; UID
  preserva caixa. Retry da mesma opção tem sucesso mesmo após encerramento;
  escolha diferente retorna 409 `already_voted`, novo voto encerrado retorna
  409 `poll_closed`. O leitor reconcilia a escolha registrada por GET explícito.
- Administração usa `/api/cms/owner-news/polls`: GET paginado (`limit`, `offset`,
  `status` opcional; array + `X-Total-Count`), POST cria draft (201), PUT
  `/:id/draft` atualiza conteúdo + `expected_version`, POST `/:id/publish` e
  `/:id/close` recebem somente `expected_version`. Conteúdo tem title (80),
  question (240), description (600), closing (200) e 2–6 opções textuais distintas
  (100 caracteres cada), sem HTML. Publicação congela conteúdo e opções; closed
  não reabre. Não há agendamento ou DELETE. Conflitos de versão e de única enquete
  aberta retornam 409 `version_conflict`/`active_poll_exists`; o último é traduzido
  somente após rollback da transação que violou o índice único.
- Cada PollDTO é projetado em uma única consulta SQL: opções ordenadas, contagens
  reais, percentuais arredondados e somente a escolha do próprio leitor. Não
  retorna posições internas, autores administrativos ou UIDs de votantes. O total
  reflete o cascade de exclusão de usuário. Auditoria guarda ação, ator e versão
  administrativa ou `{recorded}` do voto, nunca a opção escolhida.
- `tests/unit/owner-news-polls.test.mjs` cobre normalização, estados, transporte,
  autenticação e permissão real com identidades sintéticas. O script
  `scripts/test-owner-news-integration.mjs` valida em PostgreSQL descartável os
  locks, corridas de publicação/voto, idempotência, agregados e rollback da
  auditoria; serviços de enquete também são exercitados sob `portal_api`.

### Contrato editorial Owner News (E1–E2)

- `api/owner-news/editorial.js` valida o contrato da revisão na gravação,
  publicação, agendamento, promoção e leitura. `editorial: null` representa
  legado; objetos inválidos e `undefined` são rejeitados por `validateNewsRevision`.
  `EditorialV1` contém apenas `version: 1`, `kind: article|edition`, `summary`
  (até 1.000 caracteres), `author` e `source_label` (até 200 cada) e `source_date`
  (`null` ou data civil válida `YYYY-MM-DD`, preservada sem conversão de fuso).
- Publicar artigo exige resumo e corpo em paragraph/list/quote/profile; publicar
  edição exige PDF. A revisão normalizada inteira (`blocks` + `editorial`) cabe
  em 5 MiB UTF-8; o transporte CMS continua em 6 MiB.
- Os validadores backend e frontend aceitam `layout` opcional
  (`content|wide|full|left|right`) e `typography` (`serif|sans`) apenas em
  paragraph/list/callout/quote/profile, sem materializar defaults novos no legado.
  `quote` exige texto até 5.000 e admite attribution até 200; `profile` exige name
  até 200 e admite role até 200, text até 5.000 e imagem por `asset_id` plano com
  alt obrigatório até 300. Alt sem asset é inválido. O CMS remove opcionais textuais
  vazios antes de validar; a API rejeita opcionais explicitamente vazios.
- Imagem admite caption até 1.000, credit até 300 e `usage: cover|body`; PDF admite
  `usage: edition|attachment`. Há no máximo uma capa explícita e um PDF de edição
  por revisão. Não há mídia aninhada nem HTML/estilo arbitrário.
- `public/js/owner-news/model.js` espelha normalização e estimativa de leitura
  (200 palavras/minuto, arredondando para cima; edição ou texto vazio retorna null).
  A estimativa inclui heading/paragraph/list/callout/quote/profile e ignora mídia,
  créditos, metadados e títulos de PDF. `blocksToText` também projeta quote/profile.
  `getNewsPresentation` separa somente capa e PDF explicitamente marcados; imagem
  legada continua no corpo. Autoria vem dos metadados, com fallback `Owner News`.
  A composição editorial está disponível em `reader-view.js` (E5), compartilhada
  pela prévia CMS (E4) e pelo leitor sobreposto (E7).

### Renderização editorial (E5)

- `renderNewsArticle(root, article, { signal, preview = false })` em
  `public/js/owner-news/reader-view.js` retorna um cleanup idempotente. O root
  pertence ao chamador, que deve executar o cleanup anterior antes de reutilizá-lo.
  O modo preview usa h2; o leitor usa h1 e rebaixa headings h1 do corpo para h2.
- Blocos são validados antes de compor classes/containers; todo texto usa DOM
  seguro. Capa aparece uma vez, com legenda/crédito adjacentes. A primeira imagem
  legada continua no body do model para consumidores existentes; somente o novo
  reader evita repeti-la após usá-la no hero. Editorial normalizado fornece resumo,
  autoria (fallback Owner News), fonte e data civil sem deslocamento. Publicação
  no Portal usa America/Sao_Paulo; conteúdo sem texto não inventa minutos de leitura.
- O renderer comum conserva `renderBlocks`/`cleanupRenderedBlocks` e acrescenta
  quote (`blockquote`/`cite`), profile (`section`, retrato privado e texto), e
  `figure`/`figcaption` para imagem com legenda/crédito. Imagens legadas sem esses
  campos mantêm sua estrutura. Os assets continuam em `/api/cms/assets/:id` com
  autenticação; não há URLs públicas de mídia editorial.
- Cada composição rastreia containers e usa AbortController próprio. Cleanup e
  abort da página cancelam fetches/listeners, revogam blobs e limpam o root; uma
  resposta tardia também é revogada. PDF complementar é carregado apenas no
  primeiro toggle aberto e não pode ser iniciado após o descarte. Falhas de mídia
  oferecem retry local (inclusive no PDF complementar), preservando os demais
  blocos; URLs com erro e respostas tardias são revogadas. Cleanup invalida também
  os controles de retry e listeners de erro de imagem/iframe.
- `owner-news.css` contém os tokens locais, hero com/sem capa, introdução 3:1,
  grid de 12 colunas e presets content/wide/full/left/right; o hero reserva
  `min(76svh, 860px)` e cresce para acomodar títulos longos; abaixo de 760px,
  corpo e introdução usam uma coluna. Georgia compõe texto serif; Manrope compõe
  sans; DM Mono compõe metadados (mínimo 11px). Controles têm mínimo 44px.
  As fontes oficiais sem alterações e licenças OFL estão em `public/assets/fonts/`:
  `Manrope-Variable.ttf` / `Manrope-OFL.txt`, de
  `https://github.com/google/fonts/tree/main/ofl/manrope`, e
  `DMMono-Regular.ttf` / `DMMono-OFL.txt`, de
  `https://github.com/google/fonts/tree/main/ofl/dmmono` (obtidas em 30/09/2026).
- `tests/unit/owner-news-reader.test.mjs` monta os módulos reais com lifecycle real
  no feedback harness (`mount: false`, `modules`), cobrindo descarte/tardios,
  perfil/inline, datas, segurança, legado e renderer comum.

### Catálogo editorial do leitor (E6)

- `announcements.js` mantém a montagem/lifecycle e o catálogo sob o leitor. A lista usa
  `fetchAPIPage` com `kind=article`, 24 itens e total de `X-Total-Count`; categoria
  limpa offset, paginação e Back preservam filtro, e página fora do intervalo
  recupera offset zero. Respostas de consultas antigas não substituem a atual.
- Abertura publicada (`/announcements/home`), destaque global (`kind=article`,
  limit 1) e categorias com contagens carregam independentemente. Abertura tem
  precedência sobre título/resumo global; sem ambos, usa a copy contratada.
  Falhas mantêm conteúdo disponível e oferecem retry no componente afetado.
- `owner-news/catalog.js` rende cards semânticos com link envolvendo capa/título,
  ID estável, metadados e oito proporções determinadas por offset + índice.
  O mosaico CSS substitui explicitamente o grid legado: colunas de 230px,
  duas colunas até 560px e uma abaixo de 359px. Sem capa, usa marca editorial.
  Ctrl/Cmd+click mantém comportamento nativo. Capa passa somente type/asset_id/alt
  ao renderer privado; cleanup por card libera blobs atuais e tardios.
- `composeNewsFeed` é o ponto de composição puro para futura enquete: insere
  depois do terceiro artigo somente na primeira página sem categoria, sem
  alterar dados, total ou offset. A enquete ainda não é montada.
- Dashboard prioriza `editorial.summary` sobre trecho legado. O feedback harness
  monta os módulos reais de Owner News com location e histórico em memória;
  testes cobrem concorrência, fallback, retry, foco, links e descarte de mídia.

### Leitor sobreposto e histórico (E7)

- `owner-news/navigation.js` expõe `createNewsNavigation({page, overlay, onRoute})`
  com open/jump/close/sync/dispose. O overlay pertence ao body, é marcado com
  `data-page-overlay` e usa diálogo real de `ui.js`: shell inert, teclado,
  Escape, guarda de fechamento e restauração de foco. Loading/erro usam
  `aria-label`; a composição pronta fornece h1 `news-reader-title`/aria-labelledby.
- Abrir card cria uma entrada com `?id` via page.history; anterior/próxima
  substituem essa entrada. O estado `ownerNews` guarda returnHref interno,
  cardId e catalogY sem apagar outros campos nem o índice do router. Fechar
  usa um único Back, protegido contra clique/Escape duplicado. Link direto ou
  estado de retorno inválido remove id por replaceState. Categoria e offset
  permanecem na URL; modificadores de clique mantêm o link nativo.
- No popstate, o router fecha os diálogos antes dos listeners locais. sync
  reconcilia URL **e visibilidade DOM**, mesmo quando o ID não muda, reabrindo
  no Forward sem inserir histórico. Nenhuma alteração em router/ui foi necessária.
  Catálogo/capas não são remontados para troca de matéria; retorno restaura o
  link do card e sua posição, ou o título do mosaico se o card não existir.
  A restauração aguarda os loaders e cede a novas interações do usuário.
- Detalhe e `/announcements/:id/navigation?category=...` carregam em paralelo,
  com processamento independente e Promise.allSettled. A rota de vizinhos já
  seleciona artigos e **não aceita kind**. Falha de vizinhos conserva o corpo e
  tem retry próprio; 404 do detalhe tem mensagem específica e Voltar disponível.
  AbortController e contadores ignoram respostas obsoletas; cleanup da composição
  anterior é executado antes de reutilizar o root. O lifecycle acompanha as
  requisições e descarta listeners, mídia e conteúdo na saída/perda de sessão.
- Dashboard consulta `kind=article`, prioriza capa explícita e editorial.summary,
  e abre o reader por URL direta. Home pública é lida do envelope `{ content }`;
  content null conserva o fallback. Metadados, datas civis, publicação em São
  Paulo e ausência de estimativa em edição continuam no renderer compartilhado.
- Evidência local E7: router/lifecycle/ui reais em testes com histórico assíncrono;
  Edge autenticado sem bypass CSP em localhost:8081/emulator9199; duas matérias
  sintéticas publicadas via API CMS e removidas após verificar composição,
  vizinhos e Back/Forward. Retry com falhas 503 sintéticas e assets privados reais;
  títulos longos em 1440×900, 390×400 e 320×320 sem overflow horizontal.
  O 404 preexistente foi identificado como `/favicon.ico`; não é declarado
  navegador inteiramente livre de erros. Enquete e acervo real não fazem parte
  desta validação; acessibilidade completa de PDFs depende do arquivo original.

### Edição editorial no CMS (E4)

- Owner News oferece subáreas Matérias e Página inicial. As demais áreas conservam
  a paleta padrão; apenas announcement recebe quote/profile e os controles de
  diagramação, tipografia, capa, legenda/crédito e PDF complementar.
- `cms-editorial.js` mantém Resumo, Autoria, Origem, Data da fonte e Formato na
  mesma fotografia de save dos blocos. O CMS seleciona uma única revisão de
  trabalho (draft, scheduled, published), inclusive quando editorial é null.
  Legado só recebe EditorialV1 pelo botão “Preparar matéria editorial”; autoria
  permanece vazia. Edições durante save entram na fila existente de autosave.
- Publicar/agendar validam os campos editoriais e usam o revision_id retornado
  pelo save. Os opcionais vazios dos blocos são removidos por
  `normalizeEditorBlocks`; defaults ausentes de revisões legadas não são gravados.
- A prévia announcement usa `renderNewsArticle` e `estimateNewsReadTime`, com
  `cms.css` e `owner-news.css`. O cleanup anterior é executado antes de reutilizar
  o root e na saída. Upload pendente conserva a prévia e bloqueia gravação,
  publicação e navegação. O container estreito da prévia empilha a diagramação.
- `cms-home.js` usa `GET /api/cms/owner-news/home`, `PUT .../home/draft` e
  `POST .../home/publish`, sempre via page.bindAPI. Publicar requer rascunho salvo
  sem alterações locais, com expected_version atualizado. Conflito 409 mantém
  os valores locais e oferece recarregar com consentimento de descarte. A troca
  de subárea/área e page.beforeLeave respeitam dirty e mutações; dispose cancela
  o loader e invalida respostas/listeners antigos.
- `tests/unit/cms-news-editor.test.mjs` monta os módulos reais e controla somente
  DOM/transportes: isolamento, autosave, publicação, capa/reordenação, upload,
  prévia privada, abertura/conflito e descarte. Fixtures são sintéticas.

### Persistência editorial (E2)

- Migration `033_owner_news_editorial` acrescenta `cms_revisions.editorial` JSONB
  opcional, limitado a objeto ou **SQL NULL**. Revisões legadas permanecem nulas;
  nenhuma mídia fica no JSON editorial. Toda resposta de revisão inclui editorial.
- `PUT /api/cms/documents/:id/draft` aceita somente `{ blocks, editorial? }`.
  Editorial omitido herda a revisão de trabalho (draft, scheduled, published, nessa
  ordem), consultada sob o lock do documento. `null` explícito não apaga metadados
  nativos. Outras áreas aceitam somente ausência/null. Novos anúncios começam com
  EditorialV1 vazio; precisam de metadados/corpo válidos antes de publicar.
- Texto e metadados pertencem à mesma revisão imutável. Salvar draft não muda a
  publicação; cancelar ou promover scheduled conserva um draft posterior.
  Publicações editoriais inválidas são excluídas antes da contagem/paginação;
  scheduled inválido segue o caminho existente de arquivamento com auditoria.
- `profile.asset_id` aceita JPEG/PNG/WebP nos três validadores de referências
  (CMS, leitor e autorização de assets). O asset plano participa da retenção
  existente. O limite efetivo de schema/leitura permanece **50 MiB**, inclusive
  para PDF; o limite de upload PDF de 100 MiB não altera esse contrato.
- A imagem cron copia também `api/owner-news/editorial.js`, dependência do leitor
  compartilhado. A migration cria o singleton `owner_news_home` com draft/published
  opcionais e grant SELECT/INSERT/UPDATE apenas para `portal_api`; o serviço e as
  rotas da home pertencem à próxima etapa.
- Verificação real em banco local descartável: `scripts/test-migrations.mjs`
  executa o runner duas vezes; `scripts/test-owner-news-integration.mjs` verifica
  handlers Express, publicação, SQL NULL, agendamento, perfil e constraints com
  fixtures sintéticas removidas em `finally`. Exigem `NODE_ENV=development`,
  `MIGRATION_TEST_DISPOSABLE=true`, `MIGRATION_DATABASE_URL` e senhas dos papéis
  pelo mecanismo privado local.

### Publicação e ciclo de vida existentes

- Uma fonte sem `cms_documents` continua usando o corpo legado. Quando existe
  documento CMS, o corpo público é exclusivamente a revisão `published` com
  blocos e assets validados; documento sem publicação válida não reativa o texto
  legado. Busca e resumo usam a projeção textual centralizada de
  `blocksToText`/`validateBlocks`.
- O Editor CMS mantém revisões imutáveis. Publicação e agendamento resolvem o
  `draft_revision_id` sob lock transacional e rejeitam seleção obsoleta com
  `409`; o cancelamento de agendamento preserva um draft posterior e
  despublicar arquiva tanto `published` quanto `scheduled`.
- Mutations de documento, validação de asset, promoção pelo cron e retenção de
  assets adquirem primeiro o advisory lock `7193029`, depois locks de linhas.
  A retenção mantém o lock durante reserva, remoção do arquivo e confirmação
  do row; assets referenciados permanecem legíveis durante o commit. A leitura
  autorizada abre o file descriptor sob o mesmo lock antes de liberar a
  transação.
- Scheduled vencido só é promovido depois de validar blocos e cada asset
  referenciado contra MIME, tamanho, storage e `deleting_at`. Uma revisão
  inválida é arquivada, o ponteiro scheduled é removido e a auditoria registra
  o motivo, evitando nova tentativa em loop.
- Excluir a fonte remove o documento e suas revisões na mesma transação, mas
  deixa o row/arquivo de asset sem circulação para a retenção limpar com
  segurança. Links de asset continuam autenticados e a audiência/estado ativo
  da fonte é aplicado antes da entrega.
