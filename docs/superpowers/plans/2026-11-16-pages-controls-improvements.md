# Editor V2 — plano de melhoria dos controles

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Neste repositório, só delegar quando autorizado pelo usuário. A aprovação deste plano não autoriza deploy ou publicação de conteúdo. Carregar apenas skills disponíveis no ambiente; os passos abaixo também permitem execução inline com checkpoints.

**Goal:** Resolver os 18 achados da auditoria sem substituir a direção visual aprovada nem alterar os contratos de persistência e publicação.

**Architecture:** Consolidar estilos e comportamento nos componentes existentes de Pages, com pequenas extrações para menus transitórios, pendências estruturadas e legendas. O documento e `state` continuam sendo a única autoridade de autoria; componentes de UI não mantêm cópias persistentes concorrentes. Nenhum editor paralelo, framework novo ou refatoração geral do Portal.

**Tech Stack:** JavaScript ES modules, CSS, ProseMirror/Sortable existentes, Express/PostgreSQL existentes, testes Node, Playwright + axe + harness PGlite local.

**Status:** Aprovado pelo usuário em 16/11/2026. Execução com agentes por tarefa e revisão independente; gate específico da tarefa 9 preservado.

## Base e decisões de escopo

Fonte: `docs/reviews/2026-11-16-pages-controls-audit.md` (A01–A18).

Abordagens consideradas:

1. **Correções locais e consolidação incremental — recomendada.** Resolver primeiro os bloqueios, depois uniformizar componentes e simplificar autoria. Cada entrega pode ser testada e revertida de forma localizada.
2. **Somente patches CSS.** Mais curto, mas não resolve pendências invisíveis, salvar escondido, seleção de formato e autoria técnica.
3. **Refazer todo o workspace.** Maior liberdade, mas risco desnecessário sobre o design aceito, acessibilidade, autoria e testes. Fora deste plano.

Não redesenhar catálogo `/pages.html`, não alterar navegação global do Portal e não trocar marca/paleta/fontes. Modificações de aparência se concentram nos controles e estados problemáticos. A18 é uma entrega própria após estabilizar o restante, porque formulário de legendas é funcionalidade adicional e exige aceite específico.

## Global Constraints

- Preservar leitura e edição compatíveis de documentos v1/v2/v3; nenhuma migração implícita ao abrir um painel.
- Preservar autoria, permissões, audiência por cargo, CAS, idempotência e payload de retry incerto.
- Salvar permanece explícito; não implementar autosave. “Concluir edição” só fecha o painel.
- Manter rascunho/publicação separados e mídias privadas; YouTube só conecta após consentimento na leitura.
- Manter Node 18 e destino Linux/VPS; não adicionar dependências sem necessidade demonstrada.
- Não mudar `api/`, migrations, grants, cron, Nginx ou deploy neste escopo. Se um contrato exigir isso, interromper e propor escopo separado.
- Não sobrescrever as seis referências nem as capturas históricas; novas evidências em diretório novo.
- Não substituir o documento aberto por fixture para demonstrar funcionamento real; fixtures apenas no harness sintético.
- Não recriar EditorViews ao abrir/fechar menus, trocar breakpoint ou atualizar controles de seleção.
- Testes não podem esconder elementos ou reduzir a cobertura para passar. Comparações com as pranchas antigas podem registrar divergências intencionais, nunca igualdade falsa.
- Nenhuma alteração de produção ou conteúdo real está autorizada pelo pedido de planejamento.

## Contrato de UX proposto

### Componentes básicos

- Botão primário, secundário, textual, destrutivo e icônico com estados normal, hover, foco, disabled, busy, erro e confirmação aplicáveis.
- Alvo interativo de pelo menos 44×44 CSS px; ícone pode ser menor. Pseudoelementos não podem sobrepor alvos vizinhos.
- Inputs/selects textuais: altura mínima 44 px; no celular fonte mínima 16 px para evitar zoom automático. Checkboxes mantêm indicador de 18–20 px dentro de linha clicável de no mínimo 44 px.
- Foco visível e sem clipping; labels associados; erros locais associados ao campo. Atualizações assíncronas anunciadas sem alertas repetidos a cada tecla.
- Campos com 8 px entre label/controle; grupos com 16 px; seções com 24 px como base. Reduções só onde não comprometam leitura/toque.
- Usar tokens existentes. Remover seletores conflitantes na área tocada em vez de acumular outra camada geral de overrides.

