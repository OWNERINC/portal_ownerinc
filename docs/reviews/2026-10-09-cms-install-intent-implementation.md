# CMS install intent — recorte retomável, ainda fenced

## Design e plano aprovado, execução inline

Recorte escolhido dentro da autorização: primeiro entregar o contrato assinado
e o verificador de retry até provisionamento; não ligar um receiver parcial.
O verifier/register de candidato pertence à outra frente e não é substituído
por flag, shape JSON, digest isolado ou autorização sintética neste código.

Alternativas consideradas: (1) ligar instalação e rollback completos agora,
misturando qualificação, B1, pointer e readiness ainda não revisados; rejeitada;
(2) adicionar somente enum provisioned, que adotaria resíduos sem origem; rejeitada;
(3) intent assinado com marcos e retry de fronteira verificado, mantendo a entrada
operacional fechada até integração revisada; escolhida conforme fallback autorizado.

Arquitetura: o helper state guarda binding imutável de candidato, release anterior,
B0, identidade do inventário, inode da lease e alvos físicos. O runtime revalida
essas observações antes de aceitar retry. As primitivas não fazem grants, Docker,
migrations, publicação, troca de pointer ou validação de qualificação. Somente
o futuro coordenador confiável poderá reservá-las/chamá-las; não há CLI que
aceite JSON arbitrário para criar intent. Receiver atual recusa entrada Payload
antes de efeitos sobre serviços, tanto deploy quanto already-current.

Arquivos owned: `ops/payload-control-state.py`, `ops/payload-control-runtime.py`,
`ops/deploy-from-ci.sh`, `ops/payload-operations-guard.sh`, teste novo
`tests/unit/payload-install-transition.test.mjs` e este documento. Fixtures,
comparador de recuperação, CI, candidate verifier/register e diagnósticos de outras
frentes não serão editados.

- [x] Testar journal real assinado, binding exato, marcos pré/pós, retry após
  falhas, migração v1 segura e rejeição de state incompatível sem reset.
- [x] Implementar schema v2/state machine, sem limpeza de intent ou evidências.
- [x] Implementar recheck readonly de retry: ownership, lease, B0, pointer,
  imagens, alvos, quiescência, grant floors restritos por marco.
- [x] Bloquear receiver não integrado e atalhos verify-release/open/rollback
  durante instalação ou restore pendentes.
- [x] Focused, verify, security e diffcheck; registrar limites e interface.

## Fronteiras adiadas deliberadamente

Commit do floor compatível, troca atômica do pointer com intent de recuperação,
rollback pré-floor com recreate das imagens anteriores sob fence e readiness,
rollback pós-floor sem downgrade, captura B1/quatro-stores e recovery com admission
fechada são próximos gates; **não estão habilitados por esta entrega**. Qualquer
falha ou intent pendente conserva dados/evidências e admission fechada. Não apagar
CMS para tornar retry cold. Resíduo criado antes de binding físico assinado não
é automaticamente adotado: continua bloqueado para reconciliação revisada.

Autoridade continua `legacy/1`; worker hold permanece permanente. Nenhum finalizer,
protocolo News v1/v2, ativação editorial ou prova de runtime é produzido aqui.

## Interface entregue para review

### Persistência e migração

Novos estados usam `schemaVersion: 2` e `installIntent: null`. O leitor aceita
somente shapes exatos v1/v2, com validação HMAC e encadeamento íntegro. V1 não ganha
campo silenciosamente: `upgrade_install_schema(directory)` acrescenta uma entrada
v2 apenas para cold sem plano/provas/rollback/restore/floor, preservando chave e
envelopes anteriores. V1 ambíguo/ativo é recusado com `invalid_cold_state`; schema
desconhecido ou downgrade é recusado. Não há CLI de migração nem reset automático.

