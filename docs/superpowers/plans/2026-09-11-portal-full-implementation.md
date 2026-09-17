# Portal Ownerinc Full Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Corrigir os riscos confirmados do Portal e entregar uma experiência mobile-first para consulta de informações e execução de tarefas, com acesso controlado por DHO e Cards Pós independentes.

**Architecture:** Manter frontend estático, API Express, PostgreSQL, cron e Nginx. Corrigir contratos nas fronteiras compartilhadas, usar migrations para dados existentes e manter cada módulo com sua rota e política atuais.

**Tech Stack:** Node 24, Express, Firebase Auth, PostgreSQL, cron, Nginx, HTML/CSS/JavaScript estático, testes `node:test` e Supertest.

## Global Constraints

- Toda referência atual de nomenclatura no produto deve usar DHO; RH fica
  restrito às entradas legadas explicitamente consumidas pela migration 030.
- Administradores e operadores autorizados do DHO usam as ferramentas; autorização real permanece server-side.
- Cargo desativado revoga os acessos derivados dele.
- Cadastro administrativo e cadastro sujeito a aprovação permanecem disponíveis.
- A aprovação define contrato PJ/CLT e cargo antes da liberação.
- Benefícios e Sólides ficam fora da experiência inicial; Academy continua catálogo.
- A interface deve funcionar primeiro no celular e ser validada com 100 sessões simultâneas.
- Convidado e Owner são documentos independentes.
- Cada convite é uma única página no tamanho original do Figma.
- Frame 1: 1448 × 2347 px. Frame 2: 1448 × 3361 px.
- PDFs devem conter texto selecionável, idioma, ordem de leitura e fontes incorporadas; não podem cortar conteúdo silenciosamente.
- Texto excedente bloqueia a exportação, mas pode ser salvo.
- Não adicionar framework, fila ou serviço sem pressão comprovada.
- Preservar as fronteiras `api/`, `cron/`, `public/` e `nginx/`.
- Usar `npm run verify` e `git diff --check` antes da entrega final.
- Não incluir backup, Sólides ou o hub LMS nesta rodada; registrar essas evoluções como futuras.

## Dependências e sequência

1. Baseline e contratos compartilhados.
2. Segurança, banco, DHO e autorização.
3. Admissão, convites e importação.
4. CMS e notificações.
5. Shell, perfil, consulta e Academy.
6. AutoCard e Cards Pós.
7. PDF acessível.
8. Capacidade, homologação e documentação.

### Task 1: Baseline e contratos

**Files:** `AGENTS.md`, `package.json`, `api/package.json`, `cron/package.json`, `docs/product/feature-inventory.md`, `docs/superpowers/plans/2026-09-11-portal-full-implementation.md`.

- [ ] Confirmar a árvore atual e não modificar mudanças preexistentes sem entender seu objetivo.
- [ ] Alinhar a documentação de runtime ao Node exigido pelos manifests e pelo verificador.
- [ ] Registrar a matriz de usuários de teste: colaborador, operador DHO, administrador, superadministrador e conta desativada.
- [ ] Registrar os frames Figma e os critérios de PDF sem declarar como homologado o que ainda não foi executado.
- [ ] Criar um check pequeno que falhe se nomes legados RH voltarem ao catálogo canônico ou a arquivos gerados.

### Task 2: Segurança HTTP, mídia e schema

**Files:** `api/index.js`, `api/middleware/security.js`, `api/routes/autocard.js`, `api/db/provision.js`, `api/db/verify-migrations.js`, `api/db/schema.sql`, `api/db/migrations/`, `nginx/nginx.conf`, `.dockerignore`, `cron/Dockerfile`, `tests/unit/api-security.test.mjs`, `tests/unit/schema-invariants.test.mjs`, `tests/unit/operations-invariants.test.mjs`.

