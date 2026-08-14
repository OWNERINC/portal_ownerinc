# AutoCard Export and Employee Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AutoCard PNG exports preserve the preview geometry and improve the `novo_funcionario` card so its copy stays contained, smaller, and more usable.

**Architecture:** Keep the existing static JavaScript/CSS AutoCard implementation and capture the already-rendered DOM with `html2canvas`. Change only the employee template composition, shared export dimensions/readiness handling, footer assets, and focused invariant tests. The card remains a square `1080 × 1080 px` output.

**Tech Stack:** Browser JavaScript modules, CSS, `html2canvas` 1.4.1, Node's built-in test runner, existing dependency-free invariant harness.

## Global Constraints

- Keep the AutoCard export at `1080 × 1080 px`.
- Do not add a frontend framework or dependency.
- Preserve authenticated `blob:` media URLs and the existing crop contract.
- Keep the complete Portal logo assets unchanged for unrelated surfaces.
- Use the exact footer copy `Bem-vindo(a)`.
- Use wordmark-only assets copied from `C:\Ownerinc\global assets\Logos`.
- Preserve Node 18 compatibility for project code and scripts.
- Run `npm test`, `npm run verify`, focused AutoCard tests, and `git diff --check` before publication.

---

### Task 1: Add Wordmark Assets and Footer Contract

**Files:**
- Create: `public/assets/ownerinc-wordmark-black.webp` (copy from `C:\Ownerinc\global assets\Logos\logo simples preto.webp`)
- Create: `public/assets/ownerinc-wordmark-white.webp` (copy from `C:\Ownerinc\global assets\Logos\logo simples  branco.webp`)
- Modify: `public/autocard/vacancy-enhancements.js:62`
- Modify: `public/autocard/variant-enhancements.js:6-8,46-49`
- Modify: `public/autocard/app.js:62`
- Test: `tests/unit/autocard-invariants.test.mjs:667-710`

**Interfaces:**
- Consumes: the two source wordmark files in `C:\Ownerinc\global assets\Logos`.
- Produces: light/dark AutoCard footer paths `'/assets/ownerinc-wordmark-black.webp'` and `'/assets/ownerinc-wordmark-white.webp'`, without changing Portal shell logo paths.

- [ ] **Step 1: Copy the approved source assets into the public asset directory**

Verify the source files and destination directory, then copy without conversion:

```powershell
Test-Path -LiteralPath "C:\Ownerinc\global assets\Logos\logo simples preto.webp"
Test-Path -LiteralPath "C:\Ownerinc\global assets\Logos\logo simples  branco.webp"
Test-Path -LiteralPath "C:\PROJETOS\_ownerinc_portal\public\assets"
Copy-Item -LiteralPath "C:\Ownerinc\global assets\Logos\logo simples preto.webp" -Destination "C:\PROJETOS\_ownerinc_portal\public\assets\ownerinc-wordmark-black.webp"
Copy-Item -LiteralPath "C:\Ownerinc\global assets\Logos\logo simples  branco.webp" -Destination "C:\PROJETOS\_ownerinc_portal\public\assets\ownerinc-wordmark-white.webp"
```

- [ ] **Step 2: Update all AutoCard footer logo references and exact copy**

Use the wordmark paths in `footer(theme)` and the variant theme map. In
`renderEmployee()`, replace the footer span with:

```html
<span>Bem-vindo(a)</span>
```

Keep `alt="Ownerinc"`, `object-fit: contain`, and no global Portal logo changes.

- [ ] **Step 3: Add invariant assertions for the asset contract**

Extend the existing AutoCard invariant test after the current `vacancy` source
assertions:

```js
assert.match(app, /ownerinc-wordmark-(?:black|white)\.webp/);
assert.match(vacancy, /<span>Bem-vindo\(a\)<\/span>/);
assert.match(variant, /ownerinc-wordmark-black\.webp/);
assert.match(variant, /ownerinc-wordmark-white\.webp/);
```

Change the existing reads near the AutoCard source assertions to:

```js
const [app, vacancy, variant] = await Promise.all([
  readFile('public/autocard/app.js', 'utf8'),
  readFile('public/autocard/vacancy-enhancements.js', 'utf8'),
  readFile('public/autocard/variant-enhancements.js', 'utf8'),
]);
```