### Três tipos de sobreposição

1. **Menu transitório:** Prévia, Mais ações e Mais opções de texto. Apenas um aberto; Escape fecha e foca acionador. Clique fora fecha sem roubar foco do alvo clicado. Não usar role menu sem implementar a navegação correspondente.
2. **Painel ancorado:** Inserir, Estilo e cor. Mantém ancoragem no desktop e margens seguras no compacto. X/Escape fecham. Estilo tem rascunho local e Aplicar explícito; clique fora não descarta alterações silenciosamente. Conteúdo rola; ações essenciais permanecem visíveis.
3. **Modal de tarefa:** Link, fonte de vídeo, modelo, unir colunas, arquivar e revisão. Centralização, scrim e margem de 16 px; conteúdo rolável; cabeçalho/rodapé acessíveis. Durante escrita bloqueada, não permitir fechamento inseguro; após erro, permitir retry/cancelar conforme o contrato existente.

### Ações principais e inspector

- Salvar em posição fixa e previsível no chrome desktop/mobile, não migrar entre menus conforme dirty. Status visível: salvo, alterações não salvas, salvando, falha/não confirmado e conflito.
- No celular, ações essenciais e status ficam acessíveis também com o painel inferior aberto; conteúdo pode rolar sem cobrir campos/foco. Não criar duas requisições por haver mais de um acionador.
- Publicar indisponível tem aparência disabled e motivo visível, como “Salve o rascunho para revisar”. Pendências de conteúdo aparecem na revisão, com lista e navegação segura para correção.
- Conteúdo: campos específicos do bloco. Estilo: tipografia, cores, fundo, ícone, tags. Posição: largura/composição, mover, duplicar, excluir. Presets legados ficam em Estilo, em seção secundária explicada.
- Não rotular o conteúdo do usuário como ilustrativo apenas por derivar de um template.

## Arquivos e responsabilidades

- `public/css/pages-editor-v2.css`: chrome, layout responsivo, inspector e painéis do editor.
- `public/css/pages.css`: base de campos/dialogs de Pages; evitar impacto no leitor e no catálogo.
- `public/pages/editor-workspace.js`: montagem e posicionamento das ações, estrutura, menus e sheet.
- `public/pages/editor.js`: coordenação com `state`, seleção, vídeo e publicação; sem adicionar outro estado de documento.
- `public/pages/dialog.js`, `editor-panels.js`: ciclo de vida, foco, fechamento e região rolável de sobreposições.
- Novo `public/pages/editor-menus.js`: registro/fechamento de disclosures transitórios; descarte de listeners.
- `public/pages/editor-source.js`: leitura fiel do formato da seleção ProseMirror. Verificar build/bundle atual antes de modificar a distribuição gerada.
- `public/pages/editor-review.js`, `model.js`: apresentação de pendências mantendo validação existente.
- Novo `public/pages/publication-issues.js`: detalhes locais `{code,message,blockId?,itemId?,field?}`; sem alterar contrato da API.
- `public/pages/editor-style.js`: agrupamento do inspector e rodapé de Estilo.
- `public/pages/editor-media.js`, `editor-destinations.js`: campos de mídia e identificação humana de destinos.
- Novo `public/pages/editor-captions.js`: formulário de legendas no contrato atual, somente na entrega A18.
- Novo `tests/visual/check-pages-controls.mjs`: regressão reprodutível dos estados auditados.
- Novo `tests/unit/pages-editor-menus.test.mjs`: ciclo de menus.
- Novo `tests/unit/pages-editor-captions.test.mjs`: validação/edição de legendas.
- Ampliar testes existentes de foco, lifecycle, workspace, revisão, estilo, destinos, mídia e preflight.

## Método de execução e testes

Cada tarefa contém ciclo vermelho → correção mínima → verde → revisão do diff.
Não implementar todas as mudanças antes de testar.

