# Prévia visual Conecta

## Integração funcional de referência (Task 17)

Com as instalações externas existentes, execute:

```sh
npm run build:pages
npm run check:pages-build
npm run verify
git diff --check
node tests/database/check-pages.mjs
node tests/database/check-pages-v3.mjs
node tests/visual/check-pages-v2.mjs
node tests/visual/check-pages-mobile-reference.mjs
```

Defina `PGLITE_MODULE_PATH`, `PLAYWRIGHT_MODULE_PATH`, `AXE_MODULE_PATH`,
`PAGES_REFERENCE_DIR`, `FFMPEG_PATH` e `FFPROBE_PATH` com as instalações/originais
externos já disponíveis. FFmpeg/ffprobe usam caminhos absolutos. Não é necessário
instalar dependências de runtime, iniciar Docker ou acessar contas/bancos existentes.
Cada check fecha somente seu próprio loopback/PGlite e temporários exclusivos.

`V2_VISUAL_OUTPUT` escolhe a pasta V2; sua subpasta `feature-roundtrip/` contém a
sequência integrada. Pode-se repeti-la isoladamente com
`node tests/visual/check-pages-feature-roundtrip.mjs` e `FEATURE_VISUAL_OUTPUT`.
Usa `featureDocument` completo, criação real do Guia, upload registrado, controles
de marcas/propriedades/estrutura/mídia, save/reload, prévia e publicação da revisão
exata. SQL/API confirmam os bytes e a leitura por cargo; um rascunho posterior não
altera a publicação. A fixture inicial é preparada via API; os botões de download
e vídeo são criados e configurados pela UI, salvos e recarregados. Suas ações são
exercitadas na prévia e no leitor: download autenticado e foco no consentimento do
vídeo, sem carregar iframe. Falhas independentes de save conservam dirty/head;
timeout é injeção de transporte, não medição de servidor lento.

As capturas `comunicado-{before,after,undo}.png` e
`owner-news-{before,after,undo}.png` são comparadas byte a byte, junto dos estilos
computados, para abrir/cancelar/no-op/prévia/undo sem migração silenciosa. São
comparações de invariância na execução atual, não goldens de uma release antiga.
`MOBILE_VISUAL_OUTPUT` seleciona a pasta mobile, incluindo `feature-reader-390.png`
do fluxo completo de foreground e `mobile-content-390.png` do estado de referência.
Use diretórios novos para preservar capturas de rodadas anteriores.

Consulte a [matriz PASS/PENDING/BLOCKED](../../docs/reviews/2026-11-11-pages-reference-fidelity.md)
para comandos/evidências, regressões anteriores reutilizadas e limites. PG16 nativo,
restore Bash, Nginx efetivo, autenticação real e aparelho físico não são comprovados
por Chrome/PGlite. Aceite final das seis pranchas pertence à Task 18.

## Revisão editável de Pages (Task 15)

### Regressão final dos controles (melhorias Task 10)

Execute os casos `menus`, `structure`, `save`, `review`, `overlays`, `responsive`,
`text-video`, `inspector` e `acceptance` serialmente.

Seleção do caso: argumento posicional explícito > `PAGES_CONTROLS_CASE` > `menus`.
Valores inválidos (inclusive vazios explícitos) falham antes dos imports externos,
do harness e da criação de evidência; nunca caem silenciosamente em `menus`.
O caso `text-video` inclui os alvos B/I/U/Link da folha em 320/390/768 px,
Conteúdo/Estilo e scroll inicial/final/revelado, colisões e comandos reais.

Use `node tests/visual/check-pages-controls.mjs <caso>`, cada um com pasta nova em
`PAGES_CONTROLS_OUTPUT`. Use as instalações externas existentes via
`PGLITE_MODULE_PATH`, `PLAYWRIGHT_MODULE_PATH` e `AXE_MODULE_PATH` (responsive,
review e acceptance). O último caso prepara SQL sintético **antes** da abertura:
30 parágrafos longos e 62 cargos, 1366/768/390 px, teclado/clique externo com foco,
axe A/AA nos estados abertos e três reaberturas da estrutura reutilizada. Registra
incompletos axe separadamente, não como passes. As suítes amplas afetadas continuam
um gate separado de `npm run verify`. O inventário A01–A18, referências, capturas e
limites estão em `docs/reviews/2026-11-16-pages-controls-acceptance.md`; A18 está
adiado pelo usuário, não entregue. Nenhum teste substitui aceite humano, Safari ou
touch/teclado virtual/IME físicos.

### Inspector e formulários de mídia (melhorias Task 8)

`node tests/visual/check-pages-controls.mjs inspector` usa `PGLITE_MODULE_PATH`,
`PLAYWRIGHT_MODULE_PATH` e uma pasta **nova** em `PAGES_CONTROLS_OUTPUT`. Cria páginas
pela API e edita pela UI real em 1366/390 px, sem substituir o documento aberto.
Confere Conteúdo/Estilo/Posição, presets legados, hexadecimal, largura, duplicar/
excluir/undo, três uploads registrados, ordinal/identidade/metadados, miniatura blob
privada sem GET adicional, grupos ordem/remoção, troca/remoção/undo, campos longos,
download, SQL/save/reload, PM retido e publicador somente leitura. Não oculta ações
para passar; tabs/scroll são os controles reais. Use também as suítes existentes
`check-pages-editor-media.mjs` (`MEDIA_VISUAL_OUTPUT`), `check-pages-style.mjs`
(`STYLE_VISUAL_OUTPUT`), `check-pages-buttons.mjs` (`BUTTONS_VISUAL_OUTPUT`) e
`check-pages-history.mjs` (`HISTORY_VISUAL_OUTPUT`). Mídia exige os binários externos
FFmpeg/ffprobe. Não é aceite visual das seis pranchas nem validação de serviços reais.