`reserve_install(directory, binding, proof, proof_sha256)` e
`advance_install(directory, binding, stage, cms_target=None)` são **primitivas
internas de persistência**, não API de autorização. O chamador futuro deverá
validar bytes/binding do candidato, B0, source, lease e alvos reais antes de
chamá-las e observar/verificar o efeito antes do pós-marco. Qualificação de
admission é gate externo do deploy de produção, não pré-requisito do produtor
de recovery Task 3: exigir o relatório que ele ainda produzirá seria circular.
Nenhum comando externo aceita JSON para criar ou avançar intent nesta entrega.

Binding fechado:

```text
candidate: commit, runId, runAttempt, images(api/cron/cms),
           candidateSha256, reportSha256, qualificationSha256, bundleSha256
candidateRelease: releases/<commit>
sourceRelease: releases/<SHA anterior distinto>
previousImages: api/cron imutáveis
b0: directory, proofSha256
inventoryIdentity: SHA256 do inventário protegido
lease: device, inode
portalTarget: database(systemIdentifier/databaseOid/databaseName),
              volumes(portalPostgres/portalUploads: name/driver/mountpoint/fingerprint)
```

`installIntent` contém `binding`, `stage`, `cmsTarget`. Binding nunca muda no
intent e evidências nunca são limpas pelo avanço. `cmsTarget` começa null e ganha
somente o registro explícito do criador em `cms_resources_bound`, com identidade
do banco e fingerprints dos dois volumes CMS. Depois é imutável. Um retry não
aprende esse registro de um recurso encontrado. A futura criação precisa de
reconciliação revisada para a janela efeito→registro; até lá o resíduo é recusado,
inclusive em `cms_resources_pending`. Labels/nomes esperados não bastam.

### Marcos e grants

| Marco | Status | Recheck de grants Portal |
| --- | --- | --- |
| `reserved` | cold | legado completo |
| `portal_grants_pending` | cold | legado completo OU v2 completo |
| `portal_grants_verified` | cold | v2 estrito |
| `cms_resources_pending` | cold | v2 estrito; nenhum CMS residual sem binding |
| `cms_resources_bound` | cold | v2 estrito; alvos CMS físicos exatos |
| `cms_provision_pending` | cold | v2 estrito |
| `provisioned` | provisioned | v2 estrito e verifiers readonly de roles CMS |

Avanços são adjacentes; retry do mesmo marco é idempotente e não acrescenta
entrada. Saltos, downgrade, troca de binding/alvos e remoção do intent são
recusados, inclusive por `transition()` genérico. `provisioned` **não** é floor
compatível comprometido: não tem releaseImages ativo nem catálogo nativo aceito;
schema/migrations/protocolo/News/roles finais ainda precisam do gate posterior.

### Adaptador e fence

`install-retry-check RELEASE B0_DIRECTORY` revalida, sob a lease herdada:
environment owner aprovado, manifest/release root-protegidos e imagens, pointer
ainda no sourceRelease, proof B0 assinado/artefatos/manifest/tar, lease exata,
identidade/fingerprints/mounts/volumes, containers, worker hold e quiescência DB.
Recompara dados Portal e uploads vivos contra B0. Uploads usam imagem fixa com
rede desligada, pull never e mount read-only, sem entrypoint candidato. O recheck
provisioned chama apenas `--verify-control` e `--verify-migrator`, nunca um fallback
de provisionamento. Esses subprocessos são instrumentados em testes; não foram
executados contra um runtime real.

Esse comando não requalifica candidato/report/bundle nem emite permissão de
próximo passo. Na fronteira de deploy de produção, o futuro coordenador deve
consumir o contrato revisado do verifier/register; os campos acima não autorizam
payload só por serem digests bem-formados. O produtor isolado de recovery deve
executar o candidato ainda não qualificado para gerar evidência, sem requisito
circular, PASS sintético ou skip flag. O binding específico desse initializer
(incluindo a representação de evidências ainda não produzidas) é interface futura,
não preenchimento com digests inventados do contrato atual.

