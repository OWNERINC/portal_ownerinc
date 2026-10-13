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

### Receiver Payload: admissão somente (sem instalação)

O receiver possui uma rota explícita de admissão, anterior à inspeção do runtime
e ao atalho `already_current`. O comando SSH é **uma única string**, com campos
posicionais separados por exatamente um espaço ASCII, nesta ordem:

```text
production:payload-v1 COMMIT RUN_ID RUN_ATTEMPT API_IMAGE CRON_IMAGE CMS_IMAGE CANDIDATE_ARTIFACT_ID QUALIFIED_ARTIFACT_ID REPORT_ARTIFACT_ID
```

Exemplo de transporte (não executado nesta implementação):

```sh
ssh "$VPS_USER@$VPS_HOST" "production:payload-v1 $COMMIT $RUN_ID $RUN_ATTEMPT $API_IMAGE $CRON_IMAGE $CMS_IMAGE $CANDIDATE_ARTIFACT_ID $QUALIFIED_ARTIFACT_ID $REPORT_ARTIFACT_ID" < candidate.tar.gz
```

`COMMIT` contém 40 hexadecimais minúsculos; IDs e tentativa são decimais positivos
de até 20 dígitos, sem zeros iniciais; os três IDs de artefatos são distintos.
Cada imagem é a referência completa `ghcr.io/ownerinc/ownerinc-portal-SERVICE@sha256:`
seguida de 64 hexadecimais minúsculos, com SERVICE `api`, `cron`, `cms`, nessa ordem.
Não são aceitos flags adicionais, whitespace alternativo, campos extras, staging
Payload, paths de política/ferramentas ou permissões indicadas pelo solicitante.
`production:SHA`, `staging:SHA` e a normalização SHA-only do wrapper de produção
mantêm o contrato legacy de duas imagens. Três imagens via legacy são recusadas
antes da criação da árvore de release; não constituem uma alternativa à admissão.
Retries legacy `already_current` também precisam fornecer o archive de duas
imagens: a classificação ocorre antes dos checks de saúde/recuperação do cron,
para que stdin Payload não use esse atalho. O CI existente já envia esse archive.

Pré-requisito de instalação **ainda operacionalmente pendente**: instalar a versão
revisada do receiver e `ops/payload-receiver-admission.py` como
`/usr/local/libexec/payload-receiver-admission.py`, root:root, `0755`, em ancestrais
root:root não graváveis por grupo/outros e sem symlinks. Python 3.9+ deve estar
disponível em `/usr/bin/python3` (também no caminho legacy, sem exigir root para
legacy). Não há override de helper/verificador por ambiente ou request. Ambos são
executados com ambiente limpo e `-I -S`. O helper executa exclusivamente o verificador
instalado em `/opt/ownerinc/lib/payload-candidate/ops/payload-candidate-verifier.py`;
o verificador existente continua autenticando a própria toolchain, a política
protegida `/etc/ownerinc/payload-candidate/production-policy.json` e o registro em
`/var/lib/ownerinc/payload-candidate/records`. Nenhuma alteração de política ou
registro é feita pelo receiver. O Python usado deve corresponder ao intérprete
fixado na política existente; mismatch falha fechado.

O entrypoint existente `ops/prepare-cms-infrastructure.sh` inclui essa dependência:
`--check` verifica o source, a sintaxe sem executá-lo, a stdlib/Python 3.9+ pelo
intérprete fixo isolado e a cadeia root:root do destino; helper ausente é elegível,
mas bytes instalados desconhecidos ou ownership/permissões inseguros são recusados.
`--apply`, somente quando operacionalmente autorizado, instala o helper por
`atomic_install` root:root `0755` e reconfere bytes/modo **antes** de publicar o
receiver. Falha de instalação ou conferência mantém o receiver anterior. Uma
interrupção entre esses passos pode deixar apenas o helper inerte instalado, não
um novo receiver sem dependência. Helper já correto não é reescrito; a ausência
dele impede o resultado “already prepared”. Se já existente, uma cópia privada
é retida junto ao snapshot pré-mudança. O dry run não cria arquivos, e a aplicação
continua sem iniciar serviços nem abrir admissão. Isso não instala política,
registro ou verifier de candidatos e não constitui execução real na VPS.