### Controles e sobreposições (melhorias Task 5)

`node tests/visual/check-pages-controls.mjs overlays` usa `PGLITE_MODULE_PATH`,
`PLAYWRIGHT_MODULE_PATH` e um diretório **novo** em `PAGES_CONTROLS_OUTPUT`. Confere
Link/vídeo/Estilo no workspace real, primeira frame da âncora, 1366×768, campos,
checkboxes, foco, IME, busy/erro/retry e descarte. O formulário sintético de lifecycle
usa o módulo de diálogo real sem substituir o documento do editor. Salvar permanece
explícito; API/SQL descartáveis, identidades sintéticas e tráfego externo bloqueado.
O check de estilo existente mantém `--strict-reference-geometry` para o alvo
histórico; o modo funcional exige o novo alvo real de 44 px e classifica a diferença,
sem sobrescrever referências ou declarar igualdade de capturas antigas.

### Responsividade, contraste e modo (melhorias Task 6)

`node tests/visual/check-pages-controls.mjs responsive` usa as mesmas variáveis e
`AXE_MODULE_PATH` para axe real. A saída precisa ser nova. Não altera as seis
referências: registra 18 combinações de largura/altura, canvas 50/100/150%, prévia,
texto editado, v1/v2/v3, PM retido e nenhum save implícito. Confere geometria local,
alvos/hit-testing/colisões, linhas do título, toolbar/canvas e contraste do título
laranja com resultado axe completo. Resultados incompletos são preservados e falham.
Cria um perfil Chrome descartável dentro da saída para zoom **nativo** 200%, via
`chrome://settings`/`settingsPrivate.setDefaultZoom(2)`. Verifica DPR/viewport/scale
em tempo de execução e falha se não conseguir provar esse zoom. Também registra
a tentativa de atalho headless e a evidência de reflow equivalente, sem confundi-las
com o zoom nativo. Nenhum perfil pessoal ou serviço existente é usado.

O subcaso `pages-editor-responsive-targets.mjs` executa o mesmo medidor/assertor de
alvos em **648 combinações únicas**: v1/v2/v3 × edição/prévia × browser 100/200%
× canvas 50/100/150% × as nove larguras CSS × alturas CSS 640/768. Não infere
colisões ou hit-testing de uma combinação para outra. Mede os pseudoalvos, seus
quatro pontos de borda, contenção local, tamanho mínimo e colisões; selects nativos
também recebem hit-testing. Controles disabled mantêm tamanho/colisões verificados,
mas não se afirma ativação de seus pontos de borda (os resultados brutos ficam
registrados). No zoom nativo 200%, o viewport físico é duplicado para produzir
EXATAMENTE as nove larguras/duas alturas CSS requeridas; cada linha registra ambos,
DPR 2 e escala pinch 1. `target-matrix.json` guarda todas as medições e o check
exige 648 chaves distintas. Título v3 exige cor computada `rgb(232, 79, 28)`, strong
real, peso computado >=700 e tamanho canônico 20 px em cada combinação de ambos
os modos. Axe continua completo no caso principal, sem repetição por combinação.

O renderer funcional distingue a tipografia canônica dos metadados do Guia
(14/12 px) da antiga asserção genérica (32/16 px), ainda preservada com
`node tests/visual/check-pages-renderer-v3.mjs --strict-reference-typography`.
Nesse modo estrito também se conserva o antigo probe que escreve diretamente a
largura da superfície; o funcional varia seu viewport autoritativo e exige a largura
real resultante, pois ResizeObserver é o dono da superfície. A mudança é de teste,
não de renderer ou de conteúdo persistido. O estrito não representa um PASS visual.

`node tests/visual/check-pages-review.mjs` usa as instalações externas indicadas por
`PGLITE_MODULE_PATH`, `PLAYWRIGHT_MODULE_PATH` e `AXE_MODULE_PATH`, além de
`PAGES_REFERENCE_DIR` com os PNGs originais. Não instala dependências nem inicia
serviços existentes. `REVIEW_VISUAL_OUTPUT` escolhe a pasta de captura/`results.json`.
O teste confere o hash da prancha de revisão, geometria 1600×1160, campos revisionados,
sugestões/cargos, publicação exata, falha e perda de ACK após COMMIT, CAS e publicador
somente leitura. Usa Chrome, API/SQL reais em PGlite serializado e identidade sintética.
O check V2 existente também percorre o modal responsivo e o writer legado desligado.
Essas evidências não são aceite final das seis pranchas nem gates de serviços nativos.

## Aceite do Código de Ética

`check-ethics.mjs` tem servidor loopback próprio e não usa `serve-conecta.mjs`.
Exercita a tela e os helpers/rotas reais com Firebase e SQL substituídos, incluindo
as contas viewer/admin/superadmin, links diretos, aceite entre navegadores,
teclado, falhas, versão e troca de conta. Audita seis larguras com axe WCAG A/AA.
Use as variáveis `PLAYWRIGHT_MODULE_PATH` e `AXE_MODULE_PATH` descritas abaixo e
execute `node tests/visual/check-ethics.mjs`. Consulte os contratos e limites em
[`docs/product/ethics-acceptance.md`](../../docs/product/ethics-acceptance.md).

## Prévia geral

