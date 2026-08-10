# Deployment

## Pré-requisitos

- VPS Linux com Docker, plugin Docker Compose, `curl`, `gzip`, `git`, SSH e espaço persistente para backups.
- Proxy TLS publicando o Nginx em `127.0.0.1:${HTTP_PORT:-80}`. Para outro desenho, configure `BIND_ADDRESS` explicitamente.
- `/opt/ownerinc-portal/shared/.env` criado diretamente na VPS com modo `0600`.
- Login da VPS no GHCR com permissão somente de leitura dos packages privados.
- Node.js 24 para verificações locais e CI. Os serviços executam em containers.

## Configuração

O Compose entrega a cada serviço somente suas variáveis necessárias. Use `.env.example` como referência, mas nunca envie o `.env` ao Git. Senhas usadas dentro das URLs PostgreSQL devem estar em formato URL-encoded. `CORS_ORIGINS` só deve listar origens adicionais deliberadas; o acesso normal é pelo mesmo domínio do Nginx.

O banco usa três credenciais distintas:

- `MIGRATION_DATABASE_URL`: usuário administrador definido por `POSTGRES_USER`, usado somente pelo container one-shot `migrate`.
- `API_DATABASE_URL`: role fixa `portal_api`, sem DDL, usada pela API em execução.
- `CRON_DATABASE_URL`: role fixa `portal_cron`, limitada a leitura de `users`/`reminders` e leitura/escrita de `notifications_log`/`cron_status`.

Para alertas operacionais por SMTP, defina `OPERATIONAL_ALERT_EMAIL` e repita
as variáveis SMTP no ambiente do cron. Sem esse destinatário, o worker mantém
healthchecks e logs, mas não tenta enviar alertas. O estado de alerta é
deduplicado em `cron_status` e uma recuperação envia somente uma notificação de
retorno ao normal.

Defina também `PORTAL_API_DB_PASSWORD` e `PORTAL_CRON_DB_PASSWORD` com pelo menos 16 caracteres. O serviço `migrate` cria ou rotaciona essas duas roles, executa migrations sob advisory lock e reaplica os grants antes da API iniciar. As credenciais administrativas não entram no container de API em execução. Para reaplicar roles e grants manualmente, execute `docker compose run --rm migrate node db/provision.js`.

Defina `IMAGE_REGISTRY=ghcr.io/ownerinc`. O CI publica API e cron com a tag do commit. A VPS resolve a tag para digest, grava os dois digests em `.image-env` e inicia o Compose com referências `@sha256`, impedindo alteração posterior da tag.

Configure localmente `VPS_USER`, `VPS_HOST` e, se necessário, `VPS_PATH` e `SSH_PORT`. O `deploy.sh` recusa alterações rastreadas não commitadas e publica apenas um `git archive` do `HEAD`; `ownerinc-novo-agente/` é excluído explicitamente.

## Fluxo de release

1. Execute `npm run verify` e `npm run security`.
2. Execute `bash deploy.sh` somente após revisar host e revisão.
3. O servidor cria `releases/<commit>-<timestamp>`, resolve as imagens publicadas pelo CI e registra seus digests.
4. Antes de trocar uma release existente, `scripts/backup.sh` interrompe ingress e cron, salva PostgreSQL e uploads de forma consistente em `shared/backups`, reinicia os serviços e aplica retenção de 14 dias.
5. O serviço one-shot `migrate` aplica schema/grants; `api/db/verify-migrations.js` confirma o ledger e a estrutura crítica, incluindo `011_cron_alert_state`, antes dos smoke tests.
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

## Deploy automático da `main`

Depois que o job `validate` termina verde em um push para `main`, o job
`deploy-production` empacota exatamente o commit validado e o envia à VPS por
uma chave SSH exclusiva. Essa chave usa `restrict` e `command=` no
`authorized_keys`: não abre shell, não encaminha portas e só pode executar o
receptor de release do Portal Interno.

O receptor serializa deploys com `flock`, confere SHA e conteúdo do archive,
resolve API e cron por digest imutável no GHCR e cria backup verificado de
PostgreSQL e uploads antes de interromper a release anterior. Em seguida aplica
migrations, sobe a nova release e valida HTTPS, readiness, conteúdo montado e
digest da API. Falha em qualquer gate restaura o banco quando necessário e
reativa a release anterior. O arquivo `current-release` só muda depois de todos
os gates aprovados.

Os secrets exigidos no GitHub são `PORTAL_VPS_HOST`, `PORTAL_VPS_PORT`,
`PORTAL_VPS_USER`, `PORTAL_VPS_SSH_KEY` e `PORTAL_VPS_KNOWN_HOSTS`. Nenhum
segredo de runtime, Firebase, SMTP ou banco é enviado ao GitHub: eles continuam
somente no arquivo protegido da VPS.
