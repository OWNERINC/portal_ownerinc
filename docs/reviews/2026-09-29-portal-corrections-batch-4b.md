# Correções do Portal — lote 4B (interface administrativa)

Data: 29/09/2026. Implementação delimitada por
`.openchamber/reviews/batch-4b-specification.md`, sobre o contrato 4A congelado.
Base recebida: HEAD `3cf25b1`, branch `fix/portal-functional-audit-20260929`,
com R3 no working tree e **691 testes**. Este relatório registra a entrega do
implementador, não substitui inspeção, review novo ou aceitação do primário.

## Arquivos deste lote

- `public/js/admin.js`
- `public/admin.html`
- `public/css/admin.css` — somente encaixe dos filtros/ajuda.
- `public/js/admin-list-state.js` — novo; campos, validação civil e tradução URL/API.
- `tests/helpers/admin-ui-harness.mjs` — novo.
- `tests/unit/admin-ui-filters.test.mjs` — novo.
- `tests/unit/admin-ui-catalog-policy.test.mjs` — novo.
- `tests/unit/frontend-invariants.test.mjs` — atualização das duas expectativas
  estáticas afetadas pela separação do catálogo e pela nova consulta de auditoria.
- `docs/reviews/2026-09-29-portal-corrections-batch-4b.md` — este documento.

Não foram editados API, pacotes, gerador, auth, router, lifecycle, UI compartilhada,
CMS/Knowledge, AutoCard, Cards Pós, outros relatórios, plano, aceitação, specs ou
QA temporário. Alterações concorrentes nos documentos/evidências primários foram
observadas e preservadas. **Lote 5 não iniciado**; sem commit, push, PR, deploy,
delegação, acesso a credenciais, conexão ao banco ou operação de serviços.

## Comportamento entregue

### Filtros, URL e concorrência

