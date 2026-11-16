# Páginas do Conecta

## Escopo e fronteiras

Domínio novo e independente para páginas internas compostas por modelos e blocos.
Não reutiliza tabelas, uploads, endpoints, renderer, grants ou jobs do CMS histórico.
Knowledge, Academy, AutoCard e Cards Pós conservam seus contratos próprios.

A primeira entrega compreendeu comunicado, texto rico e imagem estática,
prévia desktop/mobile, rascunho persistente, publicação, leitura e arquivamento.
A expansão autorizada acrescenta composição em uma/duas colunas, arraste e comandos
por teclado, presets de bloco, destaque, botão, separador, GIF, MP3 e MP4 privados,
e um modelo Owner News sintético com cinco seções. Os resultados observados da
expansão são registrados separadamente ao final, sem estender a evidência do primeiro lote.
O exemplo de vestimenta é ilustrativo, não uma política oficial.

## Base e compatibilidade

Os menus transitórios do editor (Prévia, Mais ações e Mais opções de texto)
compartilham `createEditorMenus({page})`: `register(details)` devolve unregister,
`closeAll({restoreFocus = false})` fecha sem salvar e `dispose()` libera listeners.
Escape fecha apenas o menu superior e retorna ao summary; composição IME e dialogs
abertos mantêm prioridade. Pointerdown fora fecha sem cancelar o clique nem mover
foco. FAQ, público e opções avançadas não participam desse controlador.
O caso local `node tests/visual/pages-editor-controls.mjs menus` exige
`PGLITE_MODULE_PATH`, `PLAYWRIGHT_MODULE_PATH` e um diretório novo em
`PAGES_CONTROLS_OUTPUT`; usa apenas identidade e banco sintéticos, sem produção.
O espaço do texto no canvas preserva a base existente e cresce quando a altura
medida da barra não escalada exige mais folga: âncora de 16 px do papel e pelo
menos 4 px de separação física, inclusive a 50%. ResizeObserver acompanha a barra
atual e libera a anterior. Durante arraste de composição, a barra permanece
visível, mas cede hit-testing aos destinos; o término restaura os controles.

A estrutura conserva `onReorderSection({sectionId,beforeSectionId})` e os UUIDs do
documento. A alça ocupa 44 × 44 px reais; Posição e os botões Subir/Descer têm linha
própria e estilos compartilhados entre lateral e diálogo. `data-organizing` fica
sincronizado no root e no próprio nav, sem depender do ancestral após reparenting.
`node tests/visual/check-pages-controls.mjs structure` usa as mesmas variáveis do
caso `menus` e confere 320/390/768/1366 px, foco, seleção, limites, Alt+setas, arraste,
Escape, ordem SQL após save explícito e undo local sem recriar EditorViews.

Salvar permanece em um único slot no chrome em todas as larguras, sem relocação
por dirty/pending ou duplicação de acionadores no painel inferior. O header sticky
reserva espaço no fluxo; sua altura medida limita o painel compacto para manter
ação e status acessíveis. `update()` apenas sincroniza disponibilidade/status;
`createPageButton` continua aguardando o ACK de `state.save(api)`. Confirmação de
uma revisão anterior não confirma edições posteriores. Falha com pending anuncia
salvamento não confirmado e o retry conserva payload/key; conflito preserva o local.
Publicar disabled mantém aparência inativa inclusive em hover e motivo associado
visível. Status só muda no DOM quando a mensagem muda, não a cada tecla.
`node tests/visual/check-pages-controls.mjs save` usa a mesma configuração local,
com 320/390/768/1366 px, painel aberto, busy/ACK/503, perda de ACK após COMMIT real,
replay sem revisão duplicada, edição durante save, Mod+S, conflito e permissões.
PGlite serializado não representa concorrência nativa PostgreSQL ou produção.

Modais de tarefa (`openPagesDialog`, com o mesmo retorno `dialog`) têm scrim,
centralização e margem mínima de 16 px na área visual disponível. Cabeçalho com X
nomeado e ações ficam fora do corpo rolável; os controles de conteúdo são retidos,
não clonados. Cancelar recebe foco inicial. Escape, X, Cancelar e histórico respeitam
busy/composição; erro libera retry/cancelamento. Cleanup da visita força descarte,
sem restauração de foco nem atualização tardia de controles removidos. Clique fora
não descarta formulário. O opener opcional permite retornar ao Link da toolbar sem
depender de pointerdown mover o foco do editor.

Inserir, Estilo e cor conservam `openEditorPanel` e sua semântica nativa de foco:
âncora no desktop e área segura central no compacto. A âncora de Estilo inclui seu
deslocamento de 10 px em um único cálculo **antes** de `showModal`, sem reposicionar
depois da abertura. Resize/viewport, scroll e ResizeObserver do acionador/container
acompanham reflow; fechar libera esses listeners. Estilo mantém rascunho local,
Aplicar explícito e rodapé fora do scroller; clique fora não descarta. Inputs/selects
textuais têm 44 px e fonte de 16 px no compacto; checkboxes mantêm indicadores de
18–20 px em linhas de 44 px, sem herdar padding/altura de campo textual. Dispositivo
e Zoom usam suas classes próprias também quando movidos para Mais ações.

`node tests/visual/check-pages-controls.mjs overlays` usa o mesmo harness local e
variáveis do caso `menus`, em 1366×768 e 320/390/768×768. Mede primeira frame e frames
seguintes da âncora em aberturas repetidas, reflow, foco/IME/busy/erro/cleanup, campos,
checkboxes e rodapé, sem substituir o documento aberto nem recriar EditorViews.
`check-pages-style.mjs --strict-reference-geometry` preserva as asserções históricas
do botão 36 px + pseudoalvo; o modo funcional registra a divergência intencional e
exige alvo real de 44 px sem extensão sobre vizinhos. Não é aceite das pranchas.

A toolbar principal usa altura mínima, não fixa: linhas adicionais no tablet
reservam espaço antes do canvas. Undo/redo têm 44 × 44 px reais, sem pseudoalvos
sobrepostos; os demais alvos existentes conservam sua separação. O aviso compacto
deriva exclusivamente de `showMode(editing)` (“Edição”/“Prévia”), inclusive após
editar o conteúdo de um modelo. Não classifica documentos do autor como ilustrativos.
Cabeçalhos do Guia mantêm as métricas do painter canônico também no celular
(capa 36 px; título editorial 20 px com strong preservado), sem mudar cores,
marcas, esquema ou payload. A paleta persistida não é corrigida implicitamente.
A capa compacta reserva 4 px para a ascensão da fonte real dentro de seu fundo;
isso evita o resultado axe incompleto por texto fora do limite do bloco, sem
recortar glifos ou excluir o título da auditoria.

`node tests/visual/check-pages-controls.mjs responsive` exige também `AXE_MODULE_PATH`.
Cobre 320/390/599/600/768/1099/1100/1366/1600 px, alturas 640/768, canvas
50/100/150%, modo/preview real, identidade PM e snapshots v1/v2/v3. Mede controles
e pseudoalvos, colisões, hit-testing, contenção local, linhas do título e folga da
toolbar contextual, além de overflow global. Axe inclui todos os títulos rich-text;
o título laranja precisa ter um resultado PASS completo, não apenas zero violações.
Resultados incompletos são registrados e falham, não excluídos nem chamados de PASS.
Chrome 200% usa `settingsPrivate.setDefaultZoom(2)` em perfil descartável próprio,
validado por DPR 2, viewport CSS pela metade e visualViewport.scale 1; não usa pinch
ou transformação CSS como substituto. O check de renderer conserva as asserções
históricas com `--strict-reference-typography`; o funcional distingue metadados do
Guia 14/12 px de títulos genéricos 32/16 px e redimensiona o viewport autoritativo
em vez de disputar a largura da superfície com seu ResizeObserver.

O mesmo assertor de alvos do caso responsivo é repetido por combinação em uma
matriz de 648 chaves distintas (três esquemas, dois modos, dois zooms de browser,
três zooms de canvas, nove larguras CSS e duas alturas CSS). Para browser 200%,
viewport físico 2× produz cada largura/altura CSS exata, confirmada com DPR 2 e
pinch 1. Cada linha verifica geometria/pseudoalvos, contenção, colisão e hit-testing
das quatro bordas; selects nativos não são isentos. Disabled conserva verificações
de geometria/colisão sem afirmar ativação. A cor laranja computada, a presença de
strong e seu peso >=700 são exigidos também em prévia, sem depender apenas de axe.

O desenvolvimento parte de `2cecbe8`, incluindo o aceite obrigatório do Código de
Ética. Nenhuma rota Pages fica isenta desse gate. A autenticação continua sendo
Firebase Bearer, validada pelo middleware existente com o perfil atual no banco.

O código novo evita recursos exclusivos de Node 24. Os manifests, imagens e checks
existentes continuam em Node 24; isso não demonstra que toda a aplicação e suas
dependências são executáveis em Node 18. A divergência preexistente de AGENTS.md
fica registrada, sem downgrade de infraestrutura ou reescrita incidental das regras.

## Contrato de documento

Snapshots originais usam `schema_version: 1`; a expansão usa versão 2. Ambos têm modelo identificado e versionado, metadados,
presets de apresentação e IDs UUID estáveis em seções, linhas, colunas e blocos.
A ordem dos arrays é canônica. O formato não aceita HTML, CSS ou JavaScript livre,
base64, URLs de arquivos como substituto de mídia privada ou plugins arbitrários.

O título, resumo, tags, audiência e corpo pertencem à mesma revisão. Tags organizam
a página; não se confundem com etiquetas visuais dentro do conteúdo.

Texto rico usa uma árvore validada: documento, parágrafo, títulos H2/H3, listas
ordenadas/não ordenadas, itens, texto e quebra. As marcas permitidas são negrito,
itálico, sublinhado e links seguros. O título principal produz um único H1 na
leitura. Links externos exigem HTTPS, sem credenciais; links internos são caminhos
root-relative, sem `//`, barras invertidas ou caracteres de controle.

Limites de referência: requisição JSON de 1 MiB, 100 blocos, 100 linhas, 100 mil
caracteres de texto agregado e dois níveis de listas. A validação do backend é a
autoridade, incluindo propriedades desconhecidas, IDs duplicados e referências.
Um rascunho pode estar incompleto; a publicação tem validação adicional.

## Identidade, revisões e concorrência

A migration aditiva `042_pages_reference_fidelity` prepara o armazenamento para
revisões 1/2/3 e acrescenta `pages.slug` como texto nullable, sem default ou backfill.
Valores não nulos têm 1–120 caracteres ASCII minúsculos/numéricos separados por
hífen simples e unicidade parcial (`WHERE slug IS NOT NULL`). UUID continua sendo
a identidade. A migration não atribui aliases, modifica snapshots, referências,
timestamps ou grants, nem habilita writer/rotas v3. O bootstrap inclui a coluna e
os checks de 042, mas mantém 040/041/042 pendentes para aplicar os grants e a
expansão de mídia na ordem existente. Readiness exige o ledger atual **e** a forma
efetiva da coluna, checks validados e índice único parcial.

