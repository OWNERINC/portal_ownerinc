# Runtime Payload e recuperação coordenada

Estado: artefatos locais da Task13/extensão operacional, sem instalação na VPS.
Receiver/forced-command efetivamente instalados **não verificados nesta rodada**.
Não executar deploy, comandos SSH, cutover ou alterações de serviços sem autorização.

## Stack opcional e credenciais

`docker-compose.payload.yml` é acrescentado à stack Portal. Sem esse arquivo,
API/cron continuam independentes do CMS em autoridade `legacy`. A API recebe
`CMS_INTERNAL_URL`; o CMS consulta o Portal por HTTP privado, nunca pelo PortalDB.
`cms-postgres` usa PostgreSQL16, banco `ownerinc_cms`, sem porta publicada.
Persistência: `cms_postgres_data` e `cms_uploads_data`, separadas dos volumes antigos.

`cms-provision` recebe somente credencial administrativa e senhas dos papéis;
`cms-migrate` recebe `cms_migrator`; web/worker recebem `cms_runtime`. Provisionamento
revoga CREATE/PUBLIC e concede privilégios existentes/defaults. Startup verifica
identidade/grants sem DDL. Migrations CLI terminam antes de web/worker. `push:false`
e ausência de `prodMigrations` permanecem obrigatórios; nenhum autoRun no web.

Imagem única `ownerinc-portal-cms@sha256:...` para todos os processos CMS. Dockerfile
multi-stage Node24 preserva CLI, tsx, configs e migrations; executa como `node`.
Volume CMS `/var/lib/ownerinc-cms/media` nasce com proprietário node e modo0700;
fica fora de `/app`, que é a raiz do código para o guard de storage, inclusive
quando Next muda `import.meta.url` no bundle. API legada mantém `/app/uploads`.
O journal de importação fica em `/var/lib/ownerinc-cms/media/.owner-news-import/`.
Volumes existentes
não são corrigidos por chmod/chown destrutivo automático. Validar permissões no
ensaio. Código compartilhado API/cron mantém APIs Node18, sem alegar que CMS seja
compatível com Node18. Arquivos Linux usam LF.

Build usa **contexto raiz** e `--file cms/Dockerfile`; preserva `/app/cms`,
`/app/scripts` e `/app/api`, com `WORKDIR /app/cms`. O ignore específico
`cms/Dockerfile.dockerignore` usa allowlist e tem precedência sobre `.dockerignore`
da raiz, que continua excluindo scripts para as outras imagens. Não usar contexto
`cms` nem `COPY . .` da raiz. Os módulos de bundle/export/import legado, validators
API e hashes CMS são copiados nos paths originais. `createRequire(api/package.json)`
resolve o grafo **API** instalado explicitamente por seu lockfile (`sharp`/`pg`);
não depende de hoisting do CMS nem de symlink entre grafos.

O guard de storage considera localização do módulo e cwd: com cwd `/app/cms`,
`runtimeCheckout` é `/app`, portanto `/app/uploads` também é inválido para os
assets CMS, inclusive quando Next altera `import.meta.url` no bundle. O volume CMS
fica fora desse root; `.owner-news-import/` fica dentro de
`/var/lib/ownerinc-cms/media`, junto aos bytes promovidos/ambíguos. Uploads Portal
continuam em `/app/uploads`. Nome de volume mantido; nenhuma movimentação de dados
ou mudança de container ocorreu nesta alteração de fonte.

O estágio runtime executará `scripts/check-runtime-packaging.mjs`: imports puros
de producer/consumer e decoding PNG sintético com sharp, sem inicializar Payload
ou conectar ao banco. O build/container real ainda exige lease; smoke local da
closure com dependências instaladas não comprova binários Linux nem imagem final.
CI/SBOM precisa abranger os dois grafos npm contidos na imagem CMS.

O overlay usa build de produção (`NODE_ENV=production`); sessões locais integradas
precisam de origem HTTPS/ingress local autorizado. Não habilitar cookie insegura
de produção para contornar isso. Firebase Emulator pode continuar sendo a fonte
de identidade sintética; o primary deve coordenar TLS e portas do ensaio.

Os placeholders em `.env.example` servem para **parse**, não execução. O
provisionador recusa senhas placeholder. Não imprimir `docker compose config`
com credenciais reais: usar `--quiet` ou parser com ambiente sintético.

## Proxy e CSP

Next16 `src/proxy.ts` gera nonce por request, sobrescreve headers não confiáveis
e entrega a mesma CSP ao request Next e à resposta. Preserva Origin em ações e
exceção service-only estreita. Nginx não emite segunda CSP editorial e mantém a
política do Portal nos demais paths. Headers comuns continuam herdados.