- Formulários com IDs contratados, labels, `maxlength`, mensagens por campo,
  Aplicar e Limpar. Consultas usam exclusivamente os campos aceitos pelo 4A,
  sem filtrar apenas a página local. `%`, `_` e `\` seguem como texto literal
  para a API, responsável pelo escape SQL existente.
- Estado independente `users_*`, `titles_*`, `audit_*`, com páginas base 1.
  Aplicar/Limpar reinicia apenas a própria seção; paginação e filtros usam
  `page.history`, preservando `tab`, outras seções e metadados do router.
  Acesso direto, reload, Back/Forward e links same-path restauram os controles
  e consultam novamente mesmo sem trocar de aba.
- URL inválida é normalizada com `replaceState`: filtros repetidos/estruturados,
  enums/UUID inválidos, datas irreais/invertidas e páginas fora de 1–20001 não
  são encaminhados à API. O teto corresponde ao offset máximo 1.000.000 do 4A.
  Submissão inválida mostra erro associado ao campo e não dispara consulta.
- Usuários, tabela de cargos e auditoria têm tokens próprios; catálogo completo
  possui uma quarta geração independente. Durante a troca, a tabela anterior
  e a paginação são removidas, mas os filtros seguem disponíveis. Sucessos,
  erros, `finally`, retries, paginadores e ações de linha antigos conferem a
  geração e o lifecycle antes de agir.
- `X-Total-Count` alimenta as três paginações de 50 itens, inclusive total zero.
  `job-titles-pagination` é independente do catálogo. Página removida busca a
  última válida uma vez; nova contração durante essa recuperação ajusta URL e
  controles sem loop. Aplicar novamente atualiza uma lista ainda em mudança.
- Tabela de cargos mantém `all=true` por padrão e envia `active` apenas quando
  explícito, preservando a precedência já estabelecida no backend.

### Catálogo completo de cargos

- `jobTitles` da tabela não alimenta convites/edição/aprovação. O loader separado
  percorre `all=true&limit=100&offset=N` até completar o total, compartilha a
  Promise pendente e publica o catálogo somente após o sucesso integral.
  Página intermediária vazia/incompleta é falha, não sucesso parcial.
- Convite e aprovação oferecem todos os ativos, incluindo a segunda página;
  edição também conserva o cargo inativo atualmente atribuído. O filtro de
  usuários inclui inativos. ID/rótulo conhecido permanece disponível durante
  reconciliação, sem limpar silenciosamente uma atribuição existente.
- Editores aguardam o catálogo antes de abrir. Falha informa que não houve
  publicação parcial e oferece retry; a intenção mais recente pode ser retomada.
  Troca de aba e descarte impedem abertura tardia do editor.
- Criar/editar/ativar/desativar cargo invalida e recarrega catálogo e tabela
  separadamente. Seleções ainda válidas permanecem; convite/aprovação deixam de
  oferecer cargo que ficou inativo, sem alterar a atribuição existente no usuário.
  Filtrar/paginar a tabela não altera opções ou seleções dos formulários.
- Catálogo que termina depois de uma escolha não submetida de “Todos” não
  restaura indevidamente o filtro aplicado anterior.

### Ações, auditoria e orientação

- A própria conta continua editável nos campos permitidos, sem alteração de
  seus privilégios; desativar/reativar/anonimizar ficam indisponíveis com motivo.
- Superadministrador-alvo exige `role=admin` e `superAdmin === true` para sua
  proteção. Gestor sem super-admin não pode editar nem alterar seu estado.
  Strings não concedem privilégio. Super-admin pode agir sobre outro conforme
  a API; nenhuma contagem global é inferida de uma página filtrada.
- Anonimização mantém a confirmação e exige outro alvo, não super-admin,
  `accountDisabled === true` booleano e ainda não anonimizado. Exibição de
  estado reconhece também `accountDisabled: "true"`, com precedência disabled
  → enable_pending → active; isso não relaxa o requisito do handler de escrita.
- Cargo inativo tem aviso na linha e no editor: vínculo mantido, acesso derivado
  indisponível até atribuição/ativação autorizada; não é desativação da conta.
- Auditoria permanece exclusiva de super-admin. Datas civis são validadas sem
  conversão pelo timezone do navegador; timestamps usam `America/Sao_Paulo`.
  Mostra `actor_name` atual como texto seguro, fallback `Sistema ou conta removida`,
  tradução de ações conhecidas junto ao código, alvo e request ID. Código novo
  ou desconhecido continua consultável/legível, inclusive nomes de propriedades
  como `constructor`; não há snapshot de identidade nem novo log de filtros.
- CSV tem label associado e `aria-describedby` para UTF-8, colunas, 500 pessoas,
  remoção dos exemplos e preview. Parser, ticket, confirmação, polling e storage
  por UID não foram alterados; nenhuma promessa nova de entrega de e-mail.

## Regressões e limites da evidência

O harness lê **todo `public/admin.html`** e executa o módulo Admin completo, o
helper de listas, bulk ticket, UI, lifecycle e **router reais**, inclusive
metadados e Back/Forward. DOM/formulários e transportes são doubles explícitos.
Não há substituição dos loaders/handlers por cópias extraídas para os testes novos.

As **43 regressões novas** cobrem filtros isolados/combinados, totais, reset,
URL direta/reload e same-tab history, consulta simultânea independente, sucesso
e erro em ambas as ordens de resolução, retries/paginadores/ações obsoletos,
recuperação vazia, descarte, 105/106 cargos, falha na segunda página, catálogo
sem publicação parcial, convite/edição/aprovação, seleção inativa, mutações de
cargos, permissões próprias/protegidas/strings, nomes seguros, datas inválidas,
ação desconhecida, horário histórico de São Paulo, CSV e descoberta Sólides.

**Não são** medições Chromium, testes de reflow/acessibilidade nativos, execução
SQL ou persistência Firebase/PostgreSQL. `Intl` é real no Node; inputs, foco e
histórico de navegador têm DOM controlado. A aceitação visual/teclado, filtros
com os 55 usuários/105 cargos reais e ações/mutações reais continua com o primário.

## Verificações executadas

```sh
node --test tests/unit/admin-ui-filters.test.mjs tests/unit/admin-ui-catalog-policy.test.mjs tests/unit/admin-list-filters.test.mjs tests/unit/auth-stability.test.mjs tests/unit/frontend-invariants.test.mjs tests/unit/governance-routes.test.mjs tests/unit/operations-invariants.test.mjs tests/unit/navigation-review-regressions.test.mjs tests/unit/persistent-navigation.test.mjs tests/unit/bulk-user-import.test.mjs
npm run verify
node scripts/generate-public-shell.mjs --check
node --check public/js/admin.js
node --check public/js/admin-list-state.js
node --check tests/helpers/admin-ui-harness.mjs
node --check tests/unit/admin-ui-filters.test.mjs
node --check tests/unit/admin-ui-catalog-policy.test.mjs
git diff --check
```

| Check final | Resultado real |
| --- | --- |
| Foco ampliado listado acima | **195 passaram**, zero falhas/cancelamentos/skips. |
| `npm run verify` | **734 passaram**, zero falhas/cancelamentos/skips; exit 0 em sintaxe, testes, scanner local, nomenclatura e Compose. |
| Gerador `--check`, cinco syntax checks e whitespace | Exit 0. |
| Preservação R3 | **21 hashes** iguais ao snapshot `batch-3-r3-ff14c66-20260929.diff`. |
| Preservação fora do lote | Diff vazio contra HEAD em API, auth/router/lifecycle/UI, CMS/Knowledge, bulk state, scripts, Nginx, cron e manifest raiz. |
| Regiões não relacionadas do Admin | Bulk preview/job/storage/handlers, tabs/Sólides, Academy e Benefícios comparados byte a byte com HEAD: iguais. |

Na primeira execução das suítes preexistentes, 91/95 passaram; quatro asserções
de fonte ainda esperavam o loader antigo/boot. A ordem de boot foi preservada e
somente as duas expectativas afetadas por contratos novos foram atualizadas.
Um teste adicional de link same-path inicialmente não criava o atributo `href`
no double e não acionava o router; a fixture foi corrigida. Todas as execuções
finais acima passaram. A primeira verificação completa teve 733 passes; a
regressão adicional de same-path resultou no total final **734 = 691 + 43**.

Ambiente: Node **24.15.0**, npm **11.12.1**, Windows. Sintaxe nova compatível com
Node 18, sem declarar validação integral nesse runtime. Warning preexistente
`MODULE_TYPELESS_PACKAGE_JSON` permanece. Compose no verify é somente
`config --quiet` com `.env.example`, sem alterar serviços. `verify: security`
é o scanner local do repositório, não novo `npm audit`.

## Handoff

Sem bloqueio de implementação identificado no escopo. Primário deve inspecionar
o diff, obter review fresh e executar sua aceitação Chromium/stack real,
incluindo reflow, teclado, datas nativas, navegação, catálogo completo e políticas
de escrita. O script primário `portal-correcoes-admin-browser.cjs` não foi editado
nem executado por este implementador. Aguardar novo despacho antes do lote 5.