O harness PGlite descartável aceita `afterFoundation` e `afterMedia`; aplica 042
duas vezes após o hook de 041 para conferir preservação de v1/v2. O ensaio nativo
`scripts/test-pages-recovery.mjs` inclui dump pré-042, restore ordinário após 042,
readiness recusada até reaplicar migrations e recuperação pré-Pages usando o SQL
literal do receptor inalterado. PGlite/guardas locais não comprovam esse restore:
PostgreSQL 16 nativo, clientes pg_dump/pg_restore, concorrência e ambiente
descartável explicitamente aprovado continuam gates separados de rollout.

`pages` contém identidade, autoria, versão de concorrência e ponteiros de rascunho
e publicação. `page_revisions` contém snapshots; `page_revision_job_titles` e
`page_revision_media` contêm suas referências, inseridas na mesma transação.

Conteúdo, audiência e referências de uma revisão são append-only. A anonimização
de autoria por `ON DELETE SET NULL` é uma exceção explícita, sem modificar conteúdo.
Apagar um usuário não apaga páginas ou imagens publicadas. Autor nulo não concede
edição a administradores, publicadores ou superadministradores.

Salvar cria uma revisão e move somente o rascunho. Publicar exige a versão atual
e a revisão salva explicitamente revisada; nunca substitui a seleção por outro
rascunho mais novo. O ponteiro publicado, sua audiência e a auditoria mudam de
forma atômica. Falha de auditoria reverte a operação inteira.

As mutações recebem `expected_version` e `client_mutation_id`. Conflito retorna
409 e preserva alterações locais. O identificador é vinculado ao ator e ao hash
canônico de operação, destino e payload. Retry confirmado revalida acesso, mas não
reaplica o CAS já consumido nem gera uma segunda revisão/auditoria. Reutilizar a
mesma chave com outro conteúdo é conflito. Recibos não contêm tokens ou snapshots.

Não há exclusão definitiva exposta. Arquivar suspende leitura e mídia publicada.
Restaurar preserva o rascunho e não republica automaticamente. Revisões antigas e
arquivos referenciados permanecem preservados; esta entrega não introduz expurgo.

### Alias estável e sugestões de categoria

Create e save de rascunho reservam `pages.slug` na mesma transação de revisão,
auditoria e recibo, usando o título validado (inclusive o título real do modelo).
Título vazio mantém alias nulo. A base normalizada ASCII tem até 80 caracteres;
colisão usa `base-UUIDsemHifens` (até 113). Alias existente nunca muda ao renomear.
Não há slug fornecido pelo cliente, backfill ou reserva por leitura/publicação.
Ordem de locks: requisição → página (ou INSERT próprio) → advisory transacional
`pages-alias:<base>`. Ambos os candidatos são consultados sob esse lock, sem lock
na página concorrente. Sufixo ocupado retorna `409 slug_conflict`; uma corrida
entre bases distintas encontra o índice único como última defesa, faz rollback
completo e retorna o mesmo conflito, sem retry cego na transação abortada.

Workspace e novos ACKs retornam `slug` nullable. Replay devolve o recibo original
sem reservar alias; recibos antigos podem omitir o campo e não apagam o slug do
estado do editor. A baseline e o pending imutável continuam independentes desses
metadados confirmados. Nenhuma URL é adivinhada a partir do título no cliente.

`GET /api/pages/by-slug/:slug` é autenticado e passa pelo gate de Ética. Aceita
somente o formato ASCII persistido (1–120 caracteres), retorna o mesmo DTO da
leitura por UUID, incluindo slug, e aplica a mesma query de publicação/cargo ativo/
conta atual. Ausência, rascunho, arquivo e audiência externa resultam em 404 sem
lookup público preliminar. Admin sem cargo elegível não recebe acesso universal.
Não acrescenta redirect nem mídia pública. A rota amigável de shell é descrita abaixo.

### URL amigável no shell

`/conteudos/<slug>` aceita somente o alias persistido ASCII minúsculo/numérico,
com hífens simples e 1–120 caracteres. O router usa `/pages.html` para tabela,
import e fetch do template, mas conserva pathname/query/hash reais no histórico
e na visita. O app chama `readSlug`, nunca adivinha UUID/alias a partir do título
nem transforma query de prévia em bypass da leitura. URLs antigas por UUID e
prévia explícita continuam suportadas. Links de catálogo, gestão e retorno são
root-relative; o catálogo atual sem slug no DTO conserva o fallback por UUID.

`pages.html` declara `<base href="/">` antes dos assets. Entrada por SPA desde um
dashboard sem base acrescenta uma base self ao documento persistente, conservada
por sua vida restante: removê-la na saída causaria pedidos relativos errados no
Back nativo antes de `popstate`. O router respeita a base dos links e usa a URL
real para fragmentos locais deslocados por ela. Não modifica o gerador de shell.

Login e Ética mantêm `next` com query/hash. Destinos externos, credenciais na URL,
loops, API/uploads, announcements, dotdot, controles e separadores codificados
são recusados; fallback é `/dashboard.html`. Autorização, gate de Ética e guardas
de sessão/navegação continuam independentes do alias.

Nginx serve somente o shell pela regex quoted e restrita de `/conteudos/`.
Um prefixo normal (sem `^~`) responde 404 aos inválidos/segmentos extras, em vez
de cair no index global. Alias ausente ainda recebe shell público, seguido de
404 autenticado uniforme da API. `/api` e `/uploads` mantêm seus proxies/guardas.

`tests/visual/check-pages-friendly-route.mjs` usa Chrome isolado e API/SQL reais
em PGlite serializado, identidades sintéticas e bloqueio de rede externa. Confere
visita direta primeiro, refresh, fragmentos sem refetch, entrada SPA desde dashboard,
assets, editor/retorno, Back/Forward, login→Ética→alias, erro/retry, contas externas,
sem cargo/cargo inativo, admin/super sem audiência e troca de conta com read pendente.
O servidor estático desse check **simula** somente o shell Nginx; não comprova
`nginx -t` nativo. Esse gate continua **PENDENTE** localmente no Windows, sem
binário Linux autorizado. O job CI nativo existente permanece inalterado.

`GET /api/pages/categories?limit=50&offset=0&q=` exige editor/publicador e retorna
array de strings com `X-Total-Count`. Sugestões são categorias distintas não vazias
dos heads de rascunho não arquivados: apenas autoria própria para editor, todas as
autorias revisáveis para publicador. Busca case-insensitive e paginação usam SQL
parametrizado; `q` tem até 80 caracteres. Categoria continua livre, revisionada e
limitada a 80 caracteres, sem catálogo obrigatório nem efeito sobre audiência.

`tests/database/check-pages-v3.mjs` inclui aliases/categorias por SQL/HTTP reais,
rollback de auditoria/índice único e replay após rename. A corrida de unicidade é
injetada deterministicamente por trigger, **não** evidência de concorrência.
PGlite serializado não substitui duas conexões em PostgreSQL 16 descartável;
esse gate continua **PENDENTE**, sem cluster autorizado ou serviço iniciado.

### Gate de novas revisões v3

`PAGES_V3_WRITES_ENABLED` é `false` por padrão no ambiente/Compose. Apenas o valor
de ambiente literal `true` (ou a opção booleana `true` do router) habilita novas
revisões v3. O workspace informa `document_support` com `read_versions: [1,2,3]`
e `write_versions: [1,2]` ou `[1,2,3]`, sem alterar as capacidades reais. O catálogo
continua um array; cada modelo declara seu schema efetivamente gerado. Comunicado
permanece v1 e Owner News v2. `guia-interno@1` gera v3 e só é anunciado quando o
writer está explicitamente habilitado. A receita de produção aloca UUIDs novos,
não importa fixtures, começa sem audiência/mídia e informa que é ilustrativa,
não uma política oficial. Create com o gate desligado retorna
`409 document_version_disabled`; replay autorizado de create já confirmado continua
idempotente, sem nova página/revisão/auditoria.

Sob o mesmo lock/transação, replay reautoriza o ator e confere o hash antes do
gate: retry de uma revisão já confirmada continua retornando o ACK original com
o writer desligado. Novas revisões v3 retornam `409 document_version_disabled`;
head v3 recusa downgrade para v1/v2 com `409 schema_downgrade_conflict`. Essas
recusas não inserem revisão, projeções, auditoria ou recibo. Publicar uma revisão
v3 já salva continua possível com validação integral e audiência ativa, mesmo
com o writer desligado; arquivar/restaurar não converte o snapshot nem republica.

O estado do editor mantém o documento recebido sem upgrade implícito e expõe
`editable`/`editingUnavailableReason` para a futura UI somente leitura. Metadados
de suporte não substituem o documento nem o pending; a fotografia pendente é
profundamente imutável e pode reconciliar ACK mesmo após desabilitar o writer.
O ACK só avança a baseline enviada, preservando alterações posteriores. Não se
habilita um novo writer visual nesta etapa.

As referências tipadas de imagem/GIF/áudio/vídeo, cada item de galeria e cada ação
de download são verificadas contra mídia registrada da **mesma página e kind**.
Placeholders nulos não projetam IDs; IDs repetidos geram uma só associação por
revisão. Duração de legendas e quotas históricas de 50 arquivos/100 MiB permanecem.
`tests/database/check-pages-v3.mjs` prova esses contratos por rotas, uploads e SQL
reais em PGlite, incluindo rollback de auditoria e perda de ACK após COMMIT real.
Usa as mesmas variáveis externas de PGlite/FFmpeg dos checks existentes. Isto não
substitui os gates de PostgreSQL 16 nativo, concorrência entre processos, restore
ou prévia visual aprovada: permanecem **PENDENTES** antes de qualquer rollout.

## Capacidades e audiência

`editPages` e `publishPages` são novas capacidades normalizadas, falsas por padrão,
não novos roles. Mantêm o requisito atual de `role=admin` e a herança de capacidade
do superadministrador. A concessão continua no fluxo administrativo existente,
sem backfill ou alteração de permissões reais durante o desenvolvimento.

- Editor cria e altera somente páginas de sua própria autoria, inclusive quando
  é superadministrador. Envia mídia apenas para essas páginas.
- Publicador pode listar/revisar rascunhos e publicar/arquivar/restaurar páginas.
  Essa capacidade não permite alterar o conteúdo de outra autoria.
- Um publicador pode publicar sua própria página; não existe aprovação obrigatória
  por segunda pessoa ou estado adicional de workflow.
- Leitura normal, inclusive para administradores, exige audiência da publicação.
  Prévia administrativa é uma operação explícita diferente.

A audiência inicial é restrita por cargo. Seleções pertencem à revisão e não
mudam com o rascunho seguinte. A publicação exige seleção válida com cargo ativo;
leitura exige o cargo atual ativo do usuário na seleção publicada. Cargo ausente
ou inativo não vira audiência geral. Renomear cargos não altera seus IDs e excluir
um cargo referenciado é restrito. Prévia de rascunho é exclusiva do autor autorizado
ou publicador. Um catálogo mínimo de cargos pertence ao próprio módulo, sem abrir
o endpoint administrativo de usuários.

## Mídia privada

