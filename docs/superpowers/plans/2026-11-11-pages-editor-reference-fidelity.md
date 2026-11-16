# Editor V2 Reference Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development`
> (recommended) to implement this plan task-by-task **only after the user chooses
> the execution approach**. Inline execution is also offered; there is no installed
> `executing-plans` skill in this session, so use the explicit task/checkpoint
> protocol below instead of inventing a skill. Steps use checkbox (`- [ ]`) syntax.

**Goal:** reproduzir o visual e as funções das seis pranchas Editor V2 aprovadas,
com persistência real, preservando os documentos e os limites de acesso existentes.

**Architecture:** completar o módulo Pages existente, sem editor paralelo.
Formato v3 estrito para novas capacidades, mantendo v1/v2; API continua dona das
revisões, referências e autorização, e o renderer continua compartilhado por
editor/prévia/leitor. Separar histórico, aparência e painéis por responsabilidade;
`editor.js` permanece o coordenador, não recebe todas as novas regras inline.

**Tech Stack:** HTML/CSS/JavaScript ES modules, ProseMirror/Sortable locais,
Express/CommonJS, PostgreSQL 16; testes `node:test`, PGlite e Playwright existentes.

## Global Constraints

- Contrato aprovado: `docs/superpowers/specs/2026-11-11-pages-editor-reference-fidelity-design.md`.
  O formulário aprovou integralmente o contrato, sem observações; o estado da
  especificação foi atualizado para registrar essa aprovação.
- Ajuste aprovado após revisão da Tarefa 1: preset lateral restrito `aside_right`
  (direita 260px), ícones efetivamente desenhados e fixtures visual/funcional
  separadas. Não esconder blocos ou manter colunas iguais contra o SVG.
- “Reproduzir visual e funcionalidades dos SVGs”; não reabrir a escolha de escopo.
- “Salvar permanece explícito”; “Concluir edição fecha o painel, não salva”.
- “Nenhum deploy antes de você validar a prévia corrigida.” Sem push/merge/deploy
  de publicação antes desse aceite e de autorização própria.
- “Manter HTML/CSS/JavaScript, Express/CommonJS e PostgreSQL.” Sem framework,
  editor paralelo, CMS histórico ou dependência de runtime nova.
- “Leitores de v1/v2, IDs, referências de mídia e aparência anterior” preservados.
- CAS, idempotência, payload pendente imutável, autoria, cargos e revisão conferida
  permanecem obrigatórios. Admin não vira leitor universal; uploader continua autor.
- Não alterar migrations 040/041, conteúdo/permissões reais, receptor/scripts de
  deploy, outra worktree, main local divergente ou screenshots não rastreadas.
- Manter limites existentes: documento 1 MiB, 100.000 caracteres, 20 seções,
  100 linhas, 100 blocos; 50 arquivos/100 MiB por página, incluindo histórico.
- Linux/VPS é o alvo; preservar LF em SQL/shell/Nginx/Docker. Manter Node 18
  no código runtime; ferramentas locais seguem o Node >=24 <25 já declarado na raiz.
- Não iniciar Docker/serviços existentes sem autorização. PGlite e servidor
  sintético loopback dos testes não usam contas, banco ou uploads reais.
- Execute `npm run verify` e `git diff --check` antes de compartilhar alterações.
- Checkpoints não autorizam commits/push. Se houver autorização para commits,
  criar um por tarefa verificada, usando apenas a lista explícita de arquivos;
  nunca `git add .`. A especificação anterior já está no commit local `e78ca15`.

---

## Contexto obrigatório e mapa de arquivos

Ler antes de executar: `AGENTS.md`, `README.md`, `docs/product/brief.md`,
`docs/architecture/pages.md`, a especificação aprovada e este plano inteiro.
Checkout já isolado: `feat/conecta-pages-editor`; não criar/mover worktree de novo.
Baseline local: `e78ca15`, oito imagens não rastreadas protegidas. Confirmar com
`git status --short` antes de cada checkpoint; investigar qualquer nova alteração.

### Unidades novas e limites

Este é um único produto acoplado por documento/validação/renderização, não vários
subsistemas independentes. Por isso há um plano com checkpoints de fase, em vez
de liberar UI, aliases ou mídia em planos isolados que possam divergir do contrato.

| Arquivo | Responsabilidade / consumidor |
| --- | --- |
| `api/pages/validation-v3.js` | Validação estrita v3; dispatcher em `validation.js` mantém o legado. |
| `api/pages/appearance.js` | Resolução/contraste de cores no servidor; publicação v3. |
| `api/pages/aliases.js` | Normalização, reserva transacional e leitura elegível de alias. |
| `public/pages/appearance.js` | Herança/overrides, hex e contraste no browser. |
| `public/pages/document-v3.js` | Upgrade local puro e comandos exclusivos v3; sem gravações. |
| `public/pages/history.js` | Uma timeline do rascunho; sem requests e sem estado servidor. |
| `public/pages/editor-style.js` | Abas de estilo e inspetor, via callbacks de comandos. |
| `public/pages/editor-insert.js` | Catálogo, busca e ponto de inserção; não faz upload sozinho. |
| `public/pages/editor-media.js` | Formulários de galeria/FAQ/embed/mídia e upload autoral. |
| `public/pages/editor-review.js` | Revisão exata, metadados e invalidadores da confirmação. |
| `public/pages/render-blocks-v3.js` | Galeria, FAQ e embed; cada resultado tem `dispose()`. |
| `public/pages/button.js` | Vocabulário visual e ações tipadas; estados verdadeiros. |
| `public/js/pages-route.js` | Reconhecer somente `/conteudos/<alias>` e `.html` Pages. |
| `tests/helpers/pages-reference-document.mjs` | Fixtures sintéticas v3: referência visual e cobertura funcional separadas. |
| `tests/fixtures/pages-reference/manifest.json` | Viewports, âncoras, hashes e regiões das seis referências. |
| `tests/visual/check-pages-reference.mjs` | Captura dos seis estados + comparação geométrica/visual real. |
| `tests/visual/compare-pages-reference.mjs` | Sobreposições, diferenças por região e manifesto de evidências. |

Não extrair módulos legados não relacionados. `editor.js` continua dono do lifecycle,
`state.js` do save/ack, `store.js` da transação, `renderer.js` da montagem comum.
Os novos módulos recebem callbacks/contextos; não importam o coordenador de volta.
Testes VM que removem imports precisam carregar explicitamente as novas dependências.

## Contratos fechados para execução

### Documento v3

Objetos estritos; propriedades não listadas são rejeitadas. Reusar as estruturas
de seções/linhas/colunas e blocos atuais, com estas diferenças explícitas:

- v3 row.layout acrescenta `aside_right`: exatamente duas colunas, esquerda
  `minmax(0,1fr)` e direita 260px, gap20px conforme SVG. Em superfície mobile
  empilha. Sem proporções livres ou widths editáveis. Demais formatos e layouts
  existentes continuam `single|two_equal`. Inserir/organizar expõe o preset real.

```js
// Formas de dados, não um segundo editor ou um endpoint novo de gravação.
const presentation = {
  theme: 'conecta',
  defaults: {
    font: 'manrope', scale: 'standard', align: 'start', palette: 'conecta',
    foreground: '#26204A', background: '#FFFFFF', accent: '#E84F1C',
  },
};
const gallery = { id: 'UUID', type: 'gallery', items: [
  { id: 'UUID', kind: 'image', media_id: null, alt: '', caption: '', credit: '' },
] };
const faq = { id: 'UUID', type: 'faq', items: [
  { id: 'UUID', question: '', answer: { type: 'doc', content: [{ type: 'paragraph' }] } },
] };
const embed = { id: 'UUID', type: 'video_embed', provider: 'youtube',
  video_id: 'dQw4w9WgXcQ', title: '', transcript: '' };
const button = { id: 'UUID', type: 'button', label: 'Ver guia completo',
  preset: 'primary', action: { type: 'section', value: 'UUID' } };
```

- Combinações: v1 `comunicado@1`; v2 `comunicado@2`/`owner-news@1`; v3
  `comunicado@3`/`owner-news@2`/`guia-interno@1`.
- v3 metadata acrescenta `category` obrigatório, string até 80 caracteres, vazio
  permitido no rascunho e em publicações sem categoria; não é permissão.
- v3 presentation é a forma acima; `palette` = `conecta|editorial|neutro`.
  Os três hex são sólidos `#RRGGBB` uppercase. Paletas da UI vêm dos SVGs:
  extrair os fills/contrastes reais, não escolher cores por gosto. Os valores
  acima ilustram o par base e não substituem essa extração.