- [ ] Servir mídias AutoCard e Cards Pós somente pelas rotas autenticadas; manter o diretório público apenas para fotos permitidas.
- [ ] Validar e escapar ícones persistidos do AutoCard.
- [ ] Separar limitadores de upload e leitura de mídia; alinhar corpos aceitos com buffering temporário.
- [ ] Corrigir CORS, portas encaminhadas, JSON inválido e rejeição de Firebase Emulator fora de desenvolvimento.
- [ ] Excluir arquivos sensíveis recursivamente no contexto real do build.
- [ ] Conceder ao cron exatamente os privilégios usados pela retenção e validar cada privilégio individualmente.
- [ ] Fazer schema fresco e upgrade produzirem os mesmos índices, defaults e constraints JSON.
- [ ] Adicionar testes negativos de acesso, privilégios, constraints e parser.

### Task 3: Nomenclatura DHO e autorização por cargo

**Files:** `api/db/migrations/`, `api/middleware/auth.js`, `api/middleware/policy.js`, `api/routes/job-titles.js`, `public/js/admin.js`, `public/js/auth.js`, `scripts/generate-public-shell.mjs`, `public/`, `docs/` e testes de cargos.

- [x] Migrar todos os nomes legados contendo RH para DHO, consolidando duplicatas sem perder usuários ou permissões.
- [x] Impedir que migrations futuras reintroduzam nomes legados contendo RH.
- [x] Retornar `page_access` na listagem de cargos e preservá-lo quando o formulário alterar apenas nome/estado.
- [x] Considerar cargo ativo na autorização de páginas e revogar imediatamente acesso derivado de cargo inativo.
- [x] Definir a matriz de operadores DHO sem transformar uma permissão de administração em acesso implícito.
- [x] Remover Benefícios e Sólides da navegação global inicial, preservando tabs administrativas gated e as rotas futuras.
- [x] Cobrir migração, edição, ativação/desativação e acesso direto por testes.

### Task 4: Admissão, convite e importação

**Files:** `api/routes/auth.js`, `api/routes/registrations.js`, `api/services/pending-registration.js`, `api/services/user-invitation.js`, `api/routes/users.js`, `api/routes/user-imports.js`, `api/services/bulk-user-import.js`, `public/login.html`, `public/js/login.js`, `public/js/auth.js`, `public/admin.html`, `public/js/admin.js` e testes relacionados.

- [x] Manter convite administrativo e cadastro pendente como caminhos distintos.
- [x] Definir PJ/CLT e cargo no momento da aprovação e persistir o estado correto.
- [x] Exibir estados de confirmação, aprovação, habilitação pendente, ativo e desativado.
- [x] Explicar a criação da primeira senha sem apresentar o fluxo como recuperação comum.
- [x] Preservar destino interno após login e tratar sessão inválida de forma uniforme.
- [x] Corrigir linhas de importação CLT com dia PJ inválido e validar a confirmação contra a mesma regra da prévia.
- [x] Permitir acompanhar jobs de importação após recarregar a página, mostrando erro por linha e retry elegível.
- [x] Testar compensação Firebase/SMTP/PostgreSQL e operações repetidas.
- [x] Restringir GET/retry ao criador ou superadmin, retornar 410 sem vazamento para jobs expirados e escopar a persistência da UI por usuário autenticado.
- [x] Ordenar locks PostgreSQL corretamente e conceder ao `portal_cron` somente DELETE mais SELECT de `expires_at` para retenção de importações.
- [x] Serializar o enable Firebase com lock transacional local, preservando `firebase_enable_pending` quando a decisão ficar ambígua ou a conta for desativada.
- [x] Reconciliar commits ambíguos de importação por UID/e-mail sem marcar `failed` durante indisponibilidade de `users`, duplicar conta ou apagar identidade reutilizada.
- [x] Reforçar invariantes de contrato em migration e schema fresco, com preflight explícito e normalização apenas de dia PJ irrelevante para CLT.

### Task 5: CMS e conteúdo publicado

