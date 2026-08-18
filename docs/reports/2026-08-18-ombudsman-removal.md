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

- `npm run verify`: passou, 141 testes.
- `npm test`: passou, 141 testes.
- `git diff --check`: passou.
- `npm run test:migrations`: bloqueado neste ambiente porque o host PostgreSQL
  configurado como `postgres` não pôde ser resolvido (`ENOTFOUND`).

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