- Todo bloco v3 aceita `appearance` parcial com `font,scale,align,foreground,
  background,accent,icon` e `tags` (até 20 strings únicas de 40 caracteres).
  `background` também aceita `none`, que resolve para o fundo da página.
  `icon` = `none|info|alert|check|arrow|download|play|upload|coffee|users|headphones|shirt`.
  São SVGs locais com geometria da referência, não URLs/HTML ou ícones arbitrários.
- `style` legado continua aceito com a forma estrita antiga, inclusive no v3
  convertido. Ordem: padrões da página → style legado explícito → appearance.
  O ícone específico de callout continua em `block.icon`; o genérico é
  `block.appearance.icon`, sem colisão de propriedades.
- Upgrade puro de v1/v2: clonar, preservar todos os UUIDs, adicionar categoria
  vazia e presentation equivalente, fixar `defaultStyle()` legado nos blocos
  que não tinham style; converter `button.destination` em `button.action`.
  Não fazer upgrade ao abrir, pré-visualizar, cancelar, no-op ou falhar.
- Novos blocos não recebem `style` legado: herdam defaults. Mudar a página não
  limpa overrides existentes; o inspetor oferece “Usar padrão da página”.
- v3 marks acrescentam `text_color`/`highlight`, attrs `{color:'#RRGGBB'}`;
  até seis marks únicos. FAQ usa o mesmo texto rico restrito e budgets globais.
- Gallery até 50 itens por bloco (limite global de mídia continua 50 arquivos);
  FAQ até 50 itens por bloco; UUIDs de itens integram a unicidade global. Duplicar
  galeria/FAQ gera IDs novos para itens, mantendo só os media IDs referenciados.
- `media_id:null` só em rascunhos v3 de imagem/GIF/áudio/vídeo e itens de galeria.
  Não produz referência. Publicação rejeita placeholders e exige alt/transcrição/
  captions conforme o tipo atual. Gallery vazia/FAQ sem pergunta-resposta/embed
  sem título/transcrição são aceitos para editar, não para publicar.
- Download: action `{type:'download',media_id:'UUID',kind:'image|gif|audio|video',
  file_name:'material.webp'}`; nome até 120 caracteres, sem barras/CRLF/controles,
  extensão determinada pelo kind normalizado. Navegação preserva
  `{type:'url'|'section',value}`; vídeo usa `{type:'video',value:'UUID de bloco'}`,
  aceitando só `video` ou `video_embed` da mesma página. Não existe action upload
  de leitor nem action “Salvo” em conteúdo.
- Validação retorna a interface atual `{document,mediaIds,mediaRefs,jobTitleIds}`.
  `mediaIds` deduplicado; `mediaRefs` inclui cada uso tipado, inclusive download
  e galeria. IDs do JSON normalizados lowercase em todos os caminhos novos.

### Sessão, histórico e rich text

```js
// Contrato adicional de state.js; os métodos antigos save/ack continuam.
state.transact({ group: 'metadata:title', selection: null }, draft => {
  draft.metadata.title = 'Novo título';
}); // boolean; no-op não entra no histórico
state.undo(); // boolean; jamais chama API
state.redo(); // boolean; jamais chama API
state.canUndo; state.canRedo;
// createRichEditor acrescenta:
editor.sync(content, bookmark); // preserva EditorView; não emite onChange
editor.bookmark(); // { from, to }, relativo ao campo PM
editor.mark('text_color', { color: '#26204A' });
```

Uma timeline bounded: até 100 transações e 20 MiB de snapshots serializados;
descartar as mais antigas mantendo ao menos a transação atual. Digitação/input
do mesmo campo até 500 ms agrupa; composição IME é uma transação até compositionend;
troca de bloco, blur, save e comando estrutural fecham o grupo. Bookmarks de FAQ
usam `{blockId,itemId,from,to}`; outros textos `{blockId,from,to}`. Timeline não
contém workspace/version/ack/arquivos/pending. Sem plugin PM de histórico paralelo
no editor integrado; modo standalone mantém fallback local para testes/consumidores
que não passam `historyCommands`. Bloquear undo/redo durante saving/uploads,
conflito e upload ambíguo; falha de save pendente não altera nem limpa o payload.
Novas edições após falha continuam possíveis como hoje.

Após reconhecer um save v3, o formato mínimo da sessão passa a 3: undo de uma
entrada v1/v2 restaura seu conteúdo/aparência por `upgradeDocument`, sem emitir
v1/v2 contra um head v3. Isso não apaga histórico nem muda a revisão salva. Antes
do primeiro ack v3, undo da primeira edição nova pode voltar ao JSON v1/v2 exato.
Ack de retry v3 ambíguo aplica o mesmo piso depois de reconciliar o payload, nunca
reescreve `pending`. Guardar esse piso no estado da sessão, não na timeline.

### Alias, rotas e rollout

- Migration 042 aditiva: `pages.slug TEXT NULL`, unique parcial para não nulos,
  check ASCII lowercase/hífens até 120; expandir schema check para 1/2/3. Sem tabela
  nova/FK, sem backfill e sem coluna slug em snapshots antigos.
- Normalizar título NFKD/remover acentos → `[a-z0-9-]`, base até 80, fallback
  `pagina`; não reservar para título vazio. Reserva na mesma transação de create
  ou primeiro draft explicitamente salvo com título não vazio. Slug já existente
  é imutável. Colisão: `base-<UUID sem hífens>`, no máximo 113 caracteres.
- Ordem de locks: request → página → `pg_advisory_xact_lock(hashtext('pages-alias:'
  + base))`; checar candidato sob lock antes de UPDATE. Unique index é a defesa
  final; não continuar transação abortada por 23505 nem fazer loop de retries cegos.
- Ack/workspace passam `slug` nullable. Save conserva-o no workspace mas não muda
  baseline JSON. Página legada sem alias mostra URL UUID real até um save autorizado;
  publisher sem edit não cria alias por meio de revisão.
- `GET /api/pages/by-slug/:slug` tem auth/Ethics e mesmo predicado `eligible` da
  leitura UUID na mesma consulta; 404 uniforme para ausente/rascunho/arquivo/sem cargo.
- `/conteudos/<slug>` serve só shell estático de Pages; conteúdo vem da API
  autenticada. Adicionar `<base href="/">` somente em `pages.html`, respeitando
  CSP base-uri self. Resolver módulos/HTML/assets da navegação via `/pages.html`,
  manter a URL amigável no histórico e no `page.location`.
- Novo `document_support` em workspace: `{read_versions:[1,2,3],write_versions:[1,2]}`
  ou `[1,2,3]`; não sobrecarregar capabilities de permissão. Templates v3 aparecem
  apenas quando permitidos. API option `v3WritesEnabled`, padrão da env
  `PAGES_V3_WRITES_ENABLED === 'true'`, default false; harness passa true explicitamente.
- Gate false impede novas revisões v3/create de guia, não impede ler/validar ou
  publicar uma revisão v3 já salva. Replay confirmado é reconhecido/autorizado
  **antes** do gate; retry não perde o resultado por uma troca de flag.
- Se o draft atual é v3, rejeitar save v1/v2 com `409 schema_downgrade_conflict`.
  Clientes antigos não podem descartar blocos ao escrever. Mensagem pede recarga;
  nunca tentar um downgrade automático.
- Futuro rollout autorizado: leitores/API/banco compatíveis primeiro, flag false;
  depois escritores true. Desligar flag congela novos formatos, não torna seguro
  voltar para `e2a855b`. Depois do primeiro v3, rollback só para leitor compatível
  ou recuperação ensaiada com backup; não apagar v3 para viabilizar código antigo.
  Este plano **não executa** essas etapas de produção.

## Protocolo de cada tarefa

Cada checkbox é uma ação curta, repetida por caso quando necessário. RED significa
falha na asserção nova, não erro de sintaxe/import acidental. GREEN preserva testes
anteriores; não remover invariantes para tornar verde. Ao encerrar, registrar
arquivos/diff, comando, resultado e limite da evidência; pedir revisão fresca na
execução escolhida antes de avançar para um checkpoint de fase. Nenhuma tarefa
afirma aceite visual sem a Tarefa 18.

---

### Task 1: Fixar fixture equivalente e manifesto das referências

**Files:** criar `tests/helpers/pages-reference-document.mjs`,
`tests/fixtures/pages-reference/manifest.json`,
`tests/unit/pages-reference-fixture.test.mjs`; atualizar `tests/visual/README.md`.

