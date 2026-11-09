# Fundo aurora no login — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar uma aurora clara e discreta exclusivamente ao fundo do login.

**Architecture:** Preservar o frontend estático e o HTML/JavaScript atual.
Dois pseudo-elementos fixos, contidos no viewport e não interativos compõem o
fundo; o conteúdo mantém seu layout acima deles. Os gradientes têm uma entrada
única, desativada para movimento reduzido.

**Tech Stack:** HTML/CSS nativos, testes `node:test` sem dependências novas e
Playwright externo ao repositório para inspeção visual local.

## Global Constraints

- Fonte de requisitos: `docs/superpowers/specs/2026-11-09-login-aurora-design.md`.
- O frontend permanece estático em `public/`.
- Não serão instalados React, Tailwind, TypeScript, shadcn, Framer Motion ou Lottie.
- Nenhuma regra deve alterar os tokens globais nem alcançar as páginas autenticadas.
- Não modificar a autenticação nem `public/js/login.js`.
- Preservar logos, textos, espaçamentos estruturais e os quatro estados do acesso.
- Não haverá movimento contínuo.
- Não iniciar Docker nem acessar serviços de produção.
- Preservar o trabalho local existente; não incluí-lo acidentalmente em commits.
- Sem mudanças em API, banco, scripts de deploy ou publicação.

## Steps

- [x] Implementar, testar e conferir visualmente a aurora isolada do login.

---

### Task 1: Fundo decorativo acessível, sem novas dependências

**Files:**
- Modify: `public/css/login.css` — somente acrescentar regras do fundo.
- Create: `tests/unit/login-aurora.test.mjs` — invariantes CSS e isolamento.
- Create: `tests/visual/check-login-aurora.mjs` — composição e movimento no navegador.
- Create: `docs/reviews/2026-11-09-login-aurora.md` — resultados observados e limites.
- Read/run only: `tests/visual/check-login-approved.mjs` — regressões do login em andamento.
- Read only: `public/css/tokens.css`, `public/login.html`, `tests/visual/README.md`.

**Interfaces:**
- Consumes: `--bg`, `--primary`, `--accent`, `.login-split`, `.form-panel` e os
  estados já controlados pelo JavaScript de login.
- Produces: `body::before` e `body::after` com animação `login-aurora-enter`,
  sem novos dados, funções públicas, elementos focáveis ou chamadas de rede.

- [x] **Step 1: Registrar a base e escrever os testes unitários que falham.**

Executar `git status --short` e registrar os arquivos já alterados. Criar
`tests/unit/login-aurora.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';

const css = await readFile('public/css/login.css', 'utf8');

test('aurora stays behind the login without intercepting controls or locking scroll', () => {
  const layers = css.match(/body::before,\s*body::after\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(layers, /content:\s*""/);
  assert.match(layers, /position:\s*fixed/);
  assert.match(layers, /inset:\s*0/);
  assert.match(layers, /pointer-events:\s*none/);
  assert.match(layers, /z-index:\s*-1/);
  assert.match(css, /body\s*\{[^}]*isolation:\s*isolate/);
  assert.doesNotMatch(css, /(?:body|html)\s*\{[^}]*(?:overflow(?:-y)?:\s*hidden|height:\s*100(?:s|d)?vh)/);
  assert.doesNotMatch(css, /filter:\s*blur|backdrop-filter|https?:\/\//);
});

test('aurora uses brand gradients and a brief single entrance, with a static reduced-motion fallback', () => {
  assert.match(css, /body::before\s*\{[^}]*radial-gradient/);
  assert.match(css, /body::after\s*\{[^}]*radial-gradient/);
  assert.match(css, /var\(--primary\)/);
  assert.match(css, /var\(--accent\)/);
  assert.match(css, /@keyframes login-aurora-enter/);
  const motion = css.match(/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*body::before,\s*body::after\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(motion, /animation:\s*login-aurora-enter 900ms ease-out both/);
  assert.doesNotMatch(css, /infinite/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*body::before,\s*body::after\s*\{[^}]*animation:\s*none;[^}]*transform:\s*none/);
});

test('only login loads its effect stylesheet', async () => {
  for (const file of await readdir('public')) {
    if (!file.endsWith('.html')) continue;
    const html = await readFile(`public/${file}`, 'utf8');
    assert.equal(/href=["'][^"']*css\/login\.css["']/.test(html), file === 'login.html', file);
  }
});
```

- [x] **Step 2: Confirmar a falha antes da implementação.**

Run: `node --test tests/unit/login-aurora.test.mjs`

Expected: os dois testes do efeito falham pela ausência das camadas/animação;
o isolamento do stylesheet já deve passar. Não corrigir falhas alterando o login
existente nem relaxando os contratos de comportamento.

- [x] **Step 3: Acrescentar o CSS mínimo ao final de `public/css/login.css`.**

```css
/* Aurora decorativa exclusiva do acesso; o fluxo e o layout permanecem intactos. */
body { isolation: isolate; }
body::before, body::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
}
body::before {
  background: radial-gradient(ellipse at 12% 18%, color-mix(in srgb, var(--primary) 12%, transparent), transparent 65%);
}
body::after {
  background: radial-gradient(ellipse at 88% 82%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 62%);
}
@keyframes login-aurora-enter {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: no-preference) {
  body::before, body::after { animation: login-aurora-enter 900ms ease-out both; }
}
@media (prefers-reduced-motion: reduce) {
  body::before, body::after { animation: none; transform: none; }
}
```

As posições, transparências e duração são concretas para a primeira inspeção.
Se a inspeção mostrar contraste ruim, reduzir a opacidade, nunca alterar a
superfície opaca do formulário. `color-mix` sem suporte degrada para o fundo de
base já existente. A animação atua apenas em opacidade e transformação.