O servidor abaixo é exclusivo para inspeção local. Serve o frontend real com
substitutos de autenticação e dados claramente rotulados. Escuta somente em
`127.0.0.1`, recusa gravações e não encaminha requisições para serviços externos.
Não comprova Firebase, banco, entrega de email ou persistência em produção.

```sh
node tests/visual/serve-conecta.mjs
```

Abra `http://127.0.0.1:4178/dashboard.html`. Instale Playwright em um diretório
temporário externo ao projeto. Para registrar capturas e testar reflow, headings,
imagens, menu mobile e navegação persistente:

```sh
PLAYWRIGHT_MODULE_PATH=/caminho/externo/node_modules/playwright/index.mjs \
node tests/visual/check-conecta.mjs
```

O navegador padrão é Chrome instalado (`BROWSER_CHANNEL=chrome`).
`VISUAL_OUTPUT` altera a pasta de evidências; `VISUAL_WIDTHS=1920,402` restringe
uma repetição àquelas larguras. O padrão confere 1920, 402, 360, 768 e 1366 px.
Capturas e resultados ficam no diretório local ignorado da execução SDD.

Para auditoria automatizada WCAG A/AA, instale também `@axe-core/playwright` no
diretório externo e execute:

```sh
PLAYWRIGHT_MODULE_PATH=/caminho/externo/node_modules/playwright/index.mjs \
AXE_MODULE_PATH=/caminho/externo/node_modules/@axe-core/playwright/dist/index.mjs \
node tests/visual/check-conecta-accessibility.mjs
```

O relatório `accessibility.json` inclui violações e itens que exigem revisão
manual. `VISUAL_ROUTES=dashboard,knowledge` restringe as rotas dessa auditoria.
Ausência de violações automatizadas não substitui inspeção de teclado, foco,
alvos de toque e estados interativos.

### Login V3.5 revisado

`check-login-approved.mjs` confere as pranchetas P17D-R1 e P17M-R1 do arquivo
`Conecta-Ownerinc-V3.5-Aprovado.pen`: marca responsiva, frase de boas-vindas,
botões de largura igual e espaçamento de 12 px. O bloco público PodFalar fica
em cartão independente logo abaixo do cartão de acesso, com a mesma largura e
intervalo de 16 px, fora de todos os formulários, conforme a revisão solicitada
após a aprovação das pranchetas. Confere alinhamento nos quatro estados de acesso.
Confere também o carregamento da logo horizontal original do PodFalar, sua
largura de 108 px, proporção e nome acessível, sem distorções ou overflow.
Percorre login, recuperação e cadastro com senha em dez larguras de
320 a 1920 px, com axe WCAG A/AA e restauração do foco. No mobile, mede a
centralização vertical/horizontal do conjunto; em 360 × 480/568/667 px verifica
rolagem natural e acesso aos campos de login/cadastro e ao rodapé, sem cortes no topo. Isso não
substitui teste com teclado virtual em aparelho físico. Exercita ordem por Tab,
mostrar/ocultar senha, confirmação divergente sem envio, limpeza das senhas,
contratos de envio simulados e nova aba isolada do canal.

```sh
PLAYWRIGHT_MODULE_PATH=/caminho/externo/node_modules/playwright/index.mjs \
AXE_MODULE_PATH=/caminho/externo/node_modules/@axe-core/playwright/dist/index.mjs \
node tests/visual/check-login-approved.mjs
```

Aceita `VISUAL_ORIGIN` somente em `127.0.0.1`. `VISUAL_OUTPUT` escolhe a pasta de
capturas e `results.json`; o padrão usa `opencode/login-approved-visual` no
diretório temporário do sistema. Todas as gravações e a navegação externa são
substituídas no navegador: esse teste não envia emails nem acessa o canal real.

`check-conecta-interactions.mjs` usa a mesma variável `PLAYWRIGHT_MODULE_PATH`
para conferir detalhes, modais, Escape/retorno de foco, validação de filtros,
curso/aula e erro independente/retentativa do dashboard em 1920/402/360 px.
Também percorre AutoCard, Cards Pós, perfil, administração e dashboard no mesmo
documento, verificando a superfície do shell, fonte, heading único e reflow.

`check-conecta-editor-focus.mjs` percorre o formulário Vaga do AutoCard com
Tab/Shift+Tab em 360×874, 768×874 e 1366×768. Verifica os limites do viewport e
usa hit-testing para detectar controles focados cobertos pela barra de ações.

`check-pos-inline-viewport.mjs` verifica o editor inline dos Cards Pós com
redução sintética do visualViewport, offsets, restauração, abertura com área já
reduzida, mudança de breakpoint e descarte de listeners/overrides na navegação.
É uma regressão de geometria/oclusão; não representa teste em aparelho físico.

`compare-conecta-art.mjs` compara a árvore renderizada das artes de quatro
modelos AutoCard e dos dois Cards Pós em larguras iguais. Extraia o `public/`
da revisão-base em uma pasta temporária e sirva uma segunda instância:

```sh
VISUAL_PUBLIC_ROOT=/caminho/temporario/base/public PORT=4179 \
node tests/visual/serve-conecta.mjs
PLAYWRIGHT_MODULE_PATH=/caminho/externo/node_modules/playwright/index.mjs \
node tests/visual/compare-conecta-art.mjs
```

O servidor em 4178 continua servindo o checkout atual. A comparação registra
fontes, cores, geometria e capturas dos canvases, sem realizar exportação ou
gravação autenticada. Diferenças devem ser inspecionadas; somente executar o
script não comprova que as artes estão preservadas.

## Editor V2 — referências originais e fixture v3

### Renderer compartilhado v3

