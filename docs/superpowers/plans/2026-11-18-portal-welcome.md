# Destaques e boas-vindas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Orientar a entrada no Portal, destacar o Código e entregar o manual administrativo atualizado.

**Architecture:** Ordenar o descritor institucional na API existente. Reutilizar uma capa local e consumir o primeiro artigo autenticado no Dashboard, mantendo o ciclo de vida por visita. Gerar o menu a partir da fonte única e o PDF a partir do Markdown revisado.

**Tech Stack:** Express/PostgreSQL, módulos JavaScript nativos, HTML/CSS/Manrope, node:test, PGlite/Playwright externos, PyMuPDF/fonttools.

## Global Constraints

- Spec aprovada: `docs/superpowers/specs/2026-11-18-portal-welcome-design.md`.
- Preservar `api/ethics/term.json`, versão, hash e registros de aceite.
- Preservar o leitor privado, os pacotes WebP e suas rotas autenticadas.
- Manter Node 18 e o fluxo de publicação existente.
- Nenhuma nova tabela, migration, importação de posts ou flag operacional.
- Usar o ciclo de vida e helpers existentes para abortar requisições e ignorar respostas antigas. Sem novas dependências de runtime.
- Branch isolada existente: `feat/portal-welcome`, base `31de9142`.
- Produção exige autorização própria após prévia e verificações.

## Steps

- [x] Prioridade institucional, capa e Base.
- [x] Dashboard orientador e navegação sem Academy.
- [x] Manual Markdown/PDF reconciliado.
- [x] Navegador responsivo, verificações, revisão independente e prévia.

### Task 1: Prioridade institucional e capa

**Files:**
- Modify: `api/routes/knowledge.js`, `public/js/knowledge.js`, `public/css/knowledge.css`.
- Create: `public/assets/conecta/ethics-cover.svg`.
- Create: `tests/database/check-knowledge-priority.mjs`.
- Modify: `tests/visual/check-knowledge-documents.mjs` (contagem da capa institucional).

**Interfaces:**
- Consumes: `knowledge_base.document` JSONB, DTO `article.document.kind`.
- Produces: primeira posição elegível para `kind === 'ethics'`; capa local 960×540.

- [x] Executar teste SQL/API com post institucional antigo, artigos nulos e atualizações recentes, paginação e filtros. Usar `knowledgeDocumentAPI({ uploadDir })` em PGlite descartável e `supertest`.

```js
const first = await request(h.app).get('/api/knowledge?limit=1').set('Authorization', 'Bearer reader');
assert.equal(first.body[0].document.kind, 'ethics');
const rest = await request(h.app).get('/api/knowledge?limit=1&offset=1').set('Authorization', 'Bearer reader');
assert.notEqual(rest.body[0].document?.kind, 'ethics');
```

- [x] Aplicar prioridade SQL antes da data/ID, com tratamento explícito de NULL:

```sql
ORDER BY CASE WHEN knowledge_base.document->>'kind' = 'ethics' THEN 0 ELSE 1 END,
         knowledge_base.updated_at DESC, knowledge_base.id
```

- [x] Criar capa vetorial nas cores `#2A275E`, `#E84F1C`, `#FFFEFB`, com marca Conecta e título; texto em paths para renderização autônoma se necessário. Reutilizar em Base e Dashboard.
- [x] No catálogo, marcar o post institucional e inserir imagem decorativa:

```js
if (article.document?.kind === 'ethics') {
  button.classList.add('article-card-ethics');
  button.prepend(element('img', { className: 'article-ethics-cover',
    src: './assets/conecta/ethics-cover.svg', alt: '', width: 960, height: 540 }));
}
```

- [x] Validar filtros `q`/categoria, contagem e IDs sem duplicação entre páginas; manter ordem data/ID dos demais artigos.

### Task 2: Boas-vindas, Código no Dashboard e navegação

**Files:**
- Modify: `public/dashboard.html`, `public/js/dashboard.js`, `public/css/dashboard-home.css`.
- Modify: `scripts/generate-public-shell.mjs` e HTMLs gerados em `public/`.
- Modify: testes Dashboard em `tests/unit/conecta-content-redesign.test.mjs`, `portal-without-editorial.test.mjs`, `academy-frontend.test.mjs`, `task-7-shell-mobile.test.mjs`.

**Interfaces:**
- Consumes: `page.user`, `page.bindAPI`, `page.active`, `page.cleanup`, `page.listen`.
- Produces: `#dashboard-greeting`, `#quick-links`, `#ethics-preview`; `/api/knowledge?limit=1` como única descoberta do Código.
- Permissões: `user.autocard_access === true`, `user.pos_cards_access === true`, `user.role === 'admin'`, iguais às regras da navegação/router.

- [x] Migrar os testes de cursos no Dashboard para cobertura do destaque institucional: sucesso, erro/retry, ausência, texto seguro, foco, BFCache e resposta tardia; manter os testes de cursos na própria Academy.
- [x] Renderizar saudação e links com `element`/`textContent`, a partir do perfil validado:

