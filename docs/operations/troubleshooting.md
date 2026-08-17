# Troubleshooting

## API indisponível

Verifique `docker compose ps`, os logs de `api` e a saúde do PostgreSQL. Teste
`/api/health` para o processo e `/api/ready` para banco/migrações. Confirme que
`MIGRATION_DATABASE_URL` e `API_DATABASE_URL` usam o hostname `postgres` dentro
do Compose e que as senhas coincidem com `POSTGRES_PASSWORD` e
`PORTAL_API_DB_PASSWORD`.

Se o log indicar falha em grants ou criação de roles, a credencial de
`MIGRATION_DATABASE_URL` precisa ser a role administradora `POSTGRES_USER`.
Reaplique com `docker compose run --rm api node db/provision.js` somente depois
que as tabelas já existirem.

## Token inválido

Confirme se frontend e Firebase Admin usam o mesmo projeto e se a chave privada
preserva as quebras de linha representadas por `\n` no `.env`.

## Emails não enviados

Convites, redefinições da API e lembretes usam o Resend por SMTP. Verifique o
log da API pelo `requestId` e confirme no ambiente do Compose `SMTP_ADDRESS`
(`smtp.resend.com`), `SMTP_PORT` (`465`), `SMTP_USERNAME` (`resend`),
`SMTP_PASSWORD` (a chave de API da Resend) e `MAILER_SENDER_EMAIL`. O remetente
precisa estar verificado no Resend. Para lembretes, confira também o horário e
o fuso do container cron, `OPERATIONAL_ALERT_EMAIL` e `notifications_log`.

## Upload não aparece

Confirme a existência do volume `uploads_data`, os logs da API e o proxy de
`/uploads/` no Nginx.

## Release falhou no smoke

Consulte a saída JSON de `scripts/smoke.sh`, `docker compose ps` e os logs de
Nginx/API. O deploy tenta reativar a release anterior sem reconstruí-la; confirme
o destino de `current` e não restaure dados automaticamente.

## Backup falhou

Confirme espaço e permissões em `BACKUP_DIR`, saúde de PostgreSQL/API e presença
de `pg_dump`, `tar` e `sha256sum` nos containers/host. Diretórios incompletos são
removidos pelo script; um backup só é válido com `manifest.sha256` verificado.