`node tests/visual/check-pages-renderer-v3.mjs` requer as instalações externas
`PGLITE_MODULE_PATH`, `PLAYWRIGHT_MODULE_PATH`, `AXE_MODULE_PATH`, `FFMPEG_PATH` e
`FFPROBE_PATH`. Usa Chrome e API/arquivos privados reais em PGlite serializado,
somente identidades sintéticas e recursos loopback próprios. Não instala nada,
não conecta a serviços existentes e bloqueia rede externa. Conta **zero** pedidos
YouTube antes do clique informado; depois serve um stub local, sem player ao vivo.

`RENDERER_V3_VISUAL_OUTPUT` escolhe capturas/`results.json`; padrão
`opencode/pages-renderer-v3` no temporário. Cobre lifecycle/reorder de galeria,
GIF explícito, FAQ independente por teclado, cores/captions computadas com o gate
AA canônico, leitura amigável, prévias staged/revision, superfícies 180/390/1044,
layout do editor existente e regressões v1/v2. Não antecipa authoring de novos
blocos/marcas ou o aceite visual final do workspace; gates nativos permanecem pendentes.

### URL amigável e navegação persistente

`node tests/visual/check-pages-friendly-route.mjs` requer `PGLITE_MODULE_PATH` e
`PLAYWRIGHT_MODULE_PATH` externos já instalados. Usa Chrome (`BROWSER_CHANNEL`,
padrão `chrome`), API/SQL reais em banco descartável serializado e Firebase
sintético; bloqueia chamadas externas. Inicia/encerra apenas seus recursos loopback.
`FRIENDLY_VISUAL_OUTPUT` escolhe os artefatos; padrão `opencode/pages-friendly-route`
no temporário. Sem credenciais, serviços existentes ou conteúdo real.

Visita direta ocorre antes de SPA. Cobre refresh/hash sem refetch, dashboard sem
base→alias→editor/Pages, assets 200, documento/sidebar preservados, Back/Forward,
login real→Ética com escolha explícita e SQL→alias/query/hash, erros/404, audiência
e mudança de conta com leitura pendente. A regra estática é uma **simulação** do
shell Nginx: não substitui `nginx -t` nativo (pendente sem Linux autorizado), nem
PostgreSQL 16, autenticação Firebase real ou homologação de produção.

### Referências e fixture

`tests/helpers/pages-reference-document.mjs` exporta dois produtores puros:
`referenceDocument()` para comparação visual e `featureDocument()` para cobertura
funcional, nunca como golden visual. Ambos criam um novo objeto profundo por
chamada, sem I/O, com UUIDs estáveis, schema 3,
`guia-interno@1` e cinco seções Capa/Introdução/Orientações/Galeria/Dúvidas
frequentes. É um **rascunho de teste**, não um documento real nem código importado
pelo runtime. A receita de produção é independente e só é anunciada com writer v3
habilitado; o helper não cria conta, audiência, publicação ou upload real.

### Workspace desktop (Task 14)

`node tests/visual/check-pages-workspace.mjs` requer as instalações externas
`PGLITE_MODULE_PATH` e `PLAYWRIGHT_MODULE_PATH`. Usa API/SQL e Chrome reais, apenas
contas sintéticas e listeners loopback próprios, com rede externa bloqueada.
`WORKSPACE_VISUAL_OUTPUT` escolhe os artefatos; padrão `opencode/pages-workspace`
no temporário. O harness expõe `__referenceDraft()` apenas na resposta JS servida
ao seu contexto de teste, nunca no arquivo de produção.

`desktop-editing-1600.png`, `desktop-style-1600.png` e
`desktop-insert-1600.png` são capturas da implementação, **não novos goldens**.
`results.json` inclui geometria observada e cenários. Mede 1366/1600, dispositivo
desktop/celular390, cinco zooms, scrollWidth/scrollHeight reais, reflow, drag/caret
em todas essas combinações, toolbar sem sobrepor texto, alvos por teclado e
contexto de toque simulado, PM/JSON estáveis,
modelo/cancel/guarda/ACK perdido/falha de navegação, save/readonly e Portal. Não
substitui asserções por registro: os painéis exigem os retângulos exatos da fonte,
e introdução/cards/FAQ/áudio usam âncoras com tolerância máxima de 2 px. Também cobre
v2 `two_equal` com mobile390 dentro de navegador largo, retorno ao desktop sem
alterar JSON/EditorViews e labels prospectivos após small/large → standard. Não
homologa todas as seis pranchas (Task 18), mobile completo (Task 16), Auth real,
PostgreSQL/Nginx nativos, IME ou dispositivo físico.

A fixture visual contém apenas os tipos retratados `rich_text`, `audio` e `faq`.
Galeria preserva sua seção/linha/coluna com `blocks: []`. A fixture funcional
preenche essa mesma coluna com `image`, `gallery` e `button`, conservando todos
os IDs compartilhados, sem compartilhar objetos mutáveis. Seus blocos são
conteúdo visível no mesmo renderer, não elementos ocultos por cenário.

`referenceIds` é um objeto congelado de UUIDs nomeados. As chaves
`coverSection`, `introductionSection`, `orientationsSection`, `gallerySection`
e `faqSection` identificam seções; `coverBlock`, `introductionBlock`,
`dailyBlock`, `meetingsBlock`, `imageBlock`, `galleryBlock`, `guideButton`,
`faqBlock` e `audioBlock` identificam blocos. `imageBlock`, `galleryBlock`,
`guideButton` e `galleryItem` são usados somente em `featureDocument()`.
`faqItem`, `officialPolicyItem` e `galleryItem` identificam itens. A seleção de referência é
`introductionSection`/`introductionBlock`, sem item selecionado. `jobTitle`
é um cargo somente sintético para registro pelo futuro harness, nunca um
privilégio implícito. `syntheticImageMedia` é reservado à mídia opt-in.

