# Fluxo de Dados

## Requisição autenticada

1. O usuário autentica no Firebase pelo frontend.
2. `public/js/auth.js` inclui o token Bearer na requisição.
3. A API valida o token pelo Firebase Admin.
4. A API cria ou carrega o perfil correspondente no PostgreSQL.
5. A rota aplica a permissão necessária e consulta ou altera o banco.

## Lembretes

1. O cron executa diariamente às 08:00 no fuso de São Paulo.
2. O serviço seleciona lembretes ativos para o dia corrente.
3. Os destinatários são resolvidos a partir dos usuários no PostgreSQL.
4. O SendGrid envia o email.
5. O resultado é registrado em `notifications_log`.

## Uploads

1. O usuário autenticado envia uma imagem para `/api/upload/photo`.
2. A API grava o arquivo no volume `uploads_data`.
3. A URL relativa é armazenada no perfil.
4. O Nginx encaminha `/uploads/` para a API.
