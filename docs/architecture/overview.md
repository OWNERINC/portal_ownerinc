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

## Players de aulas da Academy

`public/academy/player.js` exporta
`createLessonPlayer({ host, media, startSeconds, signal, onPosition, onPause, onEnded, onError })`,
uma Promise de `{ getPosition(), pause(), seek(seconds), destroy() }`. O container
é exclusivo da aula; o chamador define `host` com `aria-label` igual ao título da
aula para rotular o iframe/vídeo. A mídia segue o objeto normalizado da API.
Os controles são oficiais/nativos, sem autoplay; a posição salva validada é
incluída no embed YouTube e aplicada após `loadedmetadata` no HTML5.

O loader YouTube é compartilhado por documento, injeta `iframe_api` dinamicamente,
preserva/restaura o callback global anterior e limita cada tentativa a 15 segundos.
Falhas removem script/cache para retry explícito criando um novo player.
No timeout, se o bootstrap próprio terminou mas
o segundo script `www-widgetapi.js` não inicializou o Player, o adapter remove
apenas esse widget observado e repete sua URL oficial no próximo retry explícito,
sem reiniciar o bootstrap nem alterar `YT.loading` ou sua fila de callbacks.
Preserva namespace/configuração e providers preexistentes, substituídos ou
já prontos; não realiza tentativas automáticas. Abort de
um consumidor rejeita sua Promise imediatamente sem cancelar outros consumidores.
Cada player também limita a espera de readiness/metadados a 15 segundos. Abort,
erro e `destroy()` limpam instância, timers, DOM e listeners; callbacks tardios
não reativam uma aula descartada. `destroy()` é idempotente.

`onPosition(number)` emite posição a cada segundo enquanto reproduzindo e visível,
e ao pausar/terminar; HTML5 também emite após seek. `onPause()` opcional notifica
após a emissão da posição para permitir flush pelo chamador. `onEnded()` apenas notifica,
sem concluir ou persistir progresso. `onError(Error)` entrega mensagem em português
e, no YouTube, código do provedor (incluindo 101/150). Falhas antes de readiness
também rejeitam a Promise; cancelamentos rejeitam com `AbortError` sem `onError`.
A sala chamadora é responsável por apresentar mensagem/retry e conectar o
controller de progresso; os adapters não montam a interface da sala.

### Catálogo, curso e sala no shell persistente

`public/js/academy.js` monta `mountAcademy(page)` de `public/academy/app.js` em
`academy-root`, sem reconstruir o shell. `createAcademyAPI(page)` expõe
`list(query)`, `categories()`, `continueCourses()`, `course(id, preview)` e
`lesson(id, preview)`; leituras usam `page.bindAPI`. Cada transição cria um
lifecycle descartável. Aula acrescenta escopo filho para CMS, player e progresso.

O catálogo consulta `group=initial` e `group=role` separadamente, cada um com
limite 20, categoria e offset. `initial_category`, `initial_offset`,
`role_category` e `role_offset` guardam os dois filtros na URL. Links legados
`group=initial&category=...&offset=20` são aceitos e convertidos ao alterar o grupo.
`/continue?limit=3` é independente da paginação. Página esvaziada oferece retorno
ao início do próprio grupo. A marca permanece em estados vazios e de erro.

Detalhes usam `?course=ID`, aulas `?course=ID&lesson=ID`. Navegações explícitas
chamam `page.history.pushState` e renderizam localmente; Back/Forward fazem o
mesmo sem recarregar documento. `history.state.academyCatalog` conserva a URL
de retorno, preservando os demais metadados do router. `preview=1` exige
`manageAcademy` e usa `all=true`; a prévia não grava progresso. A rota `manage=1`
está reservada à gestão, com barreira de permissão, sem editor nesta etapa.

A aula confere currículo e parent IDs antes de criar mídia. O título rotula
o host do player; somente textos de status são live regions. O currículo usa
disclosure nativo e empilha abaixo de 1000px. Foco vai ao h1 após navegação
explícita, nunca por gravação. Troca interna pausa, registra, aguarda flush e
descarta player/escopo antes da próxima instância. Falha no flush mantém a
última posição confirmada e informa a possível perda da posição recente.
Saída para outra área cancela recursos; não promete salvar no fechamento abrupto.

