# Correções do Portal — lote 4A (consultas administrativas)

Data: 29/09/2026. Implementação exclusiva dos contratos de leitura de usuários,
cargos e auditoria, conforme o contrato congelado do lote 4. Base recebida:
**616 testes aprovados**. Inspeção, revisão independente, execução do SQL no
PostgreSQL local e aceitação continuam com a sessão principal.

## Arquivos deste lote

- `api/routes/users.js` — somente `GET /`, `GET /audit`, imports e constantes
  estreitamente ligados aos filtros dessas consultas.
- `api/routes/job-titles.js` — somente `GET /`, imports e validadores da listagem.
- `api/admin-list-filters.js` — novo; escape de substring literal e validação
  de data civil, sem framework ou conexão a serviços.
- `tests/helpers/admin-filter-harness.mjs` — novo.
- `tests/unit/admin-list-filters.test.mjs` — novo.
- `tests/unit/governance-routes.test.mjs` — apenas asserções afetadas pela nova
  assinatura de validação/numeração de parâmetros.
- `tests/unit/operations-invariants.test.mjs` — apenas asserções da precedência
  de `active`/`all` e do predicado parametrizado.
- `docs/reviews/2026-09-29-portal-corrections-batch-4a.md` — novo.

As regiões dos handlers de mutação foram comparadas em bytes com `HEAD`, pois
esses dois arquivos estavam sem alterações ao receber este lote:

| Região preservada | Resultado |
| --- | --- |
| Helpers existentes de auditoria/reconciliação/foto e `GET /me` | Idênticos, 3133 bytes. |
| `PUT /me` | Idêntico, 664 bytes. |
| Demais mutations de usuários e exports | Idênticos, 17957 bytes. |
| Mutations de cargos e exports | Idênticos, 2135 bytes. |

Sem alteração de frontend (incluindo lote 3), schema/migrations/índices,
dependências, runtime, deploy, API de escrita ou retenção. Preservados todos os
artefatos anteriores e documentos da sessão principal. Sem delegação, commit,
push, produção, inspeção de credenciais ou operações sobre serviços em execução.

## Contrato entregue para a próxima etapa de UI

### Comum às três listagens

- Resposta continua sendo **array**, com `X-Total-Count` do resultado filtrado,
  não apenas do tamanho da página. Nenhum envelope novo.
- `limit`/`offset` continuam usando `parseListQuery`: defaults 50/0, limite
  máximo 100 e offset máximo 1.000.000, com as regras numéricas existentes.
- Parâmetros desconhecidos, repetidos, arrays e objetos que chegam do parser
  estendido são rejeitados com 400 antes das consultas de rota. Erros preservam
  `requestId`; autenticação e autorização continuam anteriores à validação.
- Valores fornecidos pelo cliente são parâmetros SQL. Cada endpoint reutiliza
  o mesmo `WHERE` e os mesmos parâmetros de filtro no COUNT e na listagem;
  somente a listagem acrescenta parâmetros de `LIMIT`/`OFFSET`.
- A UI deve omitir filtros opcionais vazios. A exceção tolerada é `q` vazio ou
  composto apenas de espaços, que não aplica condição de busca.

### `GET /api/users`

Permissão: gate existente `can(user, 'manageUsers')`. Administrador com a
permissão booleana e super-admin continuam aceitos; ser apenas admin não basta.

| Parâmetro | Semântica |
| --- | --- |
| `q` | String até 200 caracteres pelo validador existente, antes do trim; substring literal em **nome OU e-mail**, sem distinção de maiúsculas via `ILIKE`. |
| `role` | Exatamente `viewer` ou `admin`. |
| `state` | Exatamente `active`, `disabled` ou `enable_pending`. |
| `job_title_id` | UUID v1–v5 pelo validador existente, inclusive representação hexadecimal maiúscula. |

Não há filtro especial de super-admin ou sem cargo. Busca escapa `%`, `_` e
barra invertida, com escape SQL explícito; o OR de nome/e-mail fica entre
parênteses antes de combinar outros filtros. Ordenação preservada:
`u.name, u.uid`.