O runner novo aproveita `createPagesDatabaseHarness`, `pagesBrowserContext`,
`pagesBrowserReady` e fixtures existentes. Deve aceitar `PAGES_CONTROLS_CASE`
para selecionar um caso e `PAGES_CONTROLS_OUTPUT` para diretório novo obrigatório.
Falhar se dependências externas estiverem ausentes; não declarar PASS por skip.
Configuração externa: `PGLITE_MODULE_PATH`, `PLAYWRIGHT_MODULE_PATH`,
`AXE_MODULE_PATH`, `FFMPEG_PATH` e `FFPROBE_PATH`, como nos runners atuais.

Invocação por caso depois da configuração dessas variáveis:

```powershell
$env:PAGES_CONTROLS_CASE='menus'
$env:PAGES_CONTROLS_OUTPUT=Join-Path $env:LOCALAPPDATA ('Temp/opencode/pages-controls-' + [guid]::NewGuid())
node tests/visual/check-pages-controls.mjs
```

O runner será construído incrementalmente junto à tarefa 1; cada tarefa seguinte
adiciona o respectivo caso. As amostras de teste abaixo rodam dentro desse runner,
com `p` sendo a página Playwright e helpers reais importados.

### Tarefa 1 — menus de texto e fechamento coordenado

**Achados:** A01, A08. **Depende de:** nenhuma tarefa.

**Arquivos:** criar `editor-menus.js`, `pages-editor-menus.test.mjs` e runner
visual; modificar `editor.js`, `editor-workspace.js`, `pages-editor-v2.css`.

**Interface:** `createEditorMenus({page})` retorna
`{register(details), closeAll({restoreFocus = false} = {}), dispose()}`.
`register` retorna função de unregister. Somente menus transitórios são registrados;
FAQ, opções avançadas e público não entram nesse controlador.

- [ ] Adicionar caso `menus`: abrir Mais opções de texto, medir botões e executar Lista/Remover lista; verificar documento e undo. Testar Prévia→Mais ações e Escape/clique fora.

```js
await p.locator('.pages-format-more > summary').click();
const list = p.getByRole('button', {name:'Lista numerada', exact:true});
assert.ok((await list.boundingBox()).width >= 100);
await p.keyboard.press('Escape');
assert.equal(await p.locator('.pages-format-more').evaluate(n => n.open), false);
```

- [ ] Executar caso `menus` antes da correção: deve falhar pela largura/fechamento.
- [ ] Restringir tamanho icônico a botões compactos; menu textual com linhas legíveis e limites do viewport. Registrar menus no controlador; pointerdown fora fecha sem impedir ação seguinte; Escape afeta apenas a camada superior e respeita IME.
- [ ] Executar `node --test tests/unit/pages-editor-menus.test.mjs tests/unit/pages-editor-focus.test.mjs` e caso `menus`: zero falhas, sem listener remanescente após dispose.
- [ ] Revisar diff, `git diff --check` e commit localizado `fix(pages): make editor menus readable and dismissible`.

### Tarefa 2 — estrutura utilizável em desktop e celular

**Achados:** A02. **Depende de:** tarefa 1.

**Arquivos:** `editor-workspace.js`, `pages-editor-v2.css`,
`tests/unit/pages-workspace-controls.test.mjs`, runner caso `structure`.

**Interface:** conservar `onReorderSection({sectionId,beforeSectionId})` e
identidades atuais; estilos da estrutura funcionam na lateral e no dialog.

- [ ] Adicionar teste abrindo cada Posição e medindo alça, Subir/Descer e summary dentro da área útil do painel em 320/390/768 px.

```js
const d = p.getByRole('dialog', {name:'Estrutura da página'});
await d.locator('.pages-v2-section-entry summary').first().click();
const box = await d.boundingBox();
for (const action of await d.getByRole('button', {name:/seção Capa/}).all()) {
  const r = await action.boundingBox();
  if (r) assert.ok(r.x >= box.x && r.x + r.width <= box.x + box.width);
}
```