`referenceMedia()` devolve novos descritores e Buffers por chamada:
`{id,kind,mime_type,file_name,width,height,duration_ms,synthetic,bytes}`.
Contém somente um PNG sintético 1×1 decodificável, sem fotografia ou voz real.
Não acessa rede/FFmpeg/filesystem. Seu registro e vínculo no banco descartável
são responsabilidade do harness; não basta projetar o ID no documento para
declarar upload concluído. `referenceDocument()` mantém somente o áudio com
`media_id: null`. Em `featureDocument()`, imagem e item da galeria referenciam
explicitamente `referenceIds.syntheticImageMedia`, cujos bytes são retornados
por `referenceMedia()`; o áudio continua vazio. A projeção não nula permite
testes funcionais reais de referências de mídia, sem simular um ACK de upload.
Antes de usá-las, o harness precisa registrar os bytes no backend descartável
com o mesmo ID. Alt/legendas/créditos/transcrição e
respostas FAQ não fornecidos pelas pranchas continuam vazios. Isso não constitui
conteúdo pronto para publicação nem acessibilidade editorial validada.

### Manifesto e entrada externa obrigatória para conferir os originais

`tests/fixtures/pages-reference/manifest.json` contém um array com as seis
pranchas originais: botões 1600×480, quatro estados desktop 1600×1160 e Conteúdo
mobile 390×820. Cada entrada tem `id,source,png,width,height,sha256,state,regions,anchors`.
`source` guarda o nome original do SVG; `png` é somente o basename do PNG.
Os arquivos privados não são rastreados, não são copiados para `public/` e
**nenhum golden é produzido a partir da implementação**.

Forneça os PNGs existentes por `PAGES_REFERENCE_DIR` e execute:

```sh
PAGES_REFERENCE_DIR=/caminho/externo/editor-v2-reference \
node --test tests/unit/pages-reference-fixture.test.mjs
```

PowerShell:

```powershell
$env:PAGES_REFERENCE_DIR = 'C:/caminho/externo/editor-v2-reference'
node --test tests/unit/pages-reference-fixture.test.mjs
```

O teste lê bytes reais, assinatura/IHDR, dimensões e SHA-256 das seis entradas.
Também fixa os seis trios exatos `id/source/png`, impedindo renomeações ou
trocas de fontes que uma expressão regular genérica não detectaria.
Com a variável configurada, arquivo ausente, dimensão/hash divergente ou PNG
inválido é **falha**, não skip, fallback ou geração de golden. Sem a variável,
somente esse teste externo fica explicitamente skipped: a suíte ainda confere
fixture e estrutura do manifesto, mas **não comprova referências disponíveis
nem fidelidade visual**. O teste negativo confere rejeição de entrada ausente.
`npm run verify` usa a mesma variável quando fornecida.

`regions` usa caixas `{id,x,y,width,height,measurement}` e `anchors` usa pontos
`{id,x,y,measurement}`, em pixels do viewBox original, origem no topo esquerdo.
As medidas vieram dos elementos XML `rect`/`path` dos SVGs, não de capturas do
produto. `measurement` identifica elemento/transform e derivações. Contornos
de seleção incluem sua extensão preenchida: desktop 0,5 px além do retângulo
lógico, mobile 1 px. Sombras e antialiasing não entram nessas caixas.

`state` descreve painel/aba, seleção, zoom 100%, scroll zero e baseline salva
**sintética**, a ser confirmada no backend descartável antes da captura.
Não é instrução para exibir status salvo falso no produto. Publicação tem três
checks desmarcados e alias meramente ilustrativo; audiência continua por cargo.
Os botões são espécimes de componentes, não cinco workflows de negócio novos.
O manifesto registra os estados desenhados; foco/loading/disabled, teclado,
persistência e comportamento exigem verificações próprias posteriores.

### Geometria resolvida pelo contrato aprovado e limites de evidência

- O parágrafo desktop completo está na fixture. O mobile original é abreviado:
  `state.copyOverride` identifica o bloco e índice zero-based em `content.content` a
  substituir **na cópia sintética desse cenário**, não no conteúdo real.
  `headingColorOverride` registra o índigo da introdução mobile, que difere do
  laranja desktop. Não alegar equivalência de wrapping com o parágrafo errado.
- Os defaults aprovados permanecem exatamente com `foreground: '#26204A'`.
  O índigo efetivamente extraído dos SVGs é `#2A275E`; os blocos visíveis usam
  override explícito. Laranja `#E84F1C`, cartões `#F7F6F2` e áudio `#E8E6EB`
  também vêm das fontes. Nenhuma fonte/binário de tipografia foi alterado.
- A correção aprovada separa as duas fixtures: Galeria fica vazia na visual,
  mantendo a navegação. O renderer de produção compartilhado tratará seções
  vazias genericamente, sem acrescentar altura e sem ocultação específica de
  teste. A funcional preenche Galeria com mídia sintética e “Ver guia completo”,
  apontando à seção Orientações. Não se esconde conteúdo real para obter match.
- FAQ/áudio usam o layout v3 aprovado `aside_right`: coluna direita de 260 px,
  gap de 20 px e empilhamento responsivo. `two_equal` permanece somente nos dois
  cartões de Orientações. Não há decisão geométrica pendente ou CSS especial
  do harness; o suporte no renderer/validador de produção é de etapas posteriores.
