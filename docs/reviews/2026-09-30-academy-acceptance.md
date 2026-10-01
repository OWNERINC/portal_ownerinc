# Academy — matriz final de aceite

**Data:** 1º de outubro de 2026
**Baseline do artefato revisado:** `5e4b40e` (último commit funcional/documental antes desta onda; os commits desta onda estão registrados no relatório de correção final).
**Resultado:** **DONE_WITH_CONCERNS** — evidência local PASS; homologação de
serviços e navegador autenticado PENDENTE.

## Limite de execução

O usuário escolheu seguir sem subir serviços. Não foram iniciados Docker,
PostgreSQL, Firebase, Nginx ou aplicação full-stack; não foi usado banco remoto.
Logo, este relatório não afirma login autenticado real, autorização contra banco
real, persistência entre sessões/contas, headers CSP/Referrer efetivos,
reprodução YouTube/MP4 real, erro de incorporação real ou validação física de
mobile/teclado. Fixtures locais, doubles e a prancha visual são evidência de
composição/código, não substitutos dessas verificações.

## Evidência PASS disponível

| Área | PASS verificável | Evidência |
| --- | --- | --- |
| Contratos de domínio | Validação de audiência, limites, URLs, versão de mídia, CAS e erros tipados coberta por testes locais. | `api/academy/`, `tests/unit/academy-*.test.mjs`, reports Tasks 2–7 |
| Catálogo | Grupos inicial/cargo e continuidade independentes; autorização precede total/categorias/paginação; deep links e lifecycle têm cobertura. | Task 9 report; `tests/unit/academy-frontend.test.mjs` |
| Gestão/CMS | `manageAcademy`, cargos reais, CRUD, ordenação, `academy_lesson`, publicação e descarte tardio cobertos localmente. | Task 10 report; `tests/unit/academy-management.test.mjs`, `cms-frontend.test.mjs` |
| Progresso | UID autenticado é a fonte, posição não conclui, conclusão manual exige ACK, 409 interrompe writes e troca de mídia cria nova versão. | Task 7 report; `tests/unit/academy-progress.test.mjs` |
| Player/lifecycle | YouTube/HTML5 adapters reais no harness, sem autoplay, retry limitado, erros 101/150, abort e destroy idempotente. | Task 8 report; `tests/unit/academy-player.test.mjs` |
| Marca/acessibilidade estrutural | SVG allowlist, namespace CSS Academy, reduced motion, alvos/labels e estados renderizados foram inspecionados localmente. | Task 11 report; brand/motion tests; prancha documental |
| Compatibilidade | Shell persistente, Dashboard com links Academy, legado externo e integração CMS preservados por testes existentes. | Tasks 9–11; `persistent-navigation.test.mjs`, `cms-contracts.test.mjs` |
| Checks reproduzíveis | Baseline anterior: `npm run verify` 917/917; os resultados desta onda, incluindo o novo total, estão no relatório de correção final; `node scripts/generate-public-shell.mjs --check` e `git diff --check` permanecem exigidos. | Task 11 report, logs SDD e `final-fix-report.md` |

## Matriz de cenários