Payload exige UID/EUID 0 e o diretório previamente provisionado
`/var/lib/ownerinc/payload-candidate/incoming` root:root `0700`, com **toda** a
cadeia até `/` root:root, sem links, bits especiais ou escrita por grupo/outros.
O helper não corrige permissões/ownership automaticamente. Cada tentativa válida
na sintaxe cria exclusivamente `incoming/payload-<aleatório>/`, `0700`, e um
`candidate.tar.gz` exclusivo `0600`. A leitura de stdin consome no máximo **10 MiB
+ 1 byte** para detectar overflow, grava no máximo 10 MiB e não drena streams
ilimitados. O recibo mantém os bytes imutáveis em memória; a verificação compara
identidade (device/inode/metadata), FD aberto, path e conteúdo antes de consumir
**aqueles mesmos bytes**, sem reabrir o archive para extração. A cadeia protegida
impede substituição por outra identidade; substituir o inode com conteúdo idêntico
durante a verificação também é recusado. Isso não depende apenas de rehash.

Somente após PASS do verificador o helper inspeciona e materializa a árvore privada
`receipt/release` (não publica em `releases/`). Aceita apenas arquivos regulares e
diretórios, rejeita links, especiais, escapes, nomes/metadata duplicados e `.image-env`
recebido. Limites adicionais: 128 MiB descomprimidos e 20.000 membros. Commit e as
três imagens devem coincidir exatamente com os seletores autenticados, inclusive
na conferência dos arquivos extraídos. Nenhum conteúdo recebido é executado ou
sourced. **Mesmo PASS termina com exit 2 `release_not_preflighted`**; a função
`install_receiver_preflight()` existente permanece incondicionalmente fechada.
Não há pulls, inspeção Docker, mudanças em serviços/bancos/volumes/pointers,
instalação, recuperação ou ativação neste bloco.

Diagnósticos expõem apenas o basename gerado do recibo e códigos fechados, nunca
request bruto, conteúdo de política/registro ou stderr do verificador. Negativas
do verificador aparecem como `candidate_admission_denied`. Recibos Payload,
inclusive parciais, ficam preservados; PASS também preserva `admission.json` e a
árvore privada. Falha do helper legacy preserva apenas seu archive limitado,
enquanto a limpeza existente remove a staging parcial. Não se removem releases
existentes nem registros assinados. Não há garbage collection automática: o
operador deve revisar e arquivar recibos com acesso restrito e monitorar espaço;
limite por tentativa não é uma quota agregada. Falhas de sintaxe/root/ancestrais
antes da criação não geram recibo.

Testes de transporte usam doubles explicitamente identificados; bindings
criptográficos usam a suíte existente `payload-candidate-admission`. A evidência
local Windows não comprova permissões/FDs Linux, instalação no host ou deploy.
O teste de identidade nativa Linux/root permanece pendente quando skipped.

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

Para publicar somente uma imagem candidata CMS de um branch já enviado ao GitHub,
dispare o workflow existente `ci.yml` com `cms_image_only=true`:

```sh
gh workflow run ci.yml --ref feat/payload-cms-final -f cms_image_only=true
```

Esse modo continua executando a validação completa, construindo e escaneando as
imagens de API, cron e CMS, mas publica apenas CMS e seu artefato de digest. Ele
não publica API/cron, não gera o artefato legacy `image-digests` e nunca inicia
`deploy-production`, inclusive quando o ref selecionado é `main`. O modo normal
permanece: push para `main` ou dispatch na `main` com a opção omitida/desativada.
Pull requests e refs que não sejam branches não publicam imagens.

#### Candidato completo com aceite da sessão editorial API v2

Para validar o contrato API v2 e publicar, sem implantar, um conjunto candidato
com API, cron e CMS do mesmo commit, dispare `workflow_dispatch` em um branch:

```sh
gh workflow run ci.yml --repo OWNERINC/portal_ownerinc --ref feat/payload-cms-final -f publish_candidate_only=true
```

`publish_candidate_only` é booleano e começa desativado. Ele é mutuamente
exclusivo com `cms_image_only`; se ambos forem verdadeiros, o workflow falha
antes do checkout, build ou publicação. Ambos os modos manuais exigem um ref de
branch. O caminho de candidato constrói as imagens de produção, executa o teste
da sessão antes de qualquer push ao GHCR, mantém os três scans Trivy bloqueantes,
o audit de dependências e a geração de SBOMs, e só então publica API, cron e CMS.
O artefato separado `payload-release-candidate` contém `candidate.json` com
`schemaVersion: 1`, o SHA validado do commit, `runId`, `runAttempt` e as três
referências imutáveis `ghcr.io/ownerinc/ownerinc-portal-{api,cron,cms}@sha256:…`
obtidas dos pushes daquele run. Não misture digests de execuções diferentes.