- Os ícones `shirt` (Capa), `coffee`, `users` e `headphones` permanecem exatamente
  os retratados. Fazem parte da extensão aprovada do enum v3, sem substituição
  por ícones genéricos ou alteração dos leitores v1/v2 nesta tarefa.
- Badge, instrução “Adicione um áudio com as orientações da equipe.” e demais
  rótulos de UI pertencem ao estado/apresentação do harness, não são transcrição
  de áudio ou respostas FAQ inventadas. O aviso **sintético/não oficial** deve
  aparecer na página do harness/evidência, fora do canvas comparado, sem alterar
  textos e quebras da referência.

Esses testes fixam inputs e contratos; não executam comparação por pixels,
não validam renderização v3 nem provam aceite visual/funcional ou produção.
## Botões Pages — Task 8

`node tests/visual/check-pages-buttons.mjs` exercita os exports reais de
`public/pages/button.js`/renderer/API em Chrome, com Express e PGlite descartáveis,
autenticação Firebase sintética e bloqueio de rede externa. Requer as instalações
externas existentes em `PGLITE_MODULE_PATH` e `PLAYWRIGHT_MODULE_PATH`.
`BUTTONS_VISUAL_OUTPUT` escolhe capturas e `results.json` (padrão:
`opencode/pages-buttons` no temporário). Não abre nem recarrega abas do usuário.
Confere 44 px, foco 2+2, busy estável/duplo clique, attachment privado por blob,
erro/retry, save/upload com ACK real e saída/troca de conta com bytes pendentes.
O harness de comandos existe só no servidor de teste; não é uma segunda UI pública
de assets nem integração antecipada do editor. O renderer de embed/consentimento
continua responsabilidade da Task 10. PostgreSQL/Nginx/Firebase nativos permanecem
gates separados e pendentes; nenhum serviço existente é iniciado.

Round 1 de Task 8 também usa `node tests/visual/check-pages-friendly-route.mjs`:
botão real de seção no shell/router real, seção→perfil→multi-Back/Forward,
traversal dirty cancelado/aceito e prévias staged/revision somente com foco.
Não substitui essa regressão por um harness isolado de componente; mantém os
checks de skip-link e dirty/busy da Task 7. Requer as mesmas variáveis externas;
`FRIENDLY_VISUAL_OUTPUT` seleciona seus artefatos.
# Inserção e estrutura Pages — Task 11

`node tests/visual/check-pages-insertion.mjs` requer as instalações externas
`PGLITE_MODULE_PATH` e `PLAYWRIGHT_MODULE_PATH`. Executa o Editor V2 real com
identidade sintética e API/SQL em PGlite, somente listeners loopback próprios e
rede externa bloqueada. Cobre catálogo/busca/escolha destaque-botão, pontos
antes/depois/coluna vazia, upload ACK, persistência/reload, largura/merge cancelado,
aside, histórico/PM e suporte v3 desligado por padrão. Arraste real de blocos e
seções é exercitado com transforms temporários 50/100/150%, mais Alt+setas e Escape;
isto não aceita o futuro controle de zoom/chrome final. `INSERTION_VISUAL_OUTPUT`
escolhe capturas/results; padrão temporário `opencode/pages-insertion`.
# Task 12 — autoria de mídia/FAQ no editor real

`node tests/visual/check-pages-editor-media.mjs` usa as instalações externas já
existentes indicadas por `PGLITE_MODULE_PATH`, `PLAYWRIGHT_MODULE_PATH`,
`FFMPEG_PATH` e `FFPROBE_PATH` (caminhos absolutos). Não instala dependências,
inicia Docker nem usa serviços/contas reais. Cria e encerra seus próprios listeners
loopback, PGlite e fixtures lavfi; rede externa bloqueada, inclusive YouTube.
`MEDIA_VISUAL_OUTPUT` escolhe capturas/resultados (padrão temporário
`opencode/pages-editor-media`).

Cobertura: galeria multifile serial/partial fail/retry com chave estável, ACK de
COMMIT real perdido sem duplicar registro, alt/caption/credit/reorder/replace,
FAQ PM keyed/toolbar/seleção/global undo e pergunta IME via CDP, YouTube parser e
escolha de fonte/cancelamento, MP4/MP3/imagem/GIF privados, save/reload/preview e
leitor publicado por cargo, bytes/captions sob guarda privada, paste de cores
controlado/v1 preservado, troca de conta durante fila e cleanup. O check V2 inclui
cancelamento de fonte e gate default off nas sete larguras. Não é comparação
golden das referências nem aceite visual final; isso permanece na Task 14/18.
## Estilo do Editor V2 — Task 13

`node tests/visual/check-pages-style.mjs` requer `PGLITE_MODULE_PATH` e
`PLAYWRIGHT_MODULE_PATH` externos, já instalados. Executa o editor/ProseMirror real
no Chrome com SQL/HTTP em PGlite descartável e identidade sintética. Usa somente
loopback próprio, bloqueia rede externa e encerra os recursos que cria.
`STYLE_VISUAL_OUTPUT` escolhe a pasta; padrão: temporário `opencode/pages-style`.
Os sete grupos cobrem cancel/reopen/roundtrip/herança, inspector/merge, marcas
selecionadas rich/FAQ e uma única entrada undo, AA na API, IME CDP/controles retirados
e writer/readonly. Não substitui PostgreSQL/Nginx/Auth reais, IME físico ou aprovação
visual final. A regressão `check-pages-v2.mjs` conserva explicitamente o bulk v2
pelos presets legados; não atribui a documentos v2 a herança introduzida em v3.
O grupo de correções da revisão confere reset de propriedade sem desfazer o pin
legado (pares externo/interno de callout e botão), opt-out completo explicitamente
rotulado, tamanho não aplicável a imagem/GIF/galeria com legendas mantidas em 14 px,
e `compositionend` seguido imediatamente por `input` final nos hex locais.
# Comparação das seis fontes do Editor V2 (Task 18)

