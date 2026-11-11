# Editor V2 Implementation Plan

> Execução inline, tarefa a tarefa, na worktree isolada existente. A aprovação do
> usuário inclui ajuste do plano e implementação; não solicitar novamente a mesma
> decisão. Não criar commits.

**Goal:** reproduzir as pranchas Editor V2 com controles funcionais e preservar os
contratos existentes de edição, composição, mídia e publicação.

**Architecture:** `editor.js` continua dono do estado e das operações. Um módulo
de workspace monta a apresentação responsiva e gerencia painéis/seleção visual;
um módulo de painéis gerencia popovers modais locais. O shell é apresentado em
modo dedicado somente enquanto o editor está montado, com cleanup da classe.

**Tech Stack:** HTML/CSS/JavaScript, ProseMirror/Sortable locais existentes;
Express/CommonJS e PostgreSQL intactos.

## Global Constraints

- Preservar todos os arquivos não commitados e o preview sintético em uso.
- Sem backend/migration/schema novo, autosave, vídeo por link, galeria ou cor livre.
- Manter CAS, snapshots, idempotência, autoria, público por cargo e mídia privada.
- Sem dependências/fontes/framework novo; marca/Manrope existentes.
- Não reiniciar o preview, descartar edições, fazer commit, merge ou deploy.
- Layout fiel às pranchas, adaptando alvos de 44 px e contraste AA.

### Task 1 — Workspace dedicado e controles contextuais

**Files:** criar `public/pages/editor-workspace.js` e `public/pages/editor-panels.js`;
modificar `public/pages/editor.js`, adicionar `public/css/pages-editor-v2.css`
e seu link em `public/page-editor.html` (sem alterar CSS compartilhado);
testar `tests/unit/pages-editor-lifecycle.test.mjs`.

**Interfaces:** `createEditorWorkspace({root,page,header,actions,metadata,modes,toolbar,
editorHost,previewHost,add,feedback,onInsert,onStyle,onSection})` retorna referências
de `canvas`, `structure`, `inspector`, `contentFields` e métodos `select`,
`refresh`, `showMode`, `showPage`, `dispose`. Não duplica estado/documento.
`openEditorPanel({page,title,anchor,content})` monta dialog com fechamento e foco.

- [x] Adicionar regressão de workspace/cleanup e campos únicos; rodar unitário
  antes da implementação para confirmar falha por ausência dos novos elementos.
- [x] Montar header/barra/estrutura/superfície/inspetor e aba Página com metadados.
  Classe `pages-editor-active` em body removida em cleanup; shell HTML inalterado.
- [x] Separar campos do bloco do seu conteúdo; mover os mesmos nós para o inspetor,
  sem reconstruir controles ou instâncias ProseMirror em digitação/seleção textual.
- [x] Renderizar toolbar textual compacta dentro do selecionado, propriedades no
  inspetor; organização de linhas/seções acessível por controle explícito.
- [x] Montar painel inferior não modal: permite editar o conteúdo atrás dele;
  limitar altura, reservar área inferior, fechar/Escape/retorno de foco. Painéis
  de inserção/estilo/estrutura são dialogs modais, com foco nativo.
- [x] Repetir unitários e conferir navegação/cleanup em browser real.

### Task 2 — Inserção, estilo e revisão com contratos atuais

**Files:** módulos da Task 1; modificar `public/pages/dialog.js` apenas para opções
de apresentação compatíveis; testes unitários e `tests/visual/check-pages-v2.mjs`.

**Interfaces:** callbacks da UI chamam as funções atuais `composition`, `upload`,
`publish`, `state.save`. Estilo em lote usa `compose` sobre cópia local e somente
um `state.replace` após sucesso de todos os blocos; cancelar não altera documento.

- [x] Inserção pesquisável usa ações de texto/mídia/destaque/botão/separador e duas
  colunas. File input único mantém tipos e validações atuais.
- [x] Painel estilo usa fontes/paletas/escalas suportadas e aplica aos blocos
  existentes explicitamente. Nenhuma falsa herança de novos blocos.
- [x] Revisão mostra título/revisão/cargos reais, checklist auxiliar sem nova
  persistência, confirmando apenas a revisão salva atual.
- [x] Preservar save explícito, erro/retry, upload incerto, readonly/publicador,
  arquivar/restaurar e histórico textual. Não imitar autosave do desenho.

### Task 3 — Comparação visual e regressão

**Files:** criar `tests/visual/check-pages-v2.mjs`; adaptar seletores dos checks
existentes para os novos locais/painéis mantendo todas as assertions funcionais;
atualizar `docs/architecture/pages.md` e este plano.

- [x] Browser real com fixtures isoladas em 1600×1160 e 390×820; capturar estados
  edição/estilo/inserção/revisão e comparar visualmente com os SVGs inspecionados.
- [x] Testar 360/390/402/768/1366/1920, axe/reflow, tabs/Escape/foco, readonly,
  seleção/conteúdo/posição, mídia e persistência real. Testar resize com texto
  dirty, preservação da instância PM e retorno ao shell sem classe residual.
- [x] Repetir `check-pages.mjs`, `check-pages-pilot.mjs` e check visual V2; executar
  `npm run verify`, `npm run check:pages-build`, shell gerado e `git diff --check`.
- [x] Revisão fresca Astra high solicitada no histórico; corrigir achados reais e
  registrar limites. Abrir nova aba da prévia, sem tocar nas abas existentes.

## Aceite de diferenças da prancha

As receitas/conteúdo do usuário não serão substituídos pelo guia ilustrativo do
SVG. Zoom/undo global, categoria/slug, galeria, FAQ e vídeo por link não aparecem
como funções disponíveis. Estrutura pode revelar controles técnicos sob uma ação
Organizar, mantendo a superfície limpa no estado normal. Checklist não substitui
validação; o botão Salvar rascunho continua explícito em todas as larguras.

## Resultado e ajustes de implementação

- No celular, Salvar rascunho, Inserir bloco, Estilo e Propriedades ficam no menu
  Mais ações; não há autosave. Blocos, Prévia e Publicar continuam na barra curta.
- A formatação textual fica junto ao bloco no desktop e na aba Conteúdo do
  painel inferior em larguras compactas. Mover só os controles mantém PM intacto.
- A prévia antiga já estava encerrada ao apresentar o resultado. Nenhum processo
  ativo foi parado; a demonstração foi reiniciada com um novo banco sintético.
- Verificação final: 916 aprovados, zero falhas, dois skips Linux; Chrome original
  12 cenários, piloto 16, geometria/polimento 5 larguras e V2 10 cenários em 7
  larguras. Astra high fechou três achados de foco/estado/erro e retornou `ship`.
- Evidências e limitações: `docs/architecture/pages.md`, seção Editor V2.