O teste usa a imagem API recém-construída, PostgreSQL 16 e o Dockerfile
versionado do Firebase Auth Emulator em um projeto Compose e bancos descartáveis
únicos por execução. Ele cria somente uma identidade sintética de projeto
`demo-*`, provisiona o usuário no banco de fixture e faz chamadas HTTP reais às
rotas públicas e privadas de sessão v2 usando a conexão normal `portal_api`.
O segredo e a URL do banco são criados dentro da fixture, não vêm de fallback do
ambiente do runner e não são impressos. Após sucesso, serviços/volumes e o arquivo
privado de ambiente são removidos. Em falha, o runner preserva a fixture Compose
e o arquivo privado (modo `0600`) para diagnóstico local; não executa `down` nem
remove os volumes. O relatório JSON redigido contém somente o estágio, verificações
sem valores, nome aleatório do projeto e estado dos recursos — nunca tokens,
cookies, credenciais ou URLs de banco. O CI anexa apenas esse relatório; a fixture
e o arquivo privado permanecem somente durante a vida do runner efêmero e somem
quando o job termina.

Para o contrato de emissão, a fixture CMS responde somente `GET /editorial/ready`.
Isso permite verificar que o endpoint API de sessão exige
prontidão e recusa emissão quando ela desaparece; **não** comprova inicialização
do CMS real, login no navegador, disponibilidade de mídia ou CRUD editorial.
Os headers HTTP são testados diretamente; isso não é uma alegação de teste de
navegador.

O modo candidato nunca empacota `.ci-images`, não altera o artefato legacy
`image-digests` de duas linhas e exclui `deploy-production`, inclusive em um
dispatch na `main`. O modo `cms_image_only` preserva seu contrato anterior
(somente CMS); o caminho normal da `main` mantém seu autodeploy de API/cron.
Antes de tratar um candidato como qualificado, confira no Actions o SHA do run,
sucesso da integração e dos três scans, as três referências do artefato e o job
`deploy-production` ignorado. Publicação candidata não significa instalação,
ativação CMS, troca de autoridade ou autorização de restore em produção.

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

### P2: transporte privilegiado de admission Payload (ainda sem instalação)

#### Provisionamento administrativo offline do trust (slice separado)

`ops/provision-payload-candidate-trust.py` prepara somente a closure fixa de
admission, policy e diretórios privados. Não altera preparer, pins de release,
runtime, sudoers, serviços ou banco; não registra candidatos nem autoriza deploy.
**O próprio provisioner e o Python que o inicia devem ser autenticados pelo
administrador antes da execução.** Hash calculado pelo próprio bundle, arquivo
sidecar recebido com o candidato ou auto-checagem do programa não estabelece essa
confiança inicial. Bibliotecas e stdlib continuam sob confiança do SO root.

O contrato de CLI é explícito (nenhuma ação default):

```sh
/usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C \
  /usr/bin/python3 -I -S -B /root/ownerinc-reviewed/ops/provision-payload-candidate-trust.py \
  --check \
  --approval /root/ownerinc-reviewed/trust-approval.json \
  --approval-sha256 "$INDEPENDENTLY_APPROVED_MANIFEST_SHA256" \
  --bundle /root/ownerinc-reviewed/trust-bundle
```

`--apply` substitui `--check` somente após autorização administrativa. Não há
override de destino, UID/GID, endpoint ou grant para deploy executar esse comando.
Exige Linux, UID/EUID/GID/EGID zero, Python isolado sem site/bytecode e ambiente
contendo somente PATH/locale fixos. A identidade canônica do Python em execução
e do `/usr/bin/python3` usado pelo receiver deve coincidir com a policy aprovada.

O manifesto independente é JSON UTF-8 de até 1 MiB, profundidade máxima 32,
sem campos duplicados/desconhecidos, com exatamente:

- `schemaVersion: 1`;
- `kind: ownerinc-payload-trust-provisioning-v1`;
- `policySha256`: SHA-256 dos bytes integrais de `production-policy.json`;
- `toolchain`: mapa idêntico ao da policy v1, com os quatro hashes de arquivos
  fixos e os quatro executáveis `{path, sha256}` (`node`, `git`, `python`,
  `gitRemoteHttps`). A aprovação externa inclui o hash deste manifesto inteiro.

