# Editor V2 — auditoria de controles e sobreposições

Data: 16/11/2026. Base local: `0415ca7`, implementação integrada na release `edf808e`.
Pedido: revisar todos os botões, caixas e popups que aparecem durante o uso.

## Resultado

A composição principal está consistente com a direção aprovada, mas estados
expandidos revelam problemas concretos de CSS, descoberta de ações e feedback.
Esta auditoria registra achados; não implementa uma nova direção visual.

Foram feitas 161 capturas de estados e 11 de confirmação em Chromium local: 1366×768, 1600×900, 768×1024,
390×844 e 320×640. A rodada principal incluiu 51 análises axe WCAG A/AA e
nenhum `pageerror`. O harness usa HTTP/SQL reais com PGlite e contas sintéticas;
mídias de imagem/áudio da fixture foram registradas pelo endpoint de upload.
Tráfego externo é bloqueado. Capturas de mídia usam conteúdo sintético mínimo,
não constituem avaliação da qualidade de imagens reais.

## Cobertura

- Cabeçalho: voltar, modelo, desfazer/refazer, dispositivo, zoom, prévia,
  mais ações, propriedades, salvar e publicar.
- Estrutura: seções, organizar, posição, subir/descer, adicionar seção.
- Texto: formato, marcas, link, cor, mais opções, listas e histórico.
- Inspector: conteúdo, estilo, posição, campos, cores, tags, ícone, largura,
  opções avançadas, presets legados, movimentação, duplicação e exclusão.
- Estilo da página: Tema, Tipografia, Cores, inválido, legado, fechamento.
- Inserção: lista, busca, vazio, destaque/botão, outros blocos, FAQ e galeria.
- Mídia: imagem, galeria, áudio, FAQ aberto, fonte privada/YouTube e erro.
- Botões de conteúdo: URL/seção, download, vídeo sem destino e validação.
- Página: metadados, público, confirmação de arquivo, criação por modelo.
- Sobreposições: link, cor, unir colunas, vídeo, modelo, arquivar, revisão.
- Publicação: bloqueada, cargos expandidos, checks e pendências.
- Salvamento: alteração local, operação em andamento e falha HTTP simulada.

Cobertura é de superfícies e estados, não uma afirmação de que toda combinação
de controles ou todas as operações destrutivas foram executadas. Touch/IME e
teclado virtual físicos, Safari/iOS, autenticação produtiva e publicação real
não foram exercitados nesta auditoria.

## Achados prioritários

### A01 · P1 — menu de texto ilegível ao expandir

`public/css/pages-editor-v2.css:357` — a largura de 30 px dos botões icônicos
também atinge botões textuais dentro de `.pages-format-overflow`.
“Lista numerada”, “Remover lista” e “Desfazer texto” quebram em colunas de letras,
invadem a barra e cobrem o conteúdo. Reproduzido em 1366 e 1600 px.

Evidência: `1366-text-more.png`, `1600-text-more-wide.png`.
Correção proposta: limitar a regra aos controles compactos e organizar o menu
em linhas com largura de conteúdo, rótulo e estado legíveis.

### A02 · P1 — estrutura mobile corta ações de posição

`public/css/pages-editor-v2.css:38-41` — a coluna de ações tem 32 px, mas contém
alça de pelo menos 44 px e um disclosure com rótulo e botões textuais.
`public/pages/editor-workspace.js:166-168` move a estrutura para um dialog fora
de `#page-editor-root`, perdendo parte das regras de contexto.
No celular, “Posição”, “Subir” e “Descer” ultrapassam a lateral do painel.

Evidência: `390-structure-organize.png`, `390-structure-position-open.png`.
Correção proposta: ações por seção com espaço próprio e estilos válidos tanto
na lateral quanto no dialog; garantir alcance integral por toque e teclado.

### A03 · P1 — publicar fica bloqueado sem explicar visualmente o que corrigir

`public/pages/editor-review.js:170-178` — a revisão mostra apenas a quantidade
de pendências; os motivos ficam em `title` e texto visualmente oculto. A captura
tem “4 pendência(s)” e Publicar desabilitado, sem lista visível de correções.
Tooltip não é uma solução confiável em touch ou em botão desabilitado.

