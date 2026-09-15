# Rollback e restauração

## Código e imagens

O deploy automático troca `current-release` apenas para releases extraídas de commits e mantém as imagens por digest em `.image-env`. Falhas durante backup, migration, readiness ou smoke acionam automaticamente a release anterior com `--no-build`, quando disponível; o cron só é reativado depois que a nova release já passou pelos gates reversíveis.

Para rollback manual, selecione uma pasta existente em `releases/`, atualize `current-release` para ela e execute o Compose dessa pasta usando o `.image-env` validado. Faça isso somente em uma janela aprovada e rode `scripts/smoke.sh` em seguida.

## Dados

Rollback de código não reverte banco nem uploads. Antes de cada deploy sobre uma instalação existente, o fluxo cria um backup em `shared/backups`.

A restauração é destrutiva, valida os hashes, cria um backup pré-restauração e exige confirmação literal:

```sh
CURRENT_RELEASE=$(cat /opt/ownerinc/apps/portal-ownerinc-real/current-release)
PROJECT_ROOT="$CURRENT_RELEASE" \
COMPOSE_PROJECT_NAME=ownerinc-portal-prod \
COMPOSE_OVERRIDE=/opt/ownerinc/apps/portal-ownerinc-real/runtime/compose.production.yaml \
COMPOSE_ENV_FILE=/opt/ownerinc/secrets/portal-ownerinc/production.runtime.conf \
RESTORE_BASE_URL=https://portal.ownerinc.com.br \
PRE_RESTORE_BACKUP_DIR=/opt/ownerinc/backups/portal-ownerinc/production/pre-restore \
bash scripts/restore.sh /opt/ownerinc/backups/portal-ownerinc/production/AAAAmmddTHHMMSSZ --confirm RESTORE
```

O script interrompe API e cron, restaura PostgreSQL e uploads, reinicia o stack e exige smoke bem-sucedido. Não o execute sem validar o backup em ambiente não produtivo e sem janela aprovada.

## Registro

Registre revisão anterior/nova, backup usado, motivo, horários e resultado de `/api/health`, `/api/ready`, login, perfil e upload. Se uma migração não for compatível com a versão anterior, restaure dados apenas conforme o plano específico da migração.