**Interfaces:** produzir `referenceDocument()` (novo clone por chamada, UUIDs
fixos válidos, cinco seções Capa/Introdução/Orientações/Galeria/Dúvidas frequentes),
`featureDocument()` (clone independente que preenche Galeria com imagem/galeria/botão
para testes funcionais, não usado como golden visual),
`referenceIds` (section/block/item selecionados) e `referenceMedia` (bytes sintéticos
registráveis pelo harness). Não adicionar conteúdo a nenhum documento real.

- [ ] RED: escrever e rodar `node --test tests/unit/pages-reference-fixture.test.mjs`.
  O teste é determinístico e deve falhar até os exports existirem:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceDocument, featureDocument, referenceIds } from '../helpers/pages-reference-document.mjs';
test('fixture is isolated, stable and has the reference selection', () => {
  const a = referenceDocument(), b = referenceDocument();
  assert.deepEqual(a, b);
  a.metadata.title = 'Alterado';
  assert.notEqual(a.metadata.title, b.metadata.title);
  assert.equal(b.sections.length, 5);
  const blocks = b.sections.flatMap(s => s.rows.flatMap(r => r.columns.flatMap(c => c.blocks)));
  assert.ok(blocks.some(block => block.id === referenceIds.introductionBlock));
  assert.deepEqual(new Set(blocks.map(block => block.type)),
    new Set(['rich_text', 'audio', 'faq']));
  const features = featureDocument().sections.flatMap(s => s.rows.flatMap(r => r.columns.flatMap(c => c.blocks)));
  assert.deepEqual(new Set(features.map(block => block.type)),
    new Set(['rich_text', 'image', 'audio', 'gallery', 'faq', 'button']));
});
```

- [ ] Implementar o guia ilustrativo com textos/linhas equivalentes aos PNGs,
  não Owner News. Isolar IDs de mídia fixos do produtor `referenceMedia`; título
  e exemplo correspondem à prancha, aviso “sintético/não oficial” fica na página
  do harness/evidência, sem alterar wrapping no canvas comparado.
  A seção Galeria da referência fica com linha/coluna vazia (navegação preservada,
  sem conteúdo inventado); o renderer não acrescenta altura a seções vazias.
  FAQ/áudio usa `aside_right`, nunca `two_equal` ou CSS específico do teste.
  Em `featureDocument`, preencher a seção vazia com os tipos de cobertura e
  mantê-los visíveis no mesmo renderer; não fazer ocultação condicional por cenário.
- [ ] Registrar seis entradas de manifesto com `id,source,png,width,height,
  sha256,state,regions,anchors`. Fontes locais são os seis SVGs da especificação;
  PNGs em `C:/Users/Criação/AppData/Local/Temp/opencode/editor-v2-reference/`.
  Calcular hashes dos bytes reais e medir âncoras nos SVGs; nunca inventar hashes
  nem usar captura da implementação como golden. Inputs privados não vão para
  public nem exigem cópia rastreada; ambiente recebe `PAGES_REFERENCE_DIR`.
- [ ] GREEN: repetir teste; manifesto sem arquivo ausente, seis dimensões exatas.
  Checkpoint: fixture/manifesto apenas, nenhuma mudança no produto.

### Task 2: Aprovar o contrato v3 através de validador estrito

**Files:** criar `api/pages/validation-v3.js`, `tests/unit/pages-validation-v3.test.mjs`;
modificar `api/pages/validation.js:22-168`. Manter `PagesError`/validação legado;
passar `{PagesError,safeLink}` para o módulo v3, evitando require circular.
Se compartilhar primitivas puras para evitar duplicação, usar somente
`api/pages/validation-common.js` e manter os mesmos resultados legados nos testes;
não copiar verbatim o validador inteiro nem extrair outras áreas de runtime.

**Interfaces:** `validateV3(input,{publishing,PagesError,safeLink})` retorna a projeção
atual; `validateDocument` continua a única API pública para todos os formatos.

- [ ] RED: `node --test tests/unit/pages-validation-v3.test.mjs` com o caso abaixo
  e casos separados para gallery/FAQ/embed/button/placeholder/marks/IDs inválidos:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { featureDocument } from '../helpers/pages-reference-document.mjs';
const { validateDocument } = createRequire(import.meta.url)('../../api/pages/validation');
test('v3 projects private gallery and download references, not null placeholders', () => {
  const doc = featureDocument();
  const value = validateDocument(doc);
  assert.equal(value.document.schema_version, 3);
  assert.equal(new Set(value.mediaIds).size, value.mediaIds.length);
  assert.ok(value.mediaIds.length > 0);
  assert.ok(value.mediaRefs.every(ref => ['image','gif','audio','video'].includes(ref.kind)));
  assert.deepEqual(value.jobTitleIds, doc.metadata.audience.job_title_ids);
  assert.throws(() => validateDocument({ ...doc, extra: true }), { reason: 'invalid_document' });
});
```

- [ ] Implementar branch v3 antes da branch legado; budgets globais incluem
  perguntas, respostas, tags, categoria, captions, itens e marks. Rejeitar kind
  incorreto, IDs repetidos case-insensitive, vídeo alvo inexistente, actions extras,
  CSS/HTML em cores/provider, overflow de limites, gallery vazia em publicação.
  Normalizar todos os UUIDs/hex sem alterar o input. Não “corrigir” dado inválido.
  `aside_right` exige duas colunas e só existe em v3. Validar os ícones adicionais
  aprovados; v1/v2 continuam rejeitando o novo layout/appearance.
- [ ] Acrescentar fixtures de hex minúsculo normalizado, CRLF em filename, esquemas
  `javascript:` e host YouTube falso. `video_id` exato `[A-Za-z0-9_-]{11}`;
  provider estrito `youtube`. Categoria não altera jobTitleIds.
- [ ] GREEN: `node --test tests/unit/pages-validation.test.mjs tests/unit/pages-validation-v3.test.mjs`.
  Checkpoint: v1/v2 aceitam/rejeitam exatamente o que aceitavam antes.

### Task 3: Aparência herdável, upgrade puro e contraste AA

**Files:** criar `public/pages/appearance.js`, `public/pages/document-v3.js`,
`api/pages/appearance.js`, `tests/unit/pages-appearance.test.mjs`,
`tests/unit/pages-document-v3.test.mjs`; modificar `public/pages/model.js`,
`api/pages/validation-v3.js`, `public/css/pages.css` apenas para tokens novos.
Para evitar duas cópias manuais do algoritmo, `api/pages/appearance.js` é a fonte
pura canônica; `scripts/build-pages.mjs` pode gerar a variante ESM de browser
`public/pages/appearance.js` e verificar sua atualização em `--check`. Preservar
bundle/licenças atuais e acrescentar regressão em `tests/unit/pages-build.test.mjs`.

**Interfaces:** browser `normalizeHex(value):string|null`,
`resolveAppearance(doc,block):{font,scale,align,foreground,background,accent,icon}`,
`appearanceIssues(doc):{path,reason,ratio}[]`; API mesmos resultados para corpus
JSON via CommonJS. `upgradeDocument(doc):doc3` é puro;
`editV3(doc,change):doc3|null` retorna null se comando não produziu mudança.

- [ ] RED: rodar `node --test tests/unit/pages-appearance.test.mjs tests/unit/pages-document-v3.test.mjs`.
  No corpus incluir esta asserção (usar os imports definidos acima no arquivo):

```js
test('upgrade pins legacy colors; new blocks inherit, cancel is byte-stable', () => {
  const doc = createTemplate('owner-news'), bytes = JSON.stringify(doc);
  const next = upgradeDocument(doc), old = allBlocks(next)[0];
  assert.equal(JSON.stringify(doc), bytes);
  assert.equal(old.id, allBlocks(doc)[0].id);
  assert.deepEqual(old.style, allBlocks(doc)[0].style || defaultStyle());
  next.presentation.defaults.font = 'oswald';
  assert.equal(resolveAppearance(next, old).font, old.style.font);
  assert.equal(resolveAppearance(next, { type: 'rich_text' }).font, 'oswald');
  assert.equal(editV3(doc, () => false), null);
  assert.equal(normalizeHex(' #e84f1c '), '#E84F1C');
  assert.equal(normalizeHex('url(https://example.test)'), null);
});
```

- [ ] Implementar resolução tipada; cores legadas brand `#e8f1e9/#214b39`, warm
  `#f8eedb/#5a3b19` nunca redefinidas. Defaults de upgrade equivalem ao fundo/texto
  efetivos legados; capturar computed styles antes para provar equivalência.
  Campos generic icon/tags e botões/callouts resolvem em wrappers próprios.