Acrescentado **`job_title_active`** à projeção anterior: booleano quando existe
cargo vinculado, `null` sem correspondência no LEFT JOIN. Cargo inativo não
remove a conta da listagem nem muda o estado da conta.

Projeção e filtro de estado usam a mesma expressão:

```sql
CASE WHEN u.permissions->>'accountDisabled' = 'true' THEN 'disabled'
     WHEN u.firebase_enable_pending IS TRUE THEN 'enable_pending'
     ELSE 'active' END
```

Assim, JSON booleano `true` e string JSON `"true"` desativam a conta; desativação
prevalece sobre enable pendente. Chave JSON ausente/nula não exclui contas
ativas. O campo pending continua booleano.

Mantidos `BEGIN`/`COMMIT`, rollback/release e evento `user.list`. Detalhes do
evento continuam **somente `limit`, `offset`, `resultCount`**, sem filtros,
termo pesquisado, query bruta ou snapshots de identidade.

### `GET /api/job-titles`

Permissão: gate existente `manageUsers`.

| Parâmetro | Semântica |
| --- | --- |
| `q` | Mesma validação/escape de substring literal, aplicada somente ao nome do cargo. |
| `active` | Exatamente `true` ou `false`; quando presente, prevalece sobre `all`. |
| `all` | Legado, exatamente `true` ou `false`; `all=true` sem `active` inclui ativos e inativos. |

Sem `active`, ausência de `all` ou `all=false` mantém **somente ativos**.
Todos os parâmetros presentes são validados: `active=true&all=bad` não ignora
o `all` inválido. O loader legado dos formulários pode continuar usando
`all=true` sozinho.

Mantidos os campos existentes, `GROUP BY jt.id`, ordenação
`lower(jt.name), jt.id` e `COUNT(u.uid)::integer AS user_count`. O LEFT JOIN não
filtra estado, role ou permissões dos usuários: **todos os vinculados** são
contados, não apenas contas ativas.

### `GET /api/users/audit`

Permissão: `isSuperAdmin` existente, exigindo **`role='admin'` e
`permissions.superAdmin === true`**. `manageUsers` não autoriza essa consulta;
string `"true"` e flag em viewer não são bypass.

| Parâmetro | Semântica |
| --- | --- |
| `action` | String não branca de até 120 caracteres; igualdade exata com o valor recebido, sem trim, escape LIKE ou allowlist de códigos. Código desconhecido válido pode resultar em array vazio. |
| `from` | Data civil válida `YYYY-MM-DD`, anos 0001–9999; início inclusivo em São Paulo. |
| `to` | Mesma validação; limite exclusivo no início do próximo dia civil em São Paulo. |

Quando ambos estão presentes, `from <= to`. São rejeitados ano zero, rollover,
dia/mês inexistentes, anos de cinco dígitos, formato parcial, timestamp e datas
fora das regras de ano bissexto. A validação não depende de `Date` ou da coerção
JavaScript dos anos 00–99.

Limites gerados no SQL, com datas fornecidas como parâmetros:

```sql
a.created_at >= ($n::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
a.created_at < (($m::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
```

Não há corte em 23:59:59 nem soma de 24 horas ao instante. A soma acontece na
data civil antes da interpretação de timezone, inclusive para dias históricos
de mudança de horário. O PostgreSQL avaliará essas expressões sobre TIMESTAMPTZ.

Campos anteriores preservados: `id`, `actor_uid`, `action`, `target_type`,
`target_id`, `request_id`, `details`, `created_at`. Único campo adicional:
**`actor_name`**, via `LEFT JOIN users ua ON ua.uid = a.actor_uid`, contendo o
nome **atual**, possivelmente nulo. Sem e-mail, snapshot ou reconstrução de
identidade apagada. Fallback visual para sistema/ator removido fica para a UI.
Ordenação preservada: `a.created_at DESC, a.id`.