Evidência: `1366-review-blocked.png`, `390-review-blocked.png`.
Correção proposta: lista visível de pendências com acesso ao campo/bloco afetado;
deixar explícito que a conferência pessoal é opcional.

### A04 · P1 — salvar e seu status desaparecem do contexto mobile

`public/pages/editor.js:60` — quando há alteração, Salvar sai das propriedades
e vai para `.pages-primary-actions`. No celular esse grupo está dentro de Mais
ações (`public/pages/editor-workspace.js:221`).
`public/css/pages-editor-v2.css:476` oculta visualmente o status de salvamento.
Após editar o título, o botão deixa o formulário e fica no menu fechado.
Ao salvar, o menu fecha e “Salvando…” também não fica visível.

Evidência: `390-dirty-properties.png`, `390-save-busy.png`.
O salvamento funciona ao reabrir Mais ações; não foi observada perda de dados.
Correção proposta: destino estável e visível para Salvar e status permanente
de alterado/salvando/salvo/erro, inclusive no painel mobile.

## Layout, consistência e interação

### A05 · P2 — diálogos genéricos abrem em (0,0)

`public/css/pages.css:197` e `public/css/layout.css:1` — o reset zera margens,
mas o dialog genérico não restaura a centralização. Link, vídeo e confirmações
ficam colados ao canto superior esquerdo; revisão e painéis usam outros padrões.
Medição do dialog de link: x=0, y=0, largura 580 no desktop e 352 no celular.

Evidência: `1366-video-private.png`, `1600-link-selected.png`,
`390-link-selected.png`, `1366-model-confirm.png`, `1366-archive-confirm.png`.
Correção proposta: base comum de modal, margens seguras, cabeçalho, fechamento,
rolagem e rodapé de ações; distinguir modal central de painel ancorado.

### A06 · P2 — checkbox de cargo herda dimensões de campo de texto

`public/css/pages-editor-v2.css:195` — `:is(input, .pages-review-visibility)`
tem especificidade suficiente para sobrepor a regra de checkbox da linha 215.
Na revisão a 390 px, um checkbox ocupa aproximadamente 204×37 px; o marcador
nativo fica enorme e o nome do cargo é empurrado para a direita.

Evidência: `390-review-audience.png`, dados em `audit.json`.
Correção proposta: restringir estilos aos inputs textuais; fixar a área visual
do checkbox e manter a linha inteira como alvo de interação.

### A07 · P2 — toolbar de tablet invade a área do documento

`public/css/pages-editor-v2.css:26` — flex com quebra de linha e altura fixa
de 56 px. A 768 px, o segundo grupo cai abaixo da barra e cobre o cabeçalho
do canvas/status.

Evidência: `768-base.png`.
Correção proposta: altura derivada do conteúdo ou distribuição responsiva
explícita para a faixa intermediária.

### A08 · P2 — menus não coordenam fechamento

`public/pages/editor-workspace.js:213` e `public/pages/editor.js:285,748` —
Escape não fecha o menu de Prévia nem Mais opções de texto; clicar fora também
mantém Prévia aberta. No celular é possível abrir Mais ações por baixo de Prévia.
Isso foi reproduzido nas quatro larguras da rodada principal.

Evidência: registros `*-preview-escape`, `*-preview-outside` em `audit.json`,
`320-more-menu.png` e `text-more-escape` em `followup.json`.
Os dialogs nativos testados fecham por Escape; o achado é dos menus disclosure.
Correção proposta: um menu transitório por vez, Escape/clique fora consistentes
e restauração do foco no acionador correto.

### A09 · P2 — controles perdem estilo ao sair do workspace

`public/css/pages.css:78,85` — o select de dialog genérico não recebe a mesma
altura/fonte dos campos. “Fonte do vídeo” mede somente 19 px de altura.
`public/css/pages-editor-v2.css:240,259` aplica o acabamento dos selects apenas
sob `.pages-v2-tools`; no menu mobile eles são movidos para o cabeçalho, com
select nativo e ícone/chevron separados visualmente.