- [ ] **Step 4: Run the focused test**

Run: `node --test tests/unit/autocard-invariants.test.mjs`

Expected: PASS, with the existing tests and the new wordmark/copy assertions.

- [ ] **Step 5: Commit the asset and footer change**

```bash
git add public/assets/ownerinc-wordmark-black.webp public/assets/ownerinc-wordmark-white.webp public/autocard/app.js public/autocard/vacancy-enhancements.js public/autocard/variant-enhancements.js tests/unit/autocard-invariants.test.mjs
git commit -m "fix: use AutoCard wordmark footer"
```

### Task 2: Stack and Contain the Employee Card

**Files:**
- Modify: `public/autocard/vacancy-enhancements.js:53-65`
- Modify: `public/autocard/styles.css:15-19`
- Test: `tests/unit/autocard-invariants.test.mjs:407-575,713-734`

**Interfaces:**
- Consumes: existing `renderEmployee()` markup, `current.mediaCrop`, and `__autocardApplyMediaCropStyle()`.
- Produces: a full-width stacked employee card with contained name, description, and footer.

- [ ] **Step 1: Add failing layout assertions**

Add source-contract assertions for the employee renderer and styles:

```js
assert.match(vacancy, /employee-layout/);
assert.match(vacancy, /employee-copy/);
assert.match(vacancy, /Bem-vindo\\(a\\)/);
assert.match(styles, /\.employee-card/);
assert.match(styles, /\.employee-layout[^}]*flex-direction:\s*column/);
assert.match(styles, /\.employee-copy[^}]*min-width:\s*0/);
assert.match(styles, /overflow-wrap:\s*anywhere/);
```

Read `public/autocard/styles.css` as `styles` immediately before the layout
assertions:

```js
const styles = await readFile('public/autocard/styles.css', 'utf8');
```

- [ ] **Step 2: Run the focused test to verify the new assertions fail**

Run: `node --test tests/unit/autocard-invariants.test.mjs`

Expected: FAIL because the employee layout is still side-by-side and lacks the
new containment contract.

- [ ] **Step 3: Change the employee renderer only where needed**

Keep the existing crop style copied from the current image and retain the same
semantic fields. Keep this structure in `renderEmployee()`:

```html
<div class="employee-layout">
  <div class="employee-photo">...</div>
  <div class="employee-copy">
    <div class="card-kicker">...</div>
    <h2>...</h2>
    <p class="sub">...</p>
    <div class="employee-start">...</div>
    <p class="body">...</p>
    <div class="card-footer"><span>Bem-vindo(a)</span><img ...></div>
  </div>
</div>
```

Do not reintroduce private media URLs or duplicate crop state.

- [ ] **Step 4: Replace the employee CSS overrides with the stacked geometry**

Use the existing square card and give the image a bounded upper band. The
employee-specific rules should include these concrete constraints:

```css
.employee-card { container-type: inline-size; }
.employee-layout { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.employee-photo { flex: 0 0 40%; width: 100%; min-height: 0; margin: 0; border-radius: 0; }
.employee-copy { flex: 1 1 60%; min-width: 0; min-height: 0; padding: 20px 28px 22px; overflow: hidden; }
.employee-copy h2 { max-width: 100%; font-size: clamp(22px, 4.5cqw, 28px); overflow-wrap: anywhere; word-break: normal; }
.employee-copy .body { min-height: 0; overflow: hidden; line-height: 1.45; }
.employee-copy .card-footer { flex: 0 0 auto; min-width: 0; }
.employee-copy .card-footer span { min-width: 0; overflow-wrap: anywhere; }
.employee-copy .card-footer img { width: min(118px, 32%); height: auto; max-height: 24px; object-fit: contain; }
```

Retain the existing `.employee-photo img` crop positioning rules and add
responsive padding only if needed for the existing `max-width:500px` media
query. Do not use fixed height values that can create overflow.

- [ ] **Step 5: Run focused tests and inspect the generated markup contract**

Run: `node --test tests/unit/autocard-invariants.test.mjs`

Expected: PASS, including crop lifecycle tests and the new employee containment
assertions.

