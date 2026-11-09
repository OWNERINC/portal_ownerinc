# PodFalar independente e Notificações — evidências locais

## Entrega

- PodFalar em cartão compacto independente abaixo do cartão de acesso, com
  a mesma largura e intervalo de 16 px. Detalhes amarelos e pretos usam as cores
  originais da marca; os três SVGs permanecem íntegros.
- Login, cadastro, recuperação e criação de senha conservam o canal público,
  os contratos de autenticação, retorno de foco e fundo aurora.
- Nomenclatura Notificações aplicada aos menus gerados, títulos, dashboard,
  administração, prévia, criação/edição, detalhe, filtros e mensagens.
- Rotas reminders.html, endpoints, permissões, IDs, dados e cron preservados.

## Verificação

- Regressões novas falharam antes da implementação na estrutura acoplada e
  na nomenclatura antiga, passando depois das mudanças.
- `npm run build:public`: shell regenerado e validado pelo teste existente.
- `npm run verify`: **839 PASS, zero falhas, dois skips específicos de Linux**,
  seguido de `verify: ok`. Repetido após as alterações finais de markup e testes.
- `git diff --check`: aprovado.
- `tests/visual/check-login-approved.mjs`: 40 combinações largura/estado com
  axe WCAG A/AA sem violações automatizadas. Larguras: 320, 360, 402, 768, 769,
  1000, 1001, 1366, 1440 e 1920 px; estados: login, recuperação, cadastro e senha.
- Mesma suíte: igualdade de largura e alinhamento dos cartões, intervalo de
  16 px, canal fora dos formulários/cartão de acesso, logo proporcional, foco,
  ordem por Tab e isolamento da nova aba aprovados. Transportes simulados.
- Telas baixas de 360 × 480/568/667 px: centralização segura, rolagem natural
  e acesso ao canal/campos aprovados.
- Capturas desktop 1440 px e mobile 402 px inspecionadas visualmente.
- `tests/visual/check-conecta-interactions.mjs`: **42 estados aprovados** em
  1920/402/360 px, incluindo títulos Nova notificação e Editar notificação,
  validação de filtros, reflow, foco, detalhes e navegação persistente.
- Inspeção adicional pelo navegador local confirmou título, menu, cabeçalho,
  histórico e diálogo Nova notificação.
- Revisão independente read-only: aprovada, sem achados acionáveis; 44 testes
  direcionados e checagem de whitespace confirmados pelo revisor.

## Evidências e limites

Capturas, `results.json`, `interactions/interactions.json` e `verify.log` ficaram
no diretório temporário local `opencode/podfalar-card-notifications`, fora do
repositório. Prévia servida somente em loopback pelo harness existente.

Não foram usados Docker, banco remoto, autenticação Firebase real ou envio de
e-mail. Não houve deploy, push ou publicação. Fixtures e verificações locais
não comprovam persistência, entrega de notificações nem comportamento de teclado
virtual em dispositivo físico. A auditoria automática não substitui avaliação
manual completa de acessibilidade.