Imagens pertencem a uma página, em subdiretório privado próprio `pages-private`.
Não são armazenadas como fotos públicas na raiz de `/uploads`. O backend não
busca URLs arbitrárias nem aceita SVG/iframe/script como conteúdo incorporado.

JPEG, PNG e WebP devem ser decodificados, limitados a 5 MiB/20 megapixels/quadro
único, sem upscale, com dimensão máxima de saída de 2400 px e normalização WebP
sem metadados. Multipart tem margem de transporte acima do limite exato do arquivo.
Os limites de imagem não alteram o normalizador compartilhado de foto de perfil.

Leitores recebem bytes somente quando a mídia integra a publicação autorizada.
Uma referência histórica não concede acesso de leitura normal. Prévia de revisão
requer autor/publicador autorizado; mídia ainda não referenciada só pode ser vista
no contexto explícito de edição da própria página. O uploader isoladamente não é
uma permissão de acesso global. Respostas são `private, no-store` e `nosniff`.

O frontend faz fetch autenticado e usa object URLs com descarte. Não inclui tokens
em URLs. A imagem anterior permanece após falha de substituição. Quotas e limite
de quantidade consideram também a mídia histórica registrada. Não há remoção de
arquivo referenciado por qualquer revisão preservada.

Filesystem e banco não são uma transação única: uma falha antes de commit pode
ter compensação, mas erro ambíguo de COMMIT nunca autoriza apagar o arquivo, pois
a linha pode ter sido persistida. Órfãos de crash exigem inspeção/retensão própria
futura, sem alcançar outros módulos ou bytes históricos.

No primeiro lote, GIF, áudio e vídeo não estavam habilitados. A expansão implementa
validação própria de frames/codecs/duração, acessibilidade, quotas e reprodução.
Download completo autenticado por blob não é streaming; não se promete HLS ou
provider externo privado. MP3/MP4 são preservados após validação, sem promessa de
remoção de metadados; imagem estática e GIF são normalizados.

## Frontend e ciclo de vida

`pages.html` serve catálogo/leitura/gestão; `page-editor.html` serve edição. Ambos
entram no router e no shell gerado. O renderer de conteúdo é compartilhado pela
prévia e leitura, sem renderer por modelo. A largura do container da prévia mobile
controla o reflow; não se simula celular apenas reduzindo visualmente um desktop.

ProseMirror é responsável pelo DOM do texto editável, com schema restrito. Não é
o mecanismo de layout da página. Dependências do editor são locais, fixadas por
lockfile, com bundle gerado reproduzível e avisos de licença; sem CDN ou migração
de framework. SortableJS entra no lote de composição, fixado e incluído no mesmo bundle local.

Salvamento inicial é explícito. A baseline só avança após confirmação do servidor
e somente para a fotografia enviada. Digitação posterior continua dirty. Falha,
conflito e operação com resposta incerta não anunciam publicação ou salvamento.
Não há promessa de recuperação offline ou armazenamento editorial em localStorage.

Guardas protegem alterações, gravação e upload, incluindo Back/Forward e logout.
Descarte cancela recursos, listeners, popovers, observers, editores e blobs. Respostas
tardias não podem atualizar outra visita ou identidade. Prévia não perde o rascunho.
Controles têm foco visível, alvo mínimo de 44 px, Escape/retorno de foco e respeito
a movimento reduzido. Ações não dependem de hover; opções ficam contextuais.

## Validação reproduzível e limites de evidência

### Consolidação funcional de referência (Task 17)

A [matriz de evidências](../reviews/2026-11-11-pages-reference-fidelity.md) distingue
checks locais PASS, gates PENDING e lacunas BLOCKED. A sequência adicional
`tests/visual/check-pages-feature-roundtrip.mjs` também roda dentro de
`check-pages-v2.mjs`. Usa `featureDocument` inteiro, registra bytes privados reais
no harness e exercita os controles existentes, SQL, reload, prévia, revisão exata,
leitor por cargo e isolamento do rascunho posterior. O helper de teste
`pagesFeatureDocument` não é receita de produção. `referenceDocument` continua
reservado ao estado visual das pranchas, sem CSS que esconda blocos funcionais.
O teste mobile de foreground também usa as cinco seções funcionais completas.

Erros de save 400/403/404/409/413 e timeout de transporte são injetados em visitas
independentes; texto dirty e head SQL permanecem. O check de banco confirma 413
real do parser, referências de outra página rejeitadas, catálogo publicado sem
rascunho alheio, storage ausente e COMMIT confirmado sem ACK. As respostas 404
de `/uploads` no harness provam somente sua superfície Express sem mount público;
não substituem a configuração efetiva de Nginx. A identidade Firebase é substituída;
middleware de conta/Ética/capacidades, rotas e SQL continuam reais.

O formulário contextual do botão oferece rótulo, preset e destinos seção/URL,
download e vídeo. `editor-destinations.js` mantém os controles no inspector existente.
Download/vídeo são escolhas locais até **Aplicar destino**: só um candidato válido
altera o documento, com opt-in v3 e uma entrada de histórico. Abrir/escolher/cancelar
ou aplicar dados inválidos não converte o legado. A escrita v3 continua default off.

O workspace entrega `media: [{id, kind}]` somente a quem já tem `mayEdit` da página,
sem storage keys ou paths; leitores de revisão recebem lista vazia. A consulta usa
o registro `page_media` da própria página, inclusive uploads históricos ou ainda
sem colocação. ACK confirmado da visita atual acrescenta ID/kind ao inventário;
undo não apaga arquivos. Downloads selecionam esse registro, com tipo derivado,
nome de até 120 caracteres, basename não vazio, sem controles/separadores de caminho
e extensão exata `.webp`, `.gif`, `.mp3` ou `.mp4`. A API revalida autoria/referências.

Vídeo seleciona somente IDs de blocos `video`/`video_embed` do documento atual.
Alvos ausentes/incompatíveis são informados, e a exclusão direta de vídeo referenciado
pede trocar o destino antes. O botão YouTube foca o consentimento existente sem
montar iframe. Aplicação usa guardas de permissão, IME, operação pendente e descarte;
controles de visita anterior não modificam a atual. O teste integrado cria ambos
os botões e aplica os destinos pela UI, verifica JSON/SQL após salvar/recarregar e
exercita download autenticado e foco de consentimento na prévia e no leitor.

#### Rollback compatível e privacidade

Habilitar o writer requer leitores/validadores v3 e migration 042 disponíveis antes
da primeira gravação v3. Desligar `PAGES_V3_WRITES_ENABLED` suspende novas revisões,
mantém leitura, publicação de revisões já salvas e reconciliação idempotente. Não
reverte snapshots, apaga mídia ou permite downgrade por clientes antigos. Após
existirem revisões v3, rollback de aplicação deve conservar leitor v3 e 042; voltar
a uma release exclusivamente v1/v2 não é compatível. Restore nativo é gate separado,
não consequência de um teste em PGlite. Nenhum script/receptor de deploy foi alterado
pela Task 17; o histórico de deploy abaixo permanece um registro de sua própria data.

Downloads suportam somente imagem JPEG/PNG/WebP normalizada, GIF, MP3 e MP4 privados
já validados; não há suporte genérico a PDF/Office. Todas as referências de galeria
e download pertencem à mesma página e revisão autorizada. YouTube é externo e não
se torna privado pelo login; não há request de player/thumbnail antes do clique de
consentimento. Checklist de revisão é pessoal, local à sessão, opcional e não é
enviado ao backend. Nenhum desses recursos amplia autoria ou audiência por cargo.

### Renderer compartilhado v3 (Task 10)

`renderDocument` continua retornando cleanup e não converte revisões v1/v2.
`renderV3Block(block, context) -> {node, refresh, dispose}` recebe `richNode`,
`imageFigure` e `mediaFigure` por contexto, sem import circular. Galeria conserva
ordem/identidade por ID, resolve o item atual a cada refresh, aborta substituições
e revoga blobs tardios/removidos. GIF exige iniciar/parar explícitos. FAQ usa
`details/summary` independentes; expansão é somente DOM, sem salvar documento.

YouTube não monta iframe, thumbnail ou preconnect antes do clique no próprio
aviso de conexão externa. Uma ação de botão apenas foca esse aviso. A URL é
construída somente com provider/ID validado no host `youtube-nocookie.com`, sem
autoplay. Descarregar/cleanup remove `src` e iframe. Autenticação do Portal não
torna o vídeo externo privado; a validação local usa stub pós-clique, não player
ao vivo. Placeholders de mídia/galeria/FAQ são exclusivos de edição/prévia.

O painter v3 usa `resolveAppearance` para texto, header, pares internos de
callout/botão e captions/créditos (14 px normal). O part `link` centraliza a mesma
precedência usada pelo gate AA; `text_color` explícito ganha do link. Captions de
estilo legado continuam `#6C706D`, mesmo quando esse par reprova uma nova publicação
v3: não há correção silenciosa. Ícones são SVGs locais de vocabulário fechado e
tags continuam texto. `applyBlockStyle(node, block, doc?)` mantém a chamada antiga.

`aside_right` reserva 260 px e gap 20 px; container queries empilham as duas
composições v3 pela superfície, inclusive em prévia estreita sobre desktop.
Seções vazias conservam âncora sem caixa/altura adicional, sem exceção por fixture.
Este lote não adiciona authoring de novos blocos/marcas nem conclui o workspace:
essas interfaces permanecem nas Tasks 12/13/14.

`tests/visual/check-pages-renderer-v3.mjs` confere renderer/API privada reais,
PGlite serializado e Chrome, usando somente contas sintéticas/loopback próprios.
Inclui geometria de 180/390/1044 px, editor existente com blocos/marcas já suportados,
FAQ por teclado, captions computadas/AA, URLs amigáveis, descarte e regressões
v1/v2. PostgreSQL 16, Firebase/Nginx nativos e aceite visual final continuam
**PENDENTES**, não demonstrados pelo teste.

### Inserção e organização do editor (Task 11)

`composition.js` expõe comandos puros `insertAt`, `insertColumns`,
`reorderSection` e `setBlockWidth`, retornando documento ou `null` em alvo inválido,
limite/no-op. Inserção valida índices inteiros, IDs de todo o grafo (incluindo
itens FAQ/galeria), marcas/destinos e orçamentos agregados. Duplicação conserva
referências de mídia/destinos, mas gera IDs novos para bloco e itens. Texto/imagem
legados continuam v1; composição legada continua v2. `aside_right` usa `editV3`,
duas colunas reais e exige suporte de escrita 3 **antes** de converter na UI.
O writer permanece desligado por padrão. Full confirma merge esquerda→direita;
cancelamento não altera o rascunho/histórico. Half cria duas colunas quando preciso.
Todo candidato estrutural é validado **depois** da conversão de versão/layout:
novos bytes ou a contagem v3 de links não podem produzir uma edição insalvável.
Recusa mantém documento/versão/histórico e restaura o valor do controle de largura.

