# Home Editorial em Formato de Catálogo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar uma prévia isolada e navegável da home Ownerinc na direção aprovada de revista assimétrica, com capa grande, trilhos editoriais e diretório funcional responsivo.

**Architecture:** A nova página estática `public/home-preview.html` terá conteúdo editorial mockado e links reais para as áreas existentes, sem substituir `public/dashboard.html` nem inicializar autenticação. O estilo ficará isolado em `public/css/home-preview.css`, reutilizando apenas tokens e o sprite SVG existentes; não haverá dependência nova nem JavaScript específico para a primeira prévia.

**Tech Stack:** HTML estático, CSS existente do Portal, SVG sprite local, Node `node:test` para invariantes de frontend, navegador para validação visual.

## Global Constraints

- A prévia isolada deve ficar em uma página ou rota própria, sem substituir `public/dashboard.html` nesta primeira entrega.
- Preservar os tokens de marca existentes em `public/css/tokens.css`.
- Não usar emoji como ícone estrutural; reutilizar o sprite SVG existente.
- Usar links reais para cards navegáveis, com nome acessível completo.
- Garantir alvos de toque mínimos de 44 por 44 px.
- Respeitar `prefers-reduced-motion`.
- Evitar scroll horizontal global; apenas trilhos editoriais podem rolar.
- Declarar proporção ou dimensões para imagens e reservar espaço para a capa.
- Não adicionar biblioteca de carrossel, framework frontend ou dependência visual nova.
- Rodar `git diff --check` e `npm run verify` antes de entregar.

---

### Task 1: Fixar os invariantes da prévia

**Files:**
- Create: `tests/unit/home-preview.test.mjs`
- Read: `public/home-preview.html` (criado na Task 2)
- Read: `public/css/home-preview.css` (criado na Task 2)

**Interfaces:**
- Consumes: a página estática e sua folha de estilos.
- Produces: invariantes executáveis para estrutura semântica, links, acessibilidade e responsividade.

- [ ] **Step 1: Escrever os testes de contrato antes da página**

Criar um teste Node sem dependências externas:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('home preview exposes an accessible editorial structure', async () => {
  const html = await readFile('public/home-preview.html', 'utf8');
  assert.equal((html.match(/<h1(?:\s|>)/g) || []).length, 1);
  assert.match(html, /class="skip-link"[^>]*href="#main-content"/);
  assert.match(html, /<main[^>]*id="main-content"/);
  assert.match(html, /aria-labelledby="featured-heading"/);
  assert.match(html, /aria-labelledby="areas-heading"/);
  assert.match(html, /<img[^>]+alt="[^"]+"/);
  assert.doesNotMatch(html, /\son(?:click|change|submit|keydown)=/i);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
});

