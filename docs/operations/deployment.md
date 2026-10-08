# Deployment

## Pré-requisitos

- VPS Linux com Docker, plugin Docker Compose, `curl`, `gzip`, `git`, SSH e espaço persistente para backups.
- Proxy TLS publicando o Nginx em `127.0.0.1:${HTTP_PORT:-80}`. Para outro desenho, configure `BIND_ADDRESS` explicitamente.
- `/opt/ownerinc-portal/shared/.env` criado diretamente na VPS com modo `0600`.
- Login da VPS no GHCR com permissão somente de leitura dos packages privados.
- Node.js 24 para verificações locais e CI. Os serviços executam em containers.

## Configuração

O Compose entrega a cada serviço somente suas variáveis necessárias. Use `.env.example` como referência, mas nunca envie o `.env` ao Git. Senhas usadas dentro das URLs PostgreSQL devem estar em formato URL-encoded. `CORS_ORIGINS` só deve listar origens adicionais deliberadas; o acesso normal é pelo mesmo domínio do Nginx.

### Origem pública atrás do proxy TLS

O proxy TLS deve preservar o `Host` público completo (inclusive uma porta pública
não padrão) e sobrescrever `X-Forwarded-Proto` com o protocolo externo correto.
O Nginx encaminha essa autoridade em `X-Forwarded-Host` e remove
`X-Forwarded-Port` da requisição enviada à API. A porta 80 do listener interno
não representa a porta HTTPS pública; encaminhá-la fazia a API reconstruir
`https://portal.ownerinc.com.br:80` e recusar uploads do próprio Portal com 403.
A remoção explícita também impede repassar um valor de porta recebido do cliente.

Valide a configuração efetiva da borda antes da publicação: se a borda substitui
o Host pelo nome/porta do upstream, ajuste-a para preservar a autoridade pública.
O Nginx interno deve continuar acessível somente pelo ingress previsto. Não
amplie `CORS_ORIGINS` indiscriminadamente para contornar divergências do proxy.

O smoke agora inclui um GET de health com o cabeçalho `Origin` derivado de
`BASE_URL`, além de health/readiness sem Origin. Execute-o também pelo endereço
HTTPS público; um health simples pode retornar 200 enquanto uploads retornam 403.

```sh
BASE_URL=https://portal.ownerinc.com.br bash scripts/smoke.sh
```

Após o smoke, confirme upload autenticado e exportação em Cards Pós e AutoCard,
além do upload de perfil. O smoke não realiza essas mutações.

O gate estático do AutoCard segue o contrato atual de navegação: shell em
`/autocard.html`, módulo `/js/router-bootstrap.js` que importa e chama
`startRouter`, mapa de `/js/router.js` para `/autocard/entry.js` e exportação
`mount` dessa entry. O smoke baixa os três módulos e recusa recurso ausente,
HTML genérico ou transferência HTTP incompleta; mantém também a raiz e o
redirect legado `/autocard/`. Mudanças nesse contrato devem atualizar o smoke
e seu teste HTTP com os arquivos do checkout, não adicionar tags antigas ao
frontend. Essas checagens de entrega não executam JavaScript nem percorrem
todas as dependências: não substituem a validação autenticada no navegador.

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
- `CRON_DATABASE_URL`: role fixa `portal_cron`, com leitura e apenas o `UPDATE` necessário para `SELECT ... FOR UPDATE` em `users`/`reminders`, leitura/escrita de `notifications_log`/`cron_status`, leitura de `autocard_cards`, leitura/exclusão de `autocard_media` e leitura/escrita de `audit_log` para a retenção do AutoCard.

Para alertas operacionais por SMTP, defina `OPERATIONAL_ALERT_EMAIL` e repita
as variáveis SMTP no ambiente do cron. Sem esse destinatário, o worker mantém
healthchecks e logs, mas não tenta enviar alertas. O estado de alerta é
deduplicado em `cron_status` e uma recuperação envia somente uma notificação de
retorno ao normal.