`editor-insert.js` exporta `openInsertPanel`, `insertionPoint` e
`resolveInsertionPoint`. O painel captura IDs de seção/linha/coluna e âncora de
bloco antes/depois, sem reconsultar seleção após await. Novo grupo de duas colunas
não converte a linha selecionada. Colunas vazias têm destino explícito. Upload
continua no pipeline existente e só insere referência após ACK; âncora removida
retém o arquivo enviado para escolha explícita de outro destino, sem reenviar bytes
ou alegar rollback físico. Arquivo aguardando destino também impede arquivamento e
exige confirmação explícita ao recarregar, mesmo com rascunho limpo; cancelar
preserva o handle, e aceitar abandona apenas a colocação local, não os bytes enviados.
O catálogo tem sete grupos, escolha real destaque/botão,
busca sem acentos e FAQ/separador em Outros blocos. FAQ/galeria novos são apenas
rascunhos vazios v3, com indisponibilidade da autoria de itens declarada; edição
completa permanece na Task 12. Conteúdo existente usa o renderer compartilhado.
Busca e clique mantêm `aria-expanded` sincronizado com a visibilidade dessa escolha,
com `aria-controls` apontando para o grupo real de opções.

A estrutura recebe a fábrica Sortable por injeção, move seções por UUID e oferece
Subir/Descer e Alt+setas. Drop inválido/Escape restaura a ordem e os recursos são
descartados com o workspace. Todas as mudanças usam a timeline existente; PM
permanece identificado por bloco. `tests/visual/check-pages-insertion.mjs` usa
Chrome, rotas/SQL reais em PGlite serializado e contas sintéticas, com rede externa
bloqueada e listeners loopback próprios. O teste de arraste/ponteiro em 50/100/150%
agora usa o controle real de zoom da Task 14, mantendo a estrutura lateral sem
escala; confere também Escape e comandos por teclado. PostgreSQL/Firebase/Nginx
nativos continuam gates separados pendentes.

### Autoria de mídia e FAQ (Task 12)

`editor-media.js` expõe `createBlockFields({page,block,resolveBlock,transact,upload,
onFocus,createRichEditor,...bindings}) -> {node,refresh,dispose}`. O coordenador
continua dono do documento, da timeline e do pipeline de upload. `node` contém os
campos contextuais de mídia/galeria; em FAQ contém os campos nativos e as respostas
PM reais no canvas, sem cópia no inspector. `refresh(bookmark?)` reconcilia por
IDs; `dispose()` destrói apenas os recursos locais. Remover itens/referências e
undo não excluem arquivos do servidor.

Bindings exatos para consumidores posteriores: `bindNative(control,sync,
unavailable?,retained?)`, `nativeMeta(event)`, `canEdit()`, `canAct()` (ações
estruturais/picker também respeitam IME), `richOptions` (bridge global, limites,
composição, permissões, `onSelection(itemId)`), `registerEditor(itemId,editor)`,
`unregisterEditor(itemId)`, `onSource(blockId)` e `onChange()` para refresh do
renderer/guardas. `onFocus(itemId?)` seleciona o item verdadeiro. `transact(meta,
change)` recebe o documento clonado atual e retorna boolean; handlers resolvem
bloco/item por ID, nunca conservam o objeto de uma revisão anterior.

`upload(files,target)` recebe `File[]` e alvo imutável: galeria usa
`{target:'gallery',blockId,expectedKind:'image'}`; substituição usa
`{target:'replace',blockId,itemId?,sourceType,expectedKind}`. O único pipeline
serializa arquivos por página, conserva cada ACK e sua referência antes de enviar
o próximo. Falha conserva os itens anteriores, o arquivo/chave atual e os próximos
arquivos para retry explícito; não reenvia automaticamente COMMIT incerto. Cancelar
abandona apenas a fila local. Alvo removido após ACK reutiliza a recuperação de
colocação existente, sem reenviar bytes nem anexar silenciosamente a outra coluna;
os próximos arquivos não são enviados e precisam ser selecionados novamente após
resolver esse destino. Quotas históricas de 50 arquivos/100 MiB e validação de
bytes continuam na API existente. Limite local de 50 itens e budgets finais são
conferidos antes de gravar referências. Perda de suporte durante upload mantém o
ACK para recuperação, sem alterar um documento indisponível.

Pickers nomeados usam `audio/mpeg,.mp3`, `video/mp4,.mp4` e os MIME de imagem/GIF
suportados. MIME errado não é tratado como upload pronto. Replace só altera o
`media_id` após ACK; caption/alt/credit e IDs sobrevivem à troca, reorder, histórico
e save/reload. Controles descartados, mesmo com IDs repetidos numa nova visita,
não podem enviar arquivos nem modificar o documento atual.

FAQ tem perguntas nativas de até 200 caracteres com guardas/IME e EditorViews de
resposta keyed por `blockId:itemId`. Formatação contextual e bookmarks
`{blockId,itemId,from,to}` apontam para a resposta focada, compartilhando a timeline
global. Reorder conserva a view; remoção destrói somente a view removida e undo
restaura documento/seleção sem recriar as demais.

`parseYouTubeURL(input)` em `document-v3.js` retorna somente
`{provider:'youtube',video_id}` ou `null`: HTTPS, hosts exatos, watch/shorts/embed
ou youtu.be, ID exato de 11 caracteres, sem credenciais/portas não padrão/iframe.
Tracking não é persistido. A escolha explícita entre link incorporado e MP4 privado
mantém o formulário local até ID válido ou ACK; cancelar não muda a fonte. Troca
preserva o ID do bloco, tem undo e nunca apaga bytes históricos. Aviso de terceiro
explica que login do Portal não torna YouTube privado. Player/thumbnail não são
carregados pelo formulário; leitura/prévia reutilizam o consentimento da Task 10.
Novas ações v3 conferem `write_versions` antes do upgrade; writer segue default off.

O schema PM agora abre/edita marcas v3 já armazenadas `text_color`/`highlight` com
hex normalizado e atributos DOM próprios `data-pages-text_color`/
`data-pages-highlight`. Paste com valor inválido não cria marca; transação com
marca v3 em documento legado é recusada. Não há color picker novo (Task 13).

`tests/visual/check-pages-editor-media.mjs` executa Chrome, PM, SQL/HTTP e bytes
privados reais em PGlite serializado, com identidades sintéticas e somente loopback
próprio. Exercita autoria→save→reload→prévia→publicação/leitor por cargo, partial
upload/retry após COMMIT real perdido, replace/cancel, FAQ/IME/foco/identidade,
tipos privados, captions e descarte por troca de conta. Rede externa é bloqueada;
não comprova player YouTube ao vivo, Auth real, PostgreSQL/Nginx nativos ou aceite
visual final da Task 14.

### Estilo e inspetor contextual (Task 13)

`editor-style.js` mantém o formulário local separado do coordenador. Exporta
`openStylePanel({page,anchor,document,onApply,canAct,available,bindNative,onLegacy})`
→ `{close,dialog}` e `createInspector({document,block,onAppearance,onReset,onTags,onWidth,
onAdvanced,canAct,available,bindNative,nativeMeta})` → `{node,blockId,dispose}`.
`onApply(defaults)` recebe os sete defaults completos e válidos; retornar `false`
mantém o painel aberto. Abrir, cancelar, Escape ou aplicar sem mudança não converte
o documento nem cria histórico. Tema/Tipografia/Cores têm navegação por setas,
Home/End e foco visível. Paletas e hex afetam propriedades persistidas reais;
abrir uma paleta não troca silenciosamente o branco existente por sua amostra.

`onAppearance(patch)` usa `null` por propriedade para remover somente o override
explícito, sem remover `style` legado. Nesses blocos, a opção diz “Remover ajuste
(manter estilo legado)”; nos blocos sem pin, o mesmo reset herda normalmente o padrão
da página. A ação avançada separada `onReset()` remove `style` e `appearance` de forma
atômica e avisa explicitamente que substitui cores e tipografia legadas. Pares internos
de callout/botão nunca são copiados para representar cores do wrapper externo.
Imagem, GIF e galeria mostram Tamanho desabilitado/não aplicável na posição original;
suas legendas continuam em 14 px pelo contrato do renderer. Tags de bloco
não alteram `metadata.tags`; ícone genérico não altera `callout.icon`. Campos inválidos
são recusados/restaurados. Largura e composição reutilizam comandos limitados e a
confirmação de merge. Opções avançadas adotam mover/duplicar/excluir/destino e os
presets legados existentes. O bulk legado continua alterando apenas blocos existentes,
sem criar herança em documentos v2. Writer v3 indisponível desabilita apenas os novos
controles; documento v3 sem escrita suportada permanece realmente somente leitura.

`styleCandidate(document,change)` é puro: usa opt-in v3 e a contagem estrutural
existente após conversão, incluindo limites agregados de marcas, links, tags e bytes.
O coordenador confere suporte/readonly/IME antes de chamá-lo e continua dono da única
timeline. Defaults não reescrevem overrides nem cores legadas. Canvas/prévia/leitor
consomem o painter, SVGs locais e resolução canônica de aparência; alertas AA usam
`appearanceIssues`, sem aprovação visual fictícia ou contorno do gate de publicação.

`openInlineColorPanel({page,anchor,mark,onApply,canAct,bindNative,contrast})` →
`{close,dialog}` edita apenas a seleção capturada em rich text ou resposta FAQ ativa.
`onApply(color|null)` aplica/remove a marca; `contrast(color)` fornece o aviso canônico.
`Editor.prepareColor(name,color|null,bookmark)` retorna `{content,beforeSelection,
selection}` ou `null`, sem despachar transação PM. Recusa seleção vazia/modificada,
cor inválida, view destruída/IME/no-op. O coordenador verifica identidade e conteúdo
do campo e confirma upgrade + marca em uma entrada global; depois sincroniza a
mesma EditorView e seleção. Não há histórico PM concorrente nem upgrade por cancelar.
Os hex de página e inline reconciliam somente seu draft local após o cleanup nativo
de `compositionend`, incluindo um `input` final emitido imediatamente na mesma tarefa.
A confirmação no documento continua bloqueada durante composição.

`tests/visual/check-pages-style.mjs` usa Chrome + SQL/HTTP reais em PGlite, identidade
sintética e rede externa bloqueada. Cobre cancel/reopen/save/reload, herança/override,
propriedades e merge, seleção rich/FAQ, undo atômico/identidade PM, rejeição HTTP AA,
IME CDP longo, controles retirados e writer desligado. Chrome final/mobile completo,
comparação das seis pranchas e gates nativos/IME físico permanecem separados.

### Workspace desktop e controles de sessão (Task 14)

O frame desktop tem header 72 px, barra 56 px e rails 220/280 px. Modelo é um
select real: escolher abre confirmação e cria **outra** página só depois da guarda
de saída. Cancelar/falhar conserva documento, URL e EditorViews. Chave incerta e
ACK já confirmado são retidos por modelo durante a visita; falha de navegação não
autoriza outro create. A confirmação de saída vale uma vez para a fotografia
exata; a guarda do shell verifica novamente qualquer mudança antes de sair.