Gravações automáticas usam o fetch original e sinal do controller, sem busy global.
Só a ação manual passa pelo guard de mutação do Portal e bloqueia saída enquanto
pendente. Conclusão e próxima aula aparecem apenas após ack de conclusão da
própria aula/versão. 409 pede recarregar; perda definitiva de acesso em gravação
ou revalidação de foco remove mídia, materiais e ações. Erro de rede na
revalidação informa a falha sem confundi-la com revogação de autorização.

`tests/helpers/academy-frontend.mjs` executa os módulos reais com seams de
DOM/transportes/player/timers. A prancha documental
`docs/design/academy-frontend-preview.html` carrega HTML/CSS e vistas reais,
com fixtures explicitamente rotuladas via import map (sem backend/Firebase).
Ela permite revisão visual estática, não comprova reprodução nem integração
de autenticação, PostgreSQL, CSP ou Nginx reais.

A CSP adiciona somente `https://www.youtube.com` e `https://s.ytimg.com` em
`script-src`, e YouTube/YouTube nocookie em `frame-src`. O embed usa nocookie,
origin do Portal, título, fullscreen e referrer policy `strict-origin-when-cross-origin`.
Testes locais executam os adapters reais com doubles da API, DOM e relógio.
**Pendente:** validar reprodução, retomada, erros de incorporação e headers reais
através do Nginx no marco C, quando houver ambiente autorizado. Testes locais não
comprovam comportamento do provedor real; nenhum serviço é iniciado por eles.

O aceite consolidado está em
[`../reviews/2026-09-30-academy-acceptance.md`](../reviews/2026-09-30-academy-acceptance.md).
Ele distingue testes unitários/estáticos PASS de banco, autenticação, Nginx e
player real PENDENTES; a prancha de fixtures não é evidência de sessão real ou
reprodução.

## Persistência da Academy

A migration `033_academy_learning` mantém `academy` como origem dos cursos e
preserva os externos existentes (`delivery_mode=external`, `audience=all`,
`learning_group=initial`). Cursos internos usam `url=NULL`; os externos continuam
exigindo URL HTTP(S). A formação visual (`initial`/`role`) é independente do público.

- `academy_course_job_titles`: associação curso/cargo; cargo referenciado não pode
  ser excluído, e a associação é removida com o curso.
- `academy_modules` → `academy_lessons`: currículo com ordenação e publicação
  explícita (módulos e aulas inativos por padrão). A aula exige uma fonte YouTube
  ou arquivo HTTPS, mutuamente exclusivas.
- `academy_lesson_progress`: chave `(user_uid, lesson_id, media_version)`, posição
  de 0 a 86400 segundos e conclusão com timestamp consistente. Exclusão do usuário
  ou da aula remove o progresso; exclusão do curso remove a árvore por cascata.
- `cms_documents` aceita `academy_lesson`, além dos tipos anteriores.

Somente `portal_api` recebe CRUD nas quatro novas tabelas. O cron mantém seu
acesso às revisões CMS para retenção, sem acesso ao progresso. O `schema.sql`
inclui a estrutura Academy, mas **não registra 033 como aplicada**: no bootstrap,
a migration 015 ainda precisa criar o CMS antes de 033 ampliar seu CHECK.
As regras editoriais, elegibilidade e atualização de versão de mídia pertencem
à camada de aplicação; essa migration entrega a estrutura relacional.

### Políticas, validação e leitura de progresso

O catálogo em `api/academy/catalog.js` aplica audiência e publicação válida antes
de total, categorias e paginação. `GET /api/academy` mantém array e
`X-Total-Count`, aceita `group=initial|role` e acrescenta capa/contagens/progresso
sem remover os campos legados. Metadados do currículo e progresso são carregados
em lote para a página selecionada. Formação inicial e por cargo não possuem
pré-requisitos entre si. Categorias refletem o mesmo conjunto público autorizado.