`node --test tests/unit/pages-reference-comparison.test.mjs` verifica o comparador
sem browser, decoder ou serviços. Cobre deslocamento de 5 px, região/controle
ausente mesmo em frame idêntico, bordas inclusivas 2/4 px, mudança de um pixel,
dimensões inválidas, arquivo/SHA incorreto e proteção de saída existente.

`node tests/visual/check-pages-reference.mjs` requer todas as variáveis abaixo:

- `PAGES_REFERENCE_DIR`: diretório externo dos **seis PNGs originais**, com hashes
  do `tests/fixtures/pages-reference/manifest.json`. Ausência, mudança de SHA ou
  dimensão errada é erro; nunca produz um golden a partir da implementação.
- `PAGES_REFERENCE_OUTPUT`: pasta **nova**, com pai existente, fora do repositório
  e das fontes. Reutilizar uma pasta é erro, inclusive se estiver vazia.
- `PNGJS_MODULE_PATH`: caminho absoluto para PNGJS já instalado externamente.
  Também aceita o `playwright-core/lib/utilsBundle.js` instalado que exporta
  `PNG.sync`; não adiciona decoder ao runtime nem instala ferramentas.
- `PLAYWRIGHT_MODULE_PATH`, `PGLITE_MODULE_PATH`: instalações externas existentes,
  como nos demais checks Pages. Chrome usa `BROWSER_CHANNEL` ou `chrome`.
- `PAGES_REFERENCE_BROWSER_VERSION`: versão exata autorizada para essa execução;
  discrepância com `browser.version()` falha. Rodada Task18: `157.0.8103.51`.

O runner possui seus listeners loopback, identidades sintéticas, Chrome e PGlite
descartáveis. Cada estado editor usa documento, contexto e namespace SQL novos;
fontes carregadas, DPR=1, viewport exato, seleção/scroll/foco registrados e caret
oculto somente na captura. Não oculta blocos nem altera paint do produto. A prancha
de botões é um scaffold de documentação que monta **createPageButton** e CSS de
produção: confirmação vem de save HTTP real, upload tem ACK, loading retém uma
resposta privada real, disabled impede ações. Hover/foco/loading/disabled usam
visitas independentes; o destino de vídeo é o consentimento do renderer real.

Saída: seis `<estado>.png`, seis overlays 50%, seis mapas de diferença absoluta,
recortes overlay/diff por região em `comparison/`, `captures.json` com DOM/textos/
fontes/estado e `results.json` com paths/SHA completos. `buttons-*.png` complementam
os estados de interação; não são novas fontes. `compare-pages-reference.mjs` é
importável sem executar main. Seu CLI pode analisar um diretório de capturas que
ainda não contém `comparison/`, com as mesmas variáveis de fonte/saída/PNGJS.

Frames/painéis usam 2 px e controles 4 px. Geometria e pixels são independentes:
**FAIL_GEOMETRY** reprova âncora ausente/deslocada; **REVIEW_PIXELS** requer inspeção
de qualquer diferença local, inclusive rasterização. Só igualdade exata de pixels
e geometria resulta em **EXACT**, ainda sem aceite do usuário. Não há limiar global
de aprovação. Exit 1 com `results.json` pode ser uma comparação completa com
divergências; `failure.json` indica execução interrompida, nunca PASS parcial.
Os gates nativos e a apresentação/validação final continuam separados, na
[matriz de evidência](../../docs/reviews/2026-11-11-pages-reference-fidelity.md).

Na continuação Task18, as correções de produção conservam o manifesto e as
tolerâncias: inspetor em passo86, seleção de coluna inteira com contorno997,
ícones16 com passo64/gap48, rótulos com maiúscula inicial e Aplicar129×36.
`check-pages-style.mjs` confere o hit-test real acima/abaixo do desenho de Aplicar
(área44) e aplica uma mudança pelo prolongamento transparente. O painel de inserção
mantém as sete linhas principais; `check-pages-insertion.mjs` percorre com Tab/Enter
os extras FAQ/separador/ponto de inserção, confere scroll/foco visível e mantém os
testes de busca, inserção, upload, histórico e persistência. Os controles adicionais
continuam reais e alcançáveis em scroll nativo.

A asserção de evidência da rodada fica em
`.superpowers/sdd/2026-11-11-pages-editor-reference-fidelity/assert-task-18-fix.mjs`:
recebe o diretório novo como argumento, exige seis resultados, todas as108 regiões,
14 âncoras, 34 gaps e cobertura completa/única dos 64 pares de texto, confere hashes
e igualdade do contrato geométrico original. O contrato textual independente fica
em `pages-reference-text.mjs` e tem hash próprio no índice de artefatos.
Seu PASS é somente das medidas. O comparador continua saindo1/NOT_ACCEPTED enquanto
houver diferenças locais de pixels; wordmark e roxo canônico versus cinza-fonte
continuam explicitamente pendentes de revisão/aceite.

### Task18 tooling fixround2 — oclusão de pintura, não de interação

