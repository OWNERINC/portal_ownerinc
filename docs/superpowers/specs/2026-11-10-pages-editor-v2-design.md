# Editor V2 — reprodução das referências enviadas

## Direção aprovada e revisão

Em 10/11/2026, após inspeção dos seis SVGs anexados, o usuário confirmou no
formulário **Reprodução visual com funções atuais (recomendado)**. Esta especificação
detalha essa direção para revisão antes do plano de implementação. Não autoriza
expansão de backend/schema, publicação real, commit, merge ou deploy.

## Fontes visuais inspecionadas

Arquivos originais no Desktop do usuário:

- `EDITOR V2 · Desktop · Edição contextual.svg`: 1600×1160.
- `EDITOR V2 · Desktop · Estilo e cores.svg`: 1600×1160.
- `EDITOR V2 · Desktop · Inserir bloco.svg`: 1600×1160.
- `EDITOR V2 · Desktop · Revisar publicação.svg`: 1600×1160.
- `EDITOR V2 · Mobile · Painel inferior.svg`: 390×820.
- `EDITOR V2 · Assets · Botões editáveis.svg`: 1600×480.

Os seis SVGs foram rasterizados localmente e inspecionados visualmente. O texto
está convertido em paths: são referências visuais, não componentes HTML editáveis.
As imagens de inspeção estão no temporário `opencode/editor-v2-reference`, com
mapa `index.json`. Os originais não foram modificados ou incorporados ao produto.

`Sem título-1.ai` foi aberto como PDF compatível: é uma arte fotográfica com
“19H — Momento relaxante no SPA”. Fica fora da referência do editor e não será
importado como mídia sem instrução específica. Outro SVG presente no Desktop,
`EDITOR V2 · Assets · Foto, vídeo e botões.svg`, não estava entre os anexos desta
solicitação e não foi usado como referência visual.

## Objetivo

Reproduzir o layout e a linguagem visual enviados, em vez de reinterpretar o
design ou fazer apenas outro polimento. Preservar os documentos, modelos, mídia
privada e fluxos funcionais existentes. Não transformar a interface em uma imagem
ou colocar o SVG inteiro como fundo: texto, campos, menus e botões serão controles
reais, acessíveis e ligados às operações existentes.

## Estrutura desktop

- Espaço de trabalho dedicado ao editor, sem a navegação geral do Portal ocupando
  a lateral durante essa visita. Preservar o shell/router/autenticação existentes;
  a apresentação dedicada deve ser ativada e removida no ciclo de vida da rota,
  sem afetar outras páginas nem persistir preferências artificiais de sidebar.
- Cabeçalho com voltar à gestão, marca Conecta existente, título do documento,
  status real de salvamento, salvar explicitamente, prévia e publicar quando permitido.
- Segunda barra com inserir bloco, identificação do modelo e estilo. Identificar
  o modelo atual, sem oferecer troca destrutiva de receita neste lote.
- À esquerda, estrutura derivada das seções reais, seleção e navegação até o
  conteúdo, adicionar seção e comandos de organização. Rótulos e quantidade vêm
  do documento, nunca de cinco entradas fixas do exemplo.
- Ao centro, superfície editorial clara e contínua, com controles estruturais
  discretos, indicação laranja do bloco selecionado e ferramenta textual contextual.
- À direita, abas Bloco/Página. Bloco concentra propriedades e organização do
  item selecionado; Página contém título, resumo, tags e público por cargo.
- Em 1600 px, usar como referência cabeçalho de 72 px, barra de 56 px e laterais
  próximas de 220/280 px. A área central é fluida. Em larguras intermediárias,
  recolher laterais em painéis acessíveis antes de comprimir o conteúdo ou gerar
  rolagem horizontal. Estado visual de breakpoint não altera o documento.

## Interações e correspondência funcional

### Seleção, edição e posição

Selecionar bloco atualiza o inspetor sem destruir o editor de texto nem apagar a
seleção textual. Preservar instâncias ProseMirror por ID, histórico textual,
IDs/seletores estáveis, proteção contra drop de controles no texto e comandos de
composição atuais. Arraste vertical/lateral e alternativas explícitas de mover
continuam disponíveis, inclusive no toque e pelo teclado. Mudança de largura usa
as linhas existentes de uma/duas colunas; não cria larguras livres ou canvas.

Formatação contextual usa apenas as capacidades atuais de texto rico. Não
mostrar undo/redo global: comandos textuais devem ser nomeados como textuais e
atuar no editor ativo; restauração de exclusão permanece uma ação distinta.

### Inserir bloco

Popover/painel com busca local, ícones e descrições curtas seguindo a prancha.
Oferecer texto, imagem/GIF, áudio, vídeo por upload, duas colunas, destaque, botão
e separador. A inserção opera no destino selecionado com limites existentes.
Galeria, FAQ interativo e vídeo incorporado por link não serão apresentados como
opções disponíveis. Não inserir conteúdo do desenho no documento do usuário.

### Estilo e cores

Manter a aparência do painel enviado, mas usar somente fontes e presets já
validados: Manrope, Source Serif 4, Oswald; alinhamentos, escalas e paletas atuais.
Não oferecer seletor hexadecimal livre, novos temas ou cores que não persistem.
Rótulos devem descrever os presets reais, sem atribuir cores inexatas às amostras.

