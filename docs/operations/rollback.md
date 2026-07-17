# Rollback

## Código

Mantenha a versão anterior das imagens ou do checkout disponível na VPS. Em
caso de falha, restaure essa versão e execute `docker compose up -d --build`.

## Dados

Não reverta schema ou volume automaticamente junto com o código. Se uma mudança
alterar dados, documente antes dela o backup, a compatibilidade com a versão
anterior e o procedimento de restauração.

## Validação

Depois do rollback, verifique `/api/health`, login, perfil e leitura das áreas
principais. Registre o motivo e o estado final no handoff da sessão.