`GET /api/academy/:id` entrega curso e currículo; `GET /api/academy/lessons/:id`
entrega mídia, descrição/material publicado, progresso da versão atual e vizinhos
do currículo visível. Curso, módulo e aula precisam estar ativos; documento CMS
existente sem publicação válida impede fallback legado. `all=true` é preview
explícito com `manageAcademy`, inclusive nas categorias. A lista de fontes
`GET /api/academy/lessons?all=true` é exclusiva de gestores e inclui aulas inativas
para edição CMS. O tipo `academy_lesson` está registrado nas permissões, fontes,
rotas e leitor do CMS, com `manageAcademy` e origem `academy_lessons`. O leitor
genérico considera a atividade da aula, do módulo e do curso nas duas projeções;
o catálogo continua validando a publicação e audiência do curso no client bloqueado.

`authorizeLessonInTransaction(db,user,lessonId)` usa somente o client recebido,
com lock CMS `7193029` seguido de curso → módulo → aula, rechecando ancestrais,
audiência e blocos publicados. Nunca chama leitores que abrem conexões do pool.
O currículo também lê e bloqueia a hierarquia em lote nessa ordem, dentro da fase
protegida pelo CMS: revalida cursos/audiência/publicação e busca módulos/aulas
atuais antes de projetar mídia, vizinhos ou contagens. Somente fontes existentes
e autorizadas sem documento podem usar descrição legada; snapshots anteriores ao
lock não são convertidos em conteúdo legado após exclusão ou mudança de vínculo.

O harness `tests/helpers/academy-integration.mjs` monta as rotas reais e substitui
apenas pool/autenticação externa, sem alterar cache global. Para integração real,
use um banco **descartável já migrado até 033 e com Academy vazio**, configure
`MIGRATION_DATABASE_URL`, `MIGRATION_TEST_DISPOSABLE=true` e execute
`node --test scripts/test-academy.mjs`. Fixtures têm UUIDs próprios, são serializadas
por advisory lock de teste e removidas por ID no teardown. O script recusa execução
sem opt-in ou em produção. Não inicia serviços nem aplica migrations. Testes HTTP
com doubles de SQL e política/CMS reais rodam em `npm run verify`; integração com
PostgreSQL permanece uma verificação separada, dependente do ambiente autorizado.

`api/academy/access.js` separa cargo profissional de `role`: audiência restrita
exige `job_title_active === true` e associação ao cargo atual. Mesmo um gestor
precisa dessa audiência na leitura normal; somente `{ preview: true }` usa
`can(user, 'manageAcademy')` para ler curso inativo ou fora da audiência.
`canReadCourse` verifica atividade e audiência, não publicação editorial CMS.

`api/academy/validation.js` expõe validators puros que retornam objeto normalizado
ou `null`. O payload de curso aceita apenas `title`, `category`, `description`,
`url`, `order`, `active`, `delivery_mode`, `audience`, `learning_group`, `icon_key`,
`instructor_name` e `allowed_job_title_ids` (alias legado `job_title_ids`, nunca os
dois simultaneamente). Na atualização, fornecer `current` com os
metadados atuais e `job_title_ids` carregados da associação; campos omitidos são
preservados. Novos cursos são inativos. Internos usam URL nula; externos exigem
HTTP(S), mantendo compatibilidade com URLs legadas. Conversão explícita para
interno limpa a URL externa anterior na mutação, inclusive quando o editor reenviar
o link antigo; preserva ID e documento CMS.

O payload de aula aceita `title`, `description`, `order`, `active` e
`media: { type: 'youtube'|'file', url }`; título e mídia são obrigatórios.
A saída mantém `media`, normalizada para `{type:'youtube',video_id}` ou
`{type:'file',url}`. Aulas são inativas por padrão. Identificadores de usuário,
entidade e `media_version` não são editáveis nesses payloads. YouTube aceita
somente os hosts e formatos previstos, HTTPS sem credenciais/porta não padrão,
com ID de 11 caracteres. Arquivos exigem HTTPS sem credenciais e caminho
terminado em MP4/WebM, permitindo query; URLs têm limite de 2048 caracteres.
Nenhuma mídia é consultada pelo servidor durante a validação.

