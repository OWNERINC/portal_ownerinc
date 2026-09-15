# Deployment

## Pré-requisitos

- VPS Linux com Docker, plugin Docker Compose, `curl`, `gzip`, `git`, SSH e espaço persistente para backups.
- Proxy TLS publicando o Nginx em `127.0.0.1:${HTTP_PORT:-80}`. Para outro desenho, configure `BIND_ADDRESS` explicitamente.
- `/opt/ownerinc-portal/shared/.env` criado diretamente na VPS com modo `0600`.
- Login da VPS no GHCR com permissão somente de leitura dos packages privados.
- Node.js 24 para verificações locais e CI. Os serviços executam em containers.

## Configuração

O Compose entrega a cada serviço somente suas variáveis necessárias. Use `.env.example` como referência, mas nunca envie o `.env` ao Git. Senhas usadas dentro das URLs PostgreSQL devem estar em formato URL-encoded. `CORS_ORIGINS` só deve listar origens adicionais deliberadas; o acesso normal é pelo mesmo domínio do Nginx.

O envio de email usa o Resend por SMTP. A chave de API da Resend deve ser
armazenada somente em `/opt/ownerinc-portal/shared/.env`, como o valor de
`SMTP_PASSWORD`; nunca a versione ou envie ao GitHub. O endereço definido em
`MAILER_SENDER_EMAIL` precisa estar verificado no Resend.

`PORTAL_PUBLIC_URL` define o domínio do ambiente usado no link de confirmação de
e-mail; produção usa `https://portal.ownerinc.com.br` e staging deve informar seu
próprio domínio.

O banco usa três credenciais distintas:

- `MIGRATION_DATABASE_URL`: usuário administrador definido por `POSTGRES_USER`, usado somente pelo container one-shot `migrate`.
- `API_DATABASE_URL`: role fixa `portal_api`, sem DDL, usada pela API em execução.
- `CRON_DATABASE_URL`: role fixa `portal_cron`, limitada a leitura de `users`/`reminders`, leitura/escrita de `notifications_log`/`cron_status`, leitura de `autocard_cards`, leitura/exclusão de `autocard_media` e leitura/escrita de `audit_log` para a retenção do AutoCard.

Para alertas operacionais por SMTP, defina `OPERATIONAL_ALERT_EMAIL` e repita
as variáveis SMTP no ambiente do cron. Sem esse destinatário, o worker mantém
healthchecks e logs, mas não tenta enviar alertas. O estado de alerta é
deduplicado em `cron_status` e uma recuperação envia somente uma notificação de
retorno ao normal.

Defina também `PORTAL_API_DB_PASSWORD` e `PORTAL_CRON_DB_PASSWORD` com pelo menos 16 caracteres. O serviço `migrate` cria ou rotaciona essas duas roles, executa migrations sob advisory lock e reaplica os grants antes da API iniciar. `MIGRATION_ONLY=true` faz o container falhar se `RUN_MIGRATIONS=true` não estiver ativo e impede que um comando vazio seja confundido com uma migration bem-sucedida. As credenciais administrativas não entram no container de API em execução. Para reaplicar roles e grants manualmente, sobrescreva o modo one-shot: `docker compose run --rm --no-deps -e RUN_MIGRATIONS=false -e MIGRATION_ONLY=false migrate node db/provision.js`.

Defina `IMAGE_REGISTRY=ghcr.io/ownerinc`. O CI publica API e cron com a tag do commit, registra os digests e os transporta no archive de release. A VPS aceita somente os dois digests em `.image-env` e inicia o Compose com referências `@sha256`; ela não resolve tags mutáveis durante o deploy.

Configure localmente `VPS_USER`, `VPS_HOST`, `API_IMAGE`, `CRON_IMAGE` e, se necessário, `VPS_PATH` e `SSH_PORT`. `API_IMAGE` e `CRON_IMAGE` devem ser referências completas `@sha256` produzidas pelo CI. O `deploy.sh` recusa alterações rastreadas não commitadas e publica apenas um `git archive` do `HEAD` com o manifesto de imagens; `ownerinc-novo-agente/` é excluído explicitamente.

## Fluxo de release

