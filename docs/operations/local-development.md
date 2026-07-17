# Desenvolvimento Local

## Stack completa

1. Crie `.env` a partir de `.env.example` e preencha credenciais de desenvolvimento.
2. Execute `docker compose up --build`.
3. Acesse `http://localhost`.
4. Consulte os logs com `docker compose logs -f`.
5. Encerre com `docker compose down`.

Não use `docker compose down -v` se precisar preservar o banco e os uploads.

## Serviços Node isolados

A API e o cron podem ser executados em seus diretórios com `npm install` e
`npm start`, desde que `DATABASE_URL` e as credenciais externas apontem para
serviços acessíveis pelo host.

## Verificação

Execute `npm run verify`. O comando não inicia containers nem altera
dados.
