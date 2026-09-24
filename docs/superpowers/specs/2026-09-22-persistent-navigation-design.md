# Navegação persistente e permissões estáveis

## Aprovação

O usuário escolheu explicitamente **Navegação sem recarga**: preservar menu e
estrutura, substituir somente conteúdo e corrigir oscilação de permissões.

## Contrato

- Navegação entre todas as áreas do shell mantém o mesmo documento, sidebar e
  sessão Firebase. URLs `.html`, links diretos, Back/Forward e nova aba continuam
  funcionando. Login/logout continuam podendo navegar em documento completo.
- Reutilizar HTML, módulos e CSS atuais com ciclo explícito de montagem e
  desmontagem. Evitar iframes, importações com cache-busting e monkeypatch de
  APIs globais. Não duplicar Firebase, assinaturas, timers ou listeners por visita.
- Desmontagem cancela trabalho pendente, eventos globais, timers e object URLs;
  respostas de uma área antiga não podem modificar a área atual.
- Navegação comum em andamento conserva a área anterior até poder efetivar a
  próxima. Links externos, downloads, modificadores e âncoras mantêm semântica.
- Histórico restaura URL, filtros e foco; erro recuperável permite retry.
- Respeitar proteção contra perda de edições dos formulários e CMS. Abortos
  durante navegação não podem salvar, publicar ou descartar trabalho silenciosamente.
- Menu com permissão mantém o último estado visual validado da mesma conta
  durante revalidação. Erro transitório não equivale a revogação. 401, logout,
  conta trocada ou 403 de sessão invalidam o cache e removem acesso.
- Cache visual nunca concede autorização nem permite carregar conteúdo privado
  antes da confirmação necessária. API permanece autoridade em cada requisição.
- Admin não reconstrói abas idênticas nem condiciona sua exibição a consultas
  secundárias. Foco e seleção preservados durante atualização.

## Limites e validação

Preservar trabalho não commitado de Owner News e PDF, APIs, deploy e stack.
Sem framework novo. Cobrir repetição de visitas, back/forward, clique rápido,
falha de rede, revogação e troca de conta. Executar `npm run verify` e browser
autenticado nas áreas comuns, Admin, CMS, AutoCard e Cards Pós.