O painel de estilo geral pode aplicar uma combinação suportada aos blocos
existentes por ação explícita e atômica no rascunho local. Identificar o alcance
como **Aplicar aos blocos existentes**: isso persiste nos estilos de cada bloco,
não cria tema global ou herança inexistente. Cancelar não modifica o documento;
blocos adicionados depois continuam usando os padrões existentes. O inspetor
de bloco altera apenas o selecionado. Nenhum controle pode fingir persistência.

### Revisar publicação

Reproduzir a hierarquia, dimensões responsivas, backdrop e ações do modal enviado.
Mostrar título, público por cargos e revisão salva reais. Não inventar categoria,
slug público ou audiência “todos os colaboradores”. Edição de metadados ocorre na
aba Página e exige novo salvamento antes da revisão.

Checklist de conferência é somente auxílio de sessão, não uma aprovação gravada
ou novo workflow. Validações reais continuam obrigatórias independentemente dele.
Não exibir o aviso “este desenho não publica”: o editor funcional pode publicar
conforme autorização e ambiente. Mostrar claramente quando o ambiente é sintético.
Confirmar sempre usa a revisão explicitamente conferida, CAS e chave idempotente.

## Mobile

Em 390 px, seguir a prancha: cabeçalho compacto, ações Blocos/Prévia/Publicar e
conteúdo com indicação do selecionado. Propriedades migram para painel inferior
com abas Conteúdo/Estilo/Posição, fechar e concluir edição. Salvar rascunho continua
alcançável; “Concluir edição” apenas fecha o painel e não anuncia salvamento.

Painel com altura limitada à área visível e rolagem interna; considerar teclado
virtual e safe-area. Nunca ocultar permanentemente o bloco focado ou os botões
de fechamento. Blocos abre a estrutura em painel adequado ao celular. Um painel
modal por vez, com Escape, foco contido quando modal e retorno ao acionador.
Redimensionar/reorientar não duplica campos, listeners ou instâncias de texto.

## Identidade e acessibilidade

Manrope local e tokens Conecta: índigo `#2A275E`, laranja `#E84F1C`, fundo
`#F7F6F2`, borda `#E1E2DD`, seleção lavanda. Superfícies brancas do editor podem
ser locais para corresponder ao SVG, sem alterar tokens globais do Portal.
Títulos, densidade, gaps, raios e estados seguem as pranchas. Priorizar os ícones
locais; eventuais adições precisam manter licença/proveniência verificável.
Sem biblioteca visual, fonte ou framework novo.

Alvos de 44 px mesmo quando a prancha desenha controles menores; texto legível,
contraste AA, foco visível, nomes acessíveis e ações não dependentes de cor/hover.
Salvar, erro, conflito e carregamento mantêm dimensões e descrições honestas.
Não transportar a fonte/alinhamento do conteúdo para os controles do editor.

## Fronteiras técnicas

Manter HTML/CSS/JavaScript, Express/CommonJS e PostgreSQL, versões de documentos
1/2, API, autoria/permissões, audiência por cargo e mídia autenticada. Sem migration,
autosave, streaming, importação de acervo ou reativação do CMS histórico.
Prévia/leitura continuam com o mesmo renderer; alterações no chrome do editor não
redesenham o conteúdo já publicado.

Dividir os componentes de apresentação em módulos Pages pequenos: workspace,
estrutura/inspetor e painéis, com callbacks para as operações atuais. O editor
continua dono do estado e do ciclo de vida; módulos de UI não fazem gravações
independentes nem mantêm cópias divergentes do documento.

Se necessário, ajustar a apresentação do shell apenas na rota do editor e seus
testes. Não remover markers de geração nem mudar navegação de outros produtos.
Todos os recursos temporários/classes de rota devem ser removidos no descarte,
inclusive após erro de carregamento ou saída do editor.

## Verificação e aceite

- Comparação visual direta com SVGs em 1600×1160 e mobile 390×820, cobrindo edição
  contextual, estilo, inserção e revisão, com capturas legíveis.
- Reflow em 360, 390, 402, 768, 1366 e 1920 px; teclado, foco, axe e painéis sem
  overflow global. Documentar adaptações justificadas por acessibilidade/contrato.
- Preservar dados ao selecionar/mover, abrir/fechar painéis, mudar viewport, entrar
  em prévia e navegar pelo shell. Não testar alterando documentos do usuário.
- Repetir regressões reais de texto, drag mouse/touch, mídia, save, revisão,
  conflitos, readonly/publicador e descarte. Ajustar seletores de apresentação
  sem reduzir as garantias dos testes existentes.
- `npm run verify`, bundle/licenças, shell gerado e `git diff --check` antes de
  concluir. Revisão fresca conforme a preferência já estabelecida pelo usuário.
- Não reiniciar o servidor descartável em uso nem recarregar abas com edições
  locais. Conferir em ambiente/abas de teste e abrir nova aba ao apresentar.

## Aprovação para execução

O usuário aprovou a execução: “Ajuste o plano conforme necessário e siga com a
implementação do Editor V2, preservando as funções atuais.” A implementação segue
o plano `docs/superpowers/plans/2026-11-10-pages-editor-v2.md`, sem novo gate de
aprovação e sem commit, merge ou deploy.