O bundle permite **somente** `production-policy.json` (`0600`), os quatro paths
de `TOOL_FILES` já definidos pelo verifier/registrar (Python `0755`, módulos
`.mjs` `0644`) e `bin/git-remote-https` (`0755`). Diretórios extras, links e
arquivos extras são recusados. O manifesto fica fora do bundle. Todos os inputs
exigem arquivos regulares root:root, nlink=1 e ancestry protegida; o bundle é
apenas lido/hasheado, nunca importado/executado. Node/Git/Python já devem existir
nos paths canônicos aprovados com hashes correspondentes; não são instalados,
atualizados nem aprovados por descoberta local. O helper HTTPS é copiado como
arquivo regular independente para seu destino fixo, sem links ao binário do SO.

`--check` não cria diretórios, snapshots, temporários, policy nem pycache.
`--apply` aceita apenas destinos ausentes ou exatamente idênticos, incluindo
modos. Conteúdo/mode/owner incompatível é recusa, nunca reparo ou rotação. Cria
somente segmentos ausentes root:root `0700`, incluindo `records`, `work`,
`incoming` e `trust-snapshots` sob `/var/lib/ownerinc/payload-candidate`.

Antes de publicar arquivos faltantes, guarda snapshot privado UUID de estados
ausentes/presentes, cópias dos bytes anteriores idênticos e manifesto de aprovação.
Cada publicação usa temporário exclusivo, fsync e `renameat2(RENAME_NOREPLACE)`:
arquivo conflitante surgido durante a operação não é sobrescrito. Não existe
fallback para rename que substitui destinos; Linux/libc/filesystem compatível é
pré-condição. Após conferir novamente inputs, executáveis e closure instalada,
publica a policy exata **por último**. Registros existentes não são escritos ou
removidos. Temporários e snapshots de falhas ficam retidos como evidência; não
são automaticamente consumidos como sucesso. Retomada compara novamente todos
os bytes aprovados e aceita apenas ausente/idêntico, sem migrar policy anterior.

Compatibilidade dos validadores independentes do bootstrap é testada contra os
validadores Python e Node existentes, sem executar validators fornecidos no bundle.
Testes Windows usam filesystem real com doubles explícitos de ownership e
semântica POSIX; fsync/NOFOLLOW/renameat2/ancestry root precisam do teste Linux root.
Política real, IDs oficiais, hashes do host, conclusão do CI, registro autenticado
e reprodutibilidade do pacote continuam exigindo evidência própria. O pin antigo
do preparer permanece intacto: este provisionamento não aprova source de preparação
nem abre `release_not_preflighted`.

##### Qualificação nativa isolada do provisioner

O gate candidate-only existente `Test preauthority CI setup with native Linux root`
também executa a suíte de trust em modo obrigatório, sem mudar o nome autenticado
do step ou os budgets de recovery. Invocação equivalente no runner Linux descartável:

```sh
NODE_BIN="$(readlink -f -- "$(command -v node)")"
test -f "$NODE_BIN" && test -x "$NODE_BIN"
sudo -n /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
  PAYLOAD_REQUIRE_NATIVE_TRUST=1 "$NODE_BIN" --test \
  tests/unit/payload-candidate-trust-provisioning.test.mjs
```

Exige UID/EUID/GID/EGID zero, ancestry `/root` protegida, `/usr/bin/python3`
canônico root-owned, e suporte real a NOFOLLOW, links, chown, fsync de diretório
e `renameat2(RENAME_NOREPLACE)`. Ausência de requisito falha o gate: com a flag
obrigatória, não há skip por plataforma/UID. A flag pertence somente ao teste e
não é encaminhada ao processo Python, iniciado com `-I -S -B` e PATH/locale fixos.

O teste cria um sandbox exclusivo e privado sob `/root`, redirecionando **somente** as
três constantes de destino do módulo em memória. Confere antes os valores de
produção e mantém todas as funções de metadata/I/O/publicação originais. Os paths
fixos de trust de produção não são acessados para instalação ou alterados. Arquivos
de aprovação e binários sintéticos são dados de fixture; a identidade do Python
real é usada para exercitar `main()` com `--check` e `--apply`. Isto não aprova
nenhum executável, workflow ou candidato para produção.

O caso nativo testa publicação parcial e retomada, fsync dos pais já existentes,
policy por último, registros preservados, idempotência, modos/owners reais,
symlinks/hardlinks, ancestry insegura, e rename com/sem conflito. Um observador
de chamadas Python verifica a ordem sem substituir funções ou syscalls. O Node
exige e exibe o JSON completo `native-trust-filesystem-proof`; resposta ausente,
incompleta ou saída antecipada falha. O sandbox é removido ao fim; SIGKILL pode
deixar somente esse diretório de fixture no runner descartável.

