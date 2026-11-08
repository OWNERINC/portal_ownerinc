# Conecta laranja — Implementation Plan

> **For agentic workers:** Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking. The primary session owns shared files, integration, browser verification and publication.

**Goal:** Entregar o redesign V3.5 laranja do Portal atual e revisar PR e deploy.

**Architecture:** HTML/CSS/JavaScript estático, shell gerado e router persistente existentes. Tokens e componentes centrais atendem páginas e módulos; os dados continuam nas APIs atuais.

**Tech Stack:** CSS custom properties, ES modules, Express/Firebase existentes, testes Node, GitHub Actions e VPS.

## Steps

- [x] Consolidar assets oficiais, tokens e shell responsivo.
- [x] Adaptar dashboard, conhecimento, lembretes e Academy.
- [x] Adaptar acesso, perfil e administração.
- [x] Adaptar AutoCard e Cards Pós preservando as artes.
- [x] Integrar, validar em navegador e corrigir regressões.
- [ ] Abrir e revisar PR; conferir CI e deploy.

## Global Constraints

- Especificação aprovada: `docs/superpowers/specs/2026-11-08-conecta-orange-redesign-design.md`.
- Manrope local; cores `v35-*` aprovadas; marca original e símbolo extraídos sem aproximação.
- Desktop 1920 × 1080, mobile 402 px, conferência também em 360, 768 e 1366 px.
- Alvos de toque de pelo menos 44 × 44 px. Teclado, foco, Escape e movimento reduzido.
- Preservar autenticação, autorização, URLs, histórico, descarte e proteção de rascunhos.
- Notícias/CMS fora do escopo; sem endpoints inventados ou conteúdo ilustrativo apresentado como real.
- Conservar conteúdo, proporções, fontes e geração PDF das artes AutoCard/Cards Pós.
- Manter compatibilidade Node 18 no código; checks no Node 24 exigido pelo repositório.
- Docker que afete serviços requer aprovação explícita. Review de deploy não equivale a autorização de merge/produção.
- Usar patch para edições; não sobrescrever trabalho de outros agentes; nenhum agente de lote faz commit.

## Task 1 — Base visual e shell (sessão principal)

**Files:** `public/css/tokens.css`, `public/css/layout.css`, `public/css/components.css`, `public/js/sidebar.js`, `scripts/generate-public-shell.mjs`, `public/assets/conecta/`, `public/assets/fonts/`; regiões geradas dos HTML após lotes terminarem.

**Interfaces:** Mantém classes `.sidebar`, `.sidebar-nav`, `.topbar`, `.main-content`, `.btn`, `.form-input` e IDs do router. Publica tokens semânticos consumidos por todos os lotes:

```css
:root {
  --bg: #F7F6F2; --surface: #FFFEFB; --surface-2: #E8E6EB;
  --text: #2A275E; --text-secondary: #6C706D; --border: #E1E2DD;
  --primary: #2A275E; --primary-hover: #201E4D; --on-primary: #FFFEFB;
  --accent: #E84F1C; --accent-text: #C4461A; --selected: #E8E6EB;
  --success: #345F50; --success-bg: #E9F1EB;
  --danger: #B13F38; --danger-bg: #FBEDEB;
  --info: #2A5970; --info-bg: #EAF1F4;
  --warning: #805D18; --warning-bg: #F6EDDA;
  --disabled-bg: #ECEBE8; --disabled-text: #858783; --scrim: #201E4D66;
  --font-sans: 'Manrope', sans-serif; --font-display: var(--font-sans);
}
```

Consultar componentes e pranchas via MCP Pencil; extrair logo/símbolo nativos, fonte e licença. Atualizar contraste de ações primárias para texto claro. Reorganizar navegação em grupos condicionados às permissões existentes e colocar perfil ao final. O gerador mantém sua execução idempotente. No mobile, marca compacta e botão com nome acessível; o drawer conserva inert e restauração de foco.

Checks: `node scripts/generate-public-shell.mjs --check`, testes `task-7-shell-mobile`, `persistent-navigation`, `frontend-invariants`; navegador em estados recolhido/expandido/mobile. Incluir regressão de foco quando ações restritas ficam ocultas.

## Task 2 — Conteúdo e aprendizagem (lote independente)

**Files:** `public/dashboard.html` (somente main), `public/css/dashboard-home.css`, `public/js/dashboard.js`; `knowledge.html`, `css/knowledge.css`, `js/knowledge.js`; `reminders.html`, `css/reminders.css`, `js/reminders.js`; `css/academy.css`, `academy/views.js` e módulos de vistas se necessário. HTML somente fora do shell gerado.