Limites: título 200, categoria 100, descrição 5000, instrutor 120 caracteres;
ordem inteira de -100000 a 100000; até 100 UUIDs de cargo distintos (normalizados
em minúsculas), com ao menos um para público restrito. A camada transacional
de gestão verifica existência/atividade de novas associações, preserva
seleções inativas existentes, limites de 100 módulos/500 aulas e a existência
de aula pública reproduzível antes de ativar um curso interno. Essas verificações
dependem de banco/catálogo e não são inferidas pelo validator puro.

### Gestão transacional de cursos e currículo

`api/academy/mutations.js` recebe exclusivamente o client de `withAudit`, sem abrir
conexões ou transações aninhadas. Todas as escritas entram pelo lock CMS `7193029`
e bloqueiam curso → módulo → aula, nessa ordem. Contagens incluem inativos e são
checadas sob lock do curso; cargos novos exigem existência/atividade com `FOR SHARE`.
A ativação de curso interno exige módulo e aula ativos, mídia válida e publicação
válida do curso e da aula (incluindo assets); sem documento CMS, vale o conteúdo
simples legado. Agendamentos vencidos do curso e das aulas são processados pelo
promotor CMS no mesmo client antes da checagem, inclusive retirada de agendamentos
inválidos sem substituir uma publicação anterior válida. Rascunhos não são
publicados automaticamente. Rejeição da ativação ou falha de auditoria reverte
toda a transação, inclusive promoções/retiradas realizadas durante a checagem.

POST/PUT/DELETE de cursos e as rotas abaixo exigem `manageAcademy` e registram
auditoria na mesma transação; falha de auditoria reverte a mutação inteira:

- `POST /api/academy/:id/modules`; `PUT/DELETE /api/academy/modules/:id`.
- `POST /api/academy/modules/:id/lessons`; `PUT/DELETE /api/academy/lessons/:id`.
- `PUT /api/academy/:id/modules/order` e
  `PUT /api/academy/modules/:id/lessons/order`, payload `{ids: UUID[]}`.

PUT preserva campos omitidos; identificadores, datas e campos extras são rejeitados.
Reordenação exige conjunto completo do pai sem duplicatas; falha retorna
`400 invalid_order` antes de alterar ordens. A posição persistida começa em 1.
Mudar a origem normalizada do vídeo incrementa `media_version`; editar título,
ordem ou outra representação do mesmo ID YouTube não incrementa.

Exclusão remove primeiro os documentos CMS das aulas descendentes e, no caso do
curso, sua apresentação, antes da origem. Cascatas removem revisões/currículo/
progresso. Arquivos e assets compartilhados ficam com a retenção existente.
`deleteCmsSource` encaminha Academy/aulas para essas mesmas operações completas.
Os testes locais executam domínio e HTTP reais com seams de DB; o script de
integração inclui corridas nos limites, ordenação, rollback e arquivos compartilhados.

`api/academy/progress.js` contém `readProgress`, `summarizeProgress` e `saveProgress`.
A leitura parametriza usuário autenticado, aula e versão; ausência retorna
posição zero, incompleto e versão de progresso zero. O chamador deve autorizar
a leitura e fornecer o UID autenticado. O resumo recebe aulas já visíveis e
ordenadas pelo catálogo; ignora versões antigas, arredonda percentual para baixo
e retoma a última aula acessada se incompleta; se concluída, a próxima incompleta
na ordem (voltando à primeira incompleta se necessário). IDs são distintos.
Sem progresso atual ou com todas concluídas, não há aula de retomada. Posição
do vídeo não implica conclusão. `AcademyError(status, reason)` fornece erro
tipado para as rotas HTTP de leitura e gestão.