As demais provas portáveis da suíte continuam identificadas como doubles. Sucesso
de fsync/retomada **não simula power loss nem prova durabilidade de hardware**.
Não há Docker, serviços, contas ou sudoers novos. Este gate não qualifica o
launcher/sudo/SSH real da VPS, nem substitui registro autenticado e recovery.

Para `production:payload-v1 <commit> <run-id> <run-attempt> <api-image>
<cron-image> <cms-image> <candidate-artifact-id> <qualified-artifact-id>
<report-artifact-id>`, o wrapper de produção passa **uma única string**, sem
interpretação, para `/usr/bin/sudo -n --
/usr/local/libexec/ownerinc-payload-receive`. Argumentos adicionais do wrapper
são recusados. SHA isolado e `production:<sha>` continuam delegando ao receptor
comum sem sudo; staging não recebe esta rota.

O launcher `ops/payload-receiver-root.sh` é instalado root:root `0755` em
`/usr/local/libexec/ownerinc-payload-receive`. Exige UID/EUID zero e exatamente um
argumento; usa Bash em modo privilegiado, ambiente vazio com PATH/locale fixos
e `/usr/bin/python3 -I -S /usr/local/libexec/payload-receiver-admission.py payload
<argumento>`. `parse_request` do helper é a autoridade única da gramática: rejeita
roles desconhecidas, staging, campos extras e injeções antes de criar receipts.
Não há `eval`, sourcing de comando SSH nem concessão de shell/Python/env via sudo.

A preparação administrativa existente mantém os contratos
`ops/prepare-cms-infrastructure.sh --check` (default) e `--apply`. A partir de
checkout revisado sob ancestry root-protected, valida também os executáveis
fixos `/usr/bin/sudo` e `/usr/sbin/visudo`, fontes do launcher/wrapper e paths de
privilégio. `/etc/sudoers.d` deve existir protegido. O fragmento exato, publicado
como root:root `0440` em `/etc/sudoers.d/ownerinc-payload-receive`, é:

```sudoers
deploy ALL=(root) NOPASSWD: NOSETENV: /usr/local/libexec/ownerinc-payload-receive
```

O sudo autoriza somente esse executável fixo, sem wildcard de comando; a restrição
de quantidade/gramática dos argumentos pertence ao launcher/helper, não ao
matching de argumentos do sudoers. Não autoriza `sudo env`, shell, Python ou
comandos gerais. O usuário previsto é **deploy**; outra identidade de SSH exige
revisão explícita, não auto-descoberta. Esta regra não revoga eventuais permissões
pré-existentes mais amplas: a configuração efetiva de SSH/sudo precisa de revisão
administrativa antes de uso. Não se altera `authorized_keys` automaticamente.

O novo incoming é `/var/lib/ownerinc/payload-candidate/incoming`, root:root `0700`,
separado da árvore de aplicação pertencente a deploy. `--check` valida os segmentos
existentes, sem criá-los; `--apply` cria somente os ausentes. Symlink, ownership
ou modo inseguro existente é recusa, nunca chown/chmod de reparo. Nenhum ancestral
da aplicação é alterado. O helper mantém seus limites, retenção de evidência e
verificação de toda a ancestry root-protected.

Após todos os gates já existentes, a preparação preserva snapshots dos arquivos
anteriores, publica e revalida helper, incoming e launcher, valida o fragmento com
`visudo -cf` antes do rename atômico, e só então publica o wrapper de produção.
Falha de dependência não substitui os receptores anteriores. Interrupção pode
deixar dependências inertes já publicadas; reexecução é idempotente. Os hashes
dos helper/wrapper predecessores revisados são reconhecidos para esta atualização;
conteúdo desconhecido é recusado. Não há aprovação automática de fonte/candidate.

**Não executar como autorização de produção:** o pin de release/fonte antigo da
preparação permanece inalterado e bloqueia o host observado até o próximo bloco
de aprovação explícita de fonte. Este slice não instala toolchain/policy/records
do verifier em `/opt/ownerinc/lib/payload-candidate`; ausência deles continua
negando admission antes da extração. Mesmo uma admission válida termina em
`release_not_preflighted`, sem dispatch ao runtime. Instalação/rollback/readiness,
revisão nativa de sudo/SSH e aceite de produção permanecem pendentes.

O receptor serializa deploys com `flock`, confere SHA e conteúdo do archive,
resolve API e cron por digest imutável no GHCR e cria backup verificado de
PostgreSQL e uploads antes de interromper a release anterior. Em seguida aplica
migrations, sobe a nova release e valida HTTPS, readiness, conteúdo montado e
digest da API. Falha em qualquer gate restaura o banco quando necessário e
reativa a release anterior. O arquivo `current-release` só muda depois de todos
os gates aprovados.