- [ ] WCAG: `c <= .04045 ? c/12.92 : ((c+.055)/1.055)**2.4`, luminância
  `.2126*r+.7152*g+.0722*b`, razão `(Lmax+.05)/(Lmin+.05)`. Exigir 4.5:1 para
  texto normal; 3:1 somente quando tamanho/peso efetivos alcançam 24px normal ou
  18.667px bold. Resolver marks em cada run sobre fundo herdado/realce; verificar
  pares de botões/callouts, não só o default da página. `accent` decorativo não
  é automaticamente cor de texto; se usado como tal, verificar também.
- [ ] API rejeita publicação v3 com `color_contrast_required`; frontend aponta
  caminho do bloco/item/run e mostra aviso na edição. Sem fetch de mídia para
  “medir” cores, sem mudança retroativa da publicação v1/v2.
- [ ] GREEN: corpus API/browser idêntico, incluindo limiares 3/4.5, transparência
  `none`, links/marks dentro de FAQ e overrides; screenshots legado iguais antes/depois.

### Task 4: Migration aditiva 042 e verificação real de PostgreSQL

**Files:** criar `api/db/migrations/042_pages_reference_fidelity.sql`;
modificar `api/db/schema.sql`, `api/db/verify-migrations.js`,
`tests/database/check-pages.mjs`, `tests/unit/pages-recovery.test.mjs`;
criar `tests/unit/pages-schema-v3.test.mjs`; estender o ensaio de teste
`scripts/test-pages-recovery.mjs` para o schema 042 (não o receptor de deploy).
Conferir `api/db/provision.js` sem
mudar grants existentes se não necessário. Localizar consumers do ledger com
`grep` por `041_pages_media` e atualizar apenas os que representam schema atual.

**Interfaces:** novo ledger `042_pages_reference_fidelity`; colunas/grants das
seis tabelas Pages mantidos, `pages.slug` nullable unique. PGlite harness aceita
`afterMedia` para semear v1/v2 antes de 042 e aplica 042 duas vezes.

- [ ] RED: unit de schema + teste SQL no harness: snapshot antes de 042 tem mesmo
  hash/UUID/JSON/grants depois; slug duplicate é rejeitado e NULL múltiplo aceito.

```sql
ALTER TABLE pages ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE page_revisions DROP CONSTRAINT IF EXISTS page_revisions_schema_version_check;
ALTER TABLE page_revisions ADD CONSTRAINT page_revisions_schema_version_check
  CHECK (schema_version IN (1,2,3));
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'pages'::regclass AND conname = 'pages_slug_check') THEN
    ALTER TABLE pages ADD CONSTRAINT pages_slug_check CHECK (
      slug IS NULL OR (length(slug) BETWEEN 1 AND 120 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
    );
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS pages_slug_unique_idx ON pages(slug) WHERE slug IS NOT NULL;
```

- [ ] Implementar SQL acima na migration e refletir schema consolidado/verificador:
  `slug` nullable text, check, unique parcial, versões 1/2/3, invariantes/grants
  intactos. Não adicionar FK/tabela de alias ou backfill.
- [ ] Teste recuperação pré-Pages e pré-042: migration/readiness deve continuar
  restaurável com banco contendo 040/041/042 e dump anterior; adicionar caso
  sem alterar receptor de produção. Se o contrato existente não suportar,
  bloquear rollout e registrar evidência em vez de editar deploy nesta tarefa.
- [ ] GREEN: `node --test tests/unit/pages-schema-v3.test.mjs tests/unit/pages-recovery.test.mjs`
  e `node tests/database/check-pages.mjs` com `PGLITE_MODULE_PATH` externo.
  Ensaiar `npm run test:migrations` em PostgreSQL 16 descartável já autorizado;
  se indisponível, marcar esse gate pendente, não simular PASS com PGlite.

### Task 5: Projeções de mídia, gate de escritores e transações v3

**Files:** modificar `api/pages/store.js`, `api/pages/router.js`,
`api/pages/templates.js`, `public/pages/state.js`, `tests/database/check-pages.mjs`,
`tests/unit/pages-transactions.test.mjs`, `tests/unit/pages-router.test.mjs`,
`.env.example`, `docker-compose.yml`; criar `tests/database/check-pages-v3.mjs`.

**Interfaces:** `createPagesRouter({pool,authenticate,uploadDirectory,v3WritesEnabled})`;
`mutate(pool,req,operation,targetId,body,media,options)` com options
`{v3WritesEnabled:false}`; workspace recebe `document_support`, sem mudar as
capabilities existentes. Harness recebe `{v3WritesEnabled:true}` só neste teste.

- [ ] RED: no `check-pages-v3.mjs` criar páginas como autor, salvar galeria+download,
  publicar como publisher e ler como cargo A. O primeiro caso de transação deve
  provar uma única revisão/associação por media ID:

```js
const f = fixture();
const document = upgradeDocument(f.document);
const before = f.data.audit.length;
const body = { expected_version: 0, client_mutation_id: randomUUID(), document };
const first = await mutate(f.pool, f.req, 'draft', f.pageId, body, null, { v3WritesEnabled: true });
const replay = await mutate(f.pool, f.req, 'draft', f.pageId, body, null, { v3WritesEnabled: false });
assert.deepEqual(first.ack, replay.ack);
assert.equal(f.data.audit.length, before + 1);
```

  Importar `upgradeDocument` da Tarefa 3 no arquivo transacional. Esse caso isola
  gate/replay sem mídia; o teste SQL real registra os arquivos do helper antes de
  salvar gallery/download e confere `page_revision_media` por media ID esperado.
  Usar `featureDocument()` para cobertura de mídia; `referenceDocument()` é só
  o estado visual fiel e não contém essas mídias preenchidas.

- [ ] Estender o fake SQL local da fixture transacional, sem exportar estado do
  produto só para teste. Em SQL real, verificar media kind e page_id para TODOS
  os usos, quotas históricas e duração de captions. Placeholder não registra ID.
  Button download não pode referenciar outra página ou mídia inexistente.
- [ ] Implementar gate após busca/reautorização do replay e antes de inserir
  revisão; rejeitar versão v3 não habilitada com `409 document_version_disabled`.
  Impedir downgrade do head v3. Gate em template/create coerente com workspace.
  `.env.example` documenta false, Compose repassa false por default; não ativar
  serviço, mexer em segredos ou alterar pipeline de deploy.
- [ ] Manter pending/ack do state imutáveis ao receber `document_support`; salvar
  continua roundtrip explícito. Flag desligada em head v3 apresenta leitura e
  mensagem de edição indisponível, não descarta o documento.
- [ ] GREEN: unit de transações/router e `node tests/database/check-pages-v3.mjs`:
  autoria/replay após revogação, cargo inativo, admin sem cargo, troca de conta,
  audit failure rollback, COMMIT ambíguo, flags, CAS e v1/v2 originais.
  **Checkpoint A:** schema/contrato/segurança aprovados antes de ligar novo writer UI.

### Task 6: Alias estável e sugestões de categoria com acesso restrito

**Files:** criar `api/pages/aliases.js`, `tests/unit/pages-aliases.test.mjs`;
modificar `api/pages/store.js`, `api/pages/router.js`, `public/pages/api.js`,
`public/pages/state.js`, `tests/database/check-pages-v3.mjs`.

**Interfaces:** `slugBase(title):string|null`,
`ensureSlug(db,page,title):Promise<string|null>` na transação existente;
`store.readerBySlug(db,user,slug)` devolve mesmo DTO de `reader` e fica em store.js,
com `eligible` privado, evitando import circular aliases→store→aliases. API browser
`readSlug(slug)` e `categories(query)`; categories retorna paginação padrão.

- [ ] RED: `node --test tests/unit/pages-aliases.test.mjs`:

```js
test('slug handles accents, length and empty input without claiming public access', () => {
  assert.equal(slugBase('Código de vestimenta'), 'codigo-de-vestimenta');
  assert.equal(slugBase('   '), null);
  assert.equal(slugBase('!'), 'pagina');
  assert.ok(slugBase('a'.repeat(200)).length <= 80);
});
```

- [ ] Acrescentar `ensureSlug` antes de ack/audit no create/draft, mantendo slug
  existente. Incluir slug em workspace/ack; retry devolve o mesmo. Reserva segue
  ordem de locks/candidato/sufixo definida no contrato, nunca escapa da transação.
- [ ] Rota literal `/by-slug/:slug` antes de `/:id`, auth explícita, formato estrito;
  leitura por slug usa `eligible` na mesma query, sem lookup público preliminar.
  Categories em `/categories` só manager, consulta DISTINCT em drafts visíveis
  ao autor/publisher, limite/offset/q e total; sem vazar categorias de autores
  que o editor não pode revisar. Seleção livre continua possível, até 80 chars.