`PUT /api/academy/lessons/:id/progress` aceita somente `media_version`,
`expected_version`, `position_seconds` (inteiro 0..86400) e `completed` opcional.
UID vem da autenticação. Uma única conexão transacional autoriza com locks
CMS → curso → módulo → aula antes da escrita compare-and-swap. Primeira escrita
usa versão esperada zero; colisões retornam `409 progress_conflict`, mídia antiga
retorna `409 media_changed`. Omissão de `completed` preserva conclusão/data;
`false` explícito limpa a data. Nunca há conclusão automática pelo tempo assistido.
`GET /api/academy/continue?limit=3` lista cursos iniciados e incompletos por última
atividade autorizada da mídia atual, independente da primeira página do catálogo.
O limite aceita 1..100. Curso/aula sem publicação válida não entra no cálculo.
Somente o PUT no pathname exato de progresso tem limite 120/15 min/UID; demais
mutações mantêm 60/15 min e limites globais continuam vigentes.

`public/academy/progress-controller.js` recebe o `fetchAPI` original e um signal
da visita/sessão. `record(seconds)` coalesce posições, salva alterações em 30 s;
`flush()` aguarda a fila em voo (usar em pausa e antes da troca interna de aula).
`complete()` retorna Promise da própria escrita de conclusão, sem aguardar
posições posteriores (cuja falha não desfaz essa confirmação): o consumidor desabilita
o botão enquanto aguarda e atualiza conclusão apenas no sucesso. Falha rejeita
essa ação, que exige novo clique, sem publicar conclusão otimista. Escritas têm
AbortSignal local e no máximo um request simultâneo. Falhas transitórias mantêm
posição pendente com backoff 5/15/30 s, 429 aguarda 60 s; `flush` não fura backoff.
`onStatus(status, detail)` publica saved/saving/pending/conflict/unavailable;
409 encerra escritas da visita e exige recarga; 401/403/404 ou abort da sessão
encerram escritas, cabendo à camada de acesso parar playback e limpar materiais
ao receber unavailable. `dispose` cancela timers/requests e suprime callbacks
tardios. O consumidor deve descartar a visita no logout/troca de identidade.
Não há fila/token em storage. Fechamento abrupto pode perder o intervalo ainda
não confirmado. Integração de player/views pertence à etapa seguinte.

### Verificação descartável

`npm run test:migrations` mantém os requisitos `MIGRATION_TEST_DISPOSABLE=true`,
`MIGRATION_DATABASE_URL` e as senhas dos papéis de teste (`PORTAL_API_DB_PASSWORD`
e `PORTAL_CRON_DB_PASSWORD`, pelo menos 16 caracteres). Nunca apontar para produção.
Para validar os dois caminhos, usar duas bases vazias descartáveis previamente
autorizadas, uma para cada execução:

- `MIGRATION_TEST_SETUP=upgrade`: prepara migrations até 032, insere um curso
  legado e executa o migrator normal, incluindo 033.
- `MIGRATION_TEST_SETUP=bootstrap`: aplica `schema.sql`, confirma CMS e ledger
  033 ausentes, insere o curso legado e executa as migrations pendentes.

Ambos recusam bases com tabelas em `public`, sem apagar tabelas para preparar o
teste. Sem `MIGRATION_TEST_SETUP`, permanece o fluxo usual de migrations sobre a
base descartável fornecida. As verificações cobrem repetição sem reaplicar ledger,
defaults, restrições de mídia, isolamento do progresso por usuário/versão,
cascatas, FK de cargo, tipos CMS e privilégios reais. Os fixtures de comportamento
Academy são revertidos por transação. Nesta entrega, a execução PostgreSQL dos
dois caminhos permanece pendente: o usuário optou por não iniciar serviços.

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

Aceite integrado A3: o importador de pacote foi executado contra o mesmo banco
e `/app/uploads` montado na API local. Uma PNG sintética teve HTTP 200 com
MIME/tamanho/SHA-256 idênticos como editor em draft e como editor/dois leitores
após publicação; leitor comum recebeu 403 no asset privado e 404 no documento
draft. Isso complementa a verificação de arquivos em disco de A2. Browser real
também confirmou revisão salva pela ação de publicar/agendar, sessões de voto
independentes e cleanup do reader. Escopo exclusivamente sintético/local;
[relatório A3 e limites](../reports/2026-09-30-owner-news-acceptance.md).

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