Nenhum segredo de runtime, Firebase, SMTP ou banco é enviado ao GitHub: eles
continuam somente nos arquivos protegidos de cada VPS.

### Preparação P2: autoridade instalada e dispatch administrativo inativo

O perfil explícito `--profile preparation` de
`ops/provision-payload-candidate-trust.py` instala uma closure fixa e inerte.
Sem esse argumento, a CLI e o schema de candidate trust permanecem inalterados.
O **programa bootstrap deve ser autenticado administrativamente antes de root
executá-lo**; o digest independente da aprovação não autentica retroativamente
o programa que o verifica. Bundle recebido de candidato e `approvedRevisions`
da policy de admission não constituem autoridade para executar preparação.

Invocação administrativa, depois dessa autenticação independente:

```sh
/usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C \
  /usr/bin/python3 -I -S -B /root/approved/provision-payload-candidate-trust.py \
  --profile preparation --check --approval /root/approved/preparation.json \
  --approval-sha256 "$INDEPENDENT_APPROVAL_SHA256" --bundle /root/approved/preparation-bundle
```

`--apply` no **provisioner** publica apenas fontes/launcher/aprovação, nunca
executa o preparer. Usa os mesmos protected reads, snapshots retidos sob
`/var/lib/ownerinc/payload-candidate/trust-snapshots`, fsync e
`renameat2(RENAME_NOREPLACE)` do bootstrap existente. Destinos são ausentes ou
idênticos, sem reparo de conflitos. A aprovação é publicada por último, após
revalidar entradas e toda a closure. Retry reafirma durabilidade; não substitui
aprovação nem fonte já instalada diferente. Não há network ou execução de bundle.

Closure exata de 15 nomes no bundle e em `source.files`:

```text
ops/prepare-cms-infrastructure.sh
ops/prepare-cms-infrastructure-private.py
ops/payload-control-inventory.py
ops/payload-control-state.py
ops/deploy-from-ci.sh
ops/payload-receiver-admission.py
ops/payload-receiver-root.sh
ops/deploy-from-production-ci.sh
ops/payload-operations-guard.sh
ops/payload-control
ops/payload-control-runtime.py
ops/compose.payload.production.yaml
docker-compose.payload.yml
ops/prepare-cms-authenticated.py
ops/provision-payload-candidate-trust.py
```

Os arquivos vão para `/opt/ownerinc/lib/payload-preparation/<nome>`, exceto o
launcher, instalado em `/usr/local/libexec/ownerinc-payload-prepare.py`.
Código é root:root `0755`; Compose é `0644`; a aprovação protegida é `0600` em
`/etc/ownerinc/payload-preparation/production-approval.json`. Bundle tem somente
esses nomes, modos correspondentes e ancestry root-protected. Não inclui policy,
record, executáveis admission ou configuração de runtime: são trust separado.

O schema independente, fechado, é `schemaVersion: 1`,
`kind: ownerinc-payload-preparation-approval-v1`, `environment: production`,
`repository: OWNERINC/portal_ownerinc`, com:

- `source`: `commit` (40 hex; proveniência administrativa, **não prova de árvore
  Git**) e `files` (mapa exato dos 15 nomes para SHA-256).
- `hostBaseline`: `currentCommit`, `legacyImages` com digests imutáveis api/cron,
  `releaseComposeSha256`, `runtimeComposeSha256`, `releaseOverrideSha256`
  (hash ou null para ausência), `inventoryIdentity`, e `installedPredecessors`
  com `commonReceiver` obrigatório e `receiverHelper`, `productionWrapper`,
  `operationsGuard`, `cmsCandidate` como hash ou null.
- `admission`: `policySha256`, `archiveSha256`, `recordSha256`.

Campos extras, chaves duplicadas, tipos coercíveis e paths arbitrários não são
aceitos. O bootstrap valida baseline **apenas como schema**, não como observação
do host; tampouco autentica admission durante a publicação.

O launcher instalado aceita **`--check` ou `--apply`**, sob o mesmo ambiente vazio e
Python `-I -S -B`. Antes de importar qualquer helper da closure,
seu leitor stdlib verifica ancestry, ownership, modos, links, identidade e hashes
de todos os 15 arquivos. O launcher em execução é parte da confiança administrativa
prévia; seu próprio hash não é uma prova independente de si mesmo. Só então carrega
os bytes autenticados do suporte instalado, nunca módulos do checkout.

