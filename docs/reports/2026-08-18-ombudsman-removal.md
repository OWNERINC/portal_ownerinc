# Ombudsman Removal

Data: 18 de agosto de 2026
Branch: `remove-ombudsman`

## Status

Concluído sem deploy. O setor interno de Ombudsman/Ouvidoria foi removido do
runtime, frontend, permissões, retenção, configuração, schema fresco e grants.
O `audit_log` e a retenção de notificações continuam intactos.

Migration `016_remove_ombudsman`:

- remove a permissão persistida `viewOmbudsman` dos usuários;
- remove o índice legado com `DROP INDEX IF EXISTS`;
- remove a tabela e dependências com `DROP TABLE IF EXISTS ombudsman CASCADE`;
- pode ser executada novamente sem falhar.

As migrations históricas `001_initial_schema` e `003_governance` não foram
alteradas. A expectativa do ledger, a verificação de migrations e os testes de
integração agora incluem `016_remove_ombudsman`.

## Verification

- `scripts/test-migrations.mjs`: depois das migrations normais, recria uma tabela
  e um índice legados mínimos, cria um usuário fixture com JSONB contendo
  `viewOmbudsman: true` e outra permissão, executa o texto exato da migration duas
  vezes em transações separadas no mesmo client PostgreSQL e confirma a remoção
  dos objetos e somente da permissão legada. O `finally` remove apenas os
  fixtures e objetos criados pelo teste.
- `tests/unit/ombudsman-removal.test.mjs`: agora verifica toda a superfície atual
  rastreada de HTML, JavaScript, CSS, SQL, Nginx, scripts, Dockerfiles,
  workflows/configuração e documentação corrente de produto, arquitetura e
  operações. Migrations históricas 001/003, a migration de remoção, o release
  gate, testes/relatório intencionais, auditorias, relatórios e planos históricos
  datados ficam fora por serem evidência histórica ou verificações da remoção.
- `npm run verify`: passou, 141 testes.
- `npm test`: passou, 141 testes.
- `git diff --check`: passou.
- `npm run test:migrations`: bloqueado neste ambiente porque o host PostgreSQL
  configurado como `postgres` não pôde ser resolvido (`ENOTFOUND`).
- Node `24.x` é uma restrição preexistente do repositório (`package.json`), não
  introduzida por esta alteração.

## Remaining References

O scan final não encontrou referências em `public/` nem nos módulos ativos da
API, exceto nas verificações que afirmam a ausência do recurso. Permanecem
somente referências intencionais:

- `api/db/migrations/001_initial_schema.sql` e `003_governance.sql`: histórico
  aplicado, preservado por requisito.
- `api/db/migrations/016_remove_ombudsman.sql`, `api/db/verify-migrations.js`,
  `scripts/test-migrations.mjs` e invariantes unitárias: identificam a remoção,
  sua destruição e a ausência esperada.
- Relatórios/auditorias datados de 20 de julho de 2026 e planos históricos em
  `docs/reports/`, `docs/reviews/`, `docs/design/` e
  `docs/superpowers/plans/`: preservam evidência do estado anterior e não são
  inventário ou contrato atual do produto.

Nenhuma referência histórica foi usada para manter uma rota, página, grant,
permissão, retenção ou claim de produto ativo.