- [x] **Step 4: Rodar os testes do efeito e as regressões do acesso.**

Run:

```sh
node --test tests/unit/login-aurora.test.mjs tests/unit/login-approved-reference.test.mjs tests/unit/pending-registration.test.mjs tests/unit/podfalar-brand-assets.test.mjs
```

Expected: todos passam. Os três últimos arquivos já pertencem ao trabalho
existente e não devem ser editados nem incluídos no commit da aurora.

- [x] **Step 5: Criar a inspeção automatizada do efeito.**

Criar `tests/visual/check-login-aurora.mjs`:

```js
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

if (!process.env.PLAYWRIGHT_MODULE_PATH) throw new Error('Set PLAYWRIGHT_MODULE_PATH');
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const origin = new URL(process.env.VISUAL_ORIGIN || 'http://127.0.0.1:4178');
assert.equal(origin.hostname, '127.0.0.1');
const output = resolve(process.env.VISUAL_OUTPUT || join(tmpdir(), 'opencode', 'login-aurora-visual'));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
const results = [];
try {
  for (const reducedMotion of ['reduce', 'no-preference']) {
    const context = await browser.newContext({ reducedMotion });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const width of [360, 402, 1366]) {
      await page.setViewportSize({ width, height: width > 1000 ? 768 : 667 });
      await page.goto(new URL('/login.html', origin).href, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      const layers = await page.evaluate(async () => {
        const animations = document.body.getAnimations().filter(animation => animation.animationName === 'login-aurora-enter');
        const count = animations.length;
        await Promise.all(animations.map(animation => animation.finished));
        return {
          count,
          layers: ['::before', '::after'].map(pseudo => {
            const style = getComputedStyle(document.body, pseudo);
            return { background: style.backgroundImage, pointerEvents: style.pointerEvents, zIndex: style.zIndex, transform: style.transform, animation: style.animationName, opacity: style.opacity };
          }),
          overflow: document.documentElement.scrollWidth > innerWidth,
          scrollable: getComputedStyle(document.body).overflowY !== 'hidden',
        };
      });
      assert.equal(layers.count, reducedMotion === 'reduce' ? 0 : 2);
      assert.equal(layers.overflow, false);
      assert.equal(layers.scrollable, true);
      for (const layer of layers.layers) {
        assert.match(layer.background, /radial-gradient/);
        assert.equal(layer.pointerEvents, 'none');
        assert.equal(layer.zIndex, '-1');
        assert.equal(layer.opacity, '1');
        assert.equal(layer.transform, 'none');
        assert.equal(layer.animation, reducedMotion === 'reduce' ? 'none' : 'login-aurora-enter');
      }
      await page.getByRole('button', { name: 'Esqueci minha senha', exact: true }).click();
      assert.equal(await page.locator('#reset-section').isVisible(), true);
      await page.locator('#back-link').click();
      await page.getByRole('button', { name: 'Cadastre-se', exact: true }).click();
      assert.equal(await page.locator('#register-section').isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.locator('#register-back-link').click();
      await page.screenshot({ path: join(output, `login-${width}-${reducedMotion}.png`), fullPage: true });
      results.push({ width, reducedMotion, ...layers });
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`PASS ${results.length} aurora cases: ${output}`);
} finally {
  await browser.close();
}
```

- [x] **Step 6: Executar a prévia local e conferir as capturas.**

Antes de iniciar outro servidor, verificar se a porta 4178 já oferece a prévia
esperada. Se não, executar `node tests/visual/serve-conecta.mjs` em background.
Não reiniciar nem encerrar processos preexistentes de outras sessões.

Localizar Playwright e axe externos pelas variáveis de ambiente e diretórios
temporários aprovados. Se não estiverem disponíveis, registrar a limitação;
não acrescentá-los ao `package.json` nem afirmar aceite visual sem execução.

Com os caminhos reais definidos em `PLAYWRIGHT_MODULE_PATH` e
`AXE_MODULE_PATH`, executar separadamente:

```sh
node tests/visual/check-login-aurora.mjs
node tests/visual/check-login-approved.mjs
```

Expected: 6 combinações largura/movimento aprovadas no teste novo; o teste
existente deve preservar os quatro estados, foco, teclado, PodFalar e axe nas
dez larguras previstas. Ler as capturas de 360/1366 px para confirmar que os
gradientes estão visíveis, discretos e atrás do conteúdo; estilos computados
sozinhos não comprovam uma composição visual correta. Conferir também o login
no painel do navegador, fechar apenas abas abertas para inspeção própria e
encerrar apenas o servidor que esta tarefa tiver iniciado.

- [x] **Step 7: Documentar resultados, verificar e revisar o diff.**

Criar `docs/reviews/2026-11-09-login-aurora.md` com: arquivos alterados, conexão
com a especificação, comandos realmente executados, contagens de resultados,
caminhos de capturas e limitações explícitas de fixtures/autenticação real.
Registrar separadamente qualquer check que não foi executado.

Run: `npm run verify` e `git diff --check`.

Expected: zero falhas; distinguir os skips específicos de Linux. Revisar
`git diff -- public/css/login.css` para comprovar que apenas o bloco aurora foi
acrescentado sobre o trabalho existente. Fazer revisão de acessibilidade e
escopo antes da entrega. Não realizar commit de `public/css/login.css` inteiro
enquanto ele contiver mudanças anteriores não pertencentes a esta tarefa;
separar apenas o hunk da aurora caso seja necessário um commit de implementação.

- [ ] **Step 8: Entregar com evidência e sem deploy.**

Informar o efeito implementado, o escopo exclusivo do login, resultados reais
dos testes e pendências. Abrir uma captura representativa para o usuário.
Não iniciar publicação, merge nem alterações de serviços.
