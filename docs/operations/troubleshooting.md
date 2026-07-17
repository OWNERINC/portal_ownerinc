# Troubleshooting

## API indisponível

Verifique `docker compose ps`, os logs de `api` e a saúde do PostgreSQL. Confirme
que `DATABASE_URL` usa o hostname `postgres` dentro do Compose.

## Token inválido

Confirme se frontend e Firebase Admin usam o mesmo projeto e se a chave privada
preserva as quebras de linha representadas por `\n` no `.env`.

## Emails não enviados

Verifique `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, horário e fuso do container
cron. Consulte também `notifications_log` antes de repetir um envio manual.

## Upload não aparece

Confirme a existência do volume `uploads_data`, os logs da API e o proxy de
`/uploads/` no Nginx.