- [ ] **Step 6: Commit the stacked employee layout**

```bash
git add public/autocard/vacancy-enhancements.js public/autocard/styles.css tests/unit/autocard-invariants.test.mjs
git commit -m "fix: contain AutoCard employee layout"
```

### Task 3: Make PNG Export Match Preview Geometry

**Files:**
- Modify: `public/autocard/app.js:71`
- Modify: `tests/unit/autocard-invariants.test.mjs:667-710`

**Interfaces:**
- Consumes: rendered `#cardCanvas`, authenticated image/blob nodes, and the existing `html2canvas` global.
- Produces: a PNG capture using the card's actual rendered width/height and a target width of `1080`.

- [ ] **Step 1: Add failing export source assertions**

Extend the export assertions with the required readiness and geometry rules:

```js
assert.match(app, /document\.fonts\?\.ready/);
assert.match(app, /getBoundingClientRect\(\)/);
assert.match(app, /const\s+height\s*=\s*rect\.height/);
assert.match(app, /const\s+scale\s*=\s*1080\s*\/\s*width/);
assert.match(app, /height,\s*backgroundColor:\s*null/);
assert.doesNotMatch(app, /height\s*:\s*size/);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/unit/autocard-invariants.test.mjs`

Expected: FAIL because the current exporter uses `height:size` and only waits
for the first media image.

- [ ] **Step 3: Replace the exporter with geometry-preserving capture logic**

Keep the existing button disable/finally behavior and use this sequence inside
`exportCard()`:

```js
if (document.fonts?.ready) {
  try { await document.fonts.ready; } catch {}
}
const images = [...canvas.querySelectorAll('img')];
for (const image of images) {
  if (typeof image.decode === 'function') {
    try { await image.decode(); } catch { toast('A imagem ainda não está pronta para exportação.'); return; }
  } else if (!image.complete) {
    toast('A imagem ainda não está pronta para exportação.');
    return;
  }
}
const rect = canvas.getBoundingClientRect();
const width = rect.width;
const height = rect.height;
const scale = 1080 / width;
const rendered = await html2canvas(canvas, {
  scale,
  width,
  height,
  backgroundColor: null,
});
```

Use the existing download link and filename after capture. The current image
crop styles remain in the DOM and are not recomputed during export.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/unit/autocard-invariants.test.mjs`

Expected: PASS, including the existing image readiness and safe export checks.

- [ ] **Step 5: Commit the export fix**

```bash
git add public/autocard/app.js tests/unit/autocard-invariants.test.mjs
git commit -m "fix: preserve AutoCard export geometry"
```

### Task 4: Documentation and Full Verification

**Files:**
- Modify: `CHANGELOG.md`
- Verify: `docs/superpowers/specs/2026-08-14-autocard-export-and-employee-layout-design.md`
- Verify: all files changed by Tasks 1–3

- [ ] **Step 1: Record the user-visible behavior change**

Add one concise entry under the current unreleased section in `CHANGELOG.md`:

```markdown
- AutoCard exports now preserve preview proportions and the employee card uses a contained stacked layout with a wordmark-only footer.
```

- [ ] **Step 2: Run the focused and repository checks**

Run:

```bash
node --test tests/unit/autocard-invariants.test.mjs
npm test
npm run verify
git diff --check
```

Expected: all commands exit successfully, with no generated files or secrets
added to the worktree.

- [ ] **Step 3: Inspect final status and diff**

Run:

```bash
git status --short
git diff 3ba7158..HEAD --stat
git diff 3ba7158..HEAD -- public/autocard/app.js public/autocard/vacancy-enhancements.js public/autocard/styles.css public/autocard/variant-enhancements.js tests/unit/autocard-invariants.test.mjs CHANGELOG.md
```

Confirm that only the approved AutoCard behavior, assets, tests, changelog,
specification, and plan are present.

- [ ] **Step 4: Commit the documentation and final verification record**

```bash
git add CHANGELOG.md docs/superpowers/specs/2026-08-14-autocard-export-and-employee-layout-design.md docs/superpowers/plans/2026-08-14-autocard-export-and-employee-layout.md
git commit -m "docs: record AutoCard export improvements"
```