Depois da verificação de ownership/lease/inventário, a construção do Runtime pode
completar apenas a janela de um único append totalmente assinado cujo head ficou
na entrada imediatamente anterior. Verifica toda a cadeia, inventoryIdentity e
semântica de cada par anterior→seguinte antes de repor o head; nunca trunca,
salta duas entradas, aprende chave ou muda
intents. Leitura comum não repara; registros parciais, assinatura inválida,
inventário divergente e janela não única falham fechados. Testes injetam falha
antes do append e entre append/head em todos os marcos.

`install-receiver-preflight` retorna sempre `release_not_preflighted`; não há flag
de bypass. Receiver o chama antes de pulls/substituição de release/backup/DB/
serviços e no ramo already-current antes de curls/recreate. Geração de staging e
metadados de recebimento ainda pode ocorrer; são distintos de efeitos no runtime.
Não existe janela de pointer publicada por este recorte. Pointer candidato durante
retry provision-only é recusado, não é aceito como sucesso.

`verify-release` exige migrated sem install/restore intent e não apaga restore
intent. Cold/provisioned não passam por esse atalho. Cold rollback/open antigos
foram fechados: enquanto recreate fenced, imagens anteriores e readiness não
estiverem implementados/revisados, não se concede retorno ao legado. Estado
migrated conserva o gate que proíbe target legado; rollback pending restore é
recusado. Isto é preservação do fence, **não implementação completa do rollback**.

## Dependências comunicadas ao primary

1. Candidate verifier/register da outra frente: conectar comprovante qualificado
   na fronteira de deploy de produção e revalidar bytes/identidades; nenhum PASS
   fake. Não impor esse comprovante ao produtor de recovery ou a todo preflight.
2. Criador CMS: fechar a janela de criação/binding sem adoção automática de
   resíduos, com recuperação/reconciliação explicitamente revisada.
3. Coordinator: marcos antes/depois dos comandos, roles/grants e falhas reais;
   esta entrega não invoca comandos de provisionamento.
4. Floor/pointer/rollback: transação de publicação retomável, sem fallback legado
   após compromisso do floor; antes dele, retorno só com prova de compatibilidade,
   imagens anteriores recreadas fenced e readiness/imagens/estado conferidos.
5. B1 quatro-stores e recovery fechado: continuam gates posteriores; nada deste
   patch captura B1 ou libera exposição/admin/cron normal.
6. Harness Task 3 que usa `verify-release` para promover source cold continua
   bloqueado. Próxima interface: initializer isolado confiável e commit de floor,
   com binding real do candidato/provas/source/lease e o mesmo kernel de estado;
   admission de produção exige qualificação no gate externo. Não reabrir cold
   `verify-release`, não adicionar skip flag nem exigir qualificação prévia ao
   produtor que a gera. Essa interface não foi implementada nesta correção.

## Verificação e limites — 2026-10-09

- Novo teste de transição: **11 PASS**, zero skips/falhas.
- Focused ownership/controller/preparação/diagnostics/operations, antes das duas
  regressões finais adicionais: **50 PASS, 3 skips**, zero falhas; as duas novas
  regressões passaram também no teste novo e no verify final.
- `npm run verify` final: Portal **1.655 PASS, 7 skips**, zero falhas; CMS offline
  **448 PASS, 11 skips**, zero falhas; syntax/types/security/Compose e `verify: ok`.
- `npm run security`: zero vulnerabilidades reportadas em API, cron e CMS.
- Scanner separado e `git diff --check`: PASS. Python AST e LF: PASS.

Execuções globais anteriores detectaram e ajudaram a corrigir dois erros locais
de teste/código. Também observaram falhas fora do escopo: deadline sintético de
0,1s do hold e contrato de network da frente funcional; ambos passaram em
focused e no verify final, sem edição desses arquivos por esta sessão.