- [ ] GREEN SQL: dois saves com mesmo título, rename, rollback de audit, replay
  depois de rename, slug de arquivada e draft-only 404, outsider/admin sem cargo
  404, inactive cargo 404. Concorrência de duas conexões em PG16 descartável,
  não alegar teste concorrente no pool serializado PGlite.

### Task 7: URL amigável no shell, login/Ethics e navegação direta

**Files:** criar `public/js/pages-route.js`, `tests/unit/pages-friendly-route.test.mjs`;
modificar `public/js/router.js`, `public/js/portal-destination.js`,
`public/js/auth.js`, `public/pages.html`, `public/pages/app.js`,
`public/pages/catalog.js`, `nginx/nginx.conf`; localizar testes existentes de
router/destination/Nginx e acrescentar os casos abaixo nos mesmos harnesses.

**Interfaces:** `pagesSlug(pathname):string|null`;
`routePath(pathname):string` retorna `/pages.html` somente para alias válido,
senão mantém pathname. Router usa o caminho canônico para map/import/fetch,
path real para histórico/location; não liberar outros prefixos arbitrários.

- [ ] RED: unit de routePath e browser visita direta antes de navegação SPA:

```js
assert.equal(routePath('/conteudos/codigo-de-vestimenta'), '/pages.html');
assert.equal(pagesSlug('/conteudos/codigo-de-vestimenta'), 'codigo-de-vestimenta');
assert.equal(pagesSlug('/conteudos/a/b'), null);
assert.equal(pagesSlug('/conteudos/%2fadmin'), null);
assert.equal(routePath('/announcements.html'), '/announcements.html');
```

- [ ] Trocar TODAS as consultas `routes[pathname]` de router para resolver routePath,
  inclusive bootstrap, routeAllowed e canLeave; fetch template `/pages.html`,
  import módulo fixo. Normalizar URL base de estilos/scripts pelo template, não
  pela URL amigável. Converter redirects login/dashboard relativos do router
  e de auth.js em root-relative para alias; `auth-shell.js` é pre-paint clássico
  e não precisa importar o helper ESM. `safeDestination` aceita só regex interna válida
  e preserva next através de login/Ethics sem open redirect.
- [ ] `pages.html` recebe base self antes dos assets. `app.js` detecta slug do path
  e chama `readSlug`; catálogo/editor/back usam root-relative em links Pages.
  Nginx location com regex quoted e restrita `"^/conteudos/[a-z0-9]+(-[a-z0-9]+)*$"`
  faz `try_files /pages.html =404`, só shell. Acrescentar também prefixo normal
  `location /conteudos/ { return 404; }` (sem `^~`), para inválidos/segmentos extras
  não caírem no fallback global de index.html. Só a regex válida sobrepõe o prefixo;
  nunca fallback de `/api` ou `/uploads` para HTML.
- [ ] GREEN: acesso direto com/sem sessão, next pós-Ethics, refresh, hash de seção,
  back/forward, erro/404, link a dashboard/editor, troca de conta. Confirmar todos
  os assets 200 nos caminhos corretos e sem novo documento na navegação SPA.
  Usar verificador Nginx real existente em Linux (`nginx -t`), não só regex unit.
  Não criar mais um job CI nem iniciar container sem autorização.

### Task 8: Download privado e vocabulário de botões real

**Files:** criar `public/pages/button.js`, `tests/unit/pages-button.test.mjs`;
modificar `api/pages/router.js`, `public/pages/api.js`, `public/pages/renderer.js`,
`public/css/pages.css`, `tests/unit/pages-router.test.mjs`,
`tests/database/check-pages-v3.mjs`, `tests/unit/pages-renderer.test.mjs`.

**Interfaces:** API `download(pageId,mediaId,{revisionId,staged,signal})` via
fetchAPIAsset; `createPageButton({label,preset,icon,action,context}):{node,dispose}`.
Context inclui `{api,pageId,revisionId,staged,host,resolveBlock,signal}`.

- [ ] RED: ação download usa endpoint autenticado, failure permite retry sem
  navegar URL nua, disabled ignora click, busy preserva dimensões. Testar contrato
  de headers e acesso também em SQL/API real:

```js
const response = await h.api('get', `/${pageId}/media/${mediaId}/download`, null, 'reader');
assert.equal(response.status, 200);
assert.match(response.headers['content-disposition'], /^attachment;/);
assert.equal(response.headers['cache-control'], 'private, no-store');
assert.equal((await h.api('get', `/${pageId}/media/${mediaId}/download`, null, 'outsider')).status, 404);
```

- [ ] Endpoint antes de catch-all, mesma seleção query staged/revision de media
  e `store.mediaRecord`. Content-Disposition com basename gerado pelo servidor
  `material-<UUID>.<ext>`; nunca confiar em query/header/file_name fornecido para
  caminho em disco. Browser usa file_name validado no atributo download de blob.
  MIME/extension pela mídia normalizada, nosniff/no-store e sem ranges como hoje.
- [ ] Componentes primary/secondary/video/upload/confirmed 44px de altura visível,
  foco 2px+gap, ícone local, texto de verbo, busy sem salto. Confirmed só recebe
  estado vindo do ack real; upload é comando UI do autor, não renderer de conteúdo.
  vídeo local foca alvo e carrega sem `play()` automático; embed pede confirmação
  de terceiro antes de criar iframe. URL/section continuam navegação segura.
- [ ] Abortar e revogar blob em erro/dispose/troca de conta; geração impede late
  completion de iniciar download após sair. Não persistir blob URLs no documento.
- [ ] GREEN: router/button/renderer unit + SQL v3, inclusive revisão antiga em
  preview autorizado, sem revisão pública e sem autor em página alheia.

### Task 9: Timeline global integrada ao state e ProseMirror

**Files:** criar `public/pages/history.js`, `tests/unit/pages-history.test.mjs`;
modificar `public/pages/state.js`, `public/pages/editor-source.js`,
`public/pages/editor.js`, `tests/unit/pages-state.test.mjs`,
`tests/unit/pages-editor-lifecycle.test.mjs`; regenerar bundle via build existente.

**Interfaces:** `createDraftHistory({document,maxEntries=100,maxBytes=20971520})`
com `commit(document,{group,selection,time,closeGroup}),undo(),redo(),clear()`;
commit boolean, undo/redo retornam `{document,selection}|null`. State expõe
transact/undo/redo/canUndo/canRedo definidos no contrato; rich editor recebe
`historyCommands:{undo,redo}` e emite bookmark/IME antes/depois da transação.

- [ ] RED: state/history tests incluindo save/undo e pending imutável:

```js
const state = createEditorState(workspace());
const title = state.document.metadata.title;
state.transact({ group: 'title' }, doc => { doc.metadata.title = 'B'; });
await state.save({ save: async () => ({ version: 1, draft_revision_id: 'r1' }) });
assert.equal(state.undo(), true);
assert.equal(state.document.metadata.title, title);
assert.equal(state.workspace.version, 1);
assert.equal(state.dirty, true);
assert.equal(state.redo(), true);
assert.equal(state.dirty, false);
```

- [ ] Implementar timeline com cópias profundas fora de referências mutáveis;
  substituir TODAS as mutações diretas do editor por transact ou caminho único
  que registra before/after real. Não capturar baseline já mutada por onChange.
  Remover recovery de exclusão concorrente: botão antigo usa mesma undo timeline.
  Save/ack nunca viram entradas de conteúdo nem limpam histórico.
- [ ] PM integrado sem `history()` paralelo; teclas e toolbar chamam mesma timeline.
  `sync` usa transação sem onChange para atualizar doc/seleção no EditorView existente,
  clamp bookmark válido depois de excluir/recriar bloco; não recriar todos os views
  em estilo/move. Fechar grupos por save/blur/bloco/comando e IME com end explícito.
- [ ] RED adicional browser: digitar bloco A, estilo B, mover A, undo 3 vezes e redo;
  FAQ resposta usa item bookmark; pós-save undo dirty; upload/save/conflito bloqueia;
  ambiguidade não limpa pending nem deixa publicar; nova digitação após undo corta redo.
  Cobrir undo de upgrade antes/depois do ack v3: conteúdo antigo volta sem enviar
  formato antigo ao head v3; retry ambíguo estabelece o piso sem mutar pending.
- [ ] GREEN unit + lifecycle/browser; `npm run build:pages` e `npm run check:pages-build`.
  **Checkpoint B:** sem regressão de edição/save antes de novas affordances visuais.

### Task 10: Renderer v3 compartilhado e lifecycle privado

