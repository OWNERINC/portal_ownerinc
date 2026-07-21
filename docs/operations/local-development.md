# Desenvolvimento Local

## Stack completa

1. Crie `.env` a partir de `.env.example` e preencha credenciais de desenvolvimento.
2. Use `NODE_ENV=development` e `FIREBASE_AUTH_EMULATOR_HOST=firebase-auth:9099`; as credenciais Firebase Admin podem ficar vazias nesse modo.
3. Execute `docker compose --profile local up -d --build`.
4. Crie o primeiro administrador local:

```sh
docker compose --profile local --profile admin run --rm bootstrap-admin node db/create-local-admin.js admin@ownerinc.local 'SENHA_COM_8_OU_MAIS_CARACTERES' 'Admin Local'
```

5. Acesse o Portal em `http://localhost:8080` e, se necessário, o Emulator UI em `http://localhost:4000`.
6. Consulte os logs com `docker compose --profile local logs -f`.
7. Encerre com `docker compose --profile local down`.

Não use `docker compose down -v` se precisar preservar o banco e os uploads.
O perfil `local` publica o Auth Emulator apenas no loopback da máquina e não usa o projeto Firebase real.

## Integração Sólides

A integração permanece oculta por padrão com `SOLIDES_RELEASE_STAGE=off`. Para
homologação interna, configure o token somente no `.env` ignorado e use:

```text
SOLIDES_RELEASE_STAGE=internal
SOLIDES_TOKEN=<token de integração>
SOLIDES_EMPLOYER_BASE_URL=https://employer.tangerino.com.br/
SOLIDES_PUNCH_BASE_URL=https://apis.tangerino.com.br/punch/
```

Recrie a API e use a tab Sólides no painel administrativo. O botão **Testar
conexão** executa apenas GETs e não exibe o conteúdo pessoal retornado. Para o
probe por terminal, defina também `SOLIDES_TEST_EMPLOYEE_ID` e execute
`npm run solides:probe`. Nunca registre ou compartilhe o token em logs, issues ou
mensagens.

Para encerrar a homologação, volte o estágio para `off` e recrie a API. Os
vínculos permanecem armazenados, mas todas as rotas de produto voltam a 404.

## Serviços Node isolados

A API e o cron podem ser executados em seus diretórios com `npm install` e
`npm start`. Use `API_DATABASE_URL` como `DATABASE_URL` da API,
`CRON_DATABASE_URL` como `DATABASE_URL` do cron e execute `npm run db:migrate`
na raiz com `MIGRATION_DATABASE_URL` e as duas senhas de roles definidas.

## Verificação

Execute `npm run verify`. O comando não inicia containers nem altera
dados.