`createEditorWorkspace` recebe `onUndo/onRedo/onModel/onDevice/onZoom`, oferece
`setHistory({canUndo,canRedo})` e `setViewport({device,zoom})`. Desktop usa a largura
disponível; celular tem **390 CSS px** reais. 50/75/100/125/150% transformam apenas
a superfície interna, com origem top-left e wrapper de scroll medido; toolbar e
inspetor são irmãos sem escala. Preview usa a mesma superfície. São controles de
sessão, não emulação física ou edição do JSON/tamanho de fonte. O espaço contextual
reserva a altura real da toolbar não escalada, inclusive em cards compactos a 50%,
sem sobrepor texto ou caret. A medição inclui scrollWidth/scrollHeight efetivos.
O container da superfície empilha também as linhas `two_equal` legadas em 390 px,
mesmo com navegador desktop largo; voltar ao desktop restaura as colunas sem
converter v2 para v3 nem recriar os EditorViews.

Salvar continua explícito, por ação quando dirty, propriedades da Página ou
Mod+S. `createPageButton` exige ACK real; `current:false` não exibe Salvo quando a
revisão enviada foi confirmada mas há edições posteriores. `resetConfirmation()`
restaura o estado sem apagar SVGs/listeners. FAQ usa disclosures sobre os campos
nativos e EditorViews keyed existentes, sem editor ou cópia de resposta paralelos.

A tipografia da receita Guia é delimitada ao modelo v3, sem `style` legado e com
scale standard: `typographyMetrics` é canônico para painter, labels e gate AA.
As fontes efetivas desktop incluem capa 36 px e corpo da introdução 15 px; o campo
Tamanho completo mostra essas métricas. Cada opção usa suas métricas prospectivas,
inclusive ao voltar de small/large ao standard do modelo. Presets explícitos e
documentos v1/v2 conservam suas métricas. Tags reais permanecem persistidas e
visíveis/editáveis no inspetor; o canvas de edição não duplica uma linha de badges.
O leitor/prévia mantém sua apresentação de tags. O wordmark compacto recorta o SVG
local, sem desenhar uma nova marca.

`tests/visual/check-pages-workspace.mjs` registra Chrome + SQL/HTTP em PGlite,
contas sintéticas e loopback isolado. Captura os três estados desktop e verifica
geometria, cinco zooms em desktop/mobile390 a 1366/1600, drag/caret, alvos por
teclado/toque simulado, JSON/EditorView estáveis,
create/retry/guarda, ACK honesto, readonly e restauração do Portal. A comparação
inclui asserções dos retângulos Estilo (360,118,400,663) e Inserir (24,118,380,621),
âncoras de introdução/cards/FAQ/áudio e densidade das perguntas recolhidas (2 px
de tolerância para métricas de texto). Ícones locais de prévia/publicação/dispositivo
são decorativos; os controles mantêm seus nomes acessíveis e ações reais. A comparação
final das seis pranchas (Task 18), PostgreSQL/Firebase/
Nginx nativos e IME/aparelho físico permanecem gates separados, não comprovados.

O runner workspace mantém a largura histórica da toolbar em modo
`node tests/visual/check-pages-workspace.mjs --strict-reference-geometry`.
Sem a flag, verifica largura não escalada contra a medição inicial e registra
divergências aprovadas em `results.json`/stderr; não declara fidelidade à prancha.
As demais âncoras de referência e asserções funcionais continuam ativas nos dois modos.

### Conteúdo compacto e ciclo mobile (Task 16)

Até 1099 px, o inspetor é um diálogo **não modal**: o mesmo texto/EditorView continua
editável no canvas. Conteúdo reúne B/I/U/Link, fonte/escala combinadas e o campo de
fundo compartilhado. Estilo recebe os controles adicionais reais da toolbar;
Posição mantém organização avançada. Nenhum documento ou editor paralelo é criado.
O combinado “Manrope · 16 px” descreve a **escala base**, com essa distinção no title
e aria-description; a receita adapta capa/introdução no telefone (28/19 px nos
títulos, 14 px no corpo). O controle completo preserva os labels prospectivos.
Alterar fonte/escala combinadas usa uma só transação guardada de aparência.
Os parágrafos mobile herdam o foreground canônico, incluindo o padrão da página
e substituições do bloco; não há cor de texto forçada apenas no editor.

Abaixo de 600 px, Blocos/Prévia/Publicar ficam juntos e os demais controles reais
passam ao menu. A folha de 389 px tem limite pela altura disponível; fechamento
e Concluir edição preservam dirty/texto e devolvem foco ao alvo ainda disponível.
O retorno confere a área visual e o recorte dos ancestrais, não só a existência de
um retângulo de layout. Se nenhum candidato está visível, `restoreVisibleFocus`
revela o alvo retido antes de focá-lo, ajustando também o offset do teclado.
Concluir não salva. A folha possui `watchVisualViewport` apenas enquanto aberta no
breakpoint compacto; resize/scroll consideram height/offsetTop e safe-area, com
remoção ao fechar, mudar breakpoint, navegar ou descartar a página. Painéis e
diálogos aninhados possuem seu próprio watcher enquanto abertos. Escape aninhado
fecha apenas o modal superior; Back e descarte também limpam os hooks.

`tests/visual/check-pages-mobile-reference.mjs` exige as mesmas instalações externas
de PGlite/Playwright/Axe e `PAGES_REFERENCE_DIR`; `MOBILE_VISUAL_OUTPUT` seleciona os
artefatos. O teste valida o hash original e âncoras 390×820, comandos reais, bytes
salvos, identidade PM, sete larguras, axe A/AA, rotação, viewport reduzida/offset e
safe-area simulados, diálogos aninhados e reflow equivalente a 200% (683×450).
Teclado/IME/toque físico e gesto de zoom nativo continuam pendentes; simulação não
é evidência desses gates. A API/SQL usa somente o harness loopback descartável.

### Revisão editável e snapshot conferido (Task 15)

`openReview({page,state,api,cargos,onChanged,onPublish,onIssue?,canAct?,opener?})` retorna
`{close,refresh}`. O coordenador chama `refresh()` em mudanças do estado e mantém
`canAct` vinculado à visita, operações exclusivas e uploads/colocações pendentes.
Título, categoria livre com sugestões autorizadas e audiência usam a mesma timeline
do editor. Categoria só converte v1/v2 em uma edição efetiva com writer v3 habilitado.
Publicador sem autoria pode expandir a audiência para conferência, mas seus campos
ficam disabled; publicar uma revisão existente não exige capacidade de editar.

`reviewSession(state)` conserva uma sessão por instância de estado, inclusive ao
fechar/reabrir o modal. `createReviewSession(state)` expõe a lógica pura testável.
O estado oferece `subscribe(listener) -> unsubscribe`; a sessão observa cada
mutação/save/ACK/upload durante a vida do estado, independentemente do DOM do modal.
Editar e desfazer, ou falhar/cancelar upload com o modal fechado, não recupera checks
anteriores. Essa invalidação conserva o payload congelado de publicação incerta.
Seu snapshot é `{version,revisionId,documentHash,checks}`; `documentHash` é o JSON
integral com chaves de objeto ordenadas como fingerprint local sem colisão, não
digest truncado; ordem de arrays permanece semântica. Conteúdo, versão,
revisão, uploads, conflito e falha invalidam a conferência. Os três checks são
opcionais, pessoais e nunca enviados/persistidos. Não são aprovação de outra pessoa
nem substituem validação local e do servidor. Salvar é explícito dentro do modal;
só o ACK muda a revisão exibida. Voltar, × e Escape conservam as edições dirty e
as guardas normais. A URL usa exclusivamente o slug confirmado ou `/pages.html?id=UUID`.

O modal verifica o workspace ao abrir/retomar foco e antes de uma nova publicação.
Head divergente bloqueia a revisão até recarga explícita; não é adotado silenciosamente.
CAS do servidor continua fechando a corrida após essa leitura. `onPublish(payload)`
recebe o objeto congelado exato `{expected_version,revision_id,client_mutation_id}`.
Falha ambígua retém esse payload através de fechar/reabrir e bloqueia novas edições,
save, histórico e arquivamento até retry explícito. Esse retry reconcilia o recibo
original sem um preflight que confundiria o CAS já consumido com conflito externo.
Validação de conteúdo/cargos atuais não bloqueia essa reconciliação exata; inclusive
um cargo desativado após COMMIT não impede recuperar o recibo. Falha de consulta
do catálogo também não impede o retry já pendente. Autorização do servidor e guardas
de operação/visita permanecem obrigatórias; publicação nova continua validada.
O preflight de publicação respeita a versão do documento. Em v3, respostas de FAQ
com texto contam como conteúdo, inclusive numa página composta somente por FAQ.
Galerias exigem itens, arquivo e texto alternativo por item; FAQ exige itens com
pergunta e resposta textual; vídeo incorporado exige título e transcrição. As
pendências identificam bloco (ordem do documento), item e campo numa lista visível,
além do tooltip e da descrição acessível da ação de publicação. A função canônica
`publicationIssueDetails(document,cargos)` retorna `{code,message,blockId?,itemId?,field?}`;
`publicationIssues` deriva apenas as mensagens e conserva as regras, agregação e ordem
legadas. `publicationIssueTarget` resolve IDs no documento atual; não infere campo
editável de um caminho de contraste. Corrigir fecha a revisão antes de `onIssue(issue)`
selecionar/focar título, público, bloco ou item existente. Destino removido antes do
clique mantém a revisão/mensagem; sem destino seguro, não há ação inventada. Autoria,
operações exclusivas e composição continuam guardadas. Cabeçalho/rodapé permanecem
acessíveis com corpo rolável e alvos reais de 44 px, inclusive a 320 px. Checks pessoais
têm legenda visível de opcionais/não registrados e não atribuem aprovação a terceiros.
`node tests/visual/check-pages-controls.mjs review` acrescenta cargos longos, teclado,
correções com SQL após save explícito, alvo removido, identidade PM e axe A/AA;
exige `AXE_MODULE_PATH` além das variáveis do runner. A geometria histórica de revisão
é comparada/classificada no runner amplo; `--strict-reference-geometry` preserva as
asserções exatas e não deve ser anunciado como PASS quando diverge intencionalmente.
Rascunhos incompletos continuam salváveis;
validação estrutural, propriedade/tipo de mídia e autorização final pertencem à API.
As regras de preflight v1/v2 e o bypass do recibo incerto permanecem preservados.
Saída/reload com publicação incerta exige a guarda de descarte; não há armazenamento
persistente de operações locais. Erro definitivo permite corrigir o documento;
409 ou acesso negado invalida a revisão. Nenhum campo de checklist chega ao backend.

`tests/visual/check-pages-review.mjs` usa Chrome, HTTP/SQL reais e PGlite serializado
em loopback próprio. Verifica edição/save/retry, payload exato, concorrência CAS,
publicador somente leitura, sugestões/cargos/alias e captura 1600×1160 com anchors
do manifest original. A revisão honesta mostra o ID confirmado e pendências reais
no lugar da frase de protótipo. Não constitui aceite das seis pranchas ou validação
de PostgreSQL/Firebase/Nginx nativos.

`tests/unit/pages-publication-preflight.test.mjs` compara o preflight com o validador
real para conteúdo v3 completo/incompleto e conserva os contratos legados.
`tests/visual/check-pages-publication-preflight.mjs` exercita autoria de FAQ sem
texto auxiliar, save/reload/revisão/publicação/leitor e bloqueio de galeria/FAQ/embed
incompletos antes de qualquer POST. Usa Chrome e HTTP/SQL reais no harness PGlite
serializado, identidade sintética e somente loopback próprio; não substitui os gates
nativos ou o aceite visual pendente.

