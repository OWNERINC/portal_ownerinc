# Monitoramento operacional do Portal — OWN34

## Estado desta entrega

Checkpoint do núcleo em 2026-11-02: coletor de host protegido, runner de email
sem privilégios, outbox durável e observações próprias da API implementados.
**Não representa conclusão integral do OWN34 nem aceite de produção.**

As verificações CMS/ponte/barreira continuam `unknown / contract_missing`.
Instalação, credenciais, Compose, integração CMS, qualificação nativa e recebimento
humano permanecem pendentes. Nenhum serviço ou email real foi executado localmente.
O plano completo e suas restrições estão em
[`../superpowers/plans/2026-11-02-portal-operational-monitoring.md`](../superpowers/plans/2026-11-02-portal-operational-monitoring.md),
com cópia idêntica em
`C:/Users/Criação/.opencode/plan/2026-11-02-portal-operational-monitoring.md`.

## Fluxo e limites de confiança

1. `ownerinc-portal-monitor.timer` solicita um ciclo a cada 60 segundos, começando
   30 segundos após o boot.
2. `ownerinc-portal-observe.service`, root com sandbox, verifica o inventário e o
   estado assinado pela closure instalada/revisada, com `repair_head=False`.
   Lê o lock existente com lease compartilhada não bloqueante; disputa produz
   `observation_busy`. Não chama controlador, Docker, launcher ou readiness CMS.
3. O coletor observa mounts, recibos locais e propriedades fixas das duas unidades
   de backup. Publica apenas `observations/host.json`, fora de provas/journals de
   controle. Esses dados nunca autorizam operações ou qualificam recuperação.
4. `ownerinc-portal-monitor.service` roda como `portal-monitor`, sob `flock`, lê o
   arquivo protegido e consulta o endpoint HTTPS fixo da API. Usa `Wants=` e
   `After=` para o coletor, **sem `Requires=`**: falha do coletor ainda deixa o
   runner executar e alertar.
5. O runner persiste incidentes/outbox antes do SMTP e registra entrega somente
   após aceitação confirmada. Não depende do PostgreSQL para deduplicação.

Os alertas já existentes de saúde do worker continuam em `cron/health.js`.
O novo runner não importa o entrypoint cron, Firebase ou `cron/db.js`.

| Limite | Valor implementado |
| --- | --- |
| Coletor | alarme interno 9 s; unidade 10 s + parada 1 s; memória 256 MiB |
| Runner | unidade 37 s + parada 1 s; ciclo com coletor limitado a menos de 50 s |
| HTTP | 5 s por requisição; cancelamento; redirects nunca seguidos |
| Observação API | transação até 8 s; statement 1500 ms, lock 200 ms, query 2000 ms |
| SMTP | conexão/greeting 5 s; socket 10 s; deadline total 20 s |
| Payloads | observação 16 KiB; texto do email 8 KiB; estado 256 KiB |
| Validade | observação até 120 s; tolerância futura 5 s; replay não crescente recusado |

Se a API não responde, seus checks tornam-se `application_unavailable / unknown`.
Se a leitura própria falha, a API informa `database_unavailable / unknown`; isso
não diagnostica uma queda do banco. Ausência de ambos os lados não vira uma
afirmação de falha do PostgreSQL.

## Instalação/configuração ainda pendente

Os arquivos abaixo descrevem o contrato da instalação a ser feita pelo responsável
operacional. Esta entrega não cria usuário, instala arquivos, habilita timers ou
modifica os serviços existentes.

### Identidade, arquivos e permissões

Provisionar usuário/grupo de serviço `portal-monitor`, sem privilégios ou grupos
de Docker/controle. Usar caminhos canônicos locais, sem symlinks, com ancestrais
protegidos contra escrita por grupo/outros. Os testes Windows não qualificam
essas permissões Linux.

