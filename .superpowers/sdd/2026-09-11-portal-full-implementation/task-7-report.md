# Task 7 — Relatório de shell, perfil e consulta mobile

## Status

Correções da revisão implementadas no worktree `task-7-shell-mobile`, sem commit,
Docker ou serviços. O focused check está verde; o aceite visual/manual final ainda
não foi alegado porque não houve browser real.

## Arquivos alterados

- `public/js/ui.js` — atributos booleanos HTML/DOM, estados `aria-busy` e estados nulos, fallback de foco que rejeita nós/ancestrais hidden, disabled e inert.
- `public/js/sidebar.js` e `public/css/layout.css` — botão explícito de recolher/expandir, drawer mobile, `aria-hidden`, `inert`, media-query changes e restauração de foco.
- `public/css/tokens.css`, `public/css/components.css`, `public/css/cms.css`, `public/css/knowledge.css` — fonte sem dependência externa, contraste, foco, estados desabilitados, reflow e leitura/PDF responsivos.
- `public/css/dashboard-home.css` — links de título sem âncoras aninhadas e alvos de toque.
- `public/js/profile.js` e `public/profile.html` — foco restaurado sem roubar foco novo, erros visíveis, job title com reflow, preservação de alterações feitas durante requests e crop bloqueado durante save com payload capturado, guard de Escape/cancel e fallback que ignora opener disabled.
- `public/js/dashboard.js` — estados pendentes sem substituir conteúdo, tokens de request e cards sem âncoras aninhadas.
- `public/js/knowledge.js` e `public/knowledge.html` — filtros/categorias preservados, offsets vazios/recuados, paginação stale-safe, fallback de foco quando a página vira única/vazia ou o botão equivalente fica disabled/inert, fallback legado, foco no detalhe, DELETE de artigo com token/flag e controles stale-safe, retorno para lista/heading após exclusão no detalhe, Back/popstate que expõe lista/categorias/paginação antes da carga e foca retry visível em erro, fallback de foco ao esconder o controle PDF e rastreamento/cleanup de todos os assets criados na sessão.
- `public/js/pagination.js` — seam comum de busy state que preserva os limites de primeira/última página ao reativar os botões.
- `public/js/academy.js` — catálogo com categorias normalizadas, offsets protegidos, filtros/paginação stale-safe, fallback de foco para página única/vazia ou botão de boundary disabled/inert, retry de erro inicial/repetido focado em estado visível quando não há descritor, request tokens e cards sem âncoras aninhadas.
- `public/js/announcements.js` — request tokens, offset vazio/recuado, paginação stale-safe, fallback de foco para lista/estado vazio ou botão de boundary disabled/inert, estado de leitura com foco e conteúdo preservado durante request.
- `api/routes/cms-assets.js` — DELETE autenticado de assets recém-criados, com razões explícitas `not_found`/`referenced`/`already_deleting`/`pending`, lease curto para distinguir contenção ativa de reservas stale/retryáveis, retry seguro com arquivo presente ou ausente, limpeza da reserva quando uma referência reaparece, uma transação com lock advisory mantido durante recheck/unlink/finalização, auditoria, comparações UUID case-insensitive, remoção física segura e resposta pendente após falha pós-unlink.
- `cron/cms-asset-retention.js` — referências de `asset_id` normalizadas com `lower(...)` nas consultas de reserva, atualização e remoção; falhas de finalização após `unlink` limpam a reserva e entram em `finalizeFailures` para permitir retry.
- `public/js/cms-block-renderer.js` — aviso explícito de que a acessibilidade do PDF depende do arquivo original.
- `tests/unit/frontend-invariants.test.mjs`, `tests/unit/home-preview.test.mjs`, `tests/unit/cms-routes.test.mjs` e `tests/unit/cms-asset-retention.test.mjs` — invariantes alinhadas à paginação, fonte local/CSP, contrato CMS, cleanup reference-safe, ownership/race/falha pós-unlink, retry do cron e referências uppercase; `cms-routes` também monta o router real em Express/Supertest com auth/res/next reais e seams fake para Firebase/pool/filesystem.
- `tests/unit/task-7-shell-mobile.test.mjs` — invariantes e testes comportamentais com DOM fake/deferred para Academy erro inicial/retry repetido e foco de retry, Announcements/Knowledge page→single/empty/boundary-total/inert focus, stale, uploads PDF fora de ordem/seleção inválida/cleanup tardio, POST→PUT após criação, DELETE stale no detalhe/fallback, save/PDF A→B/cleanup/foco/202/409/retry/popstate/back com título de detalhe, lista visível em erro e retry focado, Profile `renderAvatar`/foco/crop deferred payload e cancel, sidebar mobile, booleanos, CSP/contraste, âncoras, viewport e motion.

Nenhum trecho de shell gerado foi alterado; a checagem do gerador continua limpa.

## Checks executados

- `node --test tests/unit/task-7-shell-mobile.test.mjs tests/unit/frontend-invariants.test.mjs tests/unit/cms-frontend.test.mjs tests/unit/cms-blocks.test.mjs tests/unit/cms-routes.test.mjs tests/unit/cms-asset-retention.test.mjs tests/unit/cms-contracts.test.mjs tests/unit/cms-reader.test.mjs tests/unit/home-preview.test.mjs tests/unit/pos-cards-frontend.test.mjs` — **passou: 178 testes, 0 falhas**.
- `node scripts/verify.mjs syntax` — **passou**.
- `node scripts/generate-public-shell.mjs --check` — **passou**.
- `git diff --check` — **passou**.

`npm run verify`, a suíte completa, Docker e serviços não foram executados conforme solicitado.

## Limitações e concerns

- Não foi executado browser real, viewport real de 320 px, zoom real de 200%, teste com leitor de tela, teclado em browser ou visualização real de PDF. Os testes cobrem apenas invariantes estáticas/determinísticas; não há alegação de aceitação desses critérios reais.
- O PDF continua sujeito à acessibilidade do arquivo fornecido; a interface oferece iframe e abertura em nova aba, sem prometer PDF acessível.
- Upload de PDF pendente ou não salvo mantém o modal aberto, bloqueia navegação SPA e limpa todos os assets recém-criados não persistidos ao substituir/remover/fechar; respostas `202`/`already_deleting` mantêm o asset para retry, enquanto `referenced` só é retirado com razão explícita. Um encerramento forçado do navegador ainda depende da retenção de órfãos do cron.
- Uploads PDF stale agora tentam DELETE do asset retornado e mantêm o asset rastreado quando o cleanup falha; artigo novo usa o ID retornado antes de qualquer cleanup e uma repetição usa PUT.
- Endpoint: o router DELETE real foi montado e executado via Express/Supertest, com cadeia real de `authMiddleware`, `res` e `next`; Firebase, pool e filesystem foram seams fake, sem alegar serviços reais. Helper/concorrência: `deleteUnreferencedAsset` foi exercitado separadamente com DB/file-system fake, incluindo referência que vence a corrida sem `unlink`, writer tardio serializado pelo lock, ownership único, retry com `ENOENT` e falha pós-unlink; cron também testa limpeza após falha de finalização. Os caminhos 202/`finalizeFailures` limpam `deleting_at` e permanecem retryable.