Evidência: `1366-video-private.png`, `390-video-private.png`, `320-more-menu.png`.
Correção proposta: estilos por componente reutilizável, independentes da posição
no DOM; estados de foco, disabled e alvo de toque consistentes.

### A10 · P2 — fonte de vídeo exibe campos irrelevantes

`public/pages/editor.js:532-542` — mesmo com “Upload MP4 privado” selecionado,
aparecem URL do YouTube e um parágrafo longo sobre serviço externo. Não há
mudança de visibilidade por fonte; “Confirmar fonte” só então abre o arquivo.

Evidência: `1366-video-private.png`, `390-video-private.png`.
Correção proposta: revelar somente os campos da fonte escolhida e usar ação
específica, como “Escolher MP4” ou “Inserir vídeo”.

### A11 · P2 — seletor de formato não representa o texto selecionado

`public/pages/editor.js:272-274,342` — o select inicia em `paragraph` e não é
sincronizado com a seleção. Ao clicar no H2 real, continua mostrando “Texto”.
O callback de seleção atualiza as marcas, mas não o formato do parágrafo.

Evidência: `1600-heading-selected.png`, `390-heading-selected.png`; os registros
mostram `format: "paragraph"` com foco no editor cujo conteúdo é H2.
Correção proposta: derivar formato e estado misto da seleção real.

### A12 · P2 — formulário de galeria sem separação entre itens e ações

`public/pages/editor-media.js:89-114` — metadados, substituir, subir/descer e
remover são acrescentados ao mesmo fluxo, sem agrupamento visual de ações.
Na captura, os botões encostam entre si e nos rótulos seguintes; os itens não
têm identificação visual própria no inspector. O mesmo padrão afeta destino
de download (`public/pages/editor-destinations.js:43,93`).

Evidência: `1366-gallery-fields.png`, `1366-button-download.png`.
Correção proposta: espaçamento consistente entre campos, identificação de item,
grupo de ações compacto e tratamento distinto para remoção.

### A13 · P2 — contraste do título laranja falha no mobile

`public/css/pages-editor-v2.css:460-461` — o título do modelo cai para 19 px e
peso 650. No texto da fixture aprovada, `#E84F1C` sobre branco foi sinalizado
pelo axe: contraste 3,77:1, abaixo dos 4,5:1 exigidos para o texto detectado.
Reproduzido a 320 e 390 px; não atribuir o erro a todos os botões laranja.

Evidência: `audit.json`, violação `color-contrast` no span de cor de texto.
Correção proposta: verificar a combinação tipografia/cor em cada breakpoint
e oferecer uma escolha de cor que atenda ao contraste desejado.

### A14 · P2 — footer de Estilo perde visibilidade em laptop

`public/css/pages-editor-v2.css:143,375` — altura fixa de 663 px combinada com
âncora e max-height. Em 1366×768, Aplicar estilo fica parcialmente cortado na
abertura e os controles de legado ficam abaixo da rolagem.

Evidência: `1366-style-theme.png`. A ação continua alcançável rolando o painel;
o problema é descoberta/visibilidade inicial, não impossibilidade de aplicação.
Correção proposta: conteúdo rolável e ações persistentes no rodapé.

### A15 · P2 — aviso de exemplo continua após editar conteúdo real

`public/pages/editor-workspace.js:87,292-294` — “Prévia · conteúdo ilustrativo”
depende somente do template `guia-interno`, não do modo nem da existência de
conteúdo ilustrativo. Permanece no editor após alterar o título.

Evidência: `390-dirty-properties.png` e condição no código.
Correção proposta: texto correspondente ao modo de edição; eventual aviso de
modelo deve ser contextual à criação, não afirmar a natureza do conteúdo atual.

### A16 · P2 — Publicar desabilitado parece ativo no celular

`public/css/pages-editor-v2.css:13,240-241` — as regras posteriores da toolbar
reaplicam a pintura primária sobre o estado disabled. Após alterar o título,
`public/pages/editor.js:62` desabilita Publicar, mas ele permanece roxo sólido.