### Timeline local do rascunho (Task 9)

`history.js` exporta `createDraftHistory({document,maxEntries=100,maxBytes=20971520})`.
`commit(document,{group,selection,beforeSelection,time,closeGroup,composing})` retorna
boolean; `undo()`/`redo()` retornam `{document,selection}` ou `null`. Snapshots e
bookmarks são cópias independentes. O limite conta transações e seus snapshots
serializados UTF-8, incluindo redo; remove as mais antigas e conserva pelo menos
uma transação, mesmo se ela exceder sozinha o orçamento. Nova edição corta redo.
`clear()` limpa a timeline sem alterar o documento atual; `closeGroup()` fecha
somente o agrupamento. Digitação no mesmo campo agrupa até 500 ms inclusive;
composição IME continua no mesmo grupo até o fim explícito. Blur, troca de bloco,
comandos estruturais/de formatação e save fecham grupos. No-op/cancelamento não
criam entrada; exceção em `transact` não altera a cópia de trabalho.

`createEditorState` é a autoridade única: `transact(meta,change)`, `undo()`,
`redo()`, `canUndo`, `canRedo`, `selection`, `closeHistoryGroup()`. `change` recebe
uma cópia e pode cancelar com `false`/`null`. `changed()`/`replace()` continuam
compatíveis, com before independente para callers legados que já mutaram o objeto.
Nenhuma entrada contém workspace, permissões, versões CAS, pending ou bytes de mídia.
Undo é local: não desfaz publicação, grants ou upload físico, apenas referências.
Saving, uploads, conflito, IME ativo e operações/ambiguidades de upload do editor
bloqueiam navegação da timeline. Edição posterior durante save continua permitida;
falha ambígua permite undo/nova edição, sem modificar o pending congelado nem
habilitar publicação antes de reconciliar o ACK original. Save/ACK não são entradas
e nunca limpam o histórico. Undo pós-save fica dirty até retornar à baseline ou
obter novo ACK explícito.

Após ACK real de v3 (inclusive retry idempotente), o estado conserva um piso de
formato 3 fora dos snapshots. Undo de entrada v1/v2 restaura seu conteúdo por
`upgradeDocument`, sem enviar downgrade do head. Antes desse ACK, undo restaura
o JSON legado exato. Piso não altera pending, versão, slug ou suporte confirmado.

`createRichEditor` integrado recebe `historyCommands:{undo,redo}` e não instala
`history()` paralelo. Atalhos, toolbar existente e recuperação de exclusão usam
a mesma timeline. Sem bridge, mantém fallback ProseMirror local. `bookmark()` e
os metadados before/after de `onChange(content,meta)` usam
`{blockId,itemId?,from,to}`; metadados não textuais usam `null`.
`sync(content,bookmark)` aplica transação silenciosa, clampa seleção e mantém o
EditorView, sem feedback de conteúdo ou sincronização durante IME. Callbacks
resolvem blocos pelo ID na cópia atual. `mark(name,attrs)` aceita atributos de
marcas já existentes e recusa marcas desconhecidas; não antecipa a UI da Task 13.

Campos nativos também rastreiam IME e bloqueiam undo até o fim explícito, inclusive
em composições acima de 500 ms. Durante upload, resultado de upload incerto,
operação exclusiva, conflito ou writer indisponível, campos de conteúdo ficam
desabilitados e eventos sintéticos rejeitados restauram o valor do rascunho.
Salvar ordinário em voo continua permitindo edições posteriores. Enter (inclusive
fallback de parágrafo), Shift-Enter, indent/outdent de listas e comandos estruturais
do keymap base têm limites próprios na timeline, separados da digitação adjacente.

`node tests/visual/check-pages-history.mjs` usa as instalações externas de PGlite e
Playwright (`PGLITE_MODULE_PATH`, `PLAYWRIGHT_MODULE_PATH`), Chrome e listeners
loopback próprios, com identidade sintética e rede externa bloqueada. Confere a
UI/PM real, persistência/reload, perda de ACK após COMMIT, CAS, upload privado e
IME real via CDP. A superfície mínima de FAQ testa somente o contrato de bookmark
por item, sem introduzir UI de FAQ antes da Task 12. Não substitui PostgreSQL 16,
concorrência nativa, Firebase/Nginx reais ou aceite visual final da Task 14.

Executar `npm run build:public`, o check read-only do bundle, os testes focados,
`npm run verify`, o check do shell gerado e `git diff --check`.

`tests/database/check-pages.mjs` usa PostgreSQL WASM efêmero, Express, rotas, arquivos
privados e middleware reais. Substitui apenas a identidade Firebase por contas
sintéticas. Requer `PGLITE_MODULE_PATH` instalado fora do projeto. Não acessa banco
remoto, não inicia Docker e não usa credenciais. Não prova paralelismo de processos,
PostgreSQL 16 nativo, Firebase real ou Nginx efetivo.

`tests/visual/check-pages.mjs` exercita o frontend real no Chrome contra esse backend
descartável. Requer também `PLAYWRIGHT_MODULE_PATH` e `AXE_MODULE_PATH` externos.
Confere o fluxo de edição/publicação, revisão isolada, navegação, teclado e reflow
em 360, 402, 768, 1366 e 1920 px. Evidências são locais e explicitamente sintéticas.
Não equivalem a aceite em aparelho físico ou produção.

Migrations fresh/upgrade/bootstrap, grants reais e readiness continuam com o harness
PostgreSQL descartável do repositório. Aplicação de migrations em ambiente existente,
concessão de permissões, publicação, merge e deploy não são efeitos do desenvolvimento.

O protótipo privado, as pranchas Pencil e o kit de assets não foram confirmados na
inspeção inicial. Nenhum arquivo sem licença/proveniência verificada deve ser
incorporado como substituto. A marca e Manrope existentes continuam sendo a fonte
visual. Fotografia de banco, se aprovada depois, deve permanecer ilustrativa.

### Evidência local do primeiro lote

- Verificador de banco: 75 verificações HTTP aprovadas, executando migration,
  consultas/transações, normalização e entrega de imagem privada reais em PGlite.
  Inclui repetição sem duplicar auditoria, CAS, rollback por falha da auditoria,
  restrição por cargo, referências históricas, arquivamento/restauração, grants e
  aceite de Ética. As identidades Firebase são sintéticas e as conexões de teste
  são serializadas; isso não comprova concorrência nativa entre processos.
- Verificador Chrome ampliado: 12 cenários aprovados, incluindo seleção/formatação
  de texto por teclado, upload e prévia real de imagem privada, prévia mobile,
  salvar sem alterar publicação, confirmação de publicação, duplo clique, edição
  durante save, falha/retry, duas sessões e navegação nativa por fragmento durante
  edição/upload e perda da resposta de um save realmente confirmado pelo servidor,
  com reconciliação idempotente antes de habilitar publicação. Editor e leitor
  passaram no axe WCAG A/AA e reflow em 360, 402,
  768, 1366 e 1920 px; nenhum erro JavaScript registrado.
- Os dois problemas encontrados pela revisão independente — remontagem por hash
  e confirmação indevida de save com resultado incerto — recebem regressões
  específicas. O resultado de teste é local, não autorização de publicação.
- O bundle local e os avisos de licença passam no check reproduzível read-only.
  Shell gerado e `git diff --check` também foram conferidos.
- Verificação integrada final: `npm run verify` com 880 aprovados, zero falhas e
  dois skips específicos de Linux no Windows. A auditoria de dependências de
  produção de API/cron retornou zero vulnerabilidades no escopo configurado.
- Revisão independente após as correções: `ship`, sem achados pendentes. Nenhum
  commit, merge, deploy ou concessão de permissões reais foi realizado.

Para repetir os verificadores, defina `PGLITE_MODULE_PATH` com o arquivo de entrada
da instalação externa de `@electric-sql/pglite`. Execute
`node tests/database/check-pages.mjs`. Para o navegador, defina também
`PLAYWRIGHT_MODULE_PATH` e `AXE_MODULE_PATH` com as entradas externas de Playwright
e `@axe-core/playwright`, e execute `node tests/visual/check-pages.mjs`. Os scripts
criam e encerram seu próprio backend loopback e banco em memória, limpando somente
o diretório temporário exclusivo criado por eles. `VISUAL_OUTPUT` escolhe o local
das capturas e do `results.json`; o padrão fica na pasta temporária `opencode/pages-editor`.

## Expansão até piloto — decisões de implementação

Em 10/11/2026, o usuário autorizou desenvolver composição, mídias e piloto.
O plano executável está em
`docs/superpowers/plans/2026-11-10-pages-pilot.md`. Esta seção registra decisões;
não converte recursos planejados em evidência de conclusão.

### Síntese da análise independente

- **Decisão:** expansão delimitada em schema v2, preservando o contrato v1 e a
  fundação de autorização, transação e revisões do primeiro lote.
- **Fatos inspecionados:** a hierarquia já possui IDs e arrays canônicos, mas o
  validador limita composição e tipos; editor/renderer achatam colunas; mídia é
  apenas WebP; o leitor refaz render em todo `popstate`.
- **Divergência resolvida:** manter v1 extensível era possível, porém ambos os
  analistas aceitaram v2 como fronteira explícita das novas semânticas. Conversão
  ocorre somente após ação v2 bem-sucedida; abrir, cancelar ou falhar não converte.
- **Hipóteses não confirmadas:** custo em VPS, suporte efetivo do pacote Alpine,
  reprodução em dispositivos físicos e integração Firebase/PostgreSQL/Nginx reais.
- **Riscos residuais:** subprocessos não são sandbox de memória/filesystem; blobs
  já baixados não podem ser revogados do dispositivo; teste automatizado não
  atesta qualidade editorial de transcrição/legendas ou uso de leitor de tela físico.
- **Verificação:** preservar regressões v1, testar upgrade populado 040→041,
  composição por teclado/ponteiro, probe/decode/reprodução de arquivos sintéticos,
  acesso tipado privado, histórico, retries, deep links e descarte; revisão fresca.
- **Condição:** implementar apenas arquivos definidos no plano, sem operações de
  produção, concessão de acesso real, reativação do CMS ou alteração da migration 040.

### Proveniência das fontes

As três fontes locais e seus textos SIL OFL 1.1 foram inspecionados. Em 10/11/2026,
os SHA-256 dos binários existentes corresponderam byte a byte aos arquivos de
Google Fonts indicados abaixo; nenhum binário foi alterado ou acrescentado.

| Fonte local | Fonte conferida | SHA-256 |
| --- | --- | --- |
| `Manrope-Variable.ttf` | `https://raw.githubusercontent.com/google/fonts/main/ofl/manrope/Manrope%5Bwght%5D.ttf` | `3ae11c49db0455a3cc33e37d380f20fdb8c7f8b41dc07625c177e3d87a9d6ae6` |
| `SourceSerif4-Variable.ttf` | `https://raw.githubusercontent.com/google/fonts/main/ofl/sourceserif4/SourceSerif4%5Bopsz,wght%5D.ttf` | `97b2d4da6e3cb494b5a1e66ae176914d852ccabef49e0c02c0df25f3e39aca0b` |
| `Oswald-Variable.ttf` | `https://raw.githubusercontent.com/google/fonts/main/ofl/oswald/Oswald%5Bwght%5D.ttf` | `5b38c246e255a12f5712d640d56bcced0472466fc68983d2d0410ec0457c2817` |

