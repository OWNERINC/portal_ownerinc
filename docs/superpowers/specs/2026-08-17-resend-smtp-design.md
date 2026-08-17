# Migração de email para SMTP do Resend

## Objetivo

Usar o SMTP do Resend como transporte único para todos os emails transacionais
do Portal: convites, redefinições de senha, lembretes e alertas operacionais.

## Arquitetura

API e cron usarão Nodemailer com a mesma configuração SMTP entregue pelo
Compose. O Resend será acessado por `smtp.resend.com`, com usuário `resend`,
senha definida pela API key do Resend e TLS explícito. A porta padrão será 465,
com conexão TLS desde o início.

As mensagens da API continuarão em
`api/integrations/password-reset-email.js`. O cron terá um helper SMTP pequeno
e compartilhado pelos lembretes e alertas operacionais, substituindo o uso
direto de `@sendgrid/mail`.

## Configuração e segurança

As variáveis usadas pelos dois serviços serão:

- `SMTP_ADDRESS=smtp.resend.com`;
- `SMTP_PORT=465`;
- `SMTP_USERNAME=resend`;
- `SMTP_PASSWORD`: API key secreta do Resend;
- `MAILER_SENDER_EMAIL`: remetente validado no Resend.

O valor de `SMTP_PASSWORD` continuará somente no `.env` protegido da VPS e
nunca será incluído no repositório, nos logs ou nos artefatos do CI. O Resend
precisa ter o remetente/domínio validado antes do teste de entrega.

As variáveis específicas do SendGrid e a dependência HTTP correspondente serão
removidas do fluxo do Portal, evitando que API e cron usem transportes
diferentes.

## Fluxo e erros

1. A API cria a identidade Firebase e a linha transacional como hoje.
2. O mailer SMTP envia o convite ou a redefinição.
3. Somente após o envio bem-sucedido a API habilita a identidade e confirma a
   transação; falhas continuam acionando rollback e compensação do Firebase.
4. O cron registra falhas conforme seu fluxo atual, sem expor senha SMTP ou
   conteúdo sensível nos logs.

Não haverá fallback automático entre provedores: isso evita envio duplicado
quando o servidor SMTP aceita a mensagem e a resposta se perde.

## Validação

- Testes unitários cobrirão host, porta, TLS, usuário Resend, remetente e
  ausência de credenciais em mensagens/logs.
- Testes confirmarão que API e cron não importam mais `@sendgrid/mail`.
- `npm run verify` será executado antes do commit.
- Após o deploy, será validada a saúde pública do Portal e será feito um teste
  real de convite para Gmail e Microsoft 365 usando um remetente verificado.
