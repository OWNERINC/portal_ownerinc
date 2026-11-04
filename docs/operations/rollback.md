# Rollback e restauração

Este procedimento cobre o Portal sem CMS, com histórico editorial preservado,
e a produção oficial em `https://portal.ownerinc.com.br`.

## Código e imagens

O receiver versionado em `ops/deploy-from-ci.sh` troca `current-release` apenas
depois dos gates, inclusive smoke e saúde do cron ativo, para uma release extraída
do commit validado. As imagens permanecem por digest em `.image-env`. Quando o
tratamento de rollback está ativo, uma falha tenta reativar a release anterior,
se disponível, e verifica readiness e saúde do cron. O cron novo fica em
`CRON_BOOTSTRAP_ONLY=true` até passar o smoke; sua ativação posterior também é
um gate fatal. O fluxo manual `deploy.sh`/`scripts/release.sh` usa `--no-build`
ao voltar os containers para a release anterior.

Essas regras descrevem os arquivos versionados. A revisão do receiver instalado
é uma evidência operacional separada; publicar uma release não instala o receiver.

Para rollback manual, selecione uma pasta existente em `releases/`, atualize `current-release` para ela e execute o Compose dessa pasta usando o `.image-env` validado. Faça isso somente em uma janela aprovada e rode `scripts/smoke.sh` em seguida.

## Dados

Rollback de código, por si só, não reverte banco nem uploads. O fluxo manual cria
o backup pré-release em `shared/backups`; o receiver de produção usa
`/opt/ownerinc/backups/portal-ownerinc/production`. O receiver pausa Nginx, API e
cron antes de copiar PostgreSQL e uploads e validar `manifest.sha256`.

### Falha antes da abertura do tráfego público

O receiver pode restaurar automaticamente **o banco** se `migration_started=true`,
`backup_complete=true` e `public_started!=true`. O backup precisa estar completo
e com checksums validados. Sem migration iniciada, não há restauração automática
do banco. Se a restauração falhar, os serviços permanecem parados para intervenção.
Essa recuperação não restaura automaticamente uploads.

### Falha depois da abertura do tráfego público

Após iniciar o Nginx, o receiver marca `public_started=true`, antes do readiness
público e do smoke. A partir desse marco, **não restaura o banco automaticamente**,
mesmo se readiness, smoke ou ativação do cron falharem, para preservar possíveis
escritas recebidas pela nova release. O rollback tenta recuperar o código anterior;
a compatibilidade dele com o banco resultante precisa ser avaliada pelo operador.

### Restauração manual

A restauração manual de PostgreSQL e uploads é destrutiva. Exige janela aprovada,
backup previamente validado em ambiente não produtivo e confirmação literal.
O script valida os hashes e cria um backup pré-restauração antes de modificar dados:

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

## Limite de readiness

`GET /api/ready` verifica apenas conectividade com PostgreSQL por `SELECT 1` e
retorna `503` genérico quando essa consulta falha. Não verifica o ledger nem a
estrutura do schema e não substitui `api/db/verify-migrations.js`, smoke ou a
conclusão do deploy com cron saudável. Readiness verde também não comprova login,
perfil ou upload autenticados.

## Registro

Registre revisão anterior/nova, backup usado, motivo, horários, marco
`public_started` e resultados da verificação de migrations, smoke, cron,
`/api/health` e `/api/ready`. Registre login, perfil e upload somente quando
efetivamente exercitados; caso contrário, mantenha-os pendentes. Se uma migração
não for compatível com a versão anterior, restaure dados apenas conforme o plano
específico da migração.