test('home preview keeps functional areas discoverable and uses local icons', async () => {
  const html = await readFile('public/home-preview.html', 'utf8');
  for (const href of ['./knowledge.html', './reminders.html', './academy.html', './benefits.html', './announcements.html', './profile.html']) {
    assert.match(html, new RegExp('href="' + href.replace('.', '\\.') + '"'));
  }
  assert.match(html, /assets\/icons\.svg#/);
  assert.doesNotMatch(html, /href="#"/);
});

test('home preview has no global horizontal overflow and honors reduced motion', async () => {
  const css = await readFile('public/css/home-preview.css', 'utf8');
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /scroll-snap-type:\s*x\s*mandatory/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /min-width:\s*44px/);
  assert.match(css, /aspect-ratio:/);
});
```

- [ ] **Step 2: Rodar os testes para confirmar a falha inicial**

Run: `node --test tests/unit/home-preview.test.mjs`

Expected: FAIL because `public/home-preview.html` and `public/css/home-preview.css` do not exist yet.

- [ ] **Step 3: Confirmar que o teste está isolado**

Run: `node --test tests/unit/home-preview.test.mjs`

Expected after the implementation tasks: PASS without requiring API, Firebase, Docker, browser automation or network data.

---

### Task 2: Construir a página estática da direção C

**Files:**
- Create: `public/home-preview.html`
- Create: `public/css/home-preview.css`

**Interfaces:**
- Consumes: `public/css/tokens.css`, `public/assets/icons.svg` e os caminhos das páginas existentes.
- Produces: uma página aberta diretamente em `/home-preview.html`, com estrutura acessível e dados mockados estáveis.

- [ ] **Step 1: Criar o documento HTML com shell editorial estático**

Incluir, nesta ordem:

```html
<a class="skip-link" href="#main-content">Pular para o conteúdo</a>
<div class="preview-shell">
  <aside class="preview-sidebar" aria-label="Navegação principal">
    <a class="preview-brand" href="./home-preview.html">Ownerinc</a>
    <nav aria-label="Áreas do Portal">
      <a class="active" aria-current="page" href="./home-preview.html">Dashboard</a>
      <a href="./knowledge.html">Base de Conhecimento</a>
      <a href="./reminders.html">Lembretes</a>
      <a href="./academy.html">Academy</a>
      <a href="./benefits.html">Benefícios</a>
      <a href="./announcements.html">Anúncios</a>
      <a href="./profile.html">Meu Perfil</a>
    </nav>
  </aside>
  <div class="preview-content">
    <header class="preview-topbar">
      <span>Visão geral</span>
      <a class="preview-avatar" href="./profile.html" aria-label="Abrir meu perfil">MO</a>
    </header>
    <main id="main-content" tabindex="-1">
      <section class="preview-hero" aria-labelledby="page-title">
        <img src="https://images.unsplash.com/photo-1521737604893-d14cc237f11d?auto=format&fit=crop&w=1600&q=80" alt="Pessoas conversando em uma sala iluminada">
        <div class="preview-hero-copy">
          <p class="eyebrow">Edição da semana · Pessoas e cultura</p>
          <h1 id="page-title">Como transformar intenção em hábito.</h1>
          <p>Uma leitura curta para organizar o que importa e levar boas ideias para a rotina.</p>
          <a class="button button-primary" href="./announcements.html">Ler história</a>
          <p class="preview-meta">Leitura em 4 min · Publicado hoje</p>
        </div>
      </section>
      <section class="preview-section" aria-labelledby="featured-heading">
        <div class="section-heading"><h2 id="featured-heading">Também pode interessar</h2><a href="./announcements.html">Ver todos</a></div>
        <div class="story-rail">
          <a class="story-card" href="./academy.html"><img src="https://images.unsplash.com/photo-1497366811353-6870744d04b2?auto=format&fit=crop&w=600&q=80" alt="Sala de trabalho iluminada" width="600" height="360" loading="lazy"><span class="story-card-body"><strong>Um espaço para aprender junto</strong><small>Academy · Desenvolvimento</small></span></a>
          <a class="story-card" href="./knowledge.html"><img src="https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=600&q=80" alt="Notebook aberto sobre uma mesa" width="600" height="360" loading="lazy"><span class="story-card-body"><strong>Organize seu próximo ciclo</strong><small>Conhecimento · Gestão</small></span></a>
          <a class="story-card" href="./benefits.html"><img src="https://images.unsplash.com/photo-1524758631624-e2822e304c36?auto=format&fit=crop&w=600&q=80" alt="Pessoas trabalhando em uma mesa" width="600" height="360" loading="lazy"><span class="story-card-body"><strong>Uma vantagem para você</strong><small>Benefícios · Parceiros</small></span></a>
        </div>
      </section>
      <section class="preview-section" aria-labelledby="areas-heading">
        <div class="section-heading"><h2 id="areas-heading">Acessar áreas</h2><span>Explorar diretório</span></div>
        <div class="areas-grid">
          <a class="area-card" href="./academy.html"><svg aria-hidden="true"><use href="./assets/icons.svg#graduation-cap"></use></svg><strong>Academy</strong><span>Trilhas e cursos</span></a>
          <a class="area-card" href="./knowledge.html"><svg aria-hidden="true"><use href="./assets/icons.svg#book-open"></use></svg><strong>Conhecimento</strong><span>Regras e práticas</span></a>
          <a class="area-card" href="./reminders.html"><svg aria-hidden="true"><use href="./assets/icons.svg#bell"></use></svg><strong>Lembretes</strong><span>Datas importantes</span></a>
          <a class="area-card" href="./benefits.html"><svg aria-hidden="true"><use href="./assets/icons.svg#gift"></use></svg><strong>Benefícios</strong><span>Parceiros e vantagens</span></a>
        </div>
      </section>
    </main>
  </div>
