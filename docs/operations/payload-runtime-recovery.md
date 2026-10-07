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
operador/root; nenhum script aqui instala arquivos no host.

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