1. Execute `npm run verify` e `npm run security`.
2. Exporte os dois digests aprovados pelo CI e execute `bash deploy.sh` somente após revisar host e revisão.
3. O servidor cria `releases/<commit>-<timestamp>`, valida o manifesto recebido e baixa somente as imagens por digest.
4. Antes de trocar uma release existente, `scripts/backup.sh` interrompe ingress e cron, salva PostgreSQL e uploads de forma consistente em `shared/backups`, reinicia os serviços e aplica retenção de 14 dias.
5. O serviço one-shot `migrate` aplica schema/grants e registra quantas migrations foram aplicadas; `api/db/verify-migrations.js` confirma o ledger e a estrutura crítica, incluindo `011_cron_alert_state` e `012_autocard_media_crop`, os privilégios mínimos do cron e o contrato não nulo do crop, antes dos smoke tests.
6. Se prontidão ou smoke falhar, os containers voltam à release/imagens anteriores quando elas existem. Dados não sofrem rollback automático.

`GET /api/health` é somente liveness. `GET /api/ready` executa `SELECT 1`, retorna `503` genérico quando o banco não responde e é usado por Compose, cron e smoke.

## Primeiro super-admin

Depois que as migrações terminarem, obtenha o UID, email e nome de uma conta já existente no Firebase Auth e execute uma única vez:

```sh
docker compose --profile tools run --rm bootstrap-admin node db/bootstrap-admin.js 'FIREBASE_UID' 'admin@empresa.com' 'Nome Completo'
```

O comando confirma no Firebase que UID/email existem, estão ativos e com email verificado; depois usa `MIGRATION_DATABASE_URL`, serializa execuções concorrentes, cria ou promove o usuário e registra a ação. Ele recusa sem alterações se já houver qualquer `superAdmin` ativo.

## Backup manual

Com o Compose ativo na raiz da release:

```sh
COMPOSE_PROJECT_NAME=ownerinc-portal-prod \
COMPOSE_OVERRIDE=/opt/ownerinc/apps/portal-ownerinc-real/runtime/compose.production.yaml \
COMPOSE_ENV_FILE=/opt/ownerinc/secrets/portal-ownerinc/production.runtime.conf \
BACKUP_DIR=/opt/ownerinc-portal/shared/backups RETENTION_DAYS=14 bash scripts/backup.sh "$PWD"
```

Cada diretório UTC contém `postgres.dump`, `uploads.tar.gz` e hashes SHA-256. Copie backups periodicamente para outro host e teste restaurações fora de produção.

Para enviar a cópia verificada a um bucket S3-compatible, configure `S3_BUCKET`,
`S3_PREFIX`, `AWS_ENDPOINT_URL` quando necessário e execute com
`BACKUP_UPLOAD_S3=true`. O host precisa ter o AWS CLI configurado por role ou
credencial protegida:

```sh
BACKUP_DIR=/opt/ownerinc-portal/shared/backups \
BACKUP_UPLOAD_S3=true S3_BUCKET=ownerinc-portal-backups \
bash scripts/backup.sh "$PWD"
```

O script preserva o artefato local quando a transferência externa falha. Meta
operacional inicial: backup diário e antes de release, RPO máximo de 24 horas e
RTO de 4 horas. Agende `scripts/backup.sh` no host, monitore falhas e execute
uma restauração trimestral em ambiente descartável.

## Validação

- `docker compose ps` mostra PostgreSQL e API saudáveis.
- `GET /api/health` retorna `{"status":"ok"}` e `GET /api/ready` retorna `{"status":"ready"}` pelo domínio publicado.
- PostgreSQL e API não possuem portas publicadas; Nginx fica em loopback por padrão.
- Login, perfil e upload funcionam, e logs não expõem chaves ou dados pessoais.

O CI usa Node 24, testa migrations em PostgreSQL real, executa invariantes/sintaxe/Compose, constrói e escaneia as imagens com Trivy, rejeita vulnerabilidades `high` ou `critical`, publica SBOMs SPDX e envia imagens imutáveis ao GHCR em pushes na `main`.
`npm run test:migrations` exige `MIGRATION_TEST_DISPOSABLE=true` e não pode ser
executado com `NODE_ENV=production`; ele modifica um banco de teste durante a
validação de migrations históricas.

O receptor de produção passa `--profile notifications` em todos os comandos
Compose compartilhados, incluindo `up`, migrations one-shot e rollback, para
que o cron de notificações permaneça habilitado. As mutações de cards AutoCard
e a limpeza de órfãos compartilham o advisory lock `7193003`.

