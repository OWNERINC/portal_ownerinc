# Lote 5 — correções da revisão final

Revisor novo `ses_f11a78df3ffe3m84npVIbw9PEo`: **fix-first**, após leitura de todo
o diff integrado contra `ff14c66`. O primário conferiu os dois achados no código.

## Escopo exclusivo do mesmo implementador

- `public/js/knowledge.js`, somente autorização do novo link editorial.
- `tests/unit/editorial-guidance.test.mjs`, regressões pertinentes.
- `tests/helpers/knowledge-editorial-harness.mjs`, somente se necessário para
  garantir fidelidade dos testes (justificar alteração).
- `docs/product/feature-inventory.md`, `docs/architecture/data-flow.md`, somente
  a afirmação sobre UID visível da auditoria.
- Adendo de `docs/reviews/2026-09-29-portal-corrections-batch-5.md`.

## Correções obrigatórias

1. **P2:** o link CMS em `syncLegacyContentField` depende de `canManage`, mas o
   helper frontend `can()` aceita truthy. Uma conta administrativa com
   `manageKnowledge: 'false'` ou `superAdmin: 'false'` recebe o novo link mesmo
   sendo recusada pela política da API. O link deve exigir `role === 'admin'`
   e (`permissions.manageKnowledge === true` OU `permissions.superAdmin === true`).
   Limitar a correção ao novo link/ajuda; manter auth compartilhado e regras dos
   handlers preexistentes. Preservar link normal, nó focado, guards e payloads.
2. Cobrir flags textuais em ambos os campos (inclusive `'true'`), outros valores
   truthy se pertinente, booleans autorizados, falso/ausente e role não admin.
   A regressão deve observar o link/ajuda no módulo montado, garantindo que o
   double do helper reproduz a semântica frontend atual e não oculta o problema.
3. **P3:** a auditoria atual renderiza nome/fallback, ação, alvo, request ID e
   horário; `actor_uid` existe na API, mas não aparece na célula de ator. Corrigir
   somente a descrição nos dois documentos: retirar a promessa de UID visível.
   Não expandir renderer/Admin nem alterar o 4B já aceito.

## Verificação e limites

Executar regressões focadas, `npm run verify`, gerador `--check` e
`git diff --check`; registrar total atualizado e comparação de hashes dos
arquivos protegidos. O último primário passou **758 testes**, zero falhas/skips.
Acrescentar adendo preservando histórico; sem declarar aceite/revisão final.

Não editar Admin/4B, ferramentas/R3, CMS, API, runtime, plano, ledger, scripts de
QA temporários ou snapshots da revisão. Sem delegar, operar serviços, credenciais,
DB, commit/push/PR/merge/deploy. O primário repetirá checks/navegador e solicitará
revisão nova. A janela local 300 req/15min está intacta e não deve ser alterada.