</div>
```

Os cards devem permanecer completos no arquivo final:

- Três cards editoriais com imagens, títulos, categorias e links para Academy, Conhecimento e Benefícios.
- Quatro cards funcionais com links para Academy, Conhecimento, Lembretes e Benefícios.
- Usar `<svg aria-hidden="true"><use href="./assets/icons.svg#home"></use></svg>` como padrão de ícone, com `aria-label` nos controles que não tiverem texto.

- [ ] **Step 2: Criar o CSS da composição desktop**

Implementar `preview-shell`, `preview-sidebar`, `preview-content`, `preview-topbar`, `preview-hero`, `preview-hero-copy`, `.story-rail` e `.areas-grid` usando os tokens existentes como base. A capa deve usar `aspect-ratio: 16 / 7`, `position: relative`, overlay escuro e `object-fit: cover`; não animar dimensões.

- [ ] **Step 3: Implementar a adaptação mobile**

Em `@media (max-width: 768px)`:

```css
.preview-shell { display: block; overflow-x: hidden; }
.preview-sidebar { display: none; }
.preview-content { padding: 0; }
.preview-hero { aspect-ratio: 4 / 5; border-radius: 0; }
.story-rail { grid-auto-flow: column; grid-auto-columns: minmax(148px, 72vw); overflow-x: auto; scroll-snap-type: x mandatory; overscroll-behavior-x: contain; }
.story-card { scroll-snap-align: start; }
.areas-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.area-card { min-height: 88px; }
```

O diretório funcional permanece em grid de duas colunas e não pode depender do trilho para ser descoberto.

- [ ] **Step 4: Adicionar estados e acessibilidade visual**

Adicionar foco visível com `:focus-visible`, targets de pelo menos 44 px, `prefers-reduced-motion: reduce`, contraste da capa com overlay e estilos de link/hover/pressed sem mudança de layout. Usar `loading="lazy"` nas imagens dos cards abaixo da capa e manter `width`, `height` ou proporção declarada.

- [ ] **Step 5: Rodar os testes unitários da prévia**

Run: `node --test tests/unit/home-preview.test.mjs`

Expected: PASS, com a página sem dependências de autenticação ou API.

---

### Task 3: Validar a prévia em viewport real e fechar a entrega

**Files:**
- Modify: `public/home-preview.html` only if browser validation finds markup/accessibility defects.
- Modify: `public/css/home-preview.css` only if browser validation finds responsive defects.
- Test: `tests/unit/home-preview.test.mjs`

**Interfaces:**
- Consumes: página estática implementada na Task 2.
- Produces: prévia validada em desktop, mobile, teclado e redução de movimento.

- [ ] **Step 1: Servir somente `public/` para inspeção visual**

Run: `node -e "require('http').createServer((req,res)=>require('fs').createReadStream('public'+(req.url==='/'?'/home-preview.html':req.url)).on('error',()=>{res.statusCode=404;res.end()}).pipe(res)).listen(4173)"`

Expected: o servidor local permanece ativo em `http://localhost:4173/home-preview.html`.

- [ ] **Step 2: Verificar desktop**

Abrir `http://localhost:4173/home-preview.html` em 1440x900 e 1024x768. Confirmar que a capa domina a primeira dobra, o texto permanece legível, a sidebar não comprime o conteúdo e o diretório de áreas fica visível sem interação horizontal.

- [ ] **Step 3: Verificar mobile**

Abrir a mesma URL em 390x844 e 320x568. Confirmar capa proporcional, cards editoriais roláveis dentro do trilho, grid funcional de duas colunas sem overflow global e targets confortáveis.

- [ ] **Step 4: Verificar teclado e movimento**

Usar Tab, Shift+Tab e Enter para acessar a capa, trilhos, diretório e perfil. Confirmar foco visível. Ativar `prefers-reduced-motion` e confirmar que nenhuma transição é necessária para entender ou operar a página.

- [ ] **Step 5: Rodar a verificação do repositório**

Run: `git diff --check`

Expected: sem erros de whitespace.

Run: `npm run verify`

Expected: todos os checks existentes e o novo teste da prévia passam.

- [ ] **Step 6: Confirmar que a home oficial não foi substituída**

Run: `git diff -- public/dashboard.html`

Expected: sem saída; a primeira entrega permanece isolada em `public/home-preview.html`.

## Self-Review

- Cobertura da especificação: objetivos e direção visual na Task 2; componentes,
  fluxo de dados mockado e limites na Task 2; acessibilidade, responsividade e
  performance nas Tasks 1, 2 e 3; validação na Task 3.
- Acessibilidade: o plano exige um `h1`, skip link, landmarks, headings,
  labels, links semânticos, foco e redução de movimento.
- Segurança: a prévia é estática e não renderiza dados da API; não há
  `innerHTML` ou handlers inline.
- Performance: a capa tem proporção reservada; cards abaixo da dobra usam lazy
  loading; nenhuma dependência nova é adicionada.
- Escopo: `public/dashboard.html` fica intacto nesta primeira entrega.
- Placeholders: as imagens externas são explicitamente temporárias e o conteúdo
  textual do mock é completo; o plano não deixa marcadores de implementação.
