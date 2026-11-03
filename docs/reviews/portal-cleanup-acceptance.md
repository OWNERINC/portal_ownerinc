# Aceite documental do Portal sem editorial

Data: 3 de novembro de 2026
Gate: OWN-45
Estado: aprovado — revisão Astra medium `ship`

## Resultado esperado

O texto ativo do projeto descreve o Portal sem CMS/Owner News no runtime e separa
explicitamente runtime mantido de migrations, tabelas, uploads e documentação
históricos. Nenhuma promoção produtiva ou limpeza de dados reais faz parte deste
gate.

## Matriz de referências

| Classe | Exemplos | Tratamento |
| --- | --- | --- |
| Runtime ativo | `api/routes/knowledge.js`, `api/academy/`, `cron/checkReminders.js`, `public/js/knowledge.js` | Descrito como contrato próprio do Portal; sem chamadas editoriais. |
| Compatibilidade negativa | `nginx/nginx.conf` para `/announcements.html`, 404 de `/api/cms`, `/uploads/cms-private` | Preservado e descrito como proteção/404 controlado, não como feature. |
| Runtime Academy | migration `033_academy_learning`, tabelas `academy*` e progresso | Mantido como consumidor ativo do runtime Academy; não é uma migration editorial. |
| Histórico preservado | migrations editoriais 015/019/034/035, `cms_*`, `owner_news_*`, uploads e relatórios anteriores | Mantido, rotulado como histórico sem consumidor runtime. |
| Termo genérico | `payload` em validação HTTP, Sólides e AutoCard | Mantido; não é referência ao produto Payload CMS. |

## Documentação atualizada

- `README.md` e `docs/product/brief.md` delimitam a superfície sem editorial.
- `docs/product/scope.md` separa capacidades incluídas, fora do escopo e pendências
  externas.
- `docs/product/feature-inventory.md` remove claims de CMS ativo em Knowledge,
  Academy e Reminders.
- `docs/product/roadmap.md` registra OWN-43, OWN-44 e OWN-45 aprovadas.
- `docs/product/privacy-retention.md` classifica documentos, assets e retenção CMS
  como histórico sem job ativo.
- `docs/architecture/data-flow.md` e `docs/operations/v1-release-checklist.md`
  distinguem contratos/checagens mantidos de registros CMS históricos.
- `docs/architecture/overview.md` e
  `docs/architecture/portal-without-editorial.md` distinguem runtime/histórico.

## Verificação

- `npm run verify` — 808 testes: 806 PASS, 0 falhas e 2 skips de plataforma;
  `verify: security`, `verify: compose` e `verify: ok`.
- `git diff --check` — PASS.
- A busca nominal nas áreas ativas mantém referências apenas quando são contratos
  negativos, termos genéricos (`payload`) ou links explicitamente históricos; não
  há nova dependência executável de CMS/Owner News.

O aceite não autoriza deploy, promoção, revogação de grants produtivos, remoção de
tabelas ou limpeza de uploads históricos. OWN-46 pode consolidar a matriz final de
smoke, evidências e pendências externas, sem executar promoção produtiva. O
handoff está em [`2026-11-03-own-46-handoff.md`](../reports/2026-11-03-own-46-handoff.md).
