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