| Caminho | Proprietário/modo esperado |
| --- | --- |
| `/etc/ownerinc/portal-monitor.json` | root:root, 0600 |
| `/etc/ownerinc/portal-monitor-mail.env` | root:root, 0600; lido por systemd |
| `/opt/ownerinc/lib/portal-monitor/{cron,ops,verifier}` | root, código/dependências sem escrita pelo runner; diretórios 0755 e arquivos 0644 são suficientes |
| `/var/lib/ownerinc-portal-monitor` | root:portal-monitor, 0750 |
| `.../observations` | root:portal-monitor, 2750 |
| `.../observations/host.json` | root:portal-monitor, 0640 |
| `.../observations/backup.json` | root:portal-monitor, 0600; runner não lê recibos privados |
| `.../delivery` | portal-monitor:portal-monitor, 0700 |
| `.../delivery/state.json`, `cycle.lock` | portal-monitor:portal-monitor, 0600 |

Instalar os cinco módulos cron deste lote e as dependências **já travadas** no
lockfile cron na árvore instalada; não iniciar `cron/index.js`. Instalar o coletor
em `.../ops/portal-operational-observe.py`. A closure `.../verifier` contém somente
as versões revisadas de `payload-control-state.py` e
`payload-control-inventory.py`; seus hashes entram no arquivo de configuração.
O coletor usa Python isolado (`-I -S -B`) e verifica os hashes antes do import.
Mudanças nesses módulos exigem nova revisão dos adaptadores e novos hashes.

A identidade do inventário deve corresponder ao inventário protegido em
`/opt/ownerinc/apps/portal-ownerinc-real/runtime/payload-control-inventory.json`.
O runtime é fixo; a configuração não seleciona comandos, controladores ou targets.
O runner não recebe chaves HMAC, credenciais CMS-controller ou acesso ao runtime.

### Configuração do coletor

`portal-monitor.json` tem exatamente as chaves:

- `schemaVersion`: inteiro `1`.
- `inventoryIdentity`: SHA-256 hexadecimal do inventário aprovado.
- `verifierSha256`: objeto com as duas chaves de nomes de arquivo da closure e
  respectivos hashes SHA-256 revisados.
- `mounts`: exatamente `postgres`, `portal_uploads`, `cms_uploads`, `backups`,
  `monitor`. Cada entrada tem somente `path`, `mountPoint`, `device`.

`path` é o diretório host efetivo; `mountPoint` é o mount governante real, e
`device` é seu `st_dev` inteiro. Aprovar a correspondência com os volumes reais.
`/` só é válido quando for de fato o mount governante aprovado; nunca é fallback
para um mapeamento ausente. Flags vêm de `/proc/1/mountinfo`, evitando confundir o
`ProtectSystem=strict` privado com filesystem host somente leitura.

O JSON é canônico: UTF-8, chaves ordenadas recursivamente, separadores `,` e `:`,
sem espaços extras, terminando em LF; equivalente a
`json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n'`.
Não usar valores exemplificativos como identidade/hash/device de produção.

### Ambiente do runner e API

O arquivo systemd `/etc/ownerinc/portal-monitor-mail.env` deve fornecer somente
a configuração necessária:

- `PORTAL_PUBLIC_URL`: origin HTTPS aprovado, sem usuário/senha/query/fragmento
  ou prefixo de caminho. O runner acrescenta os paths fixos.
- `OPERATIONAL_MONITOR_TOKEN`: segredo novo, distinto de credenciais de browser,
  CMS e controle; 32–128 caracteres de `[A-Za-z0-9_-]`.
- `OPERATIONAL_ALERT_EMAIL`: destinatário já aprovado; um endereço, sem lista.
- `MAILER_SENDER_EMAIL`, `SMTP_ADDRESS`, `SMTP_PORT`, `SMTP_USERNAME`,
  `SMTP_PASSWORD`: configuração do transporte existente. Portas suportadas pelo
  CLI: 465, 587, 2525, 25. 465 usa TLS implícito; nas demais mantém a negociação
  STARTTLS do transporte existente, com verificação de certificado habilitada.