- [ ] Executar caso `structure` e registrar falha atual por clipping.
- [ ] Dar linha própria às ações expandidas; alça com alvo 44 px; classes independentes do root; sincronizar modo organizar sem depender de ancestral perdido no reparenting.
- [ ] Testar subir/descer, Alt+setas, arrastar, limites, seleção e foco; não usar CSS ocultando os controles como correção. Confirmar ordem SQL após salvar e undo local.
- [ ] Rodar testes de workspace/foco, revisar e commit `fix(pages): keep section actions inside the structure panel`.

### Tarefa 3 — Salvar previsível e estados reais das ações

**Achados:** A04, A16. **Depende de:** tarefas 1–2.

**Arquivos:** `editor.js`, `editor-workspace.js`, `pages-editor-v2.css`,
testes `pages-state`, `pages-button`, `pages-editor-lifecycle`, runner `save`.

**Interface:** manter `state.save(api)` e o controlador `createPageButton`.
Remover relocação condicionada a dirty; `update()` atualiza estado, não localização.

- [ ] Adicionar teste título→dirty→save pendente→ACK→saved; simular 503 e perda de ACK depois de COMMIT. Verificar Salvar alcançável com painel aberto sem abrir Mais ações.

```js
await pagesEditorPageProperties(p);
await p.getByRole('textbox', {name:'Título',exact:true}).fill('Título alterado');
assert.equal(await p.getByRole('button', {name:'Salvar rascunho',exact:true}).isVisible(), true);
const publish = p.getByRole('button', {name:'Publicar',exact:true});
assert.equal(await publish.isDisabled(), true);
assert.notEqual(await publish.evaluate(n => getComputedStyle(n).backgroundColor), 'rgb(42, 39, 94)');
```

- [ ] Executar caso `save` em 320/390 px antes da mudança e registrar falhas.
- [ ] Fixar ação/status no chrome responsivo, com espaço reservado para não cobrir conteúdo. Manter acesso no painel inferior. Proteger contra clique duplo e preservar atalhos Mod+S. Exibir status de erro/incerteza sem sugerir que alterações posteriores já foram salvas.
- [ ] Verificar retry com o mesmo payload/key, alteração nova durante save, conflito, read-only e permissões. Botão disabled não muda para ativo por hover ou mudança de parent.
- [ ] Executar testes de state/button/lifecycle e caso `save`; revisar e commit `fix(pages): keep save and operation states visible`.

### Tarefa 4 — publicação com pendências visíveis e acionáveis

**Achados:** A03. **Depende de:** tarefa 3.

**Arquivos:** novo `publication-issues.js`; `model.js`, `editor-review.js`,
`editor.js`, CSS; testes `pages-publication-preflight` e `pages-editor-review`;
runner `review`.

**Interface:** `publicationIssueDetails(document,cargos)` retorna array de
`{code,message,blockId?,itemId?,field?}`. A função existente `publicationIssues`
mantém retorno string[] e regras, derivando mensagens sem duplicar validadores.
`openReview` recebe `onIssue(issue)`; fechar revisão e então selecionar/focar o
destino existente. Sem destino seguro, manter mensagem visível e não inventar link.

- [ ] Testar equivalência das mensagens antigas e novas; fixture com público vazio, FAQ incompleta e áudio pendente. Testar destino removido antes do clique.

```js
const issues = publicationIssueDetails(document, cargos);
assert.deepEqual(issues.map(i => i.message), publicationIssues(document, cargos));
assert.ok(issues.some(i => i.blockId === audioId));
await p.getByRole('button', {name:'Publicar',exact:true}).click();
assert.ok(await p.locator('[data-publication-issue]:visible').count() > 0);
```

- [ ] Rodar testes antes da implementação: falha esperada por ausência dos detalhes/lista.
- [ ] Renderizar lista visível, resumo e ação “Corrigir” para destinos resolvidos; público vazio abre audiência; FAQ abre item; mídia foca campo ou substituição. Explicar checks opcionais e não atribuir aprovação de terceiros.
- [ ] Preservar revisão exata, invalidação ao editar, verificação remota e reconciliação de publicação incerta. Nenhum bypass para publicar quando há pendências.
- [ ] Testar revisão longa com cargos, teclado e 320 px; executar testes de preflight/review e runner; commit `fix(pages): expose actionable publication issues`.

### Tarefa 5 — base consistente de dialogs, campos e rodapés

