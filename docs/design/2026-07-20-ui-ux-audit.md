# Auditoria de Design, UX e Acessibilidade

Data: 20 de julho de 2026
Referência: Web Interface Guidelines, WCAG e revisão estática de todo `public/`.

> Este documento registra o baseline anterior à implementação. As correções e
> validações restantes estão consolidadas em
> [`../reports/2026-07-20-roadmap-implementation.md`](../reports/2026-07-20-roadmap-implementation.md).

## Resumo

O Portal já possui identidade visual coerente, tokens, shell e componentes
reconhecíveis. A principal deficiência não é estética: os componentes visuais
não têm contratos completos de comportamento. Modais, tabs, toasts, tabelas,
cards clicáveis e navegação mobile precisam ser corrigidos antes de um refinamento
visual amplo.

## Bloqueadores

- Conteúdo da API em `innerHTML` permite XSS: `public/js/dashboard.js:57-67`,
  `public/js/knowledge.js:21-79`, `public/js/reminders.js:28-40`,
  `public/js/academy.js:24-37`, `public/js/benefits.js:24-41` e
  `public/js/admin.js:74-86,253-263,343-354,429-437`.
- Criação de usuário troca a sessão do administrador:
  `public/js/admin.js:205-216`.
- O shell autenticado não responde a mobile: `public/css/layout.css:21-32`,
  `public/css/layout.css:212-244`, `public/css/components.css:131-144`.
- Modais não têm `role="dialog"`, nome, foco preso, Escape ou restauração de
  foco: `public/css/components.css:94-115`, `public/knowledge.html:77-100`,
  `public/reminders.html:67-108`, `public/admin.html:155-310`.

## Acessibilidade de Alta Prioridade

### Formulários e controles

- Labels sem `for`: `public/knowledge.html:84-93`,
  `public/reminders.html:74-97`, `public/ombudsman.html:55-66`,
  `public/profile.html:133-146`, `public/admin.html:162-299`.
- Artigos usam `<div onclick>` e não funcionam por teclado:
  `public/js/knowledge.js:51-53`.
- Avatar clicável é uma `<div>` e o input fica inacessível:
  `public/profile.html:120-125`, `public/js/profile.js:33`.
- Reveladores de senha saem da ordem de tabulação:
  `public/login.html:370,407,416`.
- Grupos de input não usam `<form>`, perdendo submit por Enter e validação
  semântica: `public/ombudsman.html:47-73`, `public/profile.html:116-152`,
  `public/knowledge.html:77-100`, `public/reminders.html:67-108`,
  `public/admin.html:155-310`.
- Erros administrativos aparecem em toast, sem `aria-describedby`,
  `aria-invalid` ou foco no primeiro campo: `public/js/knowledge.js:120-124`,
  `public/js/reminders.js:75-85`, `public/js/profile.js:85-95`,
  `public/js/admin.js:176-186,295-304,386-395`.

### Estrutura e navegação

- Páginas autenticadas não oferecem skip link. Exemplo:
  `public/dashboard.html:15-47`.
- Dashboard usa vários `h1`, enquanto Academy, benefits, reminders, ombudsman e
  profile não têm `h1` de página: `public/dashboard.html:67,76`,
  `public/academy.html:45-48`, `public/benefits.html:45-48`,
  `public/reminders.html:48`, `public/ombudsman.html:45-49`,
  `public/profile.html:114-130`.
- Categorias viram `h1`: `public/js/academy.js:24-27`,
  `public/js/benefits.js:24-27`.
- Navegação ativa não usa `aria-current="page"`. Exemplo:
  `public/dashboard.html:26`.
- Tabs administrativas não têm tablist, teclado ou URL:
  `public/admin.html:77`, `public/js/admin.js:21-49`.
- Busca, categoria e artigo aberto não sobrevivem a reload/Back:
  `public/js/knowledge.js:32-36,62-89`.

### Foco, contraste e anúncios

- Branco sobre `#C4A256` no botão primário tem contraste aproximado de 2,43:1:
  `public/css/components.css:15-16`.