**Wiring exato pendente do primary:** transportar `OPERATIONAL_MONITOR_TOKEN` do
ambiente protegido aprovado para `api.environment.OPERATIONAL_MONITOR_TOKEN` no
Compose efetivo/gerador de ambiente da API; fornecer o mesmo valor ao arquivo
systemd do runner. Não inserir o token na imagem, frontend ou ambiente CMS; o
cron worker existente não precisa dele. Validar o encaminhamento HTTPS existente
para `/api/operational/observe`, preservando `Authorization` e `Cache-Control`.
A API permanece funcional sem o token; somente a observação responde 401.
O Compose base encaminha o token opcional exclusivamente à API; a declaração em
`.env.example` permanece vazia. O provisionamento protegido do runner e a
instalação das unidades continuam pendentes; detalhes em
[Deployment](deployment.md#monitor-operacional-own34--configuração-opcional-instalação-pendente).

Instalar as três novas unidades e qualificar usuário, paths, sandbox, lock,
timeouts e próximo disparo antes da ativação autorizada. A atualização do wrapper
de backup instalado também é pendente: ele opta pelos recibos ao encontrar
`/etc/ownerinc/portal-monitor.json`, com helper em caminho fixo. Preparar toda a
instalação antes de disponibilizar esse marcador; falha de recibo torna a execução
não bem-sucedida sem afirmar corrupção do backup.

## Observações da API e CMS pendente

`GET /api/operational/observe` exige `Authorization: Bearer <token>`. O handler
autentica por comparação constante de hashes antes de acessar dependências.
Recusa métodos alternativos, query, slash adicional, corpo/transfer encoding e
headers de contexto browser. Não recebe URL, ator, SQL, modo ou ação do caller.
Há uma observação concorrente por processo, com intervalo mínimo de 1 s.

A resposta `portal-operational-observation-v1` contém somente versão, fonte,
geração, timestamps e checks finitos; sem conteúdo, identidades ou erros brutos.
O schema exato está em `cron/operational-contract.js`.

Implementado:

- Leitura Portal usando transação `READ ONLY`, rollback e destruição da conexão
  em timeout, inclusive conexão adquirida tardiamente.
- Amostra de até três revisões legadas publicadas, com limites de bytes e
  validadores existentes. Os limites medem JSON serializado, não tamanho TOAST
  comprimido; conteúdo acima do budget fica `sample_limit / unknown`, não é
  diagnosticado como conteúdo inválido. Feed vazio válido é aceito. Não passa pelos GETs que
  promovem agendamentos nem toma locks `FOR UPDATE`/`FOR SHARE`.
- Releitura de autoridade ao final: mudança de modo/epoch torna a amostra
  `authority_changed / unknown`, sem inventar contradição estável.
- Sinais de respostas reais de feed e sessão/serviço editorial, incluindo 200
  degradado e 5xx. Janela de 5 minutos; restart é `coverage_gap`, falta de tráfego
  é `no_samples`. Esses sinais não são prova de sessão de navegador ponta a ponta.
- Recusas apenas do writer `legacy`, separadas de commits. Metadados não pessoais
  de tipo/mode/epoch entram na auditoria transacional existente, inclusive
  promoção/retirada de agendamentos. A leitura cobre até 200 eventos/24 h;
  limite ou eventos sem cobertura identificável ficam unknown. Um commit
  proibido observado tem precedência sobre o limite e fica latched no runner.

**Integração exata pendente do owner CMS:**

1. Implementar `cms/src/operational/observe.ts` e `signals.ts`, e o endpoint em
   `cms/src/endpoints/operational.ts`; registrar em `cms/src/payload.config.ts`.
2. Expor somente o `POST /editorial/api/portal-news/operational-observe` privado,
   com autenticação de serviço já existente e exceção exata em
   `cms/src/auth/service-access.ts`. Preservar o bloqueio público Nginx do prefixo.
3. Integrar em `cms/src/auth/portal-client.ts` a leitura autenticada de autoridade
   Portal. Retornar identidade/catalog/profile de banco, autoridade/mutation head
   e sinais finitos; sem probe de escrita em storage ou callbacks de publicação.
4. Após release/revisão do contrato, adicionar o client limitado em
   `api/operational/` e combinar ambas as observações em `observe.js`, com epoch
   coerente, diagnóstico finito e os mesmos budgets. Não reutilizar o preflight
   de ativação como prova de operação normal, nem editar os DTOs de conteúdo.

Até esse aceite, `cms_readiness`, `cms_bridge` e `authority_barrier` retornam
`contract_missing`. A amostra legada não qualifica feed Payload/dual-source.
Todos os arquivos CMS listados acima permanecem fora desta implementação.

## Fases de host e rota pública

O adaptador inicial suporta apenas estado assinado preauthority v1/v2, autoridade
legacy epoch 1, worker hold e os estágios explicitamente enumerados no coletor.
Cold/provisioned verificados produzem `planned_hold / degraded`, nunca saúde
normal. Apenas nesse caso o runner consulta `/editorial` e aceita exatamente
404 como hold observado. Não segue redirects, não envia token nessa requisição.

`migrated` não estabelece o estado da promoção independente da rota: retorna
`unsupported_contract` para host/public route, mantendo a comparação de admission
quando verificável. Recovery, fases/versões futuras e estágios desconhecidos
ficam unknown. Verificação criptográfica indisponível fica `state_unverified`.
São pendentes os adaptadores de recuperação pré-floor, lifecycle futuro e rota
promovida, com fixtures/contratos dos respectivos owners. Não há supressão
indefinida de alertas durante uma transição.

## Backup, capacidade e entrega

O wrapper grava início somente **depois do lock**; registra `verified` somente
após suas verificações de artefatos/hashes existentes, e `failed` no caminho de
saída. `backup.json` separa a última tentativa da última captura verificada.
Uma tentativa nova/running/failed não redefine a idade anterior.

RPO: **idade da captura maior que 24 h**. Usa timestamp UTC do diretório de
captura, não mtime ou horário da verificação. O coletor confere componentes,
digest do manifest e metadados protegidos dos artefatos; alterações/missing
invalidam a evidência cacheada. Não re-hasheia dumps inteiros a cada minuto.
Recibo ausente não prova sucesso; falha da unidade também gera falha da tentativa.
Timestamps do recibo são comparados ao relógio obtido depois da leitura: início
ou conclusão concorrente legítimos não viram `backup_invalid`; timestamps ainda
futuros nessa leitura continuam recusados.
O escopo é **local_only; S3 desabilitado**, sem promessa de restauração qualificada
ou cópia externa.

Capacidade usa o pior percentual entre bytes e inodes disponíveis: warning >=80%,
critical >=90%, recuperação abaixo de 75% em duas leituras. Mount ausente/device
divergente é unknown; filesystem read-only é falha imediata.

Incidentes comuns precisam de duas amostras ruins consecutivas, mesmo quando o
reason muda. `badCount` qualifica o incidente separadamente da estabilidade da
assinatura; alternar failed/unknown não reinicia essa contagem. Contradição estável
de autoridade/admission, commit proibido, backup inválido/falhado e disco crítico
são imediatos. Recuperação exige duas amostras frescas e limpas do check; unknown
não apaga falha/degradação anterior. Recuperação de um check não afirma que todos
os outros checks, particularmente CMS pendente, estejam saudáveis.

A outbox limita envio a um email agregado/ciclo. Cada transição qualificada é
persistida em FIFO, independentemente do envio ativo: um incidente B e sua
recuperação continuam retidos, nessa ordem, enquanto A aguarda retry. O ID é
atribuído ao enfileirar e preservado até a confirmação; a assinatura entregue
não substitui esse histórico. O schema de estado v2 valida razões como strings
primitivas em checks, outbox e fila, além da consistência entre a sequência
pendente e o estado atual.

Limite: uma mensagem ativa e **64 batches pendentes**, até um batch por ciclo e
um item por check no batch, mantendo o teto de estado de 256 KiB. Se uma nova
transição exceder esse limite, o runner preserva a última sequência completa e
seus checkpoints de fontes, persiste `queueOverflow=true`, emite somente o código
finito `monitor_queue_overflow` e falha sem enviar. O latch persiste entre restarts;
exige análise explícita da lacuna de cobertura e reconciliação da fila pelo
responsável, nunca limpeza automática do estado ou alegação de histórico completo.

Arquivos v1 válidos são convertidos para v2 preservando a mensagem in-flight/ID e
reconstruindo diferenças ainda representadas em current/delivered/outbox. A
conversão não recupera transições já perdidas pela implementação v1; não é prova
retroativa de cobertura. O estado convertido é persistido antes de qualquer envio.

Temporários tentam novamente
após 1, 5, 15 e até 60 minutos; permanentes após 60 minutos, ambíguos após 15.
Aceitação exige destinatário configurado na lista accepted, resposta SMTP final
2xx compatível e ausência de rejeitados/pendentes contraditórios. Promise resolvida
sozinha não é entrega. Timeout fecha transporte e destrói sockets rastreados.
O wrapper booleano de alertas existentes usa esse resultado detalhado e logs
finitos, sem mensagens brutas de erro.

Persistência usa arquivo temporário exclusivo, fsync, rename e fsync do diretório
no Linux. Estado inseguro/corrompido impede envio sem rastreamento. Não apagar
`state.json` para resolver alerta: isso perde deduplicação/evidência. O lock direto
de fixture não rouba locks abandonados; a unidade usa flock liberado pelo kernel.
Crash após aceitação SMTP e antes de persistir continua ambíguo; conserva ID e
adia retry. Message-ID estável ajuda, mas não garante exactly-once/inbox arrival.

## Verificação e gates restantes

Checkpoint inicial Windows/Node 24, offline com doubles e arquivos temporários
reais (antes da revisão corretiva abaixo):

```text
node --test tests/unit/operational-monitor.test.mjs tests/unit/operational-monitor-state.test.mjs tests/unit/operational-routes.test.mjs tests/unit/operational-observer.test.mjs tests/unit/cron-mail-transport.test.mjs
33 passed, 0 failed, 2 skipped

node --test tests/unit/cms-reader.test.mjs tests/unit/operational-timers.test.mjs
69 passed, 0 failed, 2 skipped
```

Os quatro skips são checks nativos Linux de permissões/recibos e flock/symlinks;
os testes de timers usam executáveis fake, sem Docker/serviços reais.
São 102 passes e 4 skips, sem afirmar toda a matriz do plano aprovada.

Revisão corretiva dos quatro findings (perda de transições durante backoff,
clock de recibo concorrente, razões coercíveis e qualificação de falhas alternadas):

```text
node --test tests/unit/operational-monitor.test.mjs tests/unit/operational-monitor-state.test.mjs tests/unit/operational-routes.test.mjs tests/unit/operational-observer.test.mjs tests/unit/cron-mail-transport.test.mjs
40 passed, 0 failed, 2 skipped
```

Este rerun focado cobre A pendente → B crítico → duas amostras limpas → restart →
entrega ordenada, overflow explícito persistido, upgrade de estado v1, tipos
primitivos em toda a fila e relógio avançando durante a leitura do recibo.
Os dois skips continuam sendo os fixtures nativos de permissões e recibos.
O verify completo da cópia imutável anterior, executado pelo primary, não é
evidência desses bytes novos; estes exigem re-review fresco. Não foi executado
verify amplo sobre o worktree concorrente nesta revisão.

`.github/workflows/operational-monitor-smtp.yml` adiciona workflow PR-scoped com
as mesmas actions pinadas do projeto. Roda suites offline, fixtures de host
protegidas, `systemd-analyze verify` e `tests/fixtures/operational-monitor-smtp.mjs`.
O fixture SMTP exige hosted Linux CI, ambiente explícito, loopback, destinatários
sintéticos `.test` e certificado descartável. Exercita runner/outbox reais,
aceitação/rejeição, fila multi-check durante backoff, dedup/recovery,
deadline/cleanup e rejeição de TLS inválido.
**Workflow/SMTP e qualificação nativa não foram executados nesta sessão.**

Ainda necessários: review fresco do primary; `npm run verify` completo após
estabilização concorrente; regressões de rotas com dependências/ambiente
autorizados; integração CMS/Compose descrita acima; instalação nativa e mounts
reais; comportamento efetivo das unidades; falha/recuperação controlada entregue
na inbox aprovada com confirmação humana; responsável operacional aceito; e
detecção independente off-host de perda total de VPS/rede. Autorização do
destinatário, aceitação SMTP, chegada à inbox e ownership são evidências distintas.
