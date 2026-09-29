# Lote 3 R3 — fechar F11 e corte móvel

Usuário autorizou concluir os lotes pendentes e atualizar PR #42. Branch atual:
`fix/portal-functional-audit-20260929`; HEAD `3cf25b1`; baseline original `ff14c66`.
Lotes 1, 2 e 4A aceitos. Última verificação primária: 683 testes aprovados e CI
do PR aprovada. Mesmo implementador único da execução anterior.

## Propriedade

Editar apenas `public/autocard/app.js`, `public/autocard/styles.css`, regressões
pertinentes em `tests/unit/` (helper focado em `tests/helpers/` se necessário),
adendo em `docs/reviews/2026-09-29-portal-corrections-batch-3.md`.
API é leitura apenas; manter auth.js, Cards Pós, catálogos 38/16 e outros lotes.
Plano, aceitação, specs e QA temporário são da sessão principal. Não delegar,
commitar, enviar push, operar serviços, acessar credenciais ou fazer deploy.
Leia README, AGENTS, plano e evidência; aprovação para implementação já concedida.

## F11: default inválido

Parecer novo `ses_f11fc0618ffe7txm1LmhFO30CJ`: fix-first. `novo_funcionario`
usa `defaultIcon:'user-plus'`, que só existe na allowlist de ilustrações da API.
Primário confirmou POST HTTP 400 no navegador local conservando esse padrão,
mesmo após a correção de Content-Type. Usar um default da allowlist de ícones
existente com significado pertinente, sem aumentar/remover IDs.
Cobrir os defaults dos quatro templates ativos com o validador real da rota,
idealmente payload vindo do caller montado; verificar POST e PUT. Não basta o
probe Express de headers que apenas exige template presente. Preservar seleção
manual, reabertura, mídia, permissões e payloads existentes.

## Layout móvel do Novo Funcionário

Captura `.openchamber/screenshots/qa-employee-mobile-clipping-20260929.png`.
Reprodução: 390 × 844; foto sintética válida, título
`Árvore Colaborador Silva de Almeida`, subtítulo `Equipe local`, data `29/09`,
corpo `Conteúdo sintético para conferir a exportação.`. Após fontes prontas e
60 frames, h2 clientHeight=37 e scrollHeight=40, bloqueando PNG. Título curto
`QA local 20260929` funciona após estabilizar. A medição transitória de zero
não é o defeito a corrigir.

Revisar o orçamento flex da composição employee para comportar título de duas
linhas, metadados, corpo curto e rodapé em 390px; manter visual e layout local,
fonte legível, canvas quadrado, PNG 1080px, foto/crop e detector estrito sem
tolerância adicional. Não ocultar texto real para burlar overflow, nem modificar
styles globais. Preservar desktop e bloqueio de conteúdo realmente cortado.
Primário fará medição/browser/export real sem overrides. Pode usar verificações
de regressão existentes para cascata/overflow, mas distinguir de render real.

## Entrega

Foco defaults+headers+overflow/invariantes e navegação; `npm run verify`, gerador
`--check`, `git diff --check`. Relatar arquivos/deltas/limites e append do relatório,
preservando as rodadas anteriores. Depois do handoff primário faz review novo
e aceita navegador. Lot 4B só começa por novo despacho do primário.