**Files:** criar `public/pages/render-blocks-v3.js`,
`tests/unit/pages-renderer-v3.test.mjs`; modificar `public/pages/renderer.js`,
`public/css/pages.css`, `tests/unit/pages-renderer.test.mjs` e harness VM.

**Interfaces:** `renderV3Block(block,context):{node,refresh?,dispose}`; context
inclui as funções seguras `richNode,imageFigure,mediaFigure`, evitando import
circular. `applyBlockStyle(node,block,doc)` preserva assinatura antiga opcional;
renderer v1/v2 não passa por upgrade. `renderDocument` continua retorna cleanup.

- [ ] RED unit: gallery mantém ordem, alt, requests tipados e revoga blobs; FAQ
  permite duas details abertas e não salva expansão; embed faz ZERO rede pré-clique:

```js
const figure = renderV3Block({ id: 'embed', type: 'video_embed', provider: 'youtube',
  video_id: 'dQw4w9WgXcQ', title: 'Exemplo', transcript: 'Descrição' }, context);
assert.equal(figure.node.querySelectorAll('iframe').length, 0);
figure.node.querySelector('button').click();
assert.match(figure.node.querySelector('iframe').src,
  /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
assert.doesNotMatch(figure.node.querySelector('iframe').src, /autoplay=1/);
figure.dispose();
assert.equal(figure.node.querySelectorAll('iframe').length, 0);
```

- [ ] Implementar gallery em grid responsivo, GIF reaproveita load/stop explícito,
  nenhuma animação involuntária; imagens por API privada com dispose individual.
  FAQ details/summary nativos com heading/IDs e respostas richNode; placeholder
  só aparece em edição/prévia, nunca publicado. Embed sem thumbnail externo ou
  preconnect antes de consentimento, iframe title/allow mínimo, política referrer,
  unload explícito e cleanup remove src. Não usar raw HTML/URL do autor no src.
  Renderizar layout `aside_right` com faixa direita de 260px e gap20px, em edição,
  prévia e leitor; mobile empilha por largura da superfície. Seção de navegação
  vazia não acrescenta caixa/altura visível, em qualquer documento, não apenas teste.
- [ ] Estender richNode com marks seguros e aparência efetiva, header da página
  segue defaults v3, callout/button obedecem pares próprios, tags/icons renderizam
  como dados visuais locais. Texto arbitrário sempre createTextNode/textContent.
- [ ] GREEN: unit v1/v2/v3 + testes de late blob/reorder/remove/dispose;
  conferir prévia e leitor pelo mesmo DOM, inclusive links section em URL amigável.

### Task 11: Comandos de inserção/posição e seleção acessíveis

**Files:** criar `public/pages/editor-insert.js`,
`tests/unit/pages-insertion.test.mjs`; modificar `public/pages/composition.js`,
`public/pages/document-v3.js`, `public/pages/editor.js`,
`public/pages/editor-workspace.js`, `tests/unit/pages-composition.test.mjs`.

**Interfaces:** `insertAt(doc,{columnId,index,block}):doc|null`;
`insertColumns(doc,{sectionId,beforeRowId}):doc|null`;
`reorderSection(doc,{sectionId,beforeSectionId}):doc|null`;
`setBlockWidth(doc,{blockId,width:'full'|'half'}):doc|null`.
Comando de layout da linha aceita também `aside_right` em v3 via `editV3`.
`openInsertPanel({page,anchor,point,onInsert,onUpload,onColumns})` retorna close.

- [ ] RED: novo two-column group não converte row anterior; IDs preservados,
  invalid target/limite no-op não faz upgrade:

```js
const doc = referenceDocument(), section = doc.sections[0], before = section.rows[0];
const next = insertColumns(doc, { sectionId: section.id, beforeRowId: before.id });
assert.equal(next.sections[0].rows[0].layout, 'two_equal');
assert.deepEqual(next.sections[0].rows[1], before);
assert.equal(insertAt(doc, { columnId: 'missing', index: 0, block: textBlock() }), null);
assert.equal(JSON.stringify(doc), JSON.stringify(referenceDocument()));
```

- [ ] Definir ponto before/after de bloco/linha selecionada; capturá-lo ao abrir
  painel e ao iniciar upload. Ao completar upload, resolver IDs atuais; se destino
  removido pedir novo destino, nunca anexar em outra coluna silenciosamente.
  Catálogo ref tem Texto/Imagem-GIF/Vídeo/Áudio/Galeria/Duas colunas/Destaque-botão;
  FAQ acessível por busca e opção adicional sem excluir qualquer função legada.
  Destaque-botão abre escolha real; não colapsar duas operações distintas.
- [ ] Largura half transforma linha single em two_equal preservando ordem;
  half já igual é no-op. Full em linha dupla exige confirmação de merge mantendo
  esquerda→direita, não apaga vizinhos; usa comando legado de merge testado.
  Estrutura arrasta por UUID e tem subir/descer acessíveis; ícones por conteúdo.
  Organização oferece “Conteúdo com lateral” (`aside_right`), com conversão segura
  single/two_equal e merge reversível; não torna o preset um layout oculto da fixture.
- [ ] Duplicar gera IDs novos de bloco/itens; revalida destino de botões, marks,
  limites e histórico. Mostrar placeholder “selecionar mídia” com estado honesto.
- [ ] GREEN unit + interação browser em 50/100/150%: drop/pointer/teclado,
  container transform não corrompe coordenadas; se drag não confiável, corrigir
  medição, não declarar suporte apenas porque alternativas funcionam.

### Task 12: Autoria de galeria, FAQ, vídeo externo e mídias tipadas

**Files:** criar `public/pages/editor-media.js`,
`tests/unit/pages-editor-media.test.mjs`; modificar `public/pages/editor.js`,
`public/pages/editor-source.js`, `public/pages/api.js`, `public/pages/document-v3.js`,
`tests/visual/check-pages-v2.mjs`; adicionar cenários em `check-pages-reference.mjs`
na tarefa 18 (sem afirmar comparação antes de existir).

**Interfaces:** `createBlockFields({page,block,resolveBlock,transact,upload,
onFocus,createRichEditor}):{node,refresh,dispose}` para gallery/FAQ/embed/mídia.
`parseYouTubeURL(input):{provider:'youtube',video_id}|null` no módulo document-v3.

- [ ] RED: áudio usa input accept `audio/mpeg,.mp3`, vídeo `video/mp4,.mp4`, imagem
  aceita somente seus tipos; cliente nunca trata erro de MIME como upload pronto.
  Gallery upload parcial conserva itens já confirmados e arquivos anteriores;
  order/caption/alt tornam dirty e sobrevivem ao save/reload. Cancelar picker não
  altera doc/histórico. Replace falho mantém media_id anterior.

```js
assert.deepEqual(parseYouTubeURL('https://youtu.be/dQw4w9WgXcQ'),
  { provider: 'youtube', video_id: 'dQw4w9WgXcQ' });
assert.equal(parseYouTubeURL('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ'), null);
assert.equal(parseYouTubeURL('<iframe src="https://www.youtube.com"></iframe>'), null);
assert.equal(parseYouTubeURL('http://www.youtube.com/watch?v=dQw4w9WgXcQ'), null);
```

- [ ] Aceitar apenas HTTPS hosts `youtube.com`, `www.youtube.com`, `m.youtube.com`,
  `youtu.be`, paths watch/shorts/embed e ID exato; remover tracking por normalização,
  rejeitar credenciais/portas estranhas/redirect/link arbitrário. Persistir só
  provider/ID, título e transcrição, não thumbnail, iframe ou URL crua.
- [ ] Gallery add/reorder/remove/alt/caption/credit e kind image/gif; FAQ add/reorder/
  remove/question/answer, EditorViews keyed por block+item. Cada ação via transact;
  remover item destrói view/mídia só local, não exclui arquivo no servidor.
- [ ] Embed mostra aviso terceiro e ações “link incorporado”/“upload MP4 privado”.
  Troca de fonte é explícita, preserva conteúdo anterior ao cancelar. Upload
  serializado por página respeita max50/100MiB e retry idempotente de cada arquivo;
  nunca reenvia automaticamente arquivo cuja resposta de COMMIT é ambígua.
- [ ] GREEN unit/browser: editar→salvar→reload→prévia/leitor de todos os blocos;
  dupla edição após reorder não usa closure obsoleta; sair/trocar conta cancela
  views/requests/listeners e não publica arquivo perdido.

### Task 13: Inspetor e painel de estilo fiéis e persistidos

**Files:** criar `public/pages/editor-style.js`,
`tests/unit/pages-editor-style.test.mjs`; modificar `public/pages/editor.js`,
`public/pages/editor-source.js`, `public/pages/editor-workspace.js`,
`public/css/pages-editor-v2.css`, `tests/visual/check-pages-v2.mjs`.