Evidência atual: `<temp>/opencode/pages-reference-task18-fix-2-final-v2/`.
Os64 pares são **54 verificações visíveis e10 de underlyingDOM com cobertura real**.
A antiga divisão40/24 da fixround1 confundia modalidade/inertness com pintura e
foi substituída por classificação independente de cada requisito em cada fonte.
Os totais são derivados dessas classificações, não de uma constante40.

- Estilo e Inserir: capa, introdução e No dia a dia estão parcial/totalmente
  cobertos pelos painéis opacos; cabeçalho, inspetor, Em encontros, FAQ e áudio
  estão expostos com backdrop transparente e continuam requisitos visíveis.
- Revisão: capa, introdução, Em encontros e áudio cruzam o painel opaco; cabeçalho,
  inspetor, No dia a dia e FAQ continuam visíveis através do scrim40% da fonte.
  O contrato exige esse alpha, não aceita qualquer translucência como equivalente.
- Cada um dos24 requisitos de workspace nos três overlays tem razão própria no
  `sourceTextVisibility`; underlying exige cobertura por um painel específico.

`pages-reference-inventory.mjs` percorre text nodes, sem agregar `LABEL.innerText`:
texto de options/datalist/select não entra em rótulos. Inputs e selects fornecem
somente o valor atual, como `input-value`/`selected-value`. O vínculo à região vem
da ascendência DOM do locator específico; o comparador também exige interseção
com a região-fonte. Valores selecionados exigem exatamente um controle e igualdade
do texto normalizado, não substring de opções disponíveis.

A lista `text` contém somente registros visíveis. `underlyingDOM` conserva os
demais com razões explícitas: closed-details, ancestor-clipped, viewport-clipped,
hidden, css-clip, panel-covered, opaque-backdrop ou occluded. As medidas de ink verticais usam Range e métricas da
fonte do Chrome, evitando contar ascent/descent em branco como glifos cortados.
Hit-tests amostram início/meio/fim de cada run onde não há supressão por modalidade;
camadas com opacity0 em qualquer ancestral não pintam sobre o texto. Para texto
externo ao modal, usam-se geometria pintada do painel e alpha de `::backdrop`, pois
o browser torna o conteúdo inerte até fora da área pintada. `interactionBlocked`
fica separado de `visible`. Scrim transparente não exclui texto; o translúcido é
registrado como camada, e o opaco exclui. Possíveis interseções com painéis são
refinadas por Range de grafema e métricas de ink para não confundir o envelope de
uma palavra acentuada com glifos pintados. Não se fecha/oculta/move o diálogo para
obter hit tests. São cenas de referência com um diálogo; não é OCR nem renderizador
geral de stacking/efeitos arbitrários. Clips complexos são rejeitados conservadoramente.

O comparador exige cada par esperado `(region,text)` exatamente uma vez e recalcula
todos os resultados a partir do inventário; `textChecks[].pass` da captura não tem
autoridade. A asserção exige o conjunto completo de regiões e gaps, os64 pares e
recomputação idêntica, além dos totais108/14/34/64 e contagem visível derivada do contrato.

Negativos unitários: omissões, duplicatas, região errada, sucesso forjado, seleção
errada com opção correta escondida/outro controle e texto fechado/cortado/oculto.
`node tests/visual/check-pages-reference-inventory.mjs` (PLAYWRIGHT_MODULE_PATH
externo) executa negativos em Chrome real, mais controles positivos de line-height
compacto e affordance transparente. Os testes fixround2 provam: texto exposto fora
do painel transparente permanece visível apesar do hit em DIALOG; texto realmente
coberto é excluído; esconder o requisito exposto falha; scrim40% mantém legibilidade,
scrim opaco falha; envelope de acento à esquerda não encobre letras abaixo do painel.
A fixround1 conserva seus seis negativos de cobertura. A fixround2 também executa
a asserção real sobre três cópias corrompidas das capturas atuais, escondendo o header
exposto de cada overlay enquanto o resultado forjado ainda declara PASS.

## Preflight de publicação v3

`node tests/visual/check-pages-publication-preflight.mjs` usa as instalações externas
`PGLITE_MODULE_PATH` e `PLAYWRIGHT_MODULE_PATH`, Chrome e loopback próprio. Autora FAQ
pela UI sem bloco de texto auxiliar, salva/recarrega, revisa, publica a revisão exata
e lê como colaborador autorizado. Confere também rascunhos incompletos de galeria,
FAQ e vídeo incorporado: mensagens por bloco/item/campo no tooltip e descrição
acessível, ação desabilitada e nenhum POST de publicação. `PREFLIGHT_VISUAL_OUTPUT`
define o diretório de capturas e `results.json`. Identidade sintética e SQL em
PGlite serializado não comprovam serviços nativos nem aceite das seis pranchas.
# Text format and contextual video controls (Task 7)

Run `node tests/visual/check-pages-controls.mjs text-video` with the existing
`PGLITE_MODULE_PATH`, `PLAYWRIGHT_MODULE_PATH` and a **new** `PAGES_CONTROLS_OUTPUT`.
This local integration uses actual Pages/PM/API in desktop and compact chrome;
it does not replace an opened document. A separate synthetic surface checks the
exact `selectionFormat()` API for headings, paragraph, mixed/nested/empty blocks
and standalone undo/redo. Actual Guide edits cover format/selection/global undo,
FAQ, selecting text before Link/color, retained PM identities, contextual private
MP4/YouTube, invalid URL, file-picker cancellation, replacement cancellation,
no iframe/thumbnail and no autosave. The existing media suite additionally tests
real local MP4 bytes/upload/replacement/private reader guards. Its evidence variable
is `MEDIA_VISUAL_OUTPUT`; history uses `HISTORY_VISUAL_OUTPUT`.
