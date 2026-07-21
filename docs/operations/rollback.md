# Rollback e restauração

## Código e imagens

O deploy troca o symlink `current` apenas para releases extraídas de commits e mantém imagens etiquetadas pelo identificador da release. Falhas no `docker compose up`, readiness ou smoke acionam automaticamente a release anterior com `--no-build`, quando disponível.

Para rollback manual, selecione uma pasta existente em `releases/`, aponte `current` para ela e execute o Compose dessa pasta com `RELEASE_TAG` igual ao nome da release. Faça isso somente em uma janela aprovada e rode `scripts/smoke.sh` em seguida.

## Dados

Rollback de código não reverte banco nem uploads. Antes de cada deploy sobre uma instalação existente, o fluxo cria um backup em `shared/backups`.

A restauração é destrutiva, valida os hashes, cria um backup pré-restauração e exige confirmação literal:

```sh
PROJECT_ROOT=/opt/ownerinc-portal/current \
PRE_RESTORE_BACKUP_DIR=/opt/ownerinc-portal/shared/backups/pre-restore \
bash scripts/restore.sh /opt/ownerinc-portal/shared/backups/AAAAmmddTHHMMSSZ --confirm RESTORE
```

O script interrompe API e cron, restaura PostgreSQL e uploads, reinicia o stack e exige smoke bem-sucedido. Não o execute sem validar o backup em ambiente não produtivo e sem janela aprovada.

## Registro

Registre revisão anterior/nova, backup usado, motivo, horários e resultado de `/api/health`, `/api/ready`, login, perfil e upload. Se uma migração não for compatível com a versão anterior, restaure dados apenas conforme o plano específico da migração.