**Interfaces:** `openStylePanel({page,anchor,document,onApply}):{close}`;
`createInspector({document,block,onAppearance,onTags,onWidth,onAdvanced})`;
onApply recebe defaults completos válidos; onAppearance recebe patch parcial
ou remove override. Nunca aplicar a todos os blocos como substituto de herança.

- [ ] RED browser: reabrir painel lê o estado salvo; alterar campos e Escape
  não muda JSON; Apply é uma transação undoable, novo bloco herda, override antigo
  conserva valor. Troca Tema/Tipografia/Cores funciona por teclado e foco visível.

```js
const before = JSON.stringify(state.document);
const panel = openStylePanel({ page, anchor, document: state.document, onApply });
panel.close();
assert.equal(JSON.stringify(state.document), before);
assert.equal(state.canUndo, false);
```

- [ ] Implementar ordem exata e heading contextual do inspetor: font, size,
  align, width, background/swatches, tags, icon, advanced. Only-if-applicable
  é explícito, sem controle decorativo. Advanced acomoda move/duplicate/delete/
  destino e limites reais. Fundo “Sem preenchimento” = herdar; tags não mexem
  nas tags metadata; icon genérico não sobrescreve callout.icon legado.
- [ ] PM marks text_color/highlight seguros em paste, teclado, JSON, renderer.
  Reter seleção ao clicar picker; remover cor/realce é comando real. Hex valida
  e normaliza sem interpolação CSS arbitrária; contraste ao vivo do par efetivo.
- [ ] Painel 400px/âncora conforme manifesto, paletas de 3 swatches e tab strip;
  mesmos tokens no preview. Atualizar teste antigo que afirmava “novos blocos
  não herdam” **apenas no contrato v3**; manter esse fato para documentos v2.
- [ ] GREEN unit/browser, bundle rebuild; v1/v2 sem interação nova continuam
  byte-estáveis; novo comando v3 só habilita com document_support do servidor.

### Task 14: Workspace desktop, modelos, dispositivo e zoom reais

**Files:** modificar `public/pages/editor-workspace.js`, `public/pages/editor.js`,
`public/pages/editor-panels.js`, `public/css/pages-editor-v2.css`,
`public/pages/catalog.js`, `api/pages/templates.js`, `api/pages/validation.js`;
criar `tests/unit/pages-workspace-controls.test.mjs`.

**Interfaces:** workspace callbacks `onUndo,onRedo,onModel,onDevice,onZoom`;
`setHistory({canUndo,canRedo})`, `setViewport({device,zoom})`. Modelo guia v3
produção é receita ilustrativa genérica própria, não o helper de teste importado
pelo runtime. `createTemplate` + lista de templates suportam guia quando gate true.

- [ ] RED: modelo é button/select real; escolher cria novo rascunho idempotente
  e respeita leave guard antes de abandonar atual. Cancel/falha mantém doc/views/
  URL. Nenhuma chamada create no simples abrir do dropdown.
- [ ] Header da referência: marca compacta Conecta, title/breadcrumb categoria,
  status verdadeiro, Prévia/Publicar. Segunda barra Insert/Modelo/Estilo,
  undo/redo, dispositivo e zoom. Não usar static span, modos grandes concorrentes
  ou drag row sempre visível. Reusar SVGs locais; se marca exata não existir,
  extrair só a marca original vetorial fornecida, sem reinterpretar/redesenhar.
- [ ] Dispositivo muda largura da superfície desktop/mobile390; zoom usa
  transform-origin top left em superfície interna, wrapper mede largura/altura
  escaladas para scroll correto. Toolbar/inspetor não sofrem zoom. CSS container
  da superfície controla stacking, não apenas viewport global do navegador.
  Zoom nunca muta document/font; Mod+S e status ação permanecem alcançáveis.
- [ ] Browser GREEN com geometria e estado:

```js
const before = await page.evaluate(() => JSON.stringify(globalThis.__referenceDraft()));
await page.getByRole('combobox', { name: 'Zoom' }).selectOption('75');
await page.getByRole('combobox', { name: 'Dispositivo' }).selectOption('mobile');
assert.equal(await page.locator('.pages-editor-surface').evaluate(n => n.clientWidth), 390);
assert.equal(await page.evaluate(() => JSON.stringify(globalThis.__referenceDraft())), before);
```

  `__referenceDraft` é exposto só pelo harness de teste, nunca global de produção.
  Medir 50/75/100/125/150, 1366/1600, com caret, scroll, seleção/drop e estabilidade
  de EditorView; focus-only/hover revela alvos sem sumir para teclado/toque.

### Task 15: Revisão editável sem perder o snapshot conferido

**Files:** criar `public/pages/editor-review.js`,
`tests/unit/pages-editor-review.test.mjs`; modificar `public/pages/editor.js`,
`public/pages/dialog.js`, `public/css/pages-editor-v2.css`,
`tests/unit/pages-state.test.mjs`, `tests/visual/check-pages-v2.mjs`.

**Interfaces:** `openReview({page,state,api,cargos,onChanged,onPublish}):{close}`;
estado local review guarda `{version,revisionId,documentHash,checks}`. onPublish
recebe payload idempotente exato, não lê head novo silenciosamente durante envio.

- [ ] RED: editar title/category/cargos no modal torna dirty e invalida o snapshot;
  Publish disabled até salvar, confirmar ack e mostrar nova revisão. Auxílio
  checklist não substitui validação ou aprova outra pessoa:

```js
const reviewed = state.workspace.draft_revision_id;
state.transact({ group: 'review:category' }, doc => { doc.metadata.category = 'Pessoas e cultura'; });
assert.equal(state.publishable, false);
assert.equal(state.workspace.draft_revision_id, reviewed);
await state.save(api);
assert.notEqual(state.workspace.draft_revision_id, reviewed);
assert.equal(state.pending, null);
```

- [ ] Layout/labels/close da prancha, categoria com suggestions autorizadas e
  valor livre, visibilidade abre os cargos ativos sem “Todos” implícito. URL
  mostra slug confirmado ou URL UUID verdadeira; não previewSlug inventado.
  Publisher-only lê campos disabled, pode publicar revisão existente sem edit.
- [ ] Troca de título/público feita fora do modal, revisão alterada noutra aba,
  conflito/erro ou upload pendente invalidam confirmar. Checks voltam a false
  quando conteúdo conferido muda. Voltar/Escape/× não desfaz nem salva alterações;
  deixa rascunho dirty com aviso/leave guard normais. Não apagar edição para
  fabricar aparência de “Cancel” transacional que não foi prometida.
- [ ] GREEN: payload revisão exata/CAS/idempotência, failed publish retry mesma
  chave/snapshot, archive/restore preservados e sem falso aviso de protótipo.
  **Checkpoint C:** todos os controles desktop da matriz têm roundtrip comprovado.

### Task 16: Painel mobile Conteúdo e adaptação responsiva fiel

**Files:** modificar `public/pages/editor-workspace.js`, `public/pages/editor-style.js`,
`public/pages/editor-panels.js`, `public/css/pages-editor-v2.css`;
criar `tests/visual/check-pages-mobile-reference.mjs`;
modificar `tests/unit/pages-editor-lifecycle.test.mjs`.

**Interfaces:** mesmos nós/EditorViews e command callbacks do desktop; aba/sheet
é estado UI, sem outro documento. Hook de visualViewport só enquanto sheet ativa,
com cleanup na página e quando muda breakpoint.

- [ ] RED: 390×820, selecionada Introdução/Conteúdo, B/I/U/Link, tipografia
  combinada “Manrope · 16 px”, fundo, Concluir edição alcançáveis sem scroll
  artificial na tela inicial. Abrir Estilo/Posição revela controles reais;
  voltar Conteúdo não perde seleção nem recria EditorView.

```js
await page.setViewportSize({ width: 390, height: 820 });
await page.getByRole('button', { name: 'Conteúdo', exact: true }).click();
const done = page.getByRole('button', { name: 'Concluir edição', exact: true });
const box = await done.boundingBox();
assert.ok(box.y >= 0 && box.y + box.height <= 820);
await done.click();
assert.equal(await page.getByRole('dialog', { name: /propriedades/i }).count(), 0);
```

- [ ] Ajustar Blocos/Prévia/Publicar agrupados, insets/notice/selected block e
  sheet conforme manifesto; X compacto com hit area acessível não botão visível
  gigante. Fechar restaura foco ao alvo ainda visível e mantém texto/dirty.
  Durante teclado reduzido usar visualViewport.height/offsetTop e safe area;
  garantir foco não ocluído, scroll da seleção e sheet com max-height disponível.