Licenças permanecem ao lado dos arquivos como `OFL-Manrope.txt`,
`OFL-SourceSerif4.txt` e `OFL-Oswald.txt`. Manrope continua sendo o padrão.
O piloto não substitui o PDF/kit Owner News original, indisponível nesta sessão.

### Contratos da expansão implementada

- Combinações aceitas: `schema_version: 1` / `comunicado@1`, versão 2 /
  `comunicado@2` e versão 2 / `owner-news@1`. Abrir uma revisão antiga não a migra.
  A primeira ação v2 bem-sucedida substitui a cópia de trabalho; o save pendente
  mantém seu payload/chave originais. A migration 041 amplia o schema sem atualizar
  snapshots ou privilégios. SHA-256 preservado de 040:
  `be822d6384830b775b397010929d87560e145f126c3d5fb953c09a32e59929bc`.
- Até 20 seções; `single` contém uma coluna e `two_equal` duas. A ordem de leitura é
  seção→linha→coluna esquerda inteira→coluna direita inteira, igual à ordem DOM e
  ao empilhamento mobile. Duas→uma concatena sem perder IDs/conteúdo. Destinos e
  undo usam IDs, e instâncias ProseMirror sobrevivem a movimentos e presets.
- Destaque usa texto rico restrito, tom e ícone fixos. Botão tem `label`,
  `preset: primary|secondary|text` e `destination: {type: url|section, value}`;
  `value` é HTTPS/root-relative seguro ou UUID de seção existente. Separador é um
  bloco sem HTML. Botões/separadores isolados não satisfazem conteúdo para publicação.
- O estilo opcional de bloco usa `align: start|center|end`,
  `scale: small|standard|large`, `palette: neutral|brand|warm` e
  `font: manrope|source-serif-4|oswald`, mapeados a CSS local. Não há CSS livre ou
  novas marcas inline de tipografia no texto rico.
- Multipart legado continua `image` + `client_mutation_id`. Novas mídias usam
  `file` + `kind: gif|audio|video` + `client_mutation_id`. O ACK preserva IDs e
  dimensões e acrescenta `kind`, `mime_type`, `duration_ms`; áudio tem dimensões nulas.
- GIF: 8 MiB, até 100 frames/20 milhões de pixels totais/30 segundos por ciclo,
  normalizado sem achatar animação. MP3: 10 MiB/600 segundos, uma trilha MP3 mono ou
  estéreo até 48 kHz. MP4: 25 MiB/120 segundos, H.264 yuv420p até 1920×1080/30 fps,
  AAC-LC opcional mono/estéreo até 48 kHz; VFR é conservadoramente rejeitado.
- MIME, propriedades, referências de mídia tipadas e duração são validados pelo
  servidor. Probe e decode completo usam executáveis absolutos locais, sem shell,
  demuxers fixos, protocolo file, referências externas desabilitadas, tempo/saída
  limitados e uma admissão por processo antes do buffer. Isso não é uma sandbox de
  memória. Ausência das ferramentas retorna indisponibilidade, sem aceitar por MIME.
- Linux usa o pacote FFmpeg do Alpine declarado no Dockerfile (não construído nesta
  tarefa). Windows exige `FFMPEG_PATH` e `FFPROBE_PATH` absolutos. O limite de
  transporte Pages é 26 MiB; JSON continua 1 MiB e quota histórica 50 arquivos/100 MiB.
- Áudio/vídeo só baixam após `Carregar`, sem autoplay; o usuário aciona os controles
  nativos. GIF usa `Iniciar animação` / `Parar animação`, não pausa/retomada. Áudio
  exige transcrição e vídeo também exige cues sincronizados para publicar. Cues
  são `{start_ms,end_ms,text}`, ordenados, sem sobreposição, até 500 itens e limitados
  à duração da mídia. VTT é criado como blob local, não buscado externamente.
- O catálogo permite selecionar o modelo sintético Owner News. Capa, índice,
  matéria, entrevista e reconhecimentos usam somente os blocos genéricos; pessoas e
  iniciativas são fictícias. URLs usam `pages.html?id=UUID#section-UUID`. Hash do
  mesmo documento mantém players e recursos; troca de query descarta e carrega outro.

Os scripts adicionais de aceite são `tests/database/check-pages-pilot.mjs` e
`tests/visual/check-pages-pilot.mjs`, com as mesmas variáveis externas dos checks
originais e os dois caminhos absolutos de FFmpeg. Os fixtures são gerados de lavfi
por `tests/helpers/pages-media-fixtures.mjs`; não há uploads reais ou binários de
mídia no repositório. `PILOT_VISUAL_OUTPUT` escolhe os artefatos; o padrão é
`opencode/pages-pilot` no diretório temporário. Os testes encerram os recursos que criam.

### Evidência independente da expansão — 10/11/2026

- `node tests/database/check-pages.mjs`: **75 verificações HTTP aprovadas** após
  a expansão, preservando os contratos do primeiro lote.
- `node tests/database/check-pages-pilot.mjs`: **125 verificações HTTP aprovadas**.
  Executa rotas, SQL e arquivos privados reais com FFmpeg local; inclui v1 anterior
  à migration, aplicação idempotente de 041, comparação efetiva de colunas,
  constraints, índices e grants entre bootstrap+040+041 e upgrade populado 040→041,
  modelo v2, referências tipadas, quota histórica, retry, rollback, publicação e arquivo.
- A verificação adicional rejeitou arquivos reais com codec/trilhas extras,
  duração/fps/frames excessivos, truncamento, referência externa e criptografia
  CENC. Dois arquivos têm stream anunciado 160×90/yuv420p, mas frames posteriores
  2048×1152 ou yuv444p: ambos rejeitados. MP4 válido com `sinf schm pssh url ` em
  metadados comuns foi aceito, sem confundir palavras com boxes de proteção.
- `node tests/visual/check-pages.mjs`: **12 cenários Chrome aprovados**, repetindo
  as regressões do primeiro lote e as cinco larguras.
- `node tests/visual/check-pages-pilot.mjs`: **16 cenários Chrome aprovados**:
  seleção/criação do modelo pelo catálogo real; controles de duas colunas; destino
  por teclado; drag por mouse e eventos touch do Chrome; colapso sem perda; mesma
  instância e undo ProseMirror; presets/blocos; uploads GIF/MP3/MP4 pelo editor;
  legendas editadas após substituir a cópia de composição e carregadas no player
  reutilizado; prévia mobile e confirmação de revisão/cargo; áudio/vídeo com avanço
  real de reprodução e cues; GIF com pixels visivelmente diferentes entre frames;
  início/parada explícitos; deep link/índice/Back/Forward sem refetch; troca de query
  pausando/limpando players e revogando todos os blobs; botão existente reconhecendo
  nova seção sem reload. Leitor auditado em 360/402/768/1366/1920 px, com ordem DOM
  canônica e geometria real de colunas. Axe WCAG A/AA sem violações nas superfícies
  verificadas; nenhum erro JavaScript registrado.
- `npm run verify`: **908 aprovados, zero falhas e dois skips específicos de Linux**
  no Windows. Os **55 testes Pages** focados fazem parte desse total, não se somam a ele.
- Build público, bundle/licenças reproduzíveis, shell gerado e `git diff --check`
  conferidos. Auditoria de produção API/cron: zero vulnerabilidades no escopo configurado.
- A revisão Astra high encontrou três problemas e exigiu correção: propriedades
  de vídeo somente no cabeçalho, busca textual ingênua de proteção MP4 e estado
  obsoleto em controles/mídia reutilizados. As correções recebem os testes reais
  descritos acima. A revisão fresca final Astra high retornou **`ship`**, sem
  correções adicionais obrigatórias, confirmando o fechamento dos três achados.
  O revisor inspecionou código/testes, mas teve shell e artefatos externos negados;
  as execuções, o diff acumulado e as capturas foram conferidos pela sessão primária.

Artefatos locais: `opencode/pages-editor/results.json` e
`opencode/pages-pilot/results.json`, com capturas correspondentes, no temporário.
Testes PGlite usam conexões serializadas e identidade Firebase sintética. Isto não
é homologação de PostgreSQL 16 nativo, autenticação Firebase oficial, Nginx efetivo,
build Linux do FFmpeg, capacidade VPS, aparelho físico ou leitor de tela físico.
Nenhum conteúdo real foi publicado e nenhum commit, merge ou deploy foi executado.

### Polimento visual do editor — 10/11/2026

Após inspeção local, o usuário aprovou o polimento completo descrito em
`docs/superpowers/specs/2026-11-10-pages-editor-polish-design.md`.
Mudanças de runtime localizadas em `public/css/pages.css` e `public/pages/editor.js`:

- Cabeçalho com status e grupos de ações; título/resumo em largura útil e
  metadados alinhados; barras de seção, linha e bloco com espaçamento explícito.
- Botões, selects, upload e campos seguem Manrope e tokens Conecta; handle deixa
  de ter aparência nativa. Ferramentas agrupadas por organização, apresentação e
  formatação. Rótulos visíveis dos tipos/presets ficam em português; valores JSON
  permanecem iguais e `data-block-type` identifica o tipo sem depender da tradução.
- Controles de interface não herdam Oswald/serif, alinhamento ou escala dos blocos.
  Contraste medido também sobre presets warm/brand; ações mantêm alvo de 44 px.
- Nenhum backend, schema, estado de save, mídia, renderer ou serviço foi alterado.
  O preview em uso não foi reiniciado e dados sintéticos/edições locais foram preservados.

Evidências primárias: `tests/visual/check-pages-polish.mjs` aprovado em 360, 402,
768, 1366 e 1920 px, com estados ocioso/selecionado/paleta brand/prévia; confere
geometria, fontes, gaps, isolamento dos presets, save real e axe/reflow. Os checks
Chrome originais/piloto passaram com 12+16 cenários após os ajustes de seletores
para `data-block-type`. `npm run verify`: 911 aprovados, zero falhas, dois skips de
Linux; 58 testes Pages focados fazem parte desse total. Capturas e relatório em
`opencode/pages-polish` no temporário. Revisão fresca Astra high: **`ship`**, sem
correções obrigatórias. O revisor inspecionou código e testes, mas não executou
checks ou acessou as capturas devido às permissões de suas ferramentas; execução
e inspeção visual são evidências da sessão primária. Bundle/licenças, shell gerado
e `git diff --check` aprovados. A versão atualizada foi aberta em nova aba do
preview local, sem recarregar a aba anterior nem reiniciar o servidor em uso.

### Editor V2 — reprodução de referência — 10/11/2026