### Gestão de enquetes no CMS (P3)

- Owner News também oferece Enquetes, montada por `cms-polls.js` com
  `mountNewsPollManager({root,page}) -> {canLeave,dispose}`. O controlador CMS
  mantém uma única guarda para documentos e subárea ativa; dispose aborta os
  requests e remove listeners antes de reutilizar o painel.
- A lista administrativa usa páginas de 20. Rascunhos têm título, pergunta,
  descrição, encerramento e 2–6 opções distintas, com adicionar/remover/subir/descer.
  POST cria e PUT salva com expected_version; somente a resposta bem-sucedida
  redefine a baseline e substitui integralmente o DTO, incluindo IDs das opções.
- `protectForm` aceita modo `managed` com serialização do payload e comparação
  `isDirty`: o módulo usa essa mesma baseline na guarda CMS, sem registrar uma
  segunda confirmação no guard global de UI. O comportamento padrão permanece.
- Publicar exige rascunho salvo e limpo. Aberta/encerrada mostram apenas textos e
  totais; aberta pode encerrar, encerrada pode originar nova cópia sem ID/votos.
  Conflitos preservam as entradas locais. Recarregar pede descarte e consulta a
  lista administrativa até encontrar o DTO atual (não existe GET de draft por ID).
  `active_poll_exists` consulta current e oferece navegar à enquete aberta.
- 403 remove os controles de gestão; falhas transitórias mantêm o conteúdo e
  permitem retry. O servidor continua sendo a autoridade de permissão e versão.
  `tests/unit/owner-news-polls-frontend.test.mjs` cobre o módulo real no DOM do
  harness, com requests controlados e fixtures sintéticas.

### Controle de sessão e autoridade editorial Payload

A migration `036_payload_editorial_control` cria `cms_editor_sessions` e
`owner_news_authority` no banco do Portal. O bootstrap aplica essa migration pelo
runner normal; `schema.sql` não a marca como aplicada. A reaplicação preserva as
sessões e o singleton existente, inicialmente `{mode: 'legacy', epoch: 1}`.

- Sessões guardam somente SHA-256 hexadecimal minúsculo (64 caracteres), UID,
  expiração, revogação e criação. Excluir o usuário remove suas sessões por cascata.
  `api/editorial-session/store.js` recebe o client do chamador:
  `createSessionRecord(db,{hash,uid,expiresAt})` retorna `{uid,expiresAt}`;
  `findSessionRecord(db,hash)` retorna esse objeto ou `null` para hash ausente,
  revogado ou expirado (`expires_at <= NOW()`); datas são `Date` do driver `pg`.
  `revokeSessionRecord(db,hash)` retorna booleano: `true` só na primeira revogação
  de um registro existente; repetição/ausência retorna `false` sem alterar a data.
- Cada criação limpa no máximo **100** expirados, ordenados por expiração/hash,
  com `FOR UPDATE SKIP LOCKED`, na mesma instrução SQL da inserção. O futuro POST
  de sessão consumirá esse helper. O store não cria cookies nem executa cron.
- `api/owner-news/authority.js` expõe `writerAllowed(mode,writer)`: apenas
  `legacy/legacy` e `payload/payload` autorizam; `frozen` e `payload_frozen`
  bloqueiam ambos. `getAuthority(db,{forUpdate=false})` retorna `{mode,epoch}`,
  sem cache. Configuração ausente/inválida gera `AuthorityError` com
  `status=503`, `code='news_authority_unavailable'`; erros SQL, inclusive tabela
  ausente, propagam. Não há fallback automático para legado.
- `getAuthority(db,{forUpdate:true})` adquire advisory lock CMS **7193029** e
  depois a linha singleton `FOR UPDATE`. `assertNewsWriter(db,writer)` usa essa
  leitura bloqueante, retorna `{mode,epoch}` se permitido e lança
  `AuthorityError(409,'news_read_only')` caso contrário. O chamador fornece um
  client dentro de transação (`withAudit` nas mutações auditadas) e só depois
  bloqueia documentos. Trocas de modo também devem seguir CMS → autoridade →
  documentos. Nenhum helper abre pool ou transação própria.