Depois autentica policy pelo hash aprovado e todos os tools/executáveis admission
antes de carregar bytes do verifier fixo. Reutiliza `validate_record`,
`verify_record_binding` e `verify_installed_tools` reais. O record é lido de
`/var/lib/ownerinc/payload-candidate/records/<archiveSha256>.<policySha256>.json`,
protegido e vinculado pelo hash independente. Mantém contrato qualificatório,
revision/workflow/repository bindings e `deploymentAuthorized: false`. O CMS
vem somente de `record.images.cms`; nenhum argumento fornece imagem alternativa.
Isto confia na origem administrativa/registrar do record protegido, não recria
artefatos CI, nem verifica bytes de archive ausentes.

Saída final JSON não qualificadora: `kind: payload-inactive-preparation`,
`mode: check|apply`, `hostBaselineChecked: true`, `archiveBytesChecked: false`,
`preparationExecuted: true`, `deploymentAuthorized: false`. `preparationExecuted`
indica que o preparer foi chamado, inclusive em dry-run; não significa instalação
de release nem ativação. Antes do JSON há os diagnósticos existentes do preparer.
Falha não emite report de sucesso. Nenhum banco ou serviço é iniciado.
Pins antigos de current release/CMS permanecem no caminho direto legado;
somente o caminho autenticado recebe valores da aprovação/record. Inventory,
state, guards e `release_not_preflighted` permanecem obrigatórios.
Aceite operacional continua sendo outro bloco. Provas portáteis usam doubles explícitos;
não qualificam instalação/root/SSH na VPS nem durabilidade sob power loss.

#### Gate de host sob lease (somente leitura)

Após autenticar fonte e admission, o launcher abre o **lock existente** em
`/opt/ownerinc/apps/portal-ownerinc-real/runtime/deploy.lock` com `O_RDWR`,
`O_NOFOLLOW` e `O_NONBLOCK`, sem `O_CREAT` ou `O_TRUNC`. Exige arquivo regular,
um link, owner root:root ou deploy `1000:1000`, modo `0600` ou `0644`, ancestry
segura, e identidade estável entre pathname/descriptor. O parent reserva FD9 somente se
estiver livre; descriptor preexistente não é adotado nem fechado. `flock(LOCK_EX |
LOCK_NB)` ocupado é recusa antes de ler o baseline. Revalida pathname/FD9 depois
de adquirir e ao terminar; `finally` libera somente sua própria lease e fecha FD9.
Ausência do lock é recusa, nunca criação automática.

Sob essa lease verifica paths fixos de produção, sem overrides de request:

- Pointer `current-release`, commit aprovado e formato API/cron de `.image-env`.
- Hashes dos Compose de release/runtime e presença/hash do override local
  `compose.ownerinc-vps.yaml`.
- Identidade do inventory fixo construído por `production_inventory`; se o
  inventory existir, exige bytes canônicos, schema e documento exatos. Owner de
  environment continua `1000:1000`, modo `0600`; nunca descobre política pelo host.
- Predecessores aprovados ou bytes desejados exatos para receiver/helper/wrapper,
  guard e CMS candidate; ausência só quando aprovada. Controles e overlay já
  publicados permanecem ausentes-ou-idênticos, sem adoção de bytes desconhecidos.
- Key e diretório de state ambos ausentes, ou ambos completos com inventory.
  Para state existente aceita somente os dois arquivos do journal inicial,
  HMAC/head íntegros e corpo **exatamente** schema-v2, preauthority/cold,
  sequence zero, authority legacy/epoch 1, workerHold true, admission open,
  sem intents, floor, proofs ou imagens planejadas. Sentinel admission-closed é
  recusado. Assinatura válida não autoriza estado operacional/migrado.

Helpers inventory/state vêm dos bytes já autenticados. O import adjacente do
state é ligado ao módulo inventory capturado por um import hook local ao módulo;
não reabre path de helper nem modifica importlib global. Usa `read_state` real
com `repair_head=False` e identity explícita, mantendo validação criptográfica
e do journal. A leitura de dados é substituída nesse módulo por uma leitura
limitada/estável; não há initialize, repair, create ou rewrite.

Dados deploy-owned usam API separada de leitura: owner exato `1000:1000`, modos
`0600`/`0644` (environment somente `0600`), tamanho limitado, NOFOLLOW, um link,
identidade antes/depois, ancestry root/deploy sem group/world write. State,
inventory e arquivos instalados exigem root:root e modos específicos. Isso não
relaxa o leitor root-protected da closure/admission. Valores privados não são
emitidos; dados observados e ausências são rechecados antes de devolver sucesso.

