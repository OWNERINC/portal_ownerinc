# Fronteiras

## Público

Somente o Nginx deve receber tráfego externo. Ele publica arquivos estáticos,
`/api/` e as imagens de perfil em `/uploads/`.

## Privado

PostgreSQL não possui porta publicada no Compose. API e cron acessam o banco
pela rede interna dos containers.

## Autenticação e autorização

O navegador obtém um token do Firebase. A API valida esse token, carrega o
usuário local e aplica permissões armazenadas no PostgreSQL. Ocultar controles
no frontend não substitui uma checagem de autorização na API.

## Dados e segredos

- `.env`, chaves Firebase e tokens nunca entram no Git.
- Uploads e o volume PostgreSQL são estado operacional, não código-fonte.
- Dados de perfil exigem acesso mínimo.