Os novos testes usam journal/HMAC/arquivos reais e observações DB/Docker/lease
simuladas; teste de receiver executa stanzas extraídas com recusa real do gate,
mas wrapper sintético explícito, sem alegar receiver/host reais. Windows não
comprova uid/gid, fsync e flock Linux; teste chown real da entrega anterior ainda
é skip nesta plataforma. Os skips CMS incluem PGlite opcional e fsync/symlink.

Sem commit/push/CI/SSH, operações DB ou mudanças em containers/volumes/serviços/
produção. Verify usou apenas Docker Compose config read-only, além de fixtures
locais de testes. Checkout concorrente: contagens refletem o checkout observado,
não um commit isolado. Entrega pronta para review, não alegação de SHIP do recorte
nem de primeiro deploy executável.

## Fresh review — fechamento do replay semântico

Achado confirmado e corrigido nesta passada delimitada: `read_state()` verificava
HMAC/shape/inventory/parent, mas não o contrato de transição aplicado na escrita.
Assim, um filho assinado com corpo individualmente válido poderia receber head
reparado apesar de violar as regras do install intent.

`validate_state_transition(old, new)` é agora o **único validador compartilhado**
anterior→seguinte, chamado por `transition()` antes do append e por `read_state()`
em cada par da cadeia, antes de qualquer write de reparo. Conserva adjacency,
binding/alvo imutáveis, proibição de remoção do intent e migração estreita v1→v2;
também fixa inventoryIdentity entre entradas e recusa regressão de migrated para
cold/provisioned. V2→v1 continua proibido. Entry zero mantém bootstrap legítimo
sem predecessor, com shape/HMAC/sequence/null parent verificados normalmente;
não há relaxamento de migração histórica nem novo endpoint.

As negativas usam envelopes **assinados com HMAC válido**, parent hash correto e
corpos individualmente aceitos, mas pares semanticamente ilegais: salto de fase,
mutação de binding, banco/volume CMS, downgrade v2→v1, remoção do intent, commit de
floor sem interface permitida, regressão/resurreição após migrated, upgrade v1
ativo ou com efeito extra e alteração de inventário. Ambos os caminhos recusam
com a mesma razão; nenhum append no caminho de escrita e nenhum reparo no replay.
Head/journal e todos os arquivos permanecem byte a byte, sem truncamento/rollback.
O replay recusa também head já igual ao filho inválido e janela posterior de
um neto válido: não basta validar somente o último par.

Os positivos cobrem um único filho unheaded e adjacente em todos os marcos,
bootstrap v1/v2, histórico v1 legítimo e upgrade estreito interrompido antes do
head. Só a cadeia integralmente válida pode completar a janela permitida.

Verificação desta correção:

- Teste de transição: **13 PASS**, sem falhas/skips (inclui 12 cenários semânticos
  negativos dentro da regressão de replay).
- Focused completo: **54 PASS, 3 skips**, zero falhas.
- `npm run verify`: Portal **1.657 PASS, 7 skips**; CMS offline **448 PASS,
  11 skips**; zero falhas; security/Compose e `verify: ok`.
- `npm run security`: zero vulnerabilidades reportadas API/cron/CMS.
- Python AST/LF e `git diff --check`: PASS.

**Handoff:** initializer isolado confiável + floorcommit são a próxima interface,
com candidate binding/provas/source/lease reais e o mesmo kernel. Task 3 é produtor
de qualificação e precisa executar o candidato não qualificado; impor consumo da
qualificação antes disso seria circular. Admission qualificada permanece somente
na fronteira externa de deploy de produção. Não foram adicionados requisitos de
qualificação a initialization/backup preflight, skip flags ou prova sintética.
O contrato dessa interface ainda requer design/review separado. Harness cold
`verify-release` continua incompatível de forma conhecida; receiver inativo,
cold verify fechado, B1/closed recovery ainda pendentes. Nenhuma ativação nesta
passada, nem CI/commit/push/SSH/produção/delegação.