Somente criação news-media aceita51MiB; JSON editorial6MiB. Endpoints privados
com/sem barra e `/_next/image` estão bloqueados; `^~ /_next/` evita captura pelas
locations estáticas. Bytes privados/HTML/APIs continuam no-store.

**Pendente lease do primary:** build produção, Nginx real, nonce efetivo nos scripts
HTML/RSC/Server Actions, Firebase Emulator, logout/BFCache, uploads privados/Range,
Monaco/Lexical/worker CSP e restart. Unit não demonstra hidratação. Browsers
suportados ainda precisam de decisão/evidência; não existe matriz inventada aqui.

## Release e formato de backup

`.ci-images`: exatamente duas linhas API/cron para legacy; três API/cron/CMS para
Payload. `.image-env`: API_IMAGE/CRON_IMAGE, e para CMS também CMS_IMAGE e
RELEASE_FORMAT=payload-v1. Parser recusa duplicados, campos desconhecidos,
referências mutáveis ou CMS parcial. Não carregar manifesto por source/eval.

Conjunto legacy preservado: postgres.dump/uploads.tar.gz e manifest.sha256.
Conjunto payload-v1:

1. postgres.dump — PortalDB, autoridade e sessões;
2. uploads.tar.gz — todos os uploads legados;
3. cms-postgres.dump — conteúdo, jobs, versões, import/mutation ledgers;
4. cms-uploads.tar.gz — **todo** CMS_UPLOAD_DIR, inclusive `.owner-news-import/`,
   staging, promoções, órfãos e bytes com COMMIT desconhecido;
5. release.images, operations-proof.json e backup.format — metadados verificados;
6. manifest.sha256 — sete entradas exatas, incluindo todos os metadados acima.

Backup diário e pré-release usam o mesmo contrato. CMS não aplica expurgo automático
enquanto política coordenada/ambiguidades estiver pendente; legacy mantém14dias.
S3 só copia conjunto verificado; erro preserva cópia local. A agenda diária continua
com S3 desativado. Não alegar recuperação de perda da VPS por backup no mesmo host.

## Lease e barreira externa

`runtime/deploy.lock` é único para release/backup/restore/import/manutenção.
Coordenador abre fd9 e adquire flock antes de qualquer transação DB; filhos recebem
o descriptor e conferem inode, sem readquirir recursivamente. O wrapper diário já
é o coordenador e passa fd9 ao helper. Nunca remover/substituir esse lock.

Import/manutenção externos precisam entrar por `ops/payload-writer.sh`, em foreground,
antes de conectar ao banco. Seus filhos não podem daemonizar/fechar fd9 cedo. A
integração desses callers com threads3/4 ainda é necessária. Chamador que ignore
o protocolo invalida a garantia de quiescência.

`ops/payload-operations-guard.sh` fecha admissão por sentinel no mesmo runtime,
recusa writers/one-shots extras no projeto e exige adapter durável `runtime/payload-control`.
Serviços nginx/api/cron/cms/cms-worker são parados e aguardados fora de transações
DB. Só depois o adapter comprova finalização de jobs, ledger, epoch/manifest/selo,
reconciliando COMMIT desconhecido. Locks de banco isolados não congelam discos.

Ordem DB do controle: Portal7193029→autoridade→documentos→COMMIT; depois CMS7194030
com rechecagem e prova. Nenhuma transação Portal aguarda CMS. A lease operacional
permanece durante dumps sequenciais. Falha conserva evidência e admissão fechada;
estado de serviços deve ser inspecionado antes de recuperação explícita.

## Adapter de controle: dependência de integração bloqueante

O adapter `runtime/payload-control` **não é entregue como sucesso simulado**: depende
dos contratos reais de threads3/4. Ausência bloqueia operações CMS. Guard/adapter
devem ser instalados de artefatos revisados, com diretórios protegidos e proprietário
operador/root. O preparador limitado descrito abaixo não instala nem simula
`runtime/payload-control`.

Verbos invocados com `(ação, releaseAbsoluta, evidênciaOpcional)`: release-preflight,
close-admission, quiescence-proof, backup-metadata, restore-preflight, prepare-restore,
verify-restored, verify-release, rollback-check, open-admission.

- backup-metadata grava JSON privado no path fornecido: formato, identidade do
  conjunto, autoridade/epoch, manifesto, baseline/lastMutationId/selo, migrations,
  run e ambiguidades. Não escrever corpos/segredos. Esquema final depende do ledger.
