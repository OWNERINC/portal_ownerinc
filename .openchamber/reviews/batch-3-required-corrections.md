# Lote 3 — correções delimitadas após revisão e navegador

Implementador único: continuar `ses_f126a8a46ffeA3Aky9rD2t0I9H` depois da
entrega do lote 4A. Não executar em paralelo com outra implementação.

## Responsabilidade e arquivos

Editar apenas `public/cards-pos/app.js`, `public/autocard/app.js`,
`public/autocard/styles.css`, regressões pertinentes em `tests/unit/` e o
relatório `docs/reviews/2026-09-29-portal-corrections-batch-3.md`.
Pode criar uma regressão de composição de headers com o helper de autenticação
real; preservar `public/js/auth.js`, uploads binários e todos os outros lotes.
Plano/aceitação e scripts temporários de navegador são da sessão principal.

## 1. Revisor: duas mutações do histórico concorrem

Parecer da sessão `ses_f1226236effeDBJAgT9eBgUCk1`: **fix-first**, P2.
As operações em dois IDs capturam o mesmo `historyRequest`. O refresh da
primeira incrementa o token e o sucesso/erro da segunda é descartado. O usuário
pode continuar vendo um card já excluído, ou não receber erro da segunda ação.

Preferência: serializar as mutações do histórico, incluindo o refresh, com
guarda própria nas funções e desabilitação coerente das ações. Preservar a
proteção de consultas obsoletas, navegação, paginação, editor e aviso de mídia.
Liberar a guarda em sucesso, falha e descarte; não deixar controles novos
bloqueados nem destravar uma operação mais recente. Regressões: dois IDs,
sucesso/falha, refresh pendente, nova busca e descarte da página.

## 2. F09: gravação real retorna HTTP 400

Reproduzido no navegador para AutoCard e Cards Pós, com JSON válido. Os callers
adicionam `headers: { 'content-type': 'application/json' }`, enquanto
`fetchForSession` adiciona `Content-Type` para body string. A rede recebe
`application/json, application/json` e o parser ignora o corpo.

Correção mínima: remover os headers JSON redundantes dos dois callers de
POST/PUT; conservar os headers de MIME dos uploads. Incluir regressão que
componha o caller com o helper real e confirme um único header JSON efetivo,
sem enfraquecer os testes existentes de geração/revisão/save ticket/autorização.
A sessão principal repetirá POST/reabrir/PUT/ler em todos os quatro modelos
AutoCard e ambos os Cards Pós. Não mudar contratos de payload nem o helper
compartilhado de autenticação incidentalmente.

## 3. F10: Novo Funcionário bloqueia exportação com título curto

Chromium 1440 × 900, título `QA local 20260929`, foto pronta: h2 de
`.employee-copy` mede clientHeight 23 e scrollHeight 24, overflow hidden.
Captura: `.openchamber/screenshots/correcao-f10-employee-export-blocked.png`.
Um experimento somente no DOM com `line-height:1.1` elimina o corte e gera PNG
1080 × 1080. Implementar ajuste tipográfico mínimo nesse seletor, confirmando
as regras de cascata, sem tolerância adicional no detector de overflow.
Preservar altura do canvas, crop, templates e bloqueio de textos realmente
cortados. Verificar título curto, multilinha, acentos, desktop/mobile e textos
longos com bloqueio real; medições/exports reais cabem à sessão principal.

## Verificação e entrega

Executar regressões focadas, `npm run verify`, gerador `--check` e
`git diff --check`. Atualizar o relatório com esses três deltas e limites reais.
Sem commit, push, deploy, operação de serviço Docker, schema, credenciais ou
delegação. Check Compose somente leitura permanece permitido.

Após inspeção primária, criar novo snapshot completo do lote 3 e obter revisão
**nova**, incluindo estes deltas. O PNG com override DOM é diagnóstico; não
substitui exportação sem overrides após a correção.