- `portal_api` recebe CRUD de sessões e SELECT/UPDATE da autoridade; não pode
  inserir/excluir o singleton. `portal_cron` tem somente SELECT da autoridade e
  nenhum acesso a sessões. Leituras do cron usam `getAuthority(db)`; decisões de
  escrita no cron devem usar `writerAllowed` sob seu lock CMS existente. A leitura
  `forUpdate` e `assertNewsWriter` exigem o papel API com UPDATE, não o cron.
  A referência `changed_by` fica nula ao excluir o usuário, preservando o modo.

Os testes sem banco cobrem contrato, decisões e ordem das chamadas.
Constraints, grants efetivos e comportamento SQL constam dos cenários descartáveis
de `scripts/test-migrations.mjs`, com execução **pendente de autorização de banco**.
Os helpers CommonJS novos usam APIs disponíveis em Node 18; a verificação local
usa Node 24, conforme o runtime dos manifests existentes.

### Autenticação editorial revogável (Payload Task 3)

`loadActivePortalUser(db,decoded)` centraliza o perfil ativo usado pelo Bearer e
pela sessão: email verificado, cadastro existente/aprovado, disabled boolean/string,
`firebase_enable_pending` e join de cargo. Preserva os reasons 403 e os limites
de escrita existentes (60/15 min; progresso Academy PUT exato, 120/15 min).

As rotas são montadas antes do parser CMS legado e usam JSON de **16 KiB** e
`Cache-Control: no-store`. Configuração CMS opcional é validada na fronteira da
requisição, sem impedir o startup da API legada:

- `POST /api/cms/session`: Bearer validado com `verifyIdToken(token,true)`, conta
  ativa, `can(user,'manageKnowledge')` e Origin exata. Revoga o hash anterior do
  navegador antes da nova emissão. Chama `createSessionCookie(token,{expiresIn:7200000})`,
  grava somente SHA-256 e responde **201 `{uid,expiresAt}`**. INSERT com falha
  impede Set-Cookie; a cookie nunca entra em JSON ou logs da ponte.
- `GET /api/cms/session`: somente cookie; responde **200 `{uid,expiresAt}`**, sem
  emissão/renovação. Resolução usa hash ativo, `verifySessionCookie(cookie,true)`,
  igualdade do UID validado com o UID armazenado e perfil/permissão atuais.
- `DELETE /api/cms/session`: sem Bearer, com Origin exata; revoga o hash e expira
  a cookie após sucesso, **204** inclusive em repetição/ausência. Falha de DB
  responde 503 e não confirma logout nem expira a cookie.
- Cookie: `__Host-ownerinc-editorial`, HttpOnly, Secure, SameSite=Lax, Path=/,
  duas horas. Somente `NODE_ENV=development` + HTTP loopback usa
  `ownerinc-editorial-dev`, sem Secure. Nenhuma origem ausente, diferente ou
  `Sec-Fetch-Site: cross-site` autoriza mutação. Nome duplicado é rejeitado.

O prefixo privado `/api/internal/editorial` exige `Authorization: Bearer
PAYLOAD_TO_PORTAL_SECRET` em todos os endpoints, por comparação de hashes de
comprimento fixo em tempo constante. Não aceita esse segredo como login Payload:

| Endpoint | Entrada | Saída |
|---|---|---|
| POST `/session/resolve` | `{cookie}` | `{actor,expiresAt}` |
| POST `/session/revoke` | `{cookie}` | 204 idempotente |
| POST `/actor/check` | `{uid}` | `{actor}` |
| GET `/authority` | nenhuma | `{mode,epoch}` |

