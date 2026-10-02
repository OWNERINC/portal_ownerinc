# Academy — relatório da onda final de correções

**Data:** 1º de outubro de 2026
**Escopo:** correções finais do catálogo, editor de currículo, motion/ARIA e evidência documental.
**Baseline documental:** `5e4b40e`, conforme a matriz de aceite. Os arquivos `task-*-review*.md` locais não foram alterados.

## Correções entregues

- O catálogo captura o controle que iniciou filtro/paginação em um estado estável da página, preserva os grupos independentes e restaura foco após o remount somente se o foco não tiver sido movido pelo usuário. Quando o controle equivalente desaparece, o foco cai no `h1`; retries no mesmo grupo retornam ao filtro.
- Estados de carregamento do catálogo continuam expostos com `aria-busy` e status úteis; motion mantém cancelamento e não inicia trabalho depois do descarte.
- O editor de currículo mantém reload autoritativo após mutações. O teste agora cria uma segunda mutação, deixa o reload autoritativo genuinamente pendente e só então descarta o editor antes de resolver a resposta tardia.
- A criação de aula nova não usa mais uma URL de YouTube fictícia: o payload começa com URL vazia para ser preenchido pelo editor.
- Foram adicionados/fortalecidos testes de foco, filtro/paginação, motion pós-dispose, ARIA, retry, loop de sala de aula e matriz de erros do player. A documentação de aceite agora distingue a evidência local dos limites de provider/CSP/Nginx.

## Verificações executadas separadamente

Cada arquivo de teste foi executado em um comando próprio; o comando combinado proibido não foi executado.

| Comando | Resultado |
|---|---|
| `node --check public/academy/app.js` | PASS |
| `node --check public/academy/catalog-view.js` | PASS |
| `node --check public/academy/curriculum-editor.js` | PASS |
| `node --test tests/unit/academy-frontend.test.mjs` | **21/21 PASS** |
| `node --test tests/unit/academy-management.test.mjs` | **6/6 PASS** |
| `node --test tests/unit/academy-brand-motion.test.mjs` | **6/6 PASS** |
| `node --test tests/unit/task-7-shell-mobile.test.mjs` | **40/40 PASS** |
| `npm run verify` | **919/919 PASS**, zero failures/skips/cancelamentos; `verify: security`, `verify: compose`, `verify: ok` |
| `git diff --check` | PASS |

O `npm run verify` emitiu logs esperados de doubles de falha (cron/API/router), avisos de módulos sem `type: module` para arquivos Cards Pós e mensagens de smoke; os testes correspondentes passaram. Nenhum serviço, Docker, banco ou acesso remoto foi iniciado.

## Proveniência e limitações remanescentes

- A evidência desta onda é local e reproduzível pelos comandos acima; não constitui homologação em navegador autenticado, provider YouTube real, CSP/Nginx de produção, dispositivo físico ou leitor de tela.
- O harness local cobre os códigos YouTube **101, 150 e 2**. Não há double local nesta entrega para **100/153**; esses códigos permanecem uma lacuna documental/testável, não uma alegação de cobertura.
- A matriz continua `DONE_WITH_CONCERNS`: persistência/banco real, permissões reais e execução física de mobile/tecnologia assistiva permanecem pendentes.
- O suporte integral em Node 18 não foi comprovado nesta execução; o verify foi executado no runtime disponível.