Defina também `PORTAL_API_DB_PASSWORD` e `PORTAL_CRON_DB_PASSWORD` com pelo menos 16 caracteres. O serviço `migrate` cria ou rotaciona essas duas roles, executa migrations sob advisory lock e reaplica os grants antes da API iniciar. `MIGRATION_ONLY=true` faz o container falhar se `RUN_MIGRATIONS=true` não estiver ativo e impede que um comando vazio seja confundido com uma migration bem-sucedida. As credenciais administrativas não entram no container de API em execução. Para reaplicar roles e grants manualmente, sobrescreva o modo one-shot: `docker compose run --rm --no-deps -e RUN_MIGRATIONS=false -e MIGRATION_ONLY=false migrate node db/provision.js`.

Defina `IMAGE_REGISTRY=ghcr.io/ownerinc`. O CI publica API e cron com a tag do commit, registra os digests e os transporta no archive de release. A VPS aceita somente esses dois digests em `.image-env` e inicia o Compose com referências `@sha256`; ela não resolve tags mutáveis durante o deploy. O CMS tem publicação e artefato de digest separados, ainda sem consumo pelo deploy automático.

Configure localmente `VPS_USER`, `VPS_HOST`, `API_IMAGE`, `CRON_IMAGE` e, se necessário, `VPS_PATH` e `SSH_PORT`. `API_IMAGE` e `CRON_IMAGE` devem ser referências completas `@sha256` produzidas pelo CI. O `deploy.sh` recusa alterações rastreadas não commitadas e publica apenas um `git archive` do `HEAD` com o manifesto de imagens; `ownerinc-novo-agente/` é excluído explicitamente.

## Fluxo de release

**Extensão Payload em preparação local:** o caminho legacy de duas imagens/dois
artefatos abaixo permanece compatível. Releases `payload-v1` acrescentam CMS_IMAGE
e exigem backup coordenado PortalDB/CMSDB/uploads/CMSmedia+staging, lease operacional
e adapter durável de autoridade/ledger. Sem adapter integrado, operações CMS são
recusadas. Ver [runtime e recuperação Payload](payload-runtime-recovery.md).
Arquivos versionados não comprovam receiver/forced-command instalado; instalação,
deploy e cutover dependem de nova autorização operacional explícita.

O job `validate` agora também constrói `ownerinc-portal-cms` pelo contexto raiz e
`cms/Dockerfile`. A validação de empacotamento do runtime já incluída no Dockerfile
é executada durante o build; o CI aplica ao CMS o mesmo scan Trivy bloqueante de
`HIGH,CRITICAL` usado para API/cron. Em publicação autorizada na `main`, o CI envia
a imagem com tag do commit para GHCR e expõe o digest validado em
`needs.validate.outputs.cms_image`. O artefato separado `cms-image-digest` contém
`cms-image-digest.txt` (referência completa `ghcr.io/ownerinc/ownerinc-portal-cms@sha256:…`)
e `cms-image-source.txt` (SHA do commit de origem).

Essa publicação **não ativa nem implanta o Payload CMS em produção**: não altera o
artefato legacy `image-digests`, o arquivo `.ci-images` de duas linhas, o manifesto
da VPS, Compose, banco ou autoridade CMS. Até que adapter/receiver, backup e
ativação coordenados sejam revisados e autorizados separadamente, o deploy
automático continua limitado a API e cron; não use esse digest como evidência de
release Payload `payload-v1`.

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

O envio executa `aws s3 cp --recursive` somente depois de validar
`manifest.sha256`. Sem `AWS_ENDPOINT_URL`, o AWS CLI usa seu endpoint padrão;
com essa variável, o helper passa `--endpoint-url` explicitamente. O helper é
invocado via Bash, inclusive quando o archive da release foi extraído com modo
`0644`. Mantenha caminhos e prefixos com espaços entre aspas.

Falha no envio faz `backup.sh` retornar código `3`, sem apagar o backup local
verificado; no backup normal, os serviços já foram reiniciados antes do envio.
Corrija a configuração externa e reenvie a mesma cópia, sem gerar outro dump:

```sh
S3_BUCKET=ownerinc-portal-backups S3_PREFIX=portal-ownerinc \
bash scripts/backup-s3.sh "/opt/ownerinc-portal/shared/backups/AAAAMMDDTHHMMSSZ"
```

## Agendas systemd do Portal em produção

Os arquivos em `ops/` entregam as agendas, **não as instalam nem as habilitam**.
Instalar somente após revisão, testes independentes e publicação da revisão
aprovada. Esta seção usa o layout do receptor de produção
`/opt/ownerinc/apps/portal-ownerinc-real`, não o layout legado `shared/` acima.
Requer Bash, GNU coreutils (`realpath`, `sha256sum`), `flock` do util-linux,
Docker/Compose e systemd no host. Não altera o receptor, o cron ou o proxy.

### Backup diário local

- `ownerinc-portal-backup.timer`: **06:00 UTC / 03:00 Brasília**, precisão de
  um minuto, `Persistent=true`. Pode executar ao reativar após um horário perdido;
  isso não recompõe os backups dos dias perdidos nem comprova RPO de 24 horas.
- `backup-from-timer.sh` espera até **300 segundos** pelo mesmo
  `runtime/deploy.lock` do receptor. Falha de aquisição retorna **75** e falha o
  serviço, sem anunciar backup. O receptor usa tentativa não bloqueante: um deploy
  durante o backup também pode falhar por lock ocupado e exigir nova tentativa.
- Sob esse lock, lê exatamente uma linha de `current-release`: caminho absoluto
  `releases/<sha40 minúsculo>` sob o root. Rejeita caminhos não canônicos,
  traversal, symlinks, arquivos ausentes e configurações incompletas antes de
  invocar Docker. A release, seu helper e os diretórios/configurações devem ser
  controlados pelo operador, sem escrita por usuários não confiáveis.
- Executa **o `scripts/backup.sh` da release corrente**, inclusive quando está
  em modo `0644`, com `ownerinc-portal-prod`, perfil `notifications` e runtime
  `/opt/ownerinc/secrets/portal-ownerinc/production.runtime.conf`. Prefere
  `compose.ownerinc-vps.yaml` da release; na ausência dele, usa
  `runtime/compose.production.yaml`, como o receptor. Exige `.image-env`, mas não
  usa `source`/`eval`: o helper extrai e valida os digests API/cron.
- Destino exclusivo: `/opt/ownerinc/backups/portal-ownerinc/daily`, modo `0700`;
  umask `0077`, arquivos novos `0600`. Retenção existente de **14 dias**
  (`find -mtime +14`, em dias completos) somente dentro desse destino. Backups
  pré-release não entram nessa limpeza. O helper pausa brevemente apenas nginx,
  cron e API que estavam ativos e tenta reiniciá-los; `LEAVE_STOPPED=false` é
  imposto mesmo se o ambiente herdar outro valor.
- `BACKUP_UPLOAD_S3=false` é explícito e não sobrescrevível nessa agenda.
  **Não há S3 configurado; backup no mesmo host não é cópia externa** e não atende
  ao critério S3/recuperação da perda da VPS. Configurar cópia externa exige uma
  decisão separada, não apenas definir `S3_BUCKET` no ambiente desse serviço.
- Sucesso só é registrado como `Local backup verified` após conferir os dois
  artefatos não vazios, as duas entradas do manifesto e seus hashes, ainda sob
  lock. Falha do helper preserva seu status; falha de verificação retorna `1`
  e conserva a cópia para inspeção. O stdout de sucesso antecipado do helper é
  retido. Nenhum ambiente de credenciais é impresso pelo wrapper.