Essa fronteira privada é montada antes do limite público de 300 requests/15 min/IP.
Depois da autenticação de serviço, aplica quotas agregadas **por processo**, em
janelas de um minuto: 3000 resoluções, 300 revogações, 600 checagens de ator e
120 leituras de autoridade. Cada operação tem um bucket de chave constante;
`X-Forwarded-For` e UIDs do body não definem quotas. Credenciais de serviço recusadas
têm um bucket separado de 60/min e não gastam a capacidade autenticada. Exceder
uma quota responde 429 antes do parser/DB/Firebase, sem impedir as outras operações;
o CMS traduz esse throttle em 503 controlado. As quotas públicas e Bearer por UID
permanecem vigentes. Dimensionamento real/múltiplos processos ficam no aceite integrado.

`actor` é `{uid,email,name,canManageNews:true}`, montado no servidor; expiração
é ISO UTC. Jobs checam `firebaseAuth.getUser(uid)` (existência, UID, email verificado,
disabled) e perfil/permissão atuais, independentemente da sessão do navegador.
401 indica sessão inválida/expirada/revogada; 403 indica conta ou permissão negada;
503 `editorial_unavailable` indica dependência/configuração indisponível. Autoridade
indisponível usa 503 `news_authority_unavailable`. Erros 5xx mantêm a mensagem genérica
do Portal e apenas reasons permitidos; corpos/token/causas das dependências não são
repassados. Credencial interna incorreta usa 401 `editorial_service_unauthorized`,
que o client CMS trata como **503**, não revogação da pessoa.

No CMS, a estratégia customizada revalida por request (timeout 5s, sem retry,
`redirect:'error'`, `cache:'no-store'`). Só então lê/cria `portal-editors` com
`overrideAccess:true`, por `portalUid` único, relendo após conflito de unicidade.
`portalActor` e `portalExpiresAt` são exclusivamente runtime. Admin exige a
capacidade atual; leitura da projeção é apenas da própria conta; mutações públicas
são negadas. Senhas/first-user/API keys são desabilitados; refresh nativo é negado
para não emitir JWT Payload independente. A fronteira REST preserva 401/403/503
mesmo com o catch de estratégias do framework 3.90.2, sem alterar seu núcleo.

`cms/src/proxy.ts` aplica Origin exata e rejeição de `Sec-Fetch-Site: cross-site`
antes do dispatch Next em todo `/editorial/:path*`, inclusive ações nativas do
layout que não passam pelo `serverFunction` customizado (como a cookie de idioma).
Todos os métodos mutantes são protegidos, com ou sem header `next-action`; GET,
HEAD e OPTIONS prosseguem sem mutação pelo proxy. Recusas não emitem Set-Cookie;
configuração ausente/inválida retorna 503. Permanecem os guards locais REST/action
e a autorização Portal por request. Esse scaffold não inclui CSP/infra da Task 13.

Login nativo encaminha para `/editorial-entry.html`; GET logout encaminha para
`/editorial-entry.html?logout=1`, sem mutação. POST logout nativo usa `afterLogout`
para revogação/expiração confirmadas. **Task 9** ainda entrega essa página, entrada
Bearer, logout do Portal, retry e observação de troca de UID entre abas. Migrations
dos campos Payload pertencem à tarefa de schema subsequente. Tests HTTP usam os
handlers/políticas reais com doubles externos; DB/Firebase/browser/Nginx reais
permanecem pendentes e não são declarados como aceite de autenticação.

### Persistência editorial (E2)

- Migration `034_owner_news_editorial` acrescenta `cms_revisions.editorial` JSONB
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
- Assets de `academy` e `academy_lesson` herdam os cargos do curso; aulas exigem
  também módulo/aula ativos e apresentação do curso publicada e válida quando
  há documento CMS. A revisão referenciadora completa e a apresentação são
  validadas em batch no mesmo client sob lock `7193029`, sem transação aninhada.
  Gestores com `manageAcademy` mantêm prévia de draft/published/scheduled.
  Um arquivo compartilhado é legível se ao menos uma referência for autorizada;
  `uploaded_by` não concede acesso. Asset existente sem referência autorizada
  retorna `403`; inexistente retorna `404`. Rascunhos e revisões arquivadas de
  aula conservam referências para a retenção existente; excluir a fonte elimina
  documentos/revisões e deixa o arquivo para a janela normal de retenção.