- restore-preflight/prepare-restore validam floor/schema/digests, storage, inventário
  e objetos adicionais que `pg_restore --clean` não apagaria; devem recusar alvo
  incompatível, sem apagar dados por inferência.
- verify-restored revalida os quatro componentes, bytes/ledger/autoridade, suspensão
  das agendas e elegibilidade do selo antes de abrir admissão.
- rollback-check só aceita aplicação compatível com dados/schema atuais, mantendo
  Payload/autoridade. Manifest CMS→legacy é recusado; primeira instalação legacy
  exige prova de que autoridade continua legacy e nenhuma escrita ativa foi perdida.
- verify-release comprova digests de todos os processos e prontidão esperada para
  a fase. Não executar agendamento importado nem criar uma publicação para testar.

## Preparação inicial da infraestrutura de produção — inativa

`ops/prepare-cms-infrastructure.sh` prepara somente o receiver comum, o guard
revisado, o overlay de rede/limites Payload e a configuração privada CMS. Não é um
deploy nem um cutover; o arquivo versionado não prova instalação na VPS. O comando
tem alvos fixos e aceita somente `--check` (padrão, sem mudanças) ou `--apply`; não
aceita argumento de diretório/host alternativo.

O bundle revisado precisa manter juntos `docker-compose.payload.yml`,
`ops/prepare-cms-infrastructure.sh`, `ops/prepare-cms-infrastructure-private.py`,
`ops/deploy-from-ci.sh`, `ops/payload-operations-guard.sh` e
`ops/compose.payload.production.yaml`. Antes de aplicar, confirme o bundle/commit e
execute:

```sh
sudo bash ops/prepare-cms-infrastructure.sh --check
sudo bash ops/prepare-cms-infrastructure.sh --apply
```

Requer Linux, Bash, Python 3, `flock`, utilitários GNU (`install`, `sha256sum`,
`mktemp`, `mv -T`) e o plugin Docker Compose. O preparador exige que o `current-release`
continue exatamente em `d285029970c82d48cd50cc393a054af4cbfdf1e8`, com `.image-env`
API/cron de duas linhas, e que o receiver comum instalado continue root:root,
0755, SHA-256 `30be4941fe15c1c75e16175625685e2f51acc6ceaa52db146d61684cdacce0f7`.
Mudança de release/receiver, symlink, diretório/file inseguro, URL pública não
canônica, credenciais parciais/inválidas/duplicadas ou configuração Compose inválida
aborta antes da escrita.

O Compose é validado com `docker compose config --quiet`, combinando base da release
atual, `docker-compose.payload.yml` do bundle revisado, o mesmo override de produção
efetivo que o receiver selecionará (`current-release/compose.ownerinc-vps.yaml` quando
existir como arquivo regular protegido; caso contrário `runtime/compose.production.yaml`)
e o overlay Payload novo. Um override release-local existente que seja symlink, não
regular, hardlinkado ou gravável por grupo/outros é recusado, nunca ignorado em favor
do fallback. O parser recebe o arquivo de ambiente de produção em modo privado e
valores sintéticos CMS para a validação; não imprime configuração, URL, segredo ou
comando SQL. Não há `docker pull`, `up`, `run`, `exec`, migration, database,
container, service restart, systemd/timer ou mudança de release atual.

Com `--apply`, o preparador abre o `runtime/deploy.lock` existente sem truncar,
adquirindo `flock` antes de escrever. Preserva esse inode; nunca o remove. A
substituição atômica do `production.runtime.conf` mantém bytes anteriores, uid/gid e
modo existentes (neste host, operador uid 1000 e modo 0600); a instalação não muda
permissões de usuário. Sem nenhuma das nove chaves CMS exigidas, gera senhas admin,
migrator e runtime e `PAYLOAD_SECRET`/chaves de serviço com 32 bytes aleatórios
distintos. URLs usam `cms-postgres:5432/ownerinc_cms` e os roles correspondentes.
Um conjunto existente completo e válido é preservado sem rotação; qualquer conjunto
parcial, duplicado ou inválido é recusado, sem `source`/`eval` do arquivo e sem
imprimir valores.

O snapshot imediatamente anterior fica em
`/opt/ownerinc/backups/portal-ownerinc/production/cms-infrastructure-preparation-<UTC>-<UUID>`
com diretório 0700. Guarda somente o receiver anterior, o guard anterior quando
existente, o arquivo de ambiente privado (0600) e `metadata.json` com presença,
uid/gid/modo; não contém imagem, release, backup diário nem database dump. O caminho
é impresso antes da primeira instalação, também quando uma etapa posterior falhar.