Este gate **não é preflight operacional completo**: não consulta DB/Docker,
não valida Compose por execução, nem atualiza/classifica credenciais CMS pelo
preparer. O campo de sucesso não é uma autorização reutilizável: cada execução
autentica e revalida novamente sob lease. O dispatch abaixo mantém a mesma lease
enquanto o preparer executa suas validações independentes e, somente em apply,
publica arquivos inativos.

O teste opcional Linux de flock usa syscalls reais de lock/FD9/replace, com
ancestry do diretório temporário explicitamente dobrada. **End-to-end nativo de
preparação permanece pendente**, inclusive baseline real e propriedade dos paths.

#### Dispatch e contexto autenticado

O parent autentica a closure, adquire a lease e repete autenticação e baseline.
Chama somente `/bin/bash --noprofile --norc` com o preparer instalado fixo,
`--authenticated-check|--authenticated-apply` e o SHA-256 da aprovação já lida.
Passa **FD9 com `pass_fds=(9,)`** e ambiente vazio com PATH/locale fixos; retém sua
cópia durante toda a execução, snapshots, publicações e saída do child. Revalida
ao retorno antes de fechar sua referência. No dispatch, inclusive em erro, o
parent não faz unlock explícito: se um helper descendente ainda possuir FD9 após
interrupção, a lease permanece até fechar a última referência. Isso não promete
rollback ou conclusão atômica sob interrupção; preserva exclusão entre operações.
Comando arbitrário, source path, CMS digest
e overrides de ambiente não são interfaces do launcher.

O child não abre novamente o lock e não chama unlock. Antes de executar helpers,
exige seu path instalado exato e consulta o launcher fixo com
`--verify-context <approval-sha256>`. O verifier exige root/ambiente isolado,
FD9 seguro ligado ao pathname, um probe de outra open-description bloqueado e
flock não bloqueante bem-sucedido no próprio FD9. Assim, FD aberto mas sem lease,
FD de outro inode ou descrição sem a lock exclusiva são recusados. O probe nunca
substitui FD9 e o verifier nunca libera a lease herdada.

Esse comando reautentica a aprovação, toda a closure, admission e host; o digest
passado prova continuidade, **não é credencial**. Não há confiança em `APPROVED=1`,
PID/parent observado, ambiente ou relatório anterior. Um administrador root pode
invocar a interface interna somente se todas essas autoridades independentes e
a lease também forem válidas; não se pretende criar isolamento contra root.

O protocolo é de oito linhas limitadas: approval hash, current commit, CMS image
do record, e hashes (ou `-` para ausência aprovada) dos cinco predecessores na
ordem commonReceiver/receiverHelper/productionWrapper/operationsGuard/cmsCandidate.
O shell valida quantidade e gramática, usa `mapfile` e atribuições, nunca `source`
ou `eval`. Reconsultas devem produzir exatamente os mesmos dados. São feitas
antes de snapshots/publicações e antes de atualizar environment/inventory/state;
os gates de secret parcial, URL canônica, preservação de credenciais, Compose,
inventory e integridade de state existentes continuam independentes.

No caminho autenticado helpers usam `/usr/bin/python3 -I -S -B` com ambiente
limpo. A operação interna fixa `--create-inventory <approval-sha256>` revalida
o contexto e executa `create` do inventory a partir dos bytes capturados da
closure autenticada, nunca do helper recém-publicado no runtime. Seus paths e
owner policy são constantes, sem argumentos externos; o helper publicado é
verificado separadamente. State initialization não é reparo: falha parcial é
recusada na próxima tentativa, sem reset automático.

`--check` executa apenas o caminho read-only do preparer (inclusive Compose
`config --quiet`); `--apply` publica arquivos, configuração privada e estado
inativos. Não faz Docker pull/up/run, migrations, alteração de authority, serviços
ou authorized_keys. Falhas de dependência preservam os receptores anteriores;
retry aceita somente predecessor aprovado ou bytes desejados, preservando secrets.
O path direto `prepare-cms-infrastructure.sh --check|--apply` mantém os pins antigos
e não ganha autoridade por ambiente ou flags forjadas.

Os testes de transporte executam o shell e o protocolo reais com doubles
explícitos de host/autenticação/processo; no Windows FD9 é transportado no mesmo
shell de fixture. O teste Linux opcional usa subprocesso real e `pass_fds`, testa
ausência de deadlock e confirma que o child não libera a lock do parent. Isso não
substitui a qualificação nativa completa de preparação, ainda pendente.