**Achados:** A05, A06, A09, A14. **Depende de:** tarefas 1–4.

**Arquivos:** `dialog.js`, `editor-panels.js`, `editor-style.js`,
`editor-workspace.js`, `pages.css`, `pages-editor-v2.css`; testes de foco/lifecycle/
estilo/revisão; runner `overlays`.

**Interface:** preservar assinatura/retorno dos dialogs existentes. Regiões novas
de conteúdo/ações não podem invalidar controles retidos nem callbacks de cleanup.

- [ ] Adicionar regressão de centralização, margens, foco inicial/restaurado, campo de vídeo 44 px, checkbox 18–20 px e rodapé de Estilo visível em 1366×768.

```js
const d = p.getByRole('dialog', {name:'Link no texto selecionado'});
const r = await d.boundingBox();
assert.ok(r.x >= 16 && r.y >= 16);
assert.ok(Math.abs(r.x + r.width / 2 - p.viewportSize().width / 2) < 2);
```

- [ ] Rodar caso `overlays` antes da mudança e confirmar falhas A05/A06/A09/A14.
- [ ] Centralizar modais de tarefa sem mudar âncoras; conteúdo rolável e footer persistente; incluir X com nome acessível nos dialogs genéricos, respeitando busy. Separar CSS de inputs textuais/checkboxes; classes de dispositivo/zoom funcionam fora da toolbar.
- [ ] Confirmar Escape/X/Cancelar durante normal, busy, erro, IME e navegação. Clique fora não descarta formulário silenciosamente. Cancelar upload continua sem criar bloco vazio.
- [ ] Rodar checks existentes de revisão/style/media além do novo caso; revisar impacto em catálogo/leitor (sem alteração pretendida); commit `fix(pages): unify dialog and field presentation`.

### Tarefa 6 — tablet, contraste e mensagens de modo

**Achados:** A07, A13, A15. **Depende de:** tarefas 3 e 5.

**Arquivos:** `editor-workspace.js`, `pages-editor-v2.css`, `appearance.js`
somente se necessário para métricas canônicas; testes de appearance/renderer/workspace;
runner `responsive`.

**Interface:** manter `viewportGeometry`, esquema e paleta persistidos.
Status de edição/prévia deriva do modo, não do template.

- [ ] Adicionar teste separando último controle da toolbar e topo do canvas; axe no título mobile; aviso não pode chamar conteúdo editado de ilustrativo.

```js
const tools = await p.locator('.pages-v2-tools').boundingBox();
const viewport = await p.locator('.pages-v2-viewport').boundingBox();
assert.ok(viewport.y >= tools.y + tools.height);
assert.equal(await p.getByText('Prévia · conteúdo ilustrativo', {exact:true}).count(), 0);
```

- [ ] Rodar `responsive` e confirmar falhas em 768/390 px.
- [ ] Remover altura fixa nos breakpoints que quebram linha; manter grupos de controles legíveis. Exibir “Edição”/“Prévia” conforme modo. Para A13, corrigir redução móvel inconsistente com a métrica canônica antes de mudar cor: manter cor persistida e conferir tamanho/peso reais. Se AA exigir alteração da cor do conteúdo, oferecer ajuste explícito com confirmação; não reescrever cores do usuário silenciosamente.
- [ ] Testar largura 320,390,599,600,768,1099,1100,1366,1600; alturas 640/768; zoom browser 200% e zoom canvas 50/100/150%; leitura legada e preview. Falha AA não pode ser escondida por exclusão de nós.
- [ ] Executar appearance/renderer/workspace e caso `responsive`; commit `fix(pages): correct responsive chrome and mode feedback`.

### Tarefa 7 — formato real do texto e fonte de vídeo contextual

**Achados:** A10, A11. **Depende de:** tarefas 1 e 5.

**Arquivos:** `editor-source.js`, `editor.js`; testes de mídia/history;
runner `text-video`. Executar pipeline atual de bundle após tocar o source.

**Interface:** adicionar `selectionFormat()` à API de `createRichEditor`, retornando
`'paragraph' | '2' | '3' | 'mixed'`; sincronizar select ao foco/seleção/undo.
`mixed` é opção informativa disabled, não comando de mutação.