| Cenário/requisito | Status | Observação de aceite |
| --- | --- | --- |
| Primeiro acesso: formação inicial + curso A | PENDENTE | Regra e testes locais existem; exige API/DB/Auth reais com fixtures. |
| Abrir curso/aula/PDF B por URL | PENDENTE | Autorização server-side coberta por doubles; falta sessão e asset real. |
| Sem cargo vê apenas `all` | PENDENTE | Política local PASS; confirmação ponta a ponta requer banco. |
| Cargo inativo não deriva acesso | PENDENTE | Regra local PASS; cenário real pendente. |
| Gestor com preview sem personificar aluno | PENDENTE | Gate e ausência de progresso na prévia cobertos localmente; falta auth real. |
| Admin sem `manageAcademy` não administra | PENDENTE | Testes locais PASS; API autenticada não executada. |
| Pausar e retomar em outra sessão | PENDENTE | Controller/CAS PASS; persistência real não executada. |
| Trocar conta não herda dados | PENDENTE | Lifecycle/UID cobertos; exige dois logins reais. |
| Duas abas com versão antiga retornam 409 | PENDENTE | CAS e tratamento cobertos localmente; corrida PostgreSQL pendente. |
| Reordenar preserva progresso por ID | PENDENTE | Implementação/testes locais PASS; banco real pendente. |
| Substituir vídeo reseta nova versão | PENDENTE | Contrato/testes locais PASS; persistência real pendente. |
| Desativar/despublicar bloqueia catálogo/aula/asset | PENDENTE | Regras e fixtures locais PASS; leitura autorizada real pendente. |
| YouTube 101/150/2 e script bloqueado | PENDENTE | Adapters/doubles locais cobrem 101/150/2; não há double local para 100/153 nesta entrega, e provider/CSP/Nginx reais não foram exercitados. |
| Back/Forward sem player órfão | PASS local / PENDENTE runtime | Router/lifecycle PASS em testes e prancha; navegador autenticado real pendente. |
| Mobile, teclado, reduced motion | PASS estrutural / PENDENTE físico | Código, testes e inspeção local PASS; dispositivo/leitor de tela não validado. |
| Curso legado até conversão explícita | PASS local / PENDENTE runtime | Compatibilidade de payload/links coberta; migração em ambiente real pendente. |

## Segurança, acesso, progresso, CMS e mídia

- **Segurança/acesso:** autorização é server-side; audiência restrita usa cargo
  ativo, preview é explícito e assets não são liberados por `uploaded_by`.
  PASS refere-se à implementação/testes locais, não a uma requisição real.
- **Progresso:** dado por usuário/aula/versão, CAS e conclusão manual; não há
  relatório de gestor. Retenção e cascatas estão documentadas em
  `docs/product/privacy-retention.md`.
- **CMS/publicação:** salvar, disponibilizar e publicar são estados diferentes;
  documento sem publicação válida não reativa legacy; primeira imagem publicada
  define capa. O manual está em `docs/operations/academy-content.md`.
- **Mídia:** hosts/formats são allowlisted, sem probe server-side; player tem
  retry/cleanup. Reprodução real, Referer/origin, fullscreen e CSP efetiva são
  pendências, não PASS.
- **Legado:** cursos externos preservam acesso até conversão explícita; Academy
  não substitui automaticamente o fluxo antigo.

## Findings diferidos e ruling

| Finding | Ruling Task 12 | Impacto |
| --- | --- | --- |
| Task 9: foco após filtro/paginação pode não ser restaurado em `public/academy/catalog-view.js:483-493` | **Aceito como minor deferred; não bloquear aceite local.** Abrir follow-up antes de declarar acessibilidade física completa. | UX de teclado, sem evidência de vazamento/autorização. |
| Task 10: cobertura específica de dispose durante reload autoritativo tardio | **Parked test gap; não reabrir produção.** Guardas de abort/token/dispose existem; adicionar teste dedicado em manutenção. | Cobertura de teste, não finding funcional confirmado. |
| Task 11: breadth adicional de motion/ARIA/filter/loop | **Aceito como minor deferred.** A implementação e regressões críticas estão cobertas; ampliar testes antes de futura revisão visual/a11y. | Profundidade de cobertura, sem finding Critical/Important aberto. |

## Checks desta documentação

Serão executados nesta entrega, sem serviços: `npm run verify`,
`node scripts/generate-public-shell.mjs --check`, `git diff --check` e inspeção
de consistência dos links/textos. `npm run test:migrations` e
`node --test scripts/test-academy.mjs` permanecem **PENDENTES**, pois exigem
opt-in e banco descartável real; não serão executados contra banco remoto nem
usados para alegar aprovação.

## Próxima homologação necessária

Em ambiente descartável autorizado, criar os fixtures do brief (integração,
especializados A/B, PDF publicado, documento despublicado e contas A/B/sem
cargo/gestor/admin sem permissão), executar migrations e `scripts/test-academy`,
depois percorrer o navegador via Nginx com sessão real. Registrar headers,
console, requests após `dispose`, reprodução/erro real e retomada em duas contas.