```js
const name = typeof page.user.name === 'string' ? page.user.name.trim().split(/\s+/)[0] : '';
greeting.textContent = `${salutation}${name ? `, ${name}` : ''}. Boas-vindas ao Conecta.`;
```

- [x] Explicar Conhecimento, Notificações, Pages e Perfil em links descritivos; adicionar ferramentas permitidas em seção compacta própria. Usar índigo/laranja e tipografia existente, sem área de altura excessiva.
- [x] Substituir a seção Academy pelo Código com capa, descrição e `#ethics-preview` para estado/CTA:

```js
const [article] = await fetchAPI('/api/knowledge?limit=1');
if (requestToken !== ethicsRequest || !page.active) return;
if (article?.document?.kind !== 'ethics' || !UUID_PATTERN.test(article.id)) {
  return renderState('O Código de Ética está temporariamente indisponível.');
}
const href = `./knowledge.html?article=${encodeURIComponent(article.id)}`;
```

- [x] Erro oferece retry; somente se o foco continuar no controle substituído restaurá-lo ao CTA/estado. Invalidar tokens no cleanup e recarregar notificações/Código no pageshow persistido.
- [x] Remover Academy de `pages` no gerador (manter `generatedPages` e rota). Executar `npm run build:public`.
- [x] Executar testes focais e verificar links/permissões: leitor, admin, Super Admin, acesso parcial, nome vazio e conteúdo com HTML literal.

### Task 3: Manual administrativo

**Files:**
- Create from preserved original: `docs/operations/manual-operadores.md`, `scripts/build-operator-manual.py`.
- Generate: `docs/operations/manual-operadores.pdf`.
- Modify: `README.md`, `docs/product/brief.md`.

**Interfaces:**
- Consumes: fonte e gerador no checkout `Consent-wall`, interface atual em `public/` e contratos API/cron.
- Produces: Markdown editável, PDF com sumário clicável, relatório de build e PNGs em diretório externo novo.

- [x] Copiar conteúdo via patch, preservando os originais. Conferir diferenças de `fix/portal-readiness` para a base atual, em especial edição do curso, guias de e-mail e fluxos ainda não publicados.
- [x] Atualizar edição para 18/11/2026 e referência `feat/portal-welcome`; explicar boas-vindas/permissões, Código recorrente versus aceite, documentos WebP, prioridade/filtros e Academy por link/Admin.
- [x] Separar leitura de documentos em capítulo próprio para manter legibilidade A4. Gerador deve rejeitar overflow e verificar texto/links.
- [x] Gerar e inspecionar todas as páginas:

```bash
python scripts/build-operator-manual.py --inspection-dir C:/Users/Criação/AppData/Local/Temp/opencode/portal-welcome-manual-20261118/final
```

- [x] Acrescentar links Markdown/PDF no README e registrar ocultação temporária no brief.

### Task 4: Validação integrada e revisão

**Files:**
- Create: `tests/visual/check-portal-welcome.mjs`.
- Create: `docs/reviews/2026-11-18-portal-welcome.md`.
- Modify: este plano e `tests/visual/README.md`.

**Interfaces:**
- Consumes: harness SQL/API real com identidades Firebase sintéticas, Playwright e axe externos.
- Produces: resultados JSON e capturas de 320/390/1366 px, sem alteração de serviços existentes.

- [x] Conferir Dashboard → Código → voltar, Academy ausente no menu/Dashboard, gestão/direto disponíveis, filtros e capa compartilhada; medir overflow e verificar teclado.
- [x] Cobrir erro/retry, ausência institucional, retorno pelo histórico e resposta pendente durante navegação; conferir ausência de requests Academy no Dashboard.
- [x] Executar:

```bash
node tests/database/check-knowledge-priority.mjs
node tests/visual/check-portal-welcome.mjs
npm run verify
git diff --check
```

- [x] Inspecionar capturas e PDF, registrar limitações reais (autenticação sintética e viewports emulados).
- [x] Solicitar revisão independente do diff e evidências; corrigir achados e repetir apenas verificações afetadas.
- [x] Commitar entrega verificada e apresentar prévia ao usuário para decisão de publicação.

## Resultado da execução

Entrega concluída em 18/11/2026, antes do prazo de 08:10 São Paulo.
Prioridade/capa em `a6e6f29`; Dashboard/menu/testes em `1a1dcee`; documentação e
manual no commit de conclusão deste plano.

- SQL/API, 10 testes Knowledge, 95 testes focais e 12 cenários Knowledge: PASS.
- Integração: seis cenários, 320/390/1366 px, zero erros JavaScript e axe 0/0.
- Cenários visuais existentes: PASS, 42 capturas.
- `npm run verify`: 1.239 testes, 1.235 PASS, 4 SKIP, 0 FAIL; segurança e Compose OK.
- Manual: 20 páginas A4, 19 capítulos, 38 links internos; texto e margens conferidos.
- Revisões independentes das tarefas e do conjunto final aprovadas, sem bloqueadores.

Evidências e limitações em `docs/reviews/2026-11-18-portal-welcome.md`.
A prévia foi apresentada no painel; a decisão de integração/publicação permanece
com o usuário. Produção não foi alterada por esta atualização.