Para ensaios isolados, há somente quatro overrides de ambiente confiável:
`PORTAL_ROOT`, `PORTAL_ENV_FILE`, `PORTAL_BACKUP_DIR` (diretórios/arquivo existentes,
absolutos e canônicos; backup não pode conter nem estar sob o root da aplicação)
e `PORTAL_LOCK_WAIT_SECONDS` (inteiro de 1 a 900). Produção usa os defaults;
eventual drop-in deve ser root-owned, sem escrita por grupo/outros. Não existe
arquivo shell de configuração a ser carregado. Projeto, retenção, política S3 e
alvo TLS não são knobs. Nunca aponte uma fixture para volumes/paths de produção.

### Renovação HTTPS exclusiva do Portal

`ownerinc-portal-certificate-renewal.timer` verifica às **00:00 e 12:00 UTC**,
com atraso aleatório de até **30 minutos** e `Persistent=true`. O script executa
somente este comando autorizado dentro do ingress compartilhado:

```sh
docker exec root-app-1 /opt/certbot/bin/certbot renew --non-interactive \
  --cert-name portal.ownerinc.com.br --no-random-sleep-on-renew \
  --no-directory-hooks --deploy-hook '/usr/sbin/nginx -t && /usr/sbin/nginx -s reload'
```

Não usa `--force-renewal`, dry-run periódico, outras lineages, restart/stop do
container ou reload incondicional. O hook de deploy pertence ao Certbot e só
ocorre após renovação bem-sucedida; `nginx -t` precisa passar antes do reload
gracioso. Hooks em diretórios estão desabilitados; o operador deve preservar a
ausência de hooks adicionais perigosos na configuração do Certbot/lineage.
Stdout/stderr e status reais do Certbot chegam ao journal/systemd. Um ciclo sem
certificado devido **não comprova renovação nem execução do reload**. Inspecione
também erros de hooks no journal; status zero, sozinho, não é evidência de reload.

### Instalação e aceite pelo operador autorizado

Antes de instalar, confrontar root, ponteiro, override e lock com o **receptor
efetivamente instalado**, confirmar os digests da release aprovada e ausência de
outra agenda equivalente. Não substituir configurações do proxy ou de outros
produtos. Os diretórios e arquivos ancestrais precisam continuar protegidos contra
escrita não confiável; o runtime com credenciais permanece em `0600`.

Na VPS, em Bash como root, a partir da release corrente **já revisada e publicada**:

```sh
set -euo pipefail
root=/opt/ownerinc/apps/portal-ownerinc-real
release=$(cat "$root/current-release")
[[ ${release#"$root/releases/"} =~ ^[0-9a-f]{40}$ ]]
[[ $(realpath -e -- "$release") == "$release" ]]
cd -- "$release"
install -d -o root -g root -m 0700 /opt/ownerinc/backups/portal-ownerinc/daily
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 ops/backup-from-timer.sh /usr/local/libexec/ownerinc-portal-backup
install -o root -g root -m 0755 ops/renew-portal-certificate.sh /usr/local/libexec/ownerinc-portal-renew-certificate
for unit in ownerinc-portal-backup.service ownerinc-portal-backup.timer \
  ownerinc-portal-certificate-renewal.service ownerinc-portal-certificate-renewal.timer; do
  install -o root -g root -m 0644 "ops/$unit" "/etc/systemd/system/$unit"
done
systemd-analyze verify /etc/systemd/system/ownerinc-portal-backup.{service,timer} \
  /etc/systemd/system/ownerinc-portal-certificate-renewal.{service,timer}
systemctl daemon-reload
```

As unidades executam como root, não reiniciam automaticamente e têm limites de
inicialização de uma hora (backup, com cinco minutos para parar) e 30 minutos
(Certbot). **Antes de habilitar**, em janela autorizada sem ensaio duplicado,
executar cada serviço e avaliar seu resultado:

```sh
systemctl start ownerinc-portal-backup.service
systemctl show ownerinc-portal-backup.service -p Result -p ExecMainStatus
journalctl -u ownerinc-portal-backup.service -n 50 --no-pager
BASE_URL=https://portal.ownerinc.com.br bash scripts/smoke.sh
systemctl start ownerinc-portal-certificate-renewal.service
systemctl show ownerinc-portal-certificate-renewal.service -p Result -p ExecMainStatus
journalctl -u ownerinc-portal-certificate-renewal.service -n 50 --no-pager
```