- `--text-secondary` sobre o fundo fica próximo de 4,40:1:
  `public/css/tokens.css:14`.
- Logout usa branco com 35% em 11 px: `public/css/layout.css:140-157`.
- Busca remove outline sem reposição: `public/css/components.css:140-144`.
- Botões apenas com ícone dependem de `title`, não de `aria-label`: sidebars,
  closes de modal e reveladores de senha; exemplos em
  `public/dashboard.html:21-23`, `public/knowledge.html:81`,
  `public/login.html:370-418`.
- Toasts, loading, tabelas atualizadas e sucesso não têm live region:
  `public/js/auth.js:54-60`, `public/css/components.css:117-128`,
  `public/dashboard.html:70-72`, `public/knowledge.html:59-61`,
  `public/ombudsman.html:69-71`.
- Tabelas não têm caption nem `scope="col"`: `public/reminders.html:49-60`,
  `public/admin.html:85-147`.

## UX e Correção Funcional

- A promessa “sem qualquer identificação” da ouvidoria é incompatível com o
  envio autenticado e possíveis logs: `public/ombudsman.html:49-53`,
  `public/js/auth.js:9-15`.
- “Próximos 7 dias” quebra entre meses: `public/js/dashboard.js:45-52`.
- “Emitir Nota Fiscal” aponta para `#`: `public/js/dashboard.js:75-80`.
- Knowledge, reminders e admin podem manter loading para sempre em erro:
  `public/js/knowledge.js:15-19`, `public/js/reminders.js:17-20`,
  `public/js/admin.js:56-59,242-245,332-335`.
- Fechar modal descarta alterações sem aviso:
  `public/js/knowledge.js:146-150`, `public/js/reminders.js:103-107`,
  `public/js/admin.js:231-235,321-325,412-416`.
- Modais não limitam altura nem overscroll: `public/css/components.css:94-109`.
- Alvos touch do toggle, logout e botões pequenos ficam abaixo de 44 px:
  `public/css/layout.css:68-83,140-158`, `public/css/components.css:20`.
- Sidebar/topbar não consideram safe areas: `public/css/layout.css:21-32,221-232`.
- Conteúdo longo não quebra/trunca de forma consistente:
  `public/css/layout.css:236-242`, `public/js/admin.js:74-86,429-437`.

## Conteúdo e Linguagem

- Loadings e placeholders usam `...` em vez de `…`: exemplos em
  `public/dashboard.html:71`, `public/knowledge.html:47,60`,
  `public/admin.html:91,109,127,144`, `public/login.html:488,533,584`.
- “+ Novo” é ambíguo; usar “Novo artigo” e “Novo lembrete”:
  `public/knowledge.html:49`, `public/reminders.html:44`.
- “1 dia(s)” precisa plural correto: `public/js/dashboard.js:25`.
- Termos Role, Viewer, Admin, Dashboard e Academy misturam idiomas sem um
  glossário: `public/admin.html:88,175-179`, `public/dashboard.html:44`,
  `public/academy.html:42`.
- Erros genéricos não indicam recuperação: `public/js/dashboard.js:70`,
  `public/js/academy.js:41`, `public/js/benefits.js:45`,
  `public/js/ombudsman.js:42`.
- Link externo Sólides não usa `rel="noopener noreferrer"`:
  `public/dashboard.html:59-62`.

## Movimento, Imagens e Performance

- Transições não respeitam `prefers-reduced-motion`:
  `public/css/layout.css:31,78,104,113,118,203,218`,
  `public/css/components.css:12,80,126`, `public/login.html:178-264`.
- Google Fonts usa `@import`, atrasando descoberta:
  `public/css/layout.css:1`, `public/login.html:10`.
- Lucide é síncrono e vem de CDN em todas as páginas. Exemplo:
  `public/dashboard.html:10`.
- Logos e avatar não declaram dimensões: `public/login.html:304,343`,
  `public/dashboard.html:18-19`, `public/profile.html:121`.