- [ ] GREEN em 360/390/402/768/1366/1600/1920, rotação e mudança de breakpoint,
  safe-area simulada, teclado viewport reduzido, Tab/Escape/back, modal aninhado,
  200% browser zoom/reflow, axe A/AA. Distinguir simulação de teclado físico;
  registrar teste físico como pendente se nenhum aparelho estiver disponível.

### Task 17: Garantias completas em API/banco/browser e documentação

**Files:** modificar `tests/database/check-pages-v3.mjs`,
`tests/visual/check-pages-v2.mjs`, `tests/visual/check-pages-mobile-reference.mjs`,
`tests/helpers/pages-browser.mjs`, `docs/architecture/pages.md`, `README.md`,
`tests/visual/README.md`; criar `docs/reviews/2026-11-11-pages-reference-fidelity.md`.

**Interfaces:** relatório de aceite distingue PASS/PENDING/BLOCKED por requisito,
com comando/revisão/browser/viewport e path de evidência. API/database v3 harness
exercita código real com auth substituída, sem chamar isso de autenticação produtiva.

- [ ] RED por cenário: criar guia, todas propriedades/marks, gallery/FAQ/embed,
  botões, categorias/alias, ordenar/duplicar/largura/history, salvar/recarregar,
  publicar no harness, ler como cargo e negar outro; editar depois preserva versão
  publicada. No browser validar caminho completo, não só fonte/string.
  Usar `featureDocument` nos cenários completos; usar `referenceDocument` apenas
  nas capturas de equivalência. Nenhum CSS/hide condicional para remover blocos.
- [ ] Injetar erros individuais: 400/403/404/409/413, storage ausente, timeout,
  COMMIT sem ack, troca de conta e dispose; mesmos arquivos privados não ficam
  acessíveis por URL pública/Nginx `/uploads`. Catálogo não exibe draft alheio.
  Payload de download/galeria de outra página nunca passa `references`.
- [ ] Regressão legado v1/v2: abrir/preview/cancel/no-op não migra; estilos antigos
  screenshot+computed iguais; falha/move inválido não cria versão; primeiro comando
  v3 bem-sucedido é undoable e só persiste com save. Gate e clientes antigos nunca
  convertem v3 de volta. Sem imports/referências executáveis a CMS/Owner News antigo.
- [ ] Documentar contratos novos/versionamento/flag/rollback compatível, limitações
  YouTube/arquivos suportados/checklist pessoal, comandos e privacidade. Não mudar
  o histórico de deploy anterior para parecer que esta correção já foi publicada.
- [ ] GREEN: `npm run build:pages`, `npm run check:pages-build`, `npm run verify`,
  `git diff --check`, `node tests/database/check-pages.mjs`,
  `node tests/database/check-pages-v3.mjs`, `node tests/visual/check-pages-v2.mjs`,
  `node tests/visual/check-pages-mobile-reference.mjs`. Testes nativos PG16,
  Bash/restore e Nginx real nos checks existentes, quando ambiente autorizado.
  Não instalar dependências externas no package runtime; usar paths externos já
  disponíveis (`PGLITE_MODULE_PATH`, `PLAYWRIGHT_MODULE_PATH`, `AXE_MODULE_PATH`).

### Task 18: Comparação das seis pranchas e aceite do usuário

**Files:** criar `tests/visual/check-pages-reference.mjs`,
`tests/visual/compare-pages-reference.mjs`,
`tests/unit/pages-reference-comparison.test.mjs`; modificar manifesto da Tarefa 1,
relatório da Tarefa 17 e `tests/visual/README.md`.

**Interfaces:** runner requer `PAGES_REFERENCE_DIR` e `PAGES_REFERENCE_OUTPUT`
(pasta local nova, nunca screenshots protegidas); comparator
`compareRegion({reference,actual,region,anchors})` produz medidas/diff/overlay,
sem retornar PASS só por um percentual global. Decoder PNG em módulo externo
`PNGJS_MODULE_PATH`, não dependência do runtime. Paths+hashes completos no relatório.

- [ ] RED: teste do comparador deve falhar com uma região de inspetor deslocada
  5px ou ausente, mesmo quando 95% do frame é idêntico. Arquivo obrigatório
  ausente, SHA diferente sem reconhecimento ou tamanho errado = erro, não skip.

```js
const result = compareAnchors(
  [{ name: 'inspector', x: 1320, y: 128, tolerance: 2 }],
  [{ name: 'inspector', x: 1325, y: 128 }],
);
assert.equal(result.pass, false);
assert.equal(result.failures[0].name, 'inspector');
```

  Definir/exportar `compareAnchors(expected,actual)` em compare-pages-reference
  como helper puro, importável sem executar main; retornar `{pass,failures}`.
- [ ] Capturar cada estado a partir de fixture nova, browser/version fixos,
  deviceScaleFactor1, fontes `document.fonts.ready`, seleção/foco/scroll/caret
  controlados. Usar viewport 1600×1160 nos quatro desktop, 390×820 mobile
  Conteúdo e 1600×480 botões. Não reaproveitar as mutações de outro teste.
- [ ] Registrar âncoras DOM `getBoundingClientRect` correspondentes às referências
  medidas. Frames/painéis até 2px, controles até 4px; gaps e textos visíveis por
  região (header, toolbar, estrutura, canvas, inspetor, cada overlay e sheet).
  Gerar overlay 50% e mapa de diferenças de pixels separado de geometria.
  Antialiasing/contornos de texto do SVG não devem mascarar elemento ausente:
  registrar métricas, inspecionar visualmente e explicar divergências, sem
  criar golden da implementação nem um limiar global permissivo.
- [ ] Prancha de botões usa componentes de produção, em estados default/hover/
  focus/loading/disabled/confirmed acionados por harness real. Não desenhar uma
  página HTML especial que “parece certa” mas não usa os componentes entregues.
  Foco/targets acessíveis eventualmente além da geometria visível constam como
  exceções documentadas, não mudança estética escondida.
- [ ] GREEN: `node --test tests/unit/pages-reference-comparison.test.mjs`;
  `node tests/visual/check-pages-reference.mjs`, inspeção das seis sobreposições
  e revisão fresca da diff/evidência. Nenhum item ausente pode ser “PASS parcial”.
- [ ] Apresentar ao usuário a prévia corrigida com referência ao lado/overlay,
  os fluxos funcionais e limites de prova. Solicitar aceite; se houver ajustes,
  retornar à tarefa responsável e repetir a comparação. Não chamar CI/deploy
  técnico de aceite de fidelidade.
- [ ] Só após aceite e autorização própria preparar integração/publicação.
  Não executar push/merge/deploy neste plano de correção; escrever handoff da
  estratégia leitor-primeiro, flag, backup/restore/PG16 e rollback compatível.

---

## Matriz de cobertura e checkpoints finais

| Especificação | Tarefas que comprovam |
| --- | --- |
| §1 seis pranchas, hierarquia e geometria | 1, 13–16, 18 |
| §2 save/histórico/modelos/device/zoom/inserção | 9, 11, 12, 14, 17 |
| §3 defaults/overrides, legado, marks/hex/AA | 2, 3, 10, 13, 17 |
| §4 galeria/FAQ/YouTube, privacidade | 2, 5, 10, 12, 17 |
| §5 botões reais, download/upload/status | 2, 5, 8, 12, 18 |
| §6 categoria, alias, cargos, revisão exata | 4–7, 15, 17 |
| §7 fixture/comparação/regressões/aceite | 1, 16–18 |
| Preservação/rollout leitores primeiro | 2–7, 17; handoff 18 |

**Checkpoint A:** contrato/schema/referências/autorização, sem writer UI novo.
**Checkpoint B:** histórico único/save/EditorView estáveis.
**Checkpoint C:** desktop completo com roundtrip e revisão protegida.
**Checkpoint D:** mobile/reflow e seis comparações revisadas; aceite do usuário
ainda separado do resultado automatizado. Produção não é alterada nestes checkpoints.

## Autorreflexão do plano

- Cobertura verificada contra todos os parágrafos da especificação aprovada.
- Contratos de v3, comandos, state, aliases, API e renderer definidos antes dos
  consumidores; manter esses nomes e formas ao executar tarefas vizinhas.
- Sem etapa de “apenas CSS” que possa mascarar função sem persistência.
- PostgreSQL concorrente/Nginx/teclado físico e validação produtiva têm limites
  explícitos: ambiente indisponível significa PENDING, não PASS.
- Não foi iniciada implementação, serviço, migration, gravação ou deploy para
  elaborar este documento. A escolha de execução é o próximo passo do usuário.