Conferir hashes do destino exato informado, retorno de API/cron/Nginx ao estado
anterior saudável e HTTPS externo. Esse start do serviço TLS **pode renovar** se
estiver devido; requer a autorização operacional, não é um teste simulado.
Separar evidência de “não devido”, renovação e reload efetivamente observados.
Após aceite, habilitar somente os timers e registrar o próximo disparo:

```sh
systemctl enable --now ownerinc-portal-backup.timer ownerinc-portal-certificate-renewal.timer
systemctl list-timers --all 'ownerinc-portal-*'
systemctl is-enabled ownerinc-portal-backup.timer ownerinc-portal-certificate-renewal.timer
```

Monitorar journal/`Result` e idade da última cópia verificada. Lock ocupado,
timeout, disco cheio, Docker indisponível ou erro de reinício exigem intervenção;
status não zero não comprova recuperação dos serviços. Não remover o lock para
“destravar”. Para suspender novas execuções, usar `systemctl disable --now` nos
dois **timers**; isso não interrompe um serviço já em andamento. Não parar
cegamente um backup que pode estar com os serviços pausados.

O alerta SMTP do cron é independente desses timers. O destino autorizado
`gabriel.garcia@ownerinc.com.br` só entra no worker após recriação controlada do
cron pela operação; estes arquivos não fazem essa ativação nem adicionam envio
de email para falhas systemd. Não afirmar que ciclos futuros ou alertas de timer
foram validados pela simples instalação.

## Restauração

Execute somente no ambiente alvo aprovado, com as mesmas variáveis `COMPOSE_*`
do backup e o manifesto imutável `.image-env` da release:

```sh
PROJECT_ROOT="$PWD" \
PRE_RESTORE_BACKUP_DIR=/opt/ownerinc-portal/shared/pre-restore \
bash scripts/restore.sh "/opt/ownerinc-portal/shared/backups/AAAAMMDDTHHMMSSZ" --confirm RESTORE
```

Depois de validar os hashes da cópia de entrada, o restore cria um backup de
proteção **somente local**, com `BACKUP_UPLOAD_S3=false` mesmo que o ambiente
herde `BACKUP_UPLOAD_S3=true`. Esse backup deixa os serviços parados para a
restauração; indisponibilidade de S3 não deve interromper essa transição. Envie
a cópia de proteção separadamente se necessário.

Falhas na criação ou retenção do backup de proteção acionam sua limpeza e a
tentativa de reiniciar somente os serviços antes ativos, sem iniciar a
restauração. Os traps de erro também cobrem falhas dentro das funções Compose.
Depois que a restauração começa, uma falha aciona a parada de Nginx, API e cron:
inspecione os dados ou restaure o backup de proteção antes de reiniciar. Se o
próprio Docker falhar na parada ou no reinício, confira o estado dos serviços
manualmente; o retorno não zero não comprova recuperação. O sucesso exige
migrations, verificação e smoke; use `RESTORE_BASE_URL` se o proxy não publicar
uma porta diretamente acessível.

## Validação

- `docker compose ps` mostra PostgreSQL e API saudáveis.
- `GET /api/health` retorna `{"status":"ok"}` e `GET /api/ready` retorna `{"status":"ready"}` pelo domínio publicado.
- PostgreSQL e API não possuem portas publicadas; Nginx fica em loopback por padrão.
- Login, perfil e upload funcionam, e logs não expõem chaves ou dados pessoais.

### Headers dos arquivos estáticos

Em Nginx Linux descartável, monte `nginx/nginx.conf` e `public/` somente para
leitura, publique apenas em loopback e execute `nginx -t`. Sem acessar upstreams,
faça GET de `/index.html`, `/js/router-bootstrap.js`, `/css/tokens.css` e de
arquivos `.js` e `.css` inexistentes (404). Confirme em cada resposta uma única
ocorrência dos seis headers do servidor, com os valores exatos da configuração:
`Content-Security-Policy`, `Referrer-Policy`, `Strict-Transport-Security`,
`X-Content-Type-Options`, `X-Frame-Options` e `Permissions-Policy`.