- [ ] Testar H2→H3→parágrafo e seleção mista, troca de blocos, FAQ e undo; selecionar texto antes de link/cor.

```js
await p.locator('.ProseMirror h2').first().click();
assert.equal(await p.getByRole('combobox', {name:'Formato do texto'}).inputValue(), '2');
await pagesEditorInsert(p, 'Adicionar vídeo');
assert.equal(await p.getByRole('textbox', {name:'URL do YouTube'}).isVisible(), false);
```

- [ ] Executar `text-video` e observar falhas atuais.
- [ ] Derivar formato dos textblocks selecionados em ProseMirror, não do DOM externo ou último comando. Atualizar sem reconstruir EditorView. MP4: somente explicação privada e “Escolher MP4”. YouTube: URL, aviso de serviço externo e “Inserir vídeo”/“Aplicar fonte” ao substituir.
- [ ] Cancelar seletor mantém documento; URL inválida mantém modal/erro local; mudar fonte preserva conteúdo até confirmação. Não carregar iframe/miniatura externa ao editar.
- [ ] Testar build e checks de mídia/histórico; commit `fix(pages): reflect text selection and contextual video inputs`.

### Tarefa 8 — reorganizar inspector e formulários de mídia

**Achados:** A12, A17. **Depende de:** tarefas 2,5,7.

**Arquivos:** `editor-style.js`, `editor-media.js`, `editor-destinations.js`,
`editor-workspace.js`, `editor.js`, CSS; testes de estilo/mídia/destinos;
runner `inspector`.

**Interface:** manter callbacks atuais de appearance, tags, width e transações.
`data-inspector-section` passa a representar localização correta: content/style/
position; desktop usa os mesmos agrupamentos sem esconder ações existentes.

- [ ] Testar cor personalizada em Estilo, mover/duplicar/excluir em Posição e legado em Estilo. Galeria com 3 itens deve ter identidade, metadados e ações separados.

```js
await p.locator('[data-sheet-tab=style]').click();
assert.equal(await p.getByRole('textbox', {name:'Cor de fundo personalizada'}).isVisible(), true);
await p.locator('[data-sheet-tab=position]').click();
assert.equal(await p.getByRole('button', {name:'Duplicar',exact:true}).isVisible(), true);
```

- [ ] Rodar `inspector` antes das mudanças e confirmar posições/agrupamentos inadequados.
- [ ] Criar grupos planos e espaçados; por item da galeria, título ordinal e miniatura privada quando já disponível. Remover separado de ações de ordem; não pôr controles destrutivos ao lado de Aplicar como se equivalentes. Preservar FAQ inline e EditorViews por ID.
- [ ] Verificar bloco com estilo legado, campos inaplicáveis, undo da remoção, troca de imagem, reordenação, foco por item e estado read-only. Campos longos não rompem largura.
- [ ] Rodar testes específicos, case `inspector`, revisar e commit `refactor(pages): organize inspector and media action groups`.

### Tarefa 9 — mídia com nomes legíveis e legendas sem JSON obrigatório

**Achados:** A18. **Depende de:** tarefa 8. **Gate:** apresentar formulário de
legendas e identificação de arquivos para aceite antes de implementar esta etapa.

**Arquivos:** novo `editor-captions.js` e teste unitário; `editor-media.js`,
`editor-destinations.js`, CSS; runner `captions`. Não alterar storage nem API.

**Interface:** `createCaptionFields({captions,onCommit,canAct,bindNative})`
retorna `{node,sync(captions),dispose()}`. `onCommit(captions)` retorna false
para rejeitar. Interface usa segundos e converte para `start_ms/end_ms` inteiros;
documento continua usando o schema existente. Rascunho inválido fica apenas no
formulário e mostra erro; não entra no documento nem apaga o último valor válido.

- [ ] Adicionar testes de limites: zero/120000 ms, sobreposição, duração nula, fração de milissegundo, texto >1000, >500 cues e `<`, `>`, `-->`. Testar cancelamento, reorder, read-only, undo e composição nativa.