## Deploy automático da `main`

Depois que o job `validate` termina verde em um push para `main`, o job
`deploy-staging` empacota exatamente o commit validado e o envia ao receptor
SSH exclusivo de staging. O ambiente GitHub `staging` deve exigir a aprovação
operacional correspondente e o receptor deve executar backup, migration,
readiness, smoke e rollback antes de retornar sucesso. Só então o job
`deploy-production` fica elegível; o ambiente GitHub `production` deve manter
uma aprovação separada.

Os receptores de staging e produção são separados. Cada chave usa `restrict` e
`command=` no `authorized_keys`, não abre shell, não encaminha portas e aceita
somente o alvo explícito (`staging:` ou `production:`) com SHA de 40 caracteres
acompanhado pelo archive da release. Staging
usa os secrets `PORTAL_STAGING_VPS_HOST`, `PORTAL_STAGING_VPS_PORT`,
`PORTAL_STAGING_VPS_USER`, `PORTAL_STAGING_VPS_SSH_KEY` e
`PORTAL_STAGING_VPS_KNOWN_HOSTS`; produção usa os equivalentes
`PORTAL_VPS_*`. O receptor de staging não pode apontar para o root, volumes,
domínio ou banco de produção.

O entrypoint versionado da chave de staging é `ops/deploy-from-staging-ci.sh`,
instalado como `/usr/local/libexec/ownerinc-portal-deploy-staging`; ele aceita
somente comandos `staging:<sha>` e delega ao receptor comum, instalado como
`/usr/local/libexec/ownerinc-portal-deploy`, com a configuração
privada `/etc/ownerinc/portal-staging-deploy.conf`. Essa configuração não é
versionada e deve ter modo `0600`:

```sh
DEPLOY_ROOT=/opt/ownerinc/apps/portal-ownerinc-staging
DEPLOY_RUNTIME=/opt/ownerinc/apps/portal-ownerinc-staging/runtime
DEPLOY_RELEASES=/opt/ownerinc/apps/portal-ownerinc-staging/releases
DEPLOY_CURRENT_FILE=/opt/ownerinc/apps/portal-ownerinc-staging/current-release
DEPLOY_ENVIRONMENT=/opt/ownerinc/secrets/portal-ownerinc/staging.runtime.conf
DEPLOY_BACKUP_ROOT=/opt/ownerinc/backups/portal-ownerinc/staging
DEPLOY_COMPOSE_OVERRIDE=/opt/ownerinc/apps/portal-ownerinc-staging/runtime/compose.staging.yaml
DEPLOY_PROJECT=ownerinc-portal-staging
DEPLOY_PUBLIC_URL=https://staging.portal.ownerinc.com.br
```

O arquivo `DEPLOY_ENVIRONMENT` também precisa conter
`PORTAL_PUBLIC_URL` com exatamente o mesmo domínio/URL do
`DEPLOY_PUBLIC_URL`; o receptor recusa staging quando esse valor está ausente
ou aponta para produção.

No `authorized_keys` de staging, use `restrict` e force o entrypoint acima:

```text
restrict,command="/usr/local/libexec/ownerinc-portal-deploy-staging" ssh-ed25519 AAAA... ci-staging
```

O entrypoint da chave de produção é `ops/deploy-from-production-ci.sh`,
instalado como `/usr/local/libexec/ownerinc-portal-deploy-production`; ele
aponta para o receptor comum e aceita somente `production:<sha>`. Os três
binários devem ser root-owned, modo `0755`, instalados a partir dos arquivos
versionados correspondentes. O arquivo de
configuração de staging deve usar nomes de projeto, volumes, containers e
backup distintos dos valores de produção; o receptor rejeita qualquer alvo
que não seja `production` ou `staging`.

O receptor serializa deploys com `flock`, confere SHA e conteúdo do archive,
resolve API e cron por digest imutável no GHCR e cria backup verificado de
PostgreSQL e uploads antes de interromper a release anterior. Em seguida aplica
migrations, sobe a nova release e valida HTTPS, readiness, conteúdo montado e
digest da API. Falha em qualquer gate restaura o banco quando necessário e
reativa a release anterior. O arquivo `current-release` só muda depois de todos
os gates aprovados.

Nenhum segredo de runtime, Firebase, SMTP ou banco é enviado ao GitHub: eles
continuam somente nos arquivos protegidos de cada VPS.