Evidência: `390-dirty-properties.png`, `390-save-busy.png` e cascata CSS.
Uma rodada adicional confirmou `disabled: true`, fundo `rgb(42, 39, 94)` e
opacidade 1 no celular; o desktop usa o fundo disabled `rgb(236, 235, 232)`.
Correção proposta: estado disabled compartilhado com precedência adequada em
todos os locais onde o botão é montado.

## Melhorias de organização recomendadas

### A17 · P3 — inspector avançado concentra responsabilidades diferentes

`public/pages/editor-style.js:209-216` e `public/pages/editor.js:197-261` — cor
personalizada, mover, duplicar, excluir, destino, presets legados e composição
ficam no mesmo disclosure; no mobile esse conteúdo está em “Posição”.
Recomenda-se separar conteúdo, aparência e organização, mantendo compatibilidade
legada com explicação curta e apresentação secundária.

### A18 · P3 — autoria de mídia expõe detalhes técnicos excessivos

`public/pages/editor-destinations.js:61` usa tipo + UUID como nome de arquivo.
`public/pages/editor-media.js:65-74` pede legendas sincronizadas em JSON.
São controles reais, mas exigem conhecimentos técnicos do autor.
Recomenda-se identificação humana/miniatura de arquivos e formulário ou importação
de legendas apropriado ao fluxo editorial. O campo JSON foi identificado no código;
a edição completa de legendas MP4 não foi exercitada nesta rodada.

## Ordem proposta para correções

1. A01–A04: menus legíveis, estrutura utilizável, publicação explicável e salvar visível.
2. A05–A09 e A16: base de dialogs, campos/checkboxes, tablet e estados consistentes.
3. A10–A15: clareza dos fluxos e fidelidade do estado exibido.
4. A17–A18: reorganização do inspector e facilitação da autoria de mídia.

## Evidências e reprodução

Diretórios locais novos, sem sobrescrever as capturas de aceite:

- `C:/Users/Criação/AppData/Local/Temp/opencode/pages-controls-audit-20261116/`
  — 133 capturas, inventário DOM/geometria, 51 resultados axe e erros do runner.
- `C:/Users/Criação/AppData/Local/Temp/opencode/pages-controls-followup-20261116/`
  — 17 capturas: 1600 px, heading, legado, inserções vazias e salvamento.
- `C:/Users/Criação/AppData/Local/Temp/opencode/pages-controls-focused-20261116/`
  — 11 capturas: seleção real de texto, link/cor, posição mobile e salvar/erro.
- `C:/Users/Criação/AppData/Local/Temp/opencode/pages-controls-state-confirmation-20261116/`
  — 11 capturas adicionais e propriedades computadas para confirmar A16.

Runners locais preservados em `.superpowers/audit-editor-controls.mjs` e
`.superpowers/audit-editor-followup.mjs` (diretório de trabalho ignorado pelo Git).
Usam `PGLITE_MODULE_PATH`, `PLAYWRIGHT_MODULE_PATH`, `AXE_MODULE_PATH`,
`FFMPEG_PATH`, `FFPROBE_PATH` e diretório novo `AUDIT_OUTPUT`.

Três interrupções iniciais de automação foram investigadas:

- Cor sem seleção mostrava corretamente “Selecione o texto”; a rodada focada
  selecionou texto e abriu o dialog real, inclusive no celular.
- O seletor genérico “Posição” encontrou a aba oculta; a rodada focada usou o
  summary da estrutura e confirmou o corte lateral das ações.
- Salvar desapareceu das propriedades depois da edição; reabrir Mais ações
  permitiu exercitar o request. Esse comportamento fundamenta A04.

`npm run verify`: 1.197 testes, 1.193 aprovados, zero falhas, quatro skips
(dependências/gates externos não configurados nessa execução), `verify: ok`.
Os testes gerais verdes não cobrem os estados expandidos documentados acima.

Nenhum arquivo de runtime foi alterado nesta auditoria.