- Tabelas renderizam coleções completas; adicionar paginação server-side quando
  ultrapassarem 50 itens: `public/js/admin.js:74-86,253-263,343-354,429-437`.
- Assets visuais estáveis recebem cache de 7 dias; CSS e JavaScript devem
  revalidar para que deploys não deixem HTML e scripts incompatíveis:
  `nginx/nginx.conf`.

## Avaliação por Página

| Página | Estado | Próxima correção |
| --- | --- | --- |
| `index.html` | Redireciona, mas pode ficar vazio | Status de sessão, fallback e `noscript` |
| `login.html` | Visualmente madura | Fechar admissão, teclado e semântica de forms |
| `dashboard.html` | Contextual para PJ/CLT | Datas reais, CTA de NF e hierarquia de headings |
| `knowledge.html` | Busca e leitura úteis | Teclado, deep link, erro/retry e render seguro |
| `reminders.html` | CRUD compreensível | Audiência correta, mobile e form acessível |
| `academy.html` | Catálogo simples adequado | `h1`, URL segura, erro/retry e links externos |
| `benefits.html` | Informação objetiva | `h1`, busca quando crescer e conteúdo seguro |
| `ombudsman.html` | Fluxo curto | Copy verdadeira, live region e política de caso |
| `profile.html` | Organização clara | Upload acessível, validação e remoção de foto |
| `admin.html` | Funcionalidade ampla | Criação server-side, tabs, modais e paginação |

## Design System

### Preservar

- Tokens centralizados de cor, tipografia, espaço, raio e sombra.
- Identidade Ownerinc preta e dourada.
- Shell, topbar, cards, badges, forms e tabelas visualmente consistentes.
- Escala de espaçamento curta e efeitos contidos.
- Grid de cards adaptável dentro da área disponível.

### Evoluir

- Separar tokens de marca, foco, links, warning, disabled e texto inverso.
- Não usar `--primary` simultaneamente para marca, fundo, foco e link.
- Criar tipografia editorial de 16 px/1.65 para artigos.
- Remover estilos inline em favor de padrões reutilizáveis existentes.
- Formalizar três superfícies: painel informativo, link-card e formulário.
- Definir padrões comportamentais para dialog, tabs, toast e loading.
- Definir shell mobile e densidade de tabela/touch.
- Declarar `color-scheme: light` e `theme-color`; dark mode não é prioridade.

## Critérios de Aceite da Revisão Visual

1. Um `h1`, skip link e `aria-current` em cada página autenticada.
2. Toda ação funciona com teclado e tem foco visível de 3:1.
3. Todo controle possui nome acessível e erro associado.
4. Dialog prende/restaura foco, fecha por Escape e cabe em `100dvh`.
5. Toast, loading, sucesso e erro são anunciados uma vez.
6. Texto normal atinge 4,5:1; componentes e foco atingem 3:1.
7. Não há scroll horizontal global entre 320 e 1440 px.
8. Movimento não essencial some com `prefers-reduced-motion`.
9. Filtros, tabs e artigo aberto são restaurados pela URL.
10. LCP <= 2,5 s, CLS <= 0,1 e INP <= 200 ms no perfil mobile.

## Matriz de Validação

- Desktop: Chrome, Edge e Firefox em 1024x768 e 1440x900.
- Mobile: Safari iOS 390x844, Chrome Android 360x800 e viewport 320x568.
- Tablet: 768x1024 em portrait e landscape.
- Teclado: Tab, Shift+Tab, Enter, Space, Escape e setas.
- Leitor de tela: NVDA + Chrome/Firefox e VoiceOver + Safari.
- Reflow: zoom 200% e 400%.
- Estados de rede: offline, 3G lento, 401, 403, 404, 500 e timeout.
- Conteúdo extremo: vazio, 1 caractere, 500 caracteres, URL longa, emoji e HTML.
- Volume: 0, 1, 50 e 500 registros.
- Segurança visual: HTML, handlers, aspas e URLs `javascript:`.