**Files:** `api/routes/cms.js`, `api/routes/knowledge.js`, `api/routes/academy.js`, `api/routes/benefits.js`, `api/routes/announcements.js`, `api/routes/reminders.js`, `api/routes/cms-assets.js`, `api/cms/blocks.js`, `api/cms/knowledge.js`, `api/cms/locks.js`, `api/cms/reader.js`, `api/cms/revisions.js`, `api/cms/sources.js`, `cron/checkReminders.js`, `cron/cms-asset-retention.js`, `public/js/cms.js`, `public/js/cms-block-editor.js`, `public/js/cms-block-renderer.js`, `public/js/knowledge.js`, `public/js/academy.js`, `public/js/benefits.js`, `public/js/reminders.js`, `public/js/announcements.js`, `public/js/pagination.js`, `tests/unit/api-routes.test.mjs`, `tests/unit/cms-asset-retention.test.mjs`, `tests/unit/cms-blocks.test.mjs`, `tests/unit/cms-contracts.test.mjs`, `tests/unit/cms-frontend.test.mjs`, `tests/unit/cms-reader.test.mjs`, `tests/unit/cms-routes.test.mjs`, `tests/unit/cron.test.mjs`, `tests/unit/frontend-invariants.test.mjs`, `tests/unit/operations-invariants.test.mjs`.

- [ ] Definir o CMS como fonte do corpo quando houver documento por blocos, ocultando da circulação pública documentos sem publicação válida.
- [ ] Impedir que edição legada substitua texto CMS publicado.
- [ ] Publicar/agendar a revisão explicitamente selecionada e rejeitar conflito de edição com `409`.
- [ ] Cancelar agendamento sem substituir rascunho posterior.
- [ ] Padronizar a ordem dos locks.
- [ ] Retirar documento e assets de circulação quando a fonte for excluída.
- [ ] Fazer busca, resumo e leitura usarem o corpo publicado, inclusive com `JOIN` de revisão publicada em announcements.
- [ ] Corrigir paginação, opcionais vazios, prévia após upload, badges e erros previsíveis.
- [ ] Definir “despublicar” como retirada de circulação em Knowledge, Academy, Benefícios, Announcements e Reminders, sem fallback silencioso que mantenha conteúdo ou lembrete ativo; `all=true` administrativo permanece explícito.
- [ ] Cobrir concorrência determinística por locks, exclusão, publicação, agendamento, busca, paginação, circulação pública e assets.

### Task 6: Lembretes e cron

**Files:** `cron/checkReminders.js`, `cron/scheduling.js`, `cron/health.js`, `cron/mailTransport.js`, `cron/sendEmail.js`, `api/routes/reminders.js`, `api/cms/blocks.js`, `public/js/reminders.js`, `public/js/dashboard.js`, migrations e testes de cron.

- [ ] Tratar datas civis no fuso de São Paulo em API, dashboard e histórico.
- [ ] Definir vigência para não enviar catch-up anterior à criação do lembrete.
- [ ] Classificar códigos SMTP e contabilizar tentativas de forma durável após restart.
- [ ] Separar heartbeat, sucesso de execução e falha de entrega.
- [ ] Validar audiência vazia, UIDs inválidos e canais que não estão disponíveis na UI.
- [ ] Incluir link acionável para o conteúdo do lembrete.
- [ ] Mostrar lembrete, destinatário, motivo e tentativas no histórico.
- [ ] Cobrir idempotência, falha isolada, restart, catch-up e execução vazia.

### Task 7: Shell, perfil e consulta mobile

**Files:** `public/js/ui.js`, `public/js/sidebar.js`, `public/css/tokens.css`, `public/css/layout.css`, `public/css/components.css`, `public/js/profile.js`, `public/profile.html`, `public/js/dashboard.js`, `public/js/knowledge.js`, `public/js/academy.js`, `public/js/announcements.js`, `public/js/cms-block-renderer.js` e testes frontend.

- [ ] Corrigir atributos booleanos e manter botão explícito para expandir sidebar.
- [ ] Usar fontes compatíveis com CSP e melhorar contraste/foco.
- [ ] Preservar erros, foco e alterações durante requests.
- [ ] Remover Benefícios da experiência inicial e manter Academy como catálogo.
- [ ] Corrigir respostas de filtros fora de ordem, offsets vazios, categorias e links aninhados.
- [ ] Melhorar dashboard, busca, leitura e PDFs no celular.
- [ ] Garantir fluxo por teclado, zoom de 200%, leitor de tela e viewport de 320 px.