```js
const rows = [{start_ms:0,end_ms:1000,text:'Introdução'}];
assert.equal(rows[0].end_ms > rows[0].start_ms, true);
// No teste de integração: preencher início/fim/texto, aplicar e salvar;
// GET workspace deve devolver exatamente rows no bloco de vídeo criado.
assert.deepEqual(savedVideo.captions, rows);
```

- [ ] Rodar `captions` antes da implementação: falha pela inexistência do formulário.
- [ ] Construir linhas Início/Fim/Texto com adicionar/remover e Aplicar explícito. JSON passa a opção avançada com a mesma validação. Não acrescentar importação SRT/VTT neste lote.
- [ ] Em arquivos, usar `file_name` já existente no inventário e tipo; se ausente usar “Imagem 1”, “Áudio 1”, “Vídeo 1”. UUID apenas como detalhe secundário; preservar ID como value. Não buscar arquivos de outras páginas nem expor URL pública.
- [ ] Validar com MP4 real da fixture local, save/reload e legendas renderizadas; executar testes de mídia/validação, caso `captions`; commit `feat(pages): simplify private media and caption authoring`.

### Tarefa 10 — regressão completa e aceite visual

**Achados:** todos A01–A18. **Depende de:** tarefas 1–9 (ou marcar A18 não
entregue se o gate da tarefa 9 não for aprovado; nunca declarar 18/18 nesse caso).

**Arquivos:** runner visual, testes afetados, auditoria e novo
`docs/reviews/2026-11-16-pages-controls-acceptance.md`.

- [ ] Executar todos os casos com saídas novas, inventariar cada achado como corrigido/pendente e apontar captura/teste. Incluir conteúdo longo, muitos cargos, FAQ e galeria multi-item, fontes diferentes e documentos legados reais no harness.
- [ ] Rodar axe nos estados abertos; conferir foco, hit targets sem sobreposição, clipping local e texto legível. Não basta `document.scrollWidth === innerWidth`.
- [ ] Exercitar salvar, retry incerto, edição durante save, conflito, publicar revisão exata, arquivar/restaurar no harness local, troca de rota e remount sem listeners/URLs privadas remanescentes.
- [ ] Executar `npm run verify` e `git diff --check`; testes visuais/harness são gate separado, não presumir que entram em verify.
- [ ] Comparar geometria/layout principal com referências antigas; manter originais intactos e listar diferenças intencionais deste plano (ações fixas, alvo44, toolbar, dialogs e rodapés).
- [ ] Apresentar preview desktop/tablet/mobile, estados abertos e erro/salvando. Obter aceite humano; touch/IME/teclado virtual e Safari/iOS permanecem pendentes até verificação real.
- [ ] Revisar diff final e documentação. Se houver autorização de agentes, revisão fresca por tarefa e final; sem autorização, revisão inline com evidências e limites explícitos.
- [ ] Só após aceite discutir integração/PR/deploy. Não usar autorização histórica de deploy como autorização para esta nova rodada.

## Checkpoints de entrega

1. **Usabilidade essencial:** tarefas 1–4 — menus, estrutura, salvar e publicação.
2. **Consistência dos componentes:** tarefas 5–6 — dialogs/campos, rodapés e responsividade.
3. **Clareza da autoria:** tarefas 7–8 — seleção fiel, vídeo contextual e inspector.
4. **Autoria de mídia simplificada:** tarefa 9 — aceite específico e testes de legendas.
5. **Aceite final:** tarefa 10 — nenhuma pendência crítica oculta por teste verde.

## Rastreabilidade e revisão do plano

- A01→1; A02→2; A03→4; A04→3; A05→5; A06→5; A07→6; A08→1;
  A09→5; A10→7; A11→7; A12→8; A13→6; A14→5; A15→6; A16→3;
  A17→8; A18→9.
- Dependências sem ciclos; APIs novas definidas onde introduzidas; nenhum schema novo.
- Base visual preservada; mudanças maiores que correção possuem gate de aceite.
- Sem modificações de produção, estimativas de prazo artificiais ou promessa de equivalência de pixels.
- Plano revisto inline contra os 18 achados. Próximo passo é aprovação do plano e
  escolha de execução inline ou agentes por tarefa com revisão, não implementação automática.