Instala apenas `/usr/local/libexec/ownerinc-portal-deploy` (root:root 0755) e
`runtime/payload-operations-guard` (root:root 0755), além de
`runtime/compose.payload.production.yaml` e `runtime/cms-image-candidate.env`
(root:root 0644). Não instala um wrapper production novo, não altera `authorized_keys`
nem permissões/owner do override existente `runtime/compose.production.yaml`.
O manifesto de candidato contém somente `CMS_IMAGE=` para o digest revisado
`ghcr.io/ownerinc/ownerinc-portal-cms@sha256:6eaddc9a333ba682508a09a4ae8a6409d9e571abab9ec4a62829c2e9828730b0`; não é copiado para
`current-release/.image-env`, não adiciona `RELEASE_FORMAT`, nem promove release.

O receiver comum acrescenta o override novo somente para release `payload-v1` em
produção, depois do override normal, e falha se ele estiver ausente/for symlink.
Legacy API/cron e staging continuam no conjunto anterior de arquivos Compose. O
override mantém CMS/PostgreSQL/worker sem portas publicadas e somente na rede
`ownerinc-portal-backend` interna; Nginx permanece na topologia já configurada. Aplica
limites de CPU/memória, `no-new-privileges` e logs locais limitados. Não muda
autoridade, formato de backup, retenção ou agenda diária.

Mesmo após sucesso, a preparação está **inativa**. A saída deixa explícito que
`runtime/payload-control` continua ausente (ou, se já existir, não é validado nem
invocado), API v2 compatível e Task15 permanecem pendentes e CMS/worker não foram
iniciados. Nenhum placeholder `payload-control` é criado. Esses gates requerem revisão
e autorização separadas antes de qualquer release CMS.

### Rollback manual da preparação inativa

Use o caminho privado impresso pelo instalador como `BACKUP_DIR`. Só faça este
rollback enquanto o `current-release` ainda aponta para o SHA legacy acima, Payload
não foi implantado e nenhuma outra operação/alteração de configuração está em curso.
O comando reabre o mesmo lock, repõe receiver/guard/environment a partir dos backups
e restaura owner/mode do ambiente conforme `metadata.json`; nunca mexe no lock,
override preexistente, current-release, manifesto de imagem, banco ou serviços. Se o
guard anterior estava ausente, o guard revisado recém-instalado é deixado inerte.
Overlay e manifesto CMS novos também permanecem inertes sob o receiver antigo.