**Interfaces:** Consome os tokens da Task 1 e os contratos `mount(page)` já existentes. Preserva IDs de listas, formulários, paginação e filtros. Academy usa suas APIs e currículo atuais.

Consultar pranchas D01–D04/P01–P06 e mobile. Dashboard ganha saudação, atalhos compactos e composição de continuação/lembretes. Conhecimento tem busca e leitura legíveis; lembretes têm filtros e retornos claros. Academy recebe tipografia/paleta do Portal ao redor de sua marca própria, mantendo progresso e player. Usar dados reais e fallback de marca onde não há capa real.

Checks: testes `portal-without-editorial`, `maintained-frontend-contract`, `reminder-delivery-ui`, `academy-frontend`, `academy-player`, `academy-management`, `task-7-shell-mobile`. Novos comportamentos devem ter testes com carregamento assíncrono, resposta tardia e foco, usando os harnesses existentes.

## Task 3 — Acesso, conta e gestão (lote independente)

**Files:** `public/login.html`, `public/css/login.css` novo, `public/profile.html` (somente main/estilos próprios), `public/css/profile.css` se extraído, `public/admin.html` (somente main/estilos próprios), `public/css/admin.css`. JS de login/perfil/admin somente se interação realmente exigir.

**Interfaces:** Mantém todos os IDs e estados consumidos por `js/login.js`, `js/profile.js`, `js/admin.js`. Consome marca `/assets/conecta/logo.svg`, símbolo `/assets/conecta/symbol.svg` e tokens da Task 1.

Consultar P17–P22, D06/D07/D11 e respectivas mobile. Substituir split escuro decorativo por composição de acesso da referência com marca oficial e formulário claro; conservar cadastro, verificação e reset existentes. Perfil e admin devem manter uploads, crop, filtros, paginação, abas e permissões com organização responsiva.

Checks: testes `auth-stability`, `password-reset-email`, `pending-registration`, `admin-ui-behavior`, `admin-ui-filters`, `task-7-shell-mobile`; conferir login/recuperação/erro sem chamar envio real.

## Task 4 — Ferramentas de criação (lote independente)

**Files:** `public/autocard.html` (main/estilos próprios), `public/autocard/` CSS/UI; `public/cards-pos.html` (main), `public/cards-pos/styles.css` e módulos de interface necessários.

**Interfaces:** Consome tokens da Task 1 no entorno. Preserva seletores e APIs de editor/histórico/exportação. CSS da interface deve ser delimitado para não mudar estilos renderizados nas artes/PDF.

Consultar D08–D10, P08–P10, F01–F35. Reorganizar barra de ações, seleção de modelo, editor/prévia/histórico e apresentação mobile. Campos continuam editáveis, rascunhos separados e ações assíncronas protegidas. Estados de carregamento/erro/vazio correspondem ao runtime, não a botões demonstrativos.

Checks: testes `autocard-invariants`, `card-save-headers`, `pos-cards-frontend`, `pos-cards-history`, `pos-cards-inline-editor`, `pos-cards-layout`. Comparar dimensões e fontes das artes antes/depois e verificar preview em viewport estreito.

## Task 5 — Integração e evidências (sessão principal)

**Files:** testes de regressão pertinentes e `docs/reviews/2026-11-08-conecta-redesign.md`.

Executar gerador depois dos lotes; revisar todo o diff. Servir aplicação local para inspeção visual sem iniciar serviços de produção. Fixtures de autenticação/dados somente no harness de teste e explicitamente rotuladas; não alterar runtime para liberar acesso. Registrar screenshots em desktop e mobile e cobertura por rota. Verificar nomes acessíveis e ausência de overflow.

```sh
npm run build:public
npm run verify
git diff --check
npm run security
```

Baseline já executado: 810 PASS, 2 skips Linux, zero falhas após bootstrap. Falhas novas devem ser corrigidas; o audit de dependências é um gate separado do verify.

## Task 6 — Review e publicação

**Files:** relatório de review/aceite e metadados do PR.

Submeter diff e evidências a revisão fresca read-only. Corrigir achados antes de commit final. Publicar branch, abrir PR com escopo e evidências, vincular à sessão e acompanhar CI. Confirmar estado do deploy do commit correspondente; somente declarar publicação após SHA/logs/smoke e inspeção da URL pública. Caso falte autorização de merge ou ambiente, registrar explicitamente a pendência e manter o PR pronto para decisão humana. A thread Astra xhigh solicitada responde dúvidas de abordagem, sem substituir consentimento operacional exigido.
