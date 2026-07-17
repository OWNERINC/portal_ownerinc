# Deployment

## Pré-requisitos

- VPS com Docker e plugin Docker Compose.
- DNS e proxy configurados para publicar somente o Nginx.
- `.env` criado diretamente na VPS com permissões restritas.
- Backup válido do volume PostgreSQL e dos uploads.

## Processo

O `deploy.sh` usa `rsync` e SSH, mas contém valores de exemplo. Ajuste
`VPS_USER`, `VPS_HOST` e `VPS_PATH` somente como parte de uma tarefa explícita
de deploy. Antes de executar, rode `npm run verify` e valide o destino.

Após o deploy, confirme:

- `GET /api/health` retorna `{"status":"ok"}`.
- Login e carregamento do perfil funcionam.
- PostgreSQL e API não estão publicados diretamente.
- Logs não contêm chaves ou dados pessoais desnecessários.