JS/CSS existentes devem manter uma única ocorrência de `Cache-Control: no-cache`,
gerada por `expires -1`. Não adicione `add_header` local nessa location: ele
suprime a herança dos headers do servidor. Em 404, a ausência de `Cache-Control`
é esperada porque `expires` não se aplica a esse status; os seis headers de
segurança continuam presentes por `always`. Após publicação autorizada, repita
os GETs pelo domínio HTTPS para verificar também a borda real.

O CI usa Node 24, testa migrations em PostgreSQL real, executa invariantes/sintaxe/Compose, constrói e escaneia as imagens API, cron e CMS com Trivy, rejeita vulnerabilidades `high` ou `critical`, publica SBOMs SPDX e envia imagens imutáveis ao GHCR em pushes na `main`. O digest CMS tem artefato próprio e não integra o manifesto legacy de produção.
`npm run test:migrations` exige `MIGRATION_TEST_DISPOSABLE=true` e não pode ser
executado com `NODE_ENV=production`; ele modifica um banco de teste durante a
validação de migrations históricas.

Esse teste executa migrations duas vezes (incluindo provisionamento de roles e
grants) e chama o mesmo `verifyMigrations` usado em deploy/restore, antes das
fixtures históricas. Em PostgreSQL 16, também exige que o verificador recuse
constraints CLT/PJ enfraquecidas ou não validadas e colunas incompatíveis em
`pending_registrations`/`firebase_cleanup_queue`. Cada mutação negativa é
restaurada no banco descartável antes da revalidação positiva. A comparação da
constraint usa a expressão canônica do PostgreSQL (`>= 1` e `<= 31`, não o texto
`BETWEEN` da migration), preservando os predicados e agrupamentos completos.

O receptor de produção passa `--profile notifications` em todos os comandos
Compose compartilhados, incluindo `up`, migrations one-shot e rollback, para
que o cron de notificações permaneça habilitado. As mutações de cards AutoCard
e a limpeza de órfãos compartilham o advisory lock `7193003`.

## Deploy automático da `main`

Depois que o job `validate` termina verde em um push para `main`, o job
`deploy-production` empacota exatamente o commit validado e o envia ao receptor
SSH de produção. O mesmo fluxo pode ser iniciado por `workflow_dispatch` na
`main`. O ambiente GitHub `production` mantém suas regras de aprovação e o
receptor executa backup, migration, readiness, smoke e rollback.

O fluxo autorizado em 23 de setembro de 2026 é **Validação → Produção**. Ele usa
os secrets `PORTAL_VPS_HOST`, `PORTAL_VPS_PORT`, `PORTAL_VPS_USER`,
`PORTAL_VPS_SSH_KEY` e `PORTAL_VPS_KNOWN_HOSTS`, já configurados para produção.
Staging não é uma dependência do autodeploy; os testes, scans e a publicação de
imagens imutáveis continuam obrigatórios antes de liberar produção.

## Receptor separado de staging

O receptor abaixo permanece disponível para uma implantação de staging
independente. Sua configuração não é exigida pelo workflow de produção.

Os receptores de staging e produção são separados. Cada chave usa `restrict` e
`command=` no `authorized_keys`, não abre shell e não encaminha portas. Staging
exige `staging:<sha>`. O workflow de produção envia somente o SHA de 40 caracteres,
compatível com o receptor de produção já instalado na VPS. O entrypoint exclusivo
de produção versionado normaliza esse SHA para `production:<sha>` antes de
delegar ao receptor comum; também aceita o prefixo explícito e rejeita staging.
Ambos recebem o archive da release correspondente. Staging
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
aponta para o receptor comum e aceita `production:<sha>` ou o SHA isolado, sempre
com `DEPLOY_RECEIVER_ROLE=production`. Os três
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
