# PodFalar e Notificações Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separar o cartão público PodFalar e padronizar Notificações na interface.

**Architecture:** HTML/CSS estáticos mantêm a autenticação existente. Um agrupador
neutro contém os dois cartões como irmãos. O gerador de shell continua sendo a
fonte da navegação; somente os textos da área reminders mudam.

**Tech Stack:** HTML, CSS, JavaScript ESM, node:test e Playwright/axe externos.

## Global Constraints

- Sem deploy, Docker, alterações de banco ou integrações de produção.
- Não alterar rotas reminders.html, endpoints, IDs, permissões, tabelas,
  processamento cron nem conteúdo persistido de notificações existentes.
- Manter a marca Conecta, o fundo aurora e os fluxos de autenticação atuais.
- Sem novas dependências de produção; preservar compatibilidade Node 18 no código.
- Preservar os SVGs originais PodFalar e o link externo seguro.

## Steps

- [x] Cartão PodFalar independente e testes de layout.
- [x] Nomenclatura Notificações, documentação e testes de regressão.
- [x] Verificação integrada, inspeção visual e revisão final.

### Task 1: Cartão PodFalar independente

**Files:** `public/login.html`, `public/css/login.css`,
`tests/unit/login-approved-reference.test.mjs`,
`tests/visual/check-login-approved.mjs`, `public/assets/podfalar/README.md`.

**Interfaces:** Consome formulários e classes existentes. Produz `.access-stack`
com `.form-panel` seguido por `.podfalar-panel`, sem mudar IDs ou eventos.

1. Alterar a regressão para exigir o painel fora do cartão/formulários:

```js
assert.equal(panel.closest('.form-panel'), null);
assert.equal(panel.parentElement, h.doc.querySelector('.access-stack'));
assert.equal(panel.parentElement.children.at(-1), panel);
```

2. Executar `node --test tests/unit/login-approved-reference.test.mjs` e
   confirmar falha da nova expectativa antes da alteração estrutural.
3. Envolver a seção de acesso em `.access-stack`, mover PodFalar para depois
   dela e aplicar a composição:

```css
.access-stack { display: grid; gap: 16px; min-width: 0; }
.podfalar-panel { display: flex; align-items: center; gap: 12px; width: 100%; padding: 18px 24px; border: 1px solid #e5d883; border-left: 4px solid #fed500; border-radius: var(--radius-sm); background: #fffdf2; }
```

4. O botão mantém fundo branco e logo de 108 px; borda preta deriva do preto
   `#010101` original, sem recolorir a imagem. Adaptar padding do painel para
   20/16 px nas mesmas larguras mobile do login.
5. Na suíte visual, medir o limite inferior da composição com `.access-stack`;
   exigir mesma largura e alinhamento horizontal dos cartões e intervalo de
   16 px. Conferir isso nos quatro estados em todas as larguras existentes.
6. Atualizar README dos assets, executar testes de login/aurora/marca e manter
   todos os contratos de destino, foco e ausência de requisições ao abrir a tela.

### Task 2: Nomenclatura Notificações

**Files:** `scripts/generate-public-shell.mjs`, páginas `.html` com navegação em
`public/`, `public/reminders.html`, `public/dashboard.html`, `public/admin.html`,
`public/home-preview.html`, `public/js/reminders.js`, `public/js/dashboard.js`,
`tests/unit/notifications-naming.test.mjs`, testes existentes com expectativas
textuais antigas, `README.md`, `docs/product/brief.md`.

**Interfaces:** Consome a rota reminders e seus contratos existentes. Produz
somente rótulos em português atualizados, mantendo nomes técnicos e API.

1. Criar regressão que procura nomenclatura antiga em páginas públicas e
   módulos de interface e exige o novo título:

```js
assert.doesNotMatch(source, /lembretes?/i);
assert.match(page, /<h1>Notificações<\/h1>/);
assert.match(page, /href="\.\/reminders\.html"/);
```

2. Executar `node --test tests/unit/notifications-naming.test.mjs` e confirmar
   que os rótulos antigos causam falha.
3. Trocar os textos no gerador, páginas não geradas e módulos, ajustando
   concordância: Nova notificação, Próximas notificações, Nenhuma notificação
   cadastrada, Excluir esta notificação?, Notificação criada/atualizada/excluída.
4. Executar `npm run build:public` para atualizar navegação e topbars.
5. Atualizar expectativas textuais dos testes existentes e documentação atual,
   preservando os registros históricos e o vocabulário técnico reminders.
6. Executar a nova regressão e testes existentes de reminders/dashboard/shell.

### Task 3: Verificação e revisão

**Files:** suites anteriores e documento de evidências
`docs/reviews/2026-11-09-podfalar-notifications.md`.

**Interfaces:** Consome frontend final e servidor loopback de fixtures, sem
conexão com produção. Produz evidências locais e resumo das limitações.

1. Executar `npm run verify` e `git diff --check`.
2. Iniciar `node tests/visual/serve-conecta.mjs` em background; executar a suíte
   de login com módulos externos Playwright/axe, salvando capturas no diretório
   temporário aprovado. Inspecionar capturas desktop/mobile.
3. Conferir Notificações no navegador de fixtures e ações de criação/edição,
   sem persistência real. Não apresentar dados de fixtures como prova de envio.
4. Revisar o diff completo: somente escopo aprovado, sem alteração de SVGs,
   endpoints, permissões ou lógica de autenticação.
5. Registrar contagens reais e limitações na evidência e marcar Steps concluídos.