O usuário enviou e autorizou a reprodução dos SVGs **EDITOR V2** de edição
contextual, estilo/cores, inserção, revisão, painel inferior mobile e botões.
Os seis arquivos foram rasterizados localmente e inspecionados. O arquivo `.ai`
anexado abriu como arte fotográfica de SPA, não como editor, e ficou fora do lote.
Especificação e plano em `docs/superpowers/specs/2026-11-10-pages-editor-v2-design.md`
e `docs/superpowers/plans/2026-11-10-pages-editor-v2.md`.

Implementação:

- `public/pages/editor-workspace.js`: header e barra dedicados, estrutura real de
  seções à esquerda, conteúdo central e propriedades à direita; aba Página para
  metadados/cargos. O shell continua montado, apenas apresentado em modo dedicado
  pela classe de rota, removida ao sair ou após falha de carregamento.
- `public/pages/editor-panels.js`: dialogs de inserção/estilo/estrutura, foco
  nativo e Escape. `public/css/pages-editor-v2.css`, carregado somente no editor,
  segue cores e proporções das referências; não altera tokens ou CSS do leitor.
- Formatação contextual no desktop e painel inferior não modal em tamanhos
  compactos, com Conteúdo/Estilo/Posição. Campos e controles textuais são movidos,
  não clonados; texto ProseMirror e mídia continuam com identidade estável.
- Barra curta no celular: Blocos/Prévia/Publicar. O menu Mais ações oferece
  Salvar rascunho, Inserir bloco, Estilo e Propriedades. **Salvar é explícito**;
  Concluir edição somente fecha o painel e não anuncia persistência.
- Inserção pesquisável dos tipos existentes, uploads privados e duas colunas.
  Estilo geral aplica somente presets suportados aos blocos existentes de forma
  atômica no rascunho; cancelar não altera o documento. Não cria herança global.
- Revisão com título, versão salva e cargos reais, mais checklist pessoal não
  persistente. Preserva CAS, snapshot revisado, idempotência e autorizações.
  Sem categoria/slug/audiência geral fictícios, galeria/FAQ/embed/cor livre ou
  substituição do conteúdo do usuário pelo exemplo desenhado.

Nenhum backend, migration, contrato JSON, estado de salvamento, renderer,
normalizador de mídia, ProseMirror ou Sortable foi modificado para este lote.
`dialog.js` recebeu apenas uma classe opcional compatível com os demais callers.
Os ícones locais usam geometria simples de linha; não foram importadas bibliotecas
ou fontes. Logos e fontes existentes foram preservados.

Evidências executadas pela sessão primária:

- `npm run verify`: **916 aprovados, zero falhas, dois skips Linux** no Windows.
- `tests/visual/check-pages-v2.mjs`: **10 cenários**, em **360, 390, 402, 768,
  1366, 1600 e 1920 px**. Inclui edição, busca/inserção, estilo aplicado e salvo
  na API/SQL, identidade PM, painel inferior e suas abas, retorno de foco após
  fechar/Escape/concluir, revisão, prévia, saída restaurando shell, publicador
  de outra autoria sem edição e resize com título/texto dirty e undo preservados.
- Comparação visual da sessão primária com as pranchas rasterizadas: capturas
  de edição/inserção/estilo/revisão a 1600×1160 e mobile 390×820. O conteúdo das
  capturas é sintético; diferenças de receita não representam conteúdo importado.
- Chrome original: **12 cenários**; piloto: **16**, com mídia e drag mouse/touch
  reais; polimento: **5 larguras**, fontes, gaps, contraste warm/brand e controles.
  Todos repetidos após as correções. Axe WCAG A/AA sem violações nas superfícies
  auditadas; sem overflow global ou erros JS registrados pelos verificadores.
- Bundle/licenças, shell gerado e `git diff --check` aprovados.
- Astra high: **`ship`** após corrigir estado pressed das marcas na toolbar
  movida, retorno do shell em falha de load e foco da folha Página no celular.
  Regressões específicas foram adicionadas. Revisão read-only de código/testes;
  shell/capturas externos foram negados ao revisor, portanto os PASS de execução
  e a comparação visual são evidências primárias, não reproduções independentes.

Artefatos no temporário: `opencode/editor-v2-reference` (referências rasterizadas)
e `opencode/pages-editor-v2` (capturas, `results.json`, `verify-final.log`).
As mesmas limitações de Firebase sintético, PGlite serializado, Windows/Chrome
e ausência de aparelho físico/homologação VPS continuam aplicáveis.

Ao abrir a prévia final, a porta 4186 já não tinha listener e o servidor anterior
estava encerrado. A demonstração descartável foi reiniciada com novo banco/ID,
sem parar serviços ativos ou recarregar abas anteriores. O banco em memória
antigo não foi recuperado. Nenhum dado real, permissão real, commit, merge ou
deploy foi alterado/executado.

Em 11/11/2026 o usuário autorizou o commit local da entrega completa. A checagem
pré-commit identificou CRLF no texto de licença original do Sortable: o gerador
agora normaliza os avisos para LF, preservando integralmente o texto e tornando
o resultado compatível com o blob Git e checkouts Linux. O teste reproduzível
também exige LF nos avisos. Capturas locais não integram o commit; autorização
para commit não inclui push, merge, deploy ou mudanças em serviços reais.

### Download privado e componente de botão — Task 8, 11/11/2026

`GET /api/pages/:id/media/:mediaId/download` usa o mesmo handler autenticado,
gate de Ética, seleção de query e `store.mediaRecord` da entrega inline. Aceita
somente `preview=1` **ou** `revision_id=UUID`: staged exige autoria/editPages;
revisão exige autoria autorizada/publicador; leitura normal exige referência na
publicação atual e cargo ativo elegível. Não há acesso universal de administrador.
O nome do attachment é `material-<UUID>.<webp|gif|mp3|mp4>`, derivado do kind
normalizado, nunca de query, header, nome editorial ou caminho enviado pelo cliente.
Os bytes vêm somente do storage_key privado registrado. Respostas mantêm MIME
normalizado, `nosniff`, `private, no-store` e `acceptRanges:false`. Arquivo ausente
retorna JSON 404 `media_unavailable`, sem disposition/MIME de attachment residual.

`createPagesAPI(page).download(pageId, mediaId, {revisionId, staged, signal})`
retorna a object URL de `fetchAPIAsset` vinculado ao lifecycle/sessão, como `asset`.
Não navega no endpoint nem transmite Bearer em URL. O consumidor precisa revogar
o blob. `public/pages/button.js` exporta
`createPageButton({label,preset,icon,action,context}) -> {node,dispose,setDisabled}`.
`node` é o botão/link real; `setDisabled(boolean)` impede ativação, inclusive por
evento sintético, e remove href quando desabilitado. `dispose()` é idempotente,
aborta a operação, invalida a geração e revoga blobs, inclusive respostas tardias.
O contexto é `{api,pageId,revisionId,staged,host,resolveBlock,signal}`;
`resolveBlock(id)` retorna o bloco atual do mesmo documento.

- Ações serializadas continuam somente `url`, `section`, `video`, `download`.
  O componente usa apenas DOM/local SVG. O download cria um anchor blob efêmero
  com `file_name` validado; erro anuncia retry, sem baixar URL nua ou anunciar Salvo.
- `activateVideo(id,{signal})` é um callback de integração opcional no contexto.
  O renderer resolve vídeo local para `mediaFigure.activate()`: carrega bytes e
  foca o controle real, **nunca** chama `play()`. Para `video_embed`, somente foca
  `[data-pages-video-consent]` já montado no wrapper do bloco. Esse controle pertence
  ao renderer de embed da Task 10 e deve explicar/obter consentimento antes de
  criar iframe. Task 8 não cria iframe nem adiciona renderer de embed substituto;
  sem controle montado, informa indisponibilidade e permite retry.
- Comandos **somente de UI**, nunca JSON: `action` ausente, contexto
  `{command:'upload'|'save',canAuthor:true,onCommand,signal}`.
  `onCommand({command,signal}) -> Promise<{acknowledged:true}>` precisa aguardar
  o fluxo de upload/save real e adaptar seu ACK. Seleção de arquivo, retorno
  síncrono, void, false, rejeição, aborto ou ACK incerto **não** confirmam sucesso.
  Save confirmado muda label para `Salvo`/preset `confirmed`; nova tentativa limpa
  a confirmação antes de começar. Upload só confirma envio, não salvamento.
  O caller continua responsável pelo picker, autorização atual, pending imutável,
  CAS/idempotência e semântica de baseline. Não conectar callback que apenas abre
  picker ou agenda save. Task 14 fará essa integração no editor existente.
- Presets visuais `primary`, `secondary`, `text`, `video`, `upload`; `confirmed`
  não é estado inicial configurável e só nasce do ACK assíncrono. Aparência segue
  `reference-1.png`: Manrope, 44 px visíveis, ícones locais, foco 2 px + gap 2 px,
  label estável no busy. Wrapper/presets/ícone ausente legados são preservados;
  botões v3 usam foreground/background do `resolveAppearance`, o mesmo par do gate AA.

Checks: `tests/unit/pages-button.test.mjs`, router/renderer e
`tests/database/check-pages-v3.mjs` (uploads/SQL/HTTP reais em PGlite, quatro kinds,
histórico, acesso staged/revisão/cargo e storage ausente).
`tests/visual/check-pages-buttons.mjs` usa o componente real, API/autenticação com
Firebase sintético, PGlite serializado e Chrome isolado em loopback, sem rede
externa. Confere geometria/foco/busy, falha/retry/duplo clique, ACKs reais de upload
e save, descarte e troca de conta. Não habilita writer, UI de autor para leitor,
serviços ou permissões reais. PostgreSQL 16 nativo, concorrência, restore, Firebase
real e Nginx nativo continuam gates **PENDENTES**, não PASS deste lote.

#### Correções de revisão Task 8 — round 1

Botão de seção publicado mantém o anchor absoluto de mesmo documento e **não**
intercepta sua navegação nativa por fragmento: os handlers já existentes do shell
atribuem `portalNavigation`, atualizam a URL ativa e restauram foco/posição. O
componente nunca chama `window.history.pushState` diretamente. Com `staged` ou
`revisionId`, o clique é somente foco/scroll no host, sem mudar URL ou histórico,
inclusive no editor dirty. Não há alteração dos guards ou índices do router.

Filename validado/persistido é preservado byte a byte no atributo `download`:
espaços iniciais seguros, como ` guia.webp`, são válidos pelo contrato v3 e não
podem ser recusados ou trimados no cliente. Continuam recusados controles,
separadores de caminho, basename vazio, excesso de tamanho e extensão incorreta.
O basename do attachment do servidor continua independente desse nome editorial.

`tests/visual/check-pages-friendly-route.mjs` inclui o componente de produção no
shell real: seção→perfil, índices distintos, salto multi-Back/Forward, cancelamento
e aceite de saída do perfil dirty, restauração de foco e prévias staged/revision
sem entradas adicionais. Conserva as regressões de skip-link dirty/busy da Task 7.
`pages-button.test.mjs` testa a fronteira validador **publishing:true**→componente
para nomes com espaço inicial e retry/download dos quatro kinds, sem invalidar
snapshots anteriores. Os limites de ambiente/nativos descritos acima permanecem.