```sh
BACKUP_DIR='/opt/ownerinc/backups/portal-ownerinc/production/cms-infrastructure-preparation-<UTC>-<UUID>'
sudo bash -s -- "$BACKUP_DIR" <<'BASH'
set -Eeuo pipefail
backup=$1
root=/opt/ownerinc/apps/portal-ownerinc-real
runtime="$root/runtime"
expected="$root/releases/d285029970c82d48cd50cc393a054af4cbfdf1e8"
[[ $backup =~ ^/opt/ownerinc/backups/portal-ownerinc/production/cms-infrastructure-preparation-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || exit 2
[[ -d $backup && ! -L $backup && -f $runtime/deploy.lock && ! -L $runtime/deploy.lock ]] || exit 2
lock_identity=$(stat -Lc '%d:%i:%h' "$runtime/deploy.lock")
[[ ${lock_identity##*:} == 1 ]] || exit 2
exec 9<>"$runtime/deploy.lock"
[[ ! -L $runtime/deploy.lock && /proc/$$/fd/9 -ef $runtime/deploy.lock && $(stat -Lc '%d:%i:%h' /proc/$$/fd/9) == "$lock_identity" ]] || exit 2
flock -n 9 || { echo 'Another coordinated operation holds the lock.' >&2; exit 3; }
[[ ! -L $runtime/deploy.lock && /proc/$$/fd/9 -ef $runtime/deploy.lock && $(stat -Lc '%d:%i:%h' /proc/$$/fd/9) == "$lock_identity" ]] || exit 2
[[ -f $root/current-release && ! -L $root/current-release && $(<"$root/current-release") == "$expected" ]] || exit 2
python3 - "$backup" <<'PY'
import json, os, shutil, stat, sys, tempfile

if os.geteuid() != 0:
    raise SystemExit('Rollback requires root.')
backup = sys.argv[1]
backup_info = os.lstat(backup)
if stat.S_ISLNK(backup_info.st_mode) or not stat.S_ISDIR(backup_info.st_mode) or (backup_info.st_uid, stat.S_IMODE(backup_info.st_mode)) != (0, 0o700):
    raise SystemExit('Unsafe private rollback directory.')
metadata_path = os.path.join(backup, 'metadata.json')
metadata_info = os.lstat(metadata_path)
if stat.S_ISLNK(metadata_info.st_mode) or not stat.S_ISREG(metadata_info.st_mode) or metadata_info.st_nlink != 1 or (metadata_info.st_uid, stat.S_IMODE(metadata_info.st_mode)) != (0, 0o600):
    raise SystemExit('Unsafe rollback metadata.')
with open(metadata_path, encoding='utf-8') as stream:
    metadata = json.load(stream)
targets = {
    'receiver': ('ownerinc-portal-deploy', '/usr/local/libexec/ownerinc-portal-deploy'),
    'guard': ('payload-operations-guard', '/opt/ownerinc/apps/portal-ownerinc-real/runtime/payload-operations-guard'),
    'environment': ('production.runtime.conf', '/opt/ownerinc/secrets/portal-ownerinc/production.runtime.conf'),
}
if set(metadata) != set(targets):
    raise SystemExit('Unexpected rollback metadata fields.')
restore = []
for key, (backup_name, target) in targets.items():
    record = metadata[key]
    if not record['present']:
        continue
    if set(record) != {'present', 'uid', 'gid', 'mode'} or not all(type(record[name]) is int and record[name] >= 0 for name in ('uid', 'gid')) or not isinstance(record['mode'], str) or len(record['mode']) != 4 or any(char not in '01234567' for char in record['mode']):
        raise SystemExit('Invalid rollback metadata record.')
    source = os.path.join(backup, backup_name)
    source_info = os.lstat(source)
    target_info = os.lstat(target)
    if stat.S_ISLNK(source_info.st_mode) or not stat.S_ISREG(source_info.st_mode) or source_info.st_nlink != 1 or (source_info.st_uid, stat.S_IMODE(source_info.st_mode)) != (0, 0o600):
        raise SystemExit('Unsafe rollback source.')
    if stat.S_ISLNK(target_info.st_mode) or not stat.S_ISREG(target_info.st_mode) or target_info.st_nlink != 1:
        raise SystemExit('Unsafe rollback target.')
    restore.append((key, source, target, record))

# Validate every source and target before changing any of them.
for key, source, target, record in restore:
    fd, temporary = tempfile.mkstemp(prefix='.cms-preparation-rollback.', dir=os.path.dirname(target))
    try:
        with os.fdopen(fd, 'wb') as output, open(source, 'rb') as saved:
            shutil.copyfileobj(saved, output)
            output.flush()
            os.fsync(output.fileno())
        os.chown(temporary, record['uid'], record['gid'])
        os.chmod(temporary, int(record['mode'], 8))
        os.replace(temporary, target)
        directory_fd = os.open(os.path.dirname(target), os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(f'Restored {key}; secret values were not displayed.')
PY
BASH
```

This file rollback restores only host preparation files; it is not a release/data
rollback and must not be used after Payload traffic or authority changes.

## Restauração e floor

Restore CMS recusa backup legacy; release legacy recusa backup CMS. Hashes e paths
de tar são conferidos antes de mutação; links/devices/traversal são recusados.
Gera backup de proteção completo sob a mesma lease, sem reaquisição/S3, restaura
ambos os bancos e ambos os storages, reaplica grants/migrations e exige prova do
adapter. CMS restaura ownership `cms_migrator`; runtime permanece sem DDL.
Em falha, writers ficam parados e proteção é preservada. Não reativar agendas
importadas vencidas/ator desconhecido sem revalidação/decisão formal.

Cutover só depois de floor Payload compatível instalado/ensaiado, Task9 resolvida,
prepare→reconcile→seal→activate integrado e recuperação real comprovada. Selo
vincula baseline/última mutação/epoch/manifesto; editar/desfazer também o invalida.
Não há fallback automático para legacy nem rollback parcial de dados após tráfego.

## Evidência exigida no ensaio autorizado

Bases/volumes novos distintos da amostra; migrations repetidas; DDL negado ao runtime;
Portal disponível com CMS desligado em legacy; worker único; permissões de storage;
backup/restart/restore dos quatro componentes e staging/receipts; falha no meio do
restore; COMMIT desconhecido; hashes inválidos; floor inadequado; lock ocupado;
BFCache/sessão/nonce reais. Registrar comando/exit, commit/digests/ledgers/hashes,
tempos e serviços recuperados. Doubles não provam PostgreSQL, flock/Linux ou browser.
