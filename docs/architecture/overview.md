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

`api/academy/access.js` separa cargo profissional de `role`: audiência restrita
exige `job_title_active === true` e associação ao cargo atual. Mesmo um gestor
precisa dessa audiência na leitura normal; somente `{ preview: true }` usa
`can(user, 'manageAcademy')` para ler curso inativo ou fora da audiência.
`canReadCourse` verifica atividade e audiência, não publicação editorial CMS.

`api/academy/validation.js` expõe validators puros que retornam objeto normalizado
ou `null`. O payload de curso aceita apenas `title`, `category`, `description`,
`url`, `order`, `active`, `delivery_mode`, `audience`, `learning_group`, `icon_key`,
`instructor_name` e `job_title_ids`. Na atualização, fornecer `current` com os
metadados atuais e `job_title_ids` carregados da associação; campos omitidos são
preservados. Novos cursos são inativos. Internos usam URL nula; externos exigem
HTTP(S), mantendo compatibilidade com URLs legadas. Conversão explícita para
interno sem `url` limpa a URL externa anterior.

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
de gestão deverá verificar existência/atividade de novas associações, preservar
seleções inativas existentes, limites de 100 módulos/500 aulas e a existência
de aula pública reproduzível antes de ativar um curso interno. Essas verificações
dependem de banco/catálogo e não são inferidas pelo validator puro.

`api/academy/progress.js` contém apenas `readProgress` e `summarizeProgress`.
A leitura parametriza usuário autenticado, aula e versão; ausência retorna
posição zero, incompleto e versão de progresso zero. O chamador deve autorizar
a leitura e fornecer o UID autenticado. O resumo recebe aulas já visíveis e
ordenadas pelo catálogo; ignora versões antigas, arredonda percentual para baixo
e retoma a incompleta com atividade mais recente (ou a primeira incompleta).
Sem progresso atual ou com todas concluídas, não há aula de retomada. Posição
do vídeo não implica conclusão. `AcademyError(status, reason)` fornece erro
tipado para a futura camada HTTP. Esses helpers ainda não alteram as rotas legadas.

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