## Regressões e verificação

A suíte nova executa os módulos completos de rota em Express/Supertest reais,
por HTTP em loopback, com `parseListQuery`, helpers, política e error handler
reais. Autenticação e banco são doubles; DB/Firebase/SMTP reais não são
carregados. Chamadas indevidas a serviços de mutation falham no harness.

As respostas do banco são configuradas pelo teste. Não há emulação de SQL: os
testes conferem as consultas efetivamente emitidas, seus parâmetros, predicados,
projeções e respostas HTTP. Isso **não comprova execução PostgreSQL**, collation,
filtro de linhas real, agrupamento ou offsets UTC calculados pelo banco.

Os **38 testes novos** cobrem filtros isolados/combinados, padrões literais e
pontuação SQL, defaults, precedências, projeção mínima, limites/paginação,
UUIDs, anos/leap dates, datas civis de transição de horário, ação desconhecida,
validação HTTP de formas repetidas/aninhadas/desconhecidas, matriz de permissão,
auditoria mínima e rollback/release em falhas controladas da leitura/auditoria.

Ambiente: Windows, Node **24.15.0**, npm **11.12.1**. Comandos:

```sh
node --test tests/unit/admin-list-filters.test.mjs tests/unit/governance-routes.test.mjs tests/unit/api-routes.test.mjs tests/unit/operations-invariants.test.mjs
npm run verify
node scripts/generate-public-shell.mjs --check
git diff --check
```

| Verificação | Resultado |
| --- | --- |
| `node --test tests/unit/admin-list-filters.test.mjs` | **38 passaram**, zero falhas/cancelamentos/skips. |
| Suítes focadas | **87 passaram**, zero falhas/cancelamentos/skips. |
| `npm run verify` | Exit 0; **654 passaram**, zero falhas/cancelamentos/skips; sintaxe, scanner local de segurança, nomenclatura e Compose passaram. |
| Comparação de bytes dos handlers preservados | Passou nas quatro regiões descritas acima. |
| Gerador `--check` | Exit 0; nenhum artefato de frontend regenerado. |
| `node --check` do helper da API, harness e suíte novos | Exit 0 nos três arquivos. |
| `git diff --check` | Exit 0. |

A primeira rodada focada falhou em duas asserções de fonte que exigiam a
grafia antiga dos queries; os checks foram atualizados somente para o novo
contrato, mantendo testes de política/mutations. Logs de erro sintéticos dos
casos de rollback são esperados. Permanece o aviso preexistente
`MODULE_TYPELESS_PACKAGE_JSON` dos Cards Pós, sem mudar engines/manifests.

## Riscos e aceitação pendente

- A sessão principal deve executar os novos SQLs na sua stack local e fixtures
  de 55 usuários/105 cargos, verificando conjuntos de linhas, totais e páginas.
- Conferir no PostgreSQL contas desativadas por booleano/string JSON, pending,
  permissões sem chave, cargos ativos/inativos/nulos e contagem de todos os
  usuários vinculados; os testes deste lote verificam a intenção SQL desses casos.
- Conferir os instantes limítrofes de auditoria em São Paulo, especialmente
  início/fim de dia e transições históricas de horário, e nomes atuais/atores
  nulos. Nenhuma conexão a banco foi feita por este implementador.
- Não foi feita medição de performance de SQL real; não há migration/índice
  adicional. Frontend/Admin UI e aceitação em navegador não fazem parte do lote 4A.
- As adições usam sintaxe compatível com Node 18, mas foram executadas em Node 24;
  não se afirma suporte geral da aplicação a Node 18.
- Nenhuma nova auditoria npm foi feita neste lote sem mudanças de dependências.
  O scanner de `verify` não equivale a `npm audit`; riscos residuais do lote 2
  permanecem no relatório daquele lote.

Nenhum bloqueio de implementação identificado no escopo autorizado. Entrega
sem commit, aguardando conferência e revisão pela sessão principal.