### Task 8: AutoCard

**Files:** `public/autocard.html`, `public/autocard/app.js`, `public/autocard/styles.css`, `public/autocard/vacancy-enhancements.js`, `api/routes/autocard.js`, testes AutoCard.

- [ ] Corrigir upload por teclado, estado de imagem e exportação.
- [ ] Proteger alterações pendentes e respostas assíncronas contra troca de documento.
- [ ] Paginar histórico e corrigir duplicação no limite de nome.
- [ ] Exibir ou rejeitar explicitamente requisitos além do limite.
- [ ] Ajustar preview ao container e testar mobile/desktop.

### Task 9: Cards Pós independentes e UI

**Files:** `public/cards-pos.html`, `public/cards-pos/app.js`, `public/cards-pos/styles.css`, `api/routes/pos-cards.js`, `api/db/migrations/`, testes Cards Pós.

- [ ] Manter Convidado e Owner como documentos independentes, com IDs e nomes próprios.
- [ ] Separar Novo, Editar, Duplicar e Excluir.
- [ ] Reorganizar o editor em identificação/imagem, reserva, serviços/condições e contato.
- [ ] Criar modo mobile com alternância acessível entre edição e prévia.
- [ ] Usar campos nativos para telefone/email e rich text apenas onde necessário.
- [ ] Mostrar estado salvo/pendente/erro em local visível.
- [ ] Proteger saída com alterações pendentes e respostas atrasadas.
- [ ] Usar referência Figma Frame 1 `1448 × 2347` e Frame 2 `1448 × 3361`.

### Task 10: PDF acessível de página única

**Files:** `public/cards-pos/app.js`, `public/cards-pos/styles.css`, `public/cards-pos/assets/`, `api/` somente se a prova exigir geração server-side, dependências e testes PDF.

- [ ] Confirmar o MediaBox dos PDFs exportados pelo Figma e documentar a conversão.
- [ ] Escolher o exportador após uma prova técnica com texto real, fontes incorporadas e estrutura marcada.
- [ ] Preservar uma página e o tamanho de cada frame.
- [ ] Renderizar texto selecionável e pesquisável em ordem lógica.
- [ ] Definir título, idioma, headings, parágrafos, listas e alt text para imagens informativas.
- [ ] Corrigir contraste textual sem descaracterizar elementos decorativos.
- [ ] Detectar overflow por seção, informar o campo responsável e bloquear somente a exportação.
- [ ] Comparar prévia e PDF com conteúdo curto, longo, acentos e imagens.
- [ ] Validar com parser de PDF, leitor de tela e zoom.

### Task 11: Capacidade, homologação e documentação

**Files:** scripts de teste, `docs/product/feature-inventory.md`, `docs/product/brief.md`, `docs/architecture/data-flow.md`, documentação de operação e relatórios de validação.

- [ ] Criar teste de carga com rampas de 20, 50 e 100 sessões.
- [ ] Medir latência, erros, memória, CPU, conexões e bloqueios por IP compartilhado.
- [ ] Homologar login, admissão, convite, conteúdo, lembrete, Academy, AutoCard e Cards Pós.
- [ ] Validar celular, teclado, zoom e leitor de tela.
- [ ] Atualizar inventário e remover afirmações antigas sobre a nomenclatura, Benefícios e Sólides.
- [ ] Registrar backup, deploy e LMS como pendências futuras, sem classificá-los como resolvidos.
- [ ] Executar `npm run verify` e `git diff --check`.

## Critérios de aceite finais

- 0 achados críticos ou altos abertos nos fluxos desta rodada.
- 100% das rotas sensíveis novas ou alteradas cobertas por autorização.
- Repetição de ocorrência não duplica notificações.
- Cadastro aprovado possui contrato e cargo corretos.
- Cargo inativo não concede acesso a ferramenta.
- Convidado e Owner nunca são convertidos implicitamente.
- PDFs têm uma página, tamanho correto, texto selecionável e leitura acessível.
- Nenhum fluxo principal fica bloqueado em 320 px, teclado ou zoom de 200%.
- 100 sessões simultâneas passam no cenário de carga aprovado.
