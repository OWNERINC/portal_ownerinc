# Bulk Invitation CSV Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a downloadable CSV example and complete format guidance to the existing bulk invitation panel.

**Architecture:** Serve one static CSV from `public/` and link to it from the existing administrative panel. Keep parsing and validation unchanged; a unit test will read the public asset through the production parser and assert the UI contract.

**Tech Stack:** Static HTML, CSV, Node.js built-in test runner.

## Global Constraints

- Keep the exact header order `name,email,job_title,contract_type,pj_due_day,phone`.
- Keep the existing CSV UTF-8, six-column, 500-user import contract.
- Add no dependency, API route, or JavaScript download handler.
- Example rows must be clearly fictitious and the UI must tell administrators to replace or remove them.

---

### Task 1: Downloadable template and guidance

**Files:**
- Create: `public/modelo-convites-usuarios.csv`
- Modify: `public/admin.html:79-85`
- Modify: `tests/unit/bulk-user-import.test.mjs`

**Interfaces:**
- Consumes: `parseCsv(input: string)` from `api/services/bulk-user-import.js`.
- Produces: public asset `/modelo-convites-usuarios.csv` and its download link in the bulk import panel.

- [ ] **Step 1: Write the failing contract test**

Append a test that reads `public/admin.html` and the new CSV path, then asserts:

```js
test('bulk invitation panel provides a documented parseable CSV template', async () => {
  const [html, csv] = await Promise.all([
    readFile('public/admin.html', 'utf8'),
    readFile('public/modelo-convites-usuarios.csv', 'utf8'),
  ]);
  assert.match(html, /href="\.\/modelo-convites-usuarios\.csv"[^>]*download/);
  for (const guidance of ['name', 'email', 'job_title', 'contract_type', 'pj_due_day', 'phone', '500']) {
    assert.match(html, new RegExp(guidance));
  }
  assert.equal(csv.split(/\r?\n/, 1)[0], 'name,email,job_title,contract_type,pj_due_day,phone');
  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.contract_type), ['clt', 'pj']);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/unit/bulk-user-import.test.mjs`

Expected: FAIL because `public/modelo-convites-usuarios.csv` does not exist.

- [ ] **Step 3: Add the static CSV model**

Create `public/modelo-convites-usuarios.csv` as UTF-8 text:

```csv
name,email,job_title,contract_type,pj_due_day,phone
Pessoa Exemplo CLT,substitua.clt@example.invalid,CARGO_ATIVO_EXATO,clt,,+55 11 90000-0000
Pessoa Exemplo PJ,substitua.pj@example.invalid,CARGO_ATIVO_EXATO,pj,15,+55 11 90000-0001
```

- [ ] **Step 4: Document the import beside the file selector**

In `public/admin.html`, retain the current introduction and add:

```html
<a class="btn btn-ghost btn-sm" href="./modelo-convites-usuarios.csv" download>Baixar modelo CSV</a>
<p class="card-copy"><strong>Antes de importar:</strong> substitua ou remova as duas linhas de exemplo do modelo.</p>
<ul class="card-copy">
  <li><code>name</code>: obrigatório, até 120 caracteres.</li>
  <li><code>email</code>: obrigatório, válido e não repetido no arquivo ou no Portal.</li>
  <li><code>job_title</code>: nome exato de um cargo ativo cadastrado no Portal.</li>
  <li><code>contract_type</code>: somente <code>clt</code> ou <code>pj</code>, em letras minúsculas.</li>
  <li><code>pj_due_day</code>: deixe vazio para CLT; para PJ, informe um dia de 1 a 31.</li>
  <li><code>phone</code>: opcional, até 40 caracteres.</li>
</ul>
<p class="card-copy">Mantenha o formato CSV UTF-8, os cabeçalhos na mesma ordem e o limite de 500 pessoas.</p>
```

Keep the existing file input, feedback, preview, and action buttons unchanged.

- [ ] **Step 5: Run focused and full verification**

Run: `node --test tests/unit/bulk-user-import.test.mjs`

Expected: PASS.

Run: `npm run verify`

Expected: all repository checks pass.

- [ ] **Step 6: Inspect the final diff**

Run: `git diff --check`

Expected: no whitespace errors. Do not commit unless the user explicitly requests it.
