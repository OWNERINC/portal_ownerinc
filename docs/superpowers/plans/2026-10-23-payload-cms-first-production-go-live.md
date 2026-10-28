# Payload CMS — primeiro go-live em produção

> **SUPERSEDED PARA EXECUÇÃO:** preservado como histórico. O limite de 30 minutos
> deste plano foi substituído pelo protocolo Gate E aprovado, com deadline absoluto
> de até **60 minutos**, documentado em
> `docs/operations/owner-news-authority.md`.

> **Execução:** implementar este programa em PRs sequenciais, com um único
> implementador por fatia, revisão fresca e aceite da sessão primária. Não executar
> duas fatias mutáveis em paralelo. Cada PR deve manter produção fail-closed até o
> gate explicitamente indicado.

**Goal:** colocar o novo Payload CMS no live pela primeira vez, migrar e reconciliar
todo o acervo Owner News, manter o Portal público disponível, limitar o bloqueio de
escritas editoriais a 30 minutos e ativar o worker de agendamentos no mesmo cutover.

**Architecture:** usar implantação blue-green. Preparar banco, mídia, CMS web e
worker em um plano privado sem autoridade editorial; importar e validar o acervo em
sombra; durante o cutover, congelar somente escritas editoriais, aplicar o delta
final, selar o run e trocar a autoridade por CAS. Publicar rota e liberar worker
somente após confirmação durável. Antes de mutações nativas, rollback retorna ao
legado; depois delas, recuperação permanece no floor Payload e nunca descarta
edições.

**Tech stack:** GitHub Actions, Bash/Python operacional, Docker Compose, PostgreSQL
16, Payload/Next.js/TypeScript, API Express, Nginx e testes Node sem dependências.

---

## 1. Decisões aprovadas e limites

- O CMS é uma **primeira ativação**, não atualização de uma instância live.
- O Portal público deve permanecer disponível; não há promessa de zero erro por
  arquitetura, mas o corte não pode exigir parada global do Portal.
- Escritas de Owner News podem ficar bloqueadas por no máximo **30 minutos**.
- Migrar todo o acervo: publicações, drafts, versões, mídia original, datas,
  autores e agendamentos.
- O worker de agendamentos deve entrar ativo no mesmo cutover, em gate próprio.
- Usar somente recursos do Portal. Não alterar Ownerinc Brain,
  `ownerinc-novo-agente/`, n8n ou proxy compartilhado.
- Não usar SSH manual para contornar receiver, CI, leases, approvals ou admission.
- Não versionar segredos, dumps, conteúdo privado, URLs com credenciais ou dados de
  usuários. Relatórios públicos contêm apenas códigos, hashes, contagens e IDs
  operacionais sanitizados.
- Preservar os documentos identificados no backlog vigente, seus IDs, bytes,
  histórico, drafts e agendas. Nenhum cleanup de evidência em falha.
- `release_not_preflighted` só pode deixar de ser incondicional depois dos gates
  B0, instalação recuperável, B1 e reentrada fechada terem PASS nativo.
- Esta aprovação define o programa. Cada operação host-mutável usa lease nova e
  approval vinculada ao commit/candidato. O cutover exige um go/no-go explícito
  depois do ensaio, pois evidência antiga não autoriza bytes novos.

## 2. Estratégia de PRs e gates

| PR | Resultado | Produção ao final |
|---|---|---|
| 1 | Contratos B0 reais: source, segurança e fence | Somente observação; mutações recusadas |
| 2 | Backup/restore B0 e rollback legado | Somente prova; instalação recusada |
| 3 | Instalação recuperável, floor, B1 e dispatch | CMS privado/parado; sem autoridade |
| 4 | Estados operacionais e recuperação populated | CMS privado; authority legacy |
| 5 | Importador integral e reconciliação | Importação sombra; agendas suspensas |
| 6 | Cobertura, drain, seal, CAS e worker | Mecânica pronta; cutover ainda desautorizado |
| 7 | Ensaio blue-green completo | Candidato qualificável; produção inalterada |
| 8 | Wiring final do release e runbook | Job protegido pronto; sem execução automática |
| Operação | Go-live e observação | Payload ativo e worker liberado |

Não agrupar PRs para economizar ciclos. Uma PR posterior começa somente após merge,
CI verde, revisão fresca e atualização das evidências/pendências da anterior.

## 3. Comandos comuns de verificação

Executar em toda PR, além dos testes focados da tarefa:

```sh
npm run verify
npm run security
git diff --check
```

Quando houver alteração de imagem ou lockfile:

```sh
npm run sbom
CMS_BUILD_ONLY=true npm --prefix cms run build
```

Testes Linux/PostgreSQL/Docker que não puderem rodar localmente devem ser executados
no workflow candidato isolado. Registrar separadamente PASS, fail e skip; um double
ou teste offline nunca satisfaz gate nativo. Docker local ou produtivo só deve ser
acionado com autorização correspondente.

---

### Task 1: Congelar o contrato do go-live e a matriz de estados

**PR 1 — primeiro commit documental/contratual**

**Files:**
- Modify: `docs/operations/payload-pendencias-e-plano-de-conclusao-2026-10-14.md`
- Modify: `docs/operations/deployment.md`
- Modify: `docs/operations/payload-runtime-recovery.md`
- Modify: `tests/unit/payload-operations.test.mjs`
- Modify: `tests/unit/payload-control.test.mjs`

**Step 1: escrever testes de contrato que falham**

Cobrir a máquina de estados esperada, sem implementar transições ainda:

```text
legacy_active
  -> payload_installed_closed
  -> payload_importing_frozen
  -> payload_sealed
  -> payload_active_worker_held
  -> payload_active

qualquer estado ambíguo/desconhecido -> closed
```

Exigir invariantes:

- autoridade permanece `legacy` até CAS selado;
- CMS/worker não recebem tráfego antes de readiness e seal;
- agendas importadas entram `suspended`;
- worker só sai de held após aceite próprio;
- fallback para legacy é proibido após primeira mutação nativa;
- freeze editorial e quiescência de quatro stores são provas distintas.

Rodar:

```sh
node --test tests/unit/payload-operations.test.mjs tests/unit/payload-control.test.mjs
```

Confirmar RED por estados/transições ainda ausentes, não por erro de fixture.

**Step 2: documentar o contrato operacional**

Registrar os estados, atores autorizados, entradas, saídas, receipts e motivos de
recusa. Marcar explicitamente P2–P8/B0 como pendentes; esta tarefa não muda
`deploymentAuthorized`, `productionAuthorized` ou `release_not_preflighted`.

**Step 3: ajustar somente validadores puros necessários para materializar o contrato**

Não adicionar dispatch nem mutação. Testes devem provar que campos extras, estado
desconhecido, epoch regressivo, seal divergente e worker liberado cedo recusam.

**Step 4: verificar e commitar**

```sh
node --test tests/unit/payload-operations.test.mjs tests/unit/payload-control.test.mjs
npm run verify
git diff --check
git commit -m "docs(payload): freeze first go-live state contract"
```

---

### Task 2: Fechar B0-01–03 no host — source, segurança e fence

**PR 1 — commits operacionais seguintes**

**Files:**
- Modify: `ops/prepare-cms-authenticated.py`
- Modify: `ops/payload-production-observer.py`
- Modify: `ops/payload-control-inventory.py`
- Modify: `ops/payload-control-runtime.py`
- Modify: `tests/unit/payload-production-b0-verification.test.mjs`
- Modify: `tests/unit/payload-production-legacy-security-baseline.test.mjs`
- Modify: `tests/unit/payload-production-fence-observation.test.mjs`
- Modify: `tests/unit/payload-fence-topology.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/operations/deployment.md`

**Step 1: adicionar negativos antes da implementação**

Testar source/commit divergente, lease FD9 ausente/reutilizada, approval/policy/record
alterados, role/grant inesperado, rota não observada, proxy/túnel/processo host-native
fora da closure e observação velha. Em toda recusa, afirmar:

```text
destructiveOperationAuthorized=false
installationExecuted=false
deploymentAuthorized=false
```

**Step 2: implementar collector bounded autenticado**

Partir do envelope B0-01a existente. Vincular request/response a nonce, processo,
FD9, source, inventory e estado; limitar tamanho; usar arquivos root-owned com
`0700/0600`, no-follow e single-link. Observação manual copiada nunca vira approval.

**Step 3: implementar perfil pré-grants e fence externo**

Observar owners, ACLs/defaults, memberships, privilégios efetivos, consumidores de
roles e credenciais sem revelar valores. Cobrir ingress Docker, host e não-Docker
por rotas exatas e observer independente. Timeout, DNS, TLS ou 502 genérico não
contam como fechamento.

**Step 4: integrar ao modo candidate-only sem autoridade de deploy**

O workflow deve produzir artefatos sanitizados e continuar com deploy production
SKIPPED. Não habilitar receiver de instalação.

**Step 5: provar em Linux/root isolado e depois no host read-only**

```sh
node --test \
  tests/unit/payload-production-b0-verification.test.mjs \
  tests/unit/payload-production-legacy-security-baseline.test.mjs \
  tests/unit/payload-production-fence-observation.test.mjs \
  tests/unit/payload-fence-topology.test.mjs
```

Executar o workflow candidate-only. Depois, com approval/lease próprios, executar
somente coleta read-only no host e revisar o relatório sanitizado. Drift mantém o
programa bloqueado.

**Step 6: revisar e commitar**

```sh
git commit -m "feat(payload): qualify production source and fence"
```

**Gate PR 1:** B0-01, B0-02 e B0-03 aceitos; zero mutação produtiva.

---

### Task 3: Qualificar backup B0, schema e estratégia de ACL

**PR 2**

**Files:**
- Modify: `ops/payload-control-runtime.py`
- Modify: `ops/payload-control-state.py`
- Modify: `ops/backup-from-timer.sh`
- Modify: `tests/unit/payload-preauthority-snapshot.test.mjs`
- Modify: `tests/unit/payload-preauthority-snapshot-configuration.test.mjs`
- Modify: `tests/unit/payload-logical-snapshot.test.mjs`
- Modify: `tests/unit/payload-logical-snapshot-conversion.test.mjs`
- Modify: `tests/unit/payload-production-b0-verification.test.mjs`
- Modify: `docs/operations/payload-runtime-recovery.md`
- Modify: `docs/operations/deployment.md`

**Step 1: decidir B0-07 por evidência**

Capturar em fixture fiel os owners/ACLs/grantees necessários. Escolher exatamente
uma estratégia:

1. preservar owners/ACLs do archive; ou
2. `--no-owner --no-privileges` com reparo dirigido, enumerado e testado.

Não misturar estratégias. Registrar por que outros databases, grantees e
credenciais permanecem intactos.

**Step 2: escrever testes RED para os quatro stores e metadados**

O formato `payload-v1` deve conter exatamente:

- `postgres.dump`;
- `uploads.tar.gz`;
- `cms-postgres.dump`;
- `cms-uploads.tar.gz`;
- `release.images`;
- `operations-proof.json`;
- `backup.format`;
- `manifest.sha256` com as sete entradas de payload descritas no runbook.

Rejeitar symlink/hardlink, mudança após inspeção, sparse/xattr/ACL inesperado,
manifesto parcial, digest mutável, árvore fora de limite e schema divergente.

**Step 3: implementar captura B0 e comparação source-grounded**

Não generalizar o normalizador TEST de CHECKs. Comparar o schema real e recusar
qualquer delta não aprovado. O backup deve ser consistente e produzido somente
depois de fence válido e quiescência adequada.

**Step 4: provar restore em destino descartável**

Executar dois restores completos e independentes, medir duração real, comparar
fingerprints, IDs, bytes, grants e readiness privada. Preservar fixtures em falha.

```sh
node --test \
  tests/unit/payload-preauthority-snapshot.test.mjs \
  tests/unit/payload-logical-snapshot.test.mjs \
  tests/unit/payload-logical-snapshot-conversion.test.mjs \
  tests/unit/payload-production-b0-verification.test.mjs
```

**Step 5: qualificar rollback da aplicação legacy**

Subir imagens exatas API/cron/Nginx contra o restore em contenção de saídas externas;
provar autenticação privada, readiness, smoke, DB e uploads. Disponibilidade de
digest sem startup funcional não é PASS.

**Step 6: verificar e commitar**

```sh
npm run verify
npm run security
git diff --check
git commit -m "feat(payload): qualify b0 backup and legacy rollback"
```

**Gate PR 2:** B0-04–08 aceitos; rollback pre-floor medido; receiver ainda fechado.

---

### Task 4: Implementar instalação recuperável, floor e B1

**PR 3**

**Files:**
- Modify: `ops/payload-receiver-admission.py`
- Modify: `ops/payload-receiver-root.sh`
- Modify: `ops/payload-install-recovery-isolated.py`
- Modify: `ops/payload-control-runtime.py`
- Modify: `ops/payload-control-state.py`
- Modify: `ops/deploy-from-ci.sh`
- Modify: `tests/unit/payload-receiver-admission.test.mjs`
- Modify: `tests/unit/payload-install-initializer.test.mjs`
- Modify: `tests/unit/payload-install-transition.test.mjs`
- Modify: `tests/unit/payload-install-recovery.test.mjs`
- Modify: `tests/unit/payload-receiver-root.test.mjs`
- Modify: `docs/operations/payload-runtime-recovery.md`
- Modify: `docs/operations/deployment.md`

**Step 1: testar todas as fronteiras em RED**

Cobrir interrupção antes/depois de reserve, provisioning, criação de volumes,
containers parados, migrations, floor commit, B1, readiness privada e publicação.
Cada retomada usa processo e lease novos. Recursos sem receipt nunca são adotados.

**Step 2: conectar o installer ao binding produtivo**

Exigir B0 fresco antes da primeira mutação. Provisionar quatro containers/dois
volumes CMS com receipts. API, cron, CMS e worker candidatos permanecem parados.
Reentrada deve distinguir criado, confirmado, desconhecido e incompatível.

**Step 3: implementar floor e B1**

Após floor durável, criar backup B1 coerente dos quatro stores. Recuperação
pós-floor nunca restaura aplicação incompatível nem autoridade legacy sobre dados
nativos. `data_verified_readiness_pending` continua fechado.

**Step 4: substituir a negação incondicional por gate fechado**

Somente agora `install_receiver_preflight()` pode avançar quando **todas** as
evidências autenticadas do mesmo candidato, run, attempt, binding, B0 e recovery
estiverem presentes. Ausência, expiração, mismatch ou resultado desconhecido ainda
retorna `release_not_preflighted`.

Não criar flag manual que ignore checks.

**Step 5: executar recovery nativo**

```sh
PAYLOAD_REQUIRE_NATIVE_B0_RECOVERY=1 \
PAYLOAD_B0_RECOVERY_DISPOSABLE=1 \
node --test tests/unit/payload-install-recovery.test.mjs
```

Provar cenário pre-floor e pós-floor, duas restaurações e falhas injetadas. Ajustar
budget do job somente com duração medida; não aumentar timeout para esconder hang.

**Step 6: verificar e commitar**

```sh
node --test \
  tests/unit/payload-receiver-admission.test.mjs \
  tests/unit/payload-install-initializer.test.mjs \
  tests/unit/payload-install-transition.test.mjs \
  tests/unit/payload-install-recovery.test.mjs \
  tests/unit/payload-receiver-root.test.mjs
npm run verify
git diff --check
git commit -m "feat(payload): enable recoverable cms installation"
```

**Gate PR 3:** instalação privada recuperável; CMS sem rota/authority; B0-09 e P3
aceitos.

---

### Task 5: Estender estados operacionais e restore populated

**PR 4**

**Files:**
- Modify: `ops/payload-control-state.py`
- Modify: `ops/payload-control-runtime.py`
- Modify: `ops/payload-writer.sh`
- Modify: `tests/unit/payload-control.test.mjs`
- Modify: `tests/unit/payload-control-owner.test.mjs`
- Modify: `tests/unit/payload-coordinator-writer-resume.test.mjs`
- Modify: `tests/unit/payload-recovery-budget.test.mjs`
- Modify: `docs/operations/payload-runtime-recovery.md`

**Step 1: escrever transições e negativos**

Versionar separadamente host schema, install binding, fingerprint, protocolo V2 e
extensão operacional. Testar os estados definidos na Task 1 e recusar skip, replay,
epoch regressivo, proof antigo e combinação desconhecida.

**Step 2: implementar proofs assinadas e reentrada**

Cada transição grava intenção antes da mutação, confirma COMMIT durável e só então
avança estado. Resultado desconhecido fecha admission e requer nova sessão de
reconciliação; nunca repete mutação cegamente.

**Step 3: qualificar backup/restore populated e active**

Em Linux isolado, criar conteúdo, versões, mídia e agendas; executar backup e dois
restores; comparar os quatro stores e ledgers. Worker fica held. Simular falha após
mutação nativa e provar que recovery não faz downgrade para legacy.

**Step 4: verificar e commitar**

```sh
node --test \
  tests/unit/payload-control.test.mjs \
  tests/unit/payload-control-owner.test.mjs \
  tests/unit/payload-coordinator-writer-resume.test.mjs \
  tests/unit/payload-recovery-budget.test.mjs
npm run verify
git diff --check
git commit -m "feat(payload): add recoverable operational phases"
```

**Gate PR 4:** P4 aceito com restore populated/active; produção continua legacy.

---

### Task 6: Corrigir o importador integral e a reconciliação

**PR 5**

**Files:**
- Modify: `cms/src/migration/preparation-bootstrap.ts`
- Modify: `cms/src/migration/import-news.ts`
- Modify: `cms/src/migration/import-schedules.ts`
- Modify: `cms/src/migration/plan.ts`
- Modify: `cms/src/migration/destination.ts`
- Modify: `cms/src/migration/reconcile.ts`
- Modify: `cms/src/migration/ledger.ts`
- Modify: `cms/src/collections/NewsMigrationRuns.ts`
- Modify: `cms/src/collections/NewsSchedules.ts`
- Modify: `cms/tests/unit/news-import*.test.ts`
- Modify: `cms/tests/unit/news-protocol*.test.ts`
- Modify: `docs/operations/owner-news-payload-migration.md`

**Step 1: bootstrap controller com identidade real**

Testar e implementar RPC bootstrap com target físico e source instance distintos,
lock `7194030`, grants mínimos e COMMIT confirmado antes da transação Payload. O
runtime/importador não recebe INSERT direto indevido nas tabelas de controle.

**Step 2: corrigir runs e hashes**

Cobrir criação/atualização de `news-migration-runs`, inclusive `updatedAt`, por ACLs
e hooks reais. Alinhar projeções de hash esperada/observada sem confundir hash de
origem, snapshot histórico e representação nativa.

**Step 3: preservar semântica temporal e home**

Preservar `publishedAt` e precisão disponível; não fabricar publicação. Definir home
ausente como ausência explícita, não objeto vazio silencioso.

**Step 4: completar paginação e fidelidade**

Testar múltiplas páginas e volume acima do limite por consulta para documentos,
versions, histórico, mídia e agendas. Comparar IDs, contagens, bytes, referências e
hashes. Toda agenda importada entra `suspended` com provenance; ator desconhecido e
instante vencido ficam pendentes de decisão explícita.

**Step 5: executar integração PostgreSQL 16 com grants reais**

Usar staging privado durável e leases one-shot. Injetar COMMIT desconhecido e provar
reconciliação em request novo. Não apagar fixture nem repetir importação por timeout.

**Step 6: verificar e commitar**

```sh
npm run test:cms
npm run typecheck:cms
npm run verify
npm run security
git diff --check
git commit -m "feat(payload): reconcile complete owner news archive"
```

**Gate PR 5:** P5 e importação suspensa de agendas aceitos; comparação integral sem
divergências.

---

### Task 7: Implementar coverage, drain, seal e CAS de autoridade

**PR 6 — parte 1**

**Files:**
- Modify: `cms/src/publication/mutation-ledger.ts`
- Modify: `cms/src/publication/mutation-triggers.ts`
- Modify: `cms/src/publication/seal.ts`
- Modify: `cms/src/publication/authority.ts`
- Modify: `cms/src/publication/audit.ts`
- Modify: `cms/scripts/finalize-news-protocol.ts`
- Modify: `api/db/migrations/036_payload_editorial_control.sql`
- Modify: `tests/unit/editorial-control.test.mjs`
- Modify: `cms/tests/unit/news-mutation-ledger.test.ts`
- Modify: `cms/tests/unit/news-protocol-finalizer.test.ts`
- Modify: `docs/operations/owner-news-payload-migration.md`

**Step 1: provar cobertura de toda mutação**

Instrumentar e testar importação, manutenção, Payload API/admin e worker. Um valor
`coverage_version` observado não é certificação; o seal exige baseline persistido,
head/barrier esperados e ausência de writer não coberto.

**Step 2: implementar drain editorial com API viva**

Bloquear novas escritas, aguardar writers em andamento, manter endpoints de leitura
e health. Testar corrida entre última mutação, reconciliação e seal. Não confundir
esse drain com quiescência integral usada por backup.

**Step 3: implementar seal e CAS curto**

Vincular CAS a epoch, manifest, run e seal exatos. Gravar auditoria transacional.
Depois do CAS, exigir confirmação durável fresca antes de reabrir a barreira CMS.
Resultado desconhecido mantém escrita fechada.

**Step 4: verificar e commitar**

```sh
node --test tests/unit/editorial-control.test.mjs
npm run test:cms
npm run typecheck:cms
npm run verify
git diff --check
git commit -m "feat(payload): seal migration and switch editorial authority"
```

---

### Task 8: Qualificar decisões de agenda e liberação do worker

**PR 6 — parte 2**

**Files:**
- Modify: `cms/src/migration/import-schedules.ts`
- Modify: `cms/src/publication/schedule.ts`
- Modify: `cms/src/jobs/publish-snapshot.ts`
- Modify: `cms/src/collections/NewsSchedules.ts`
- Modify: `cms/tests/unit/news-schedule-worker.test.ts`
- Modify: `cms/tests/integration/task6-worker.config.ts`
- Modify: `cms/tests/integration/task6-native.ts`
- Modify: `ops/payload-control-runtime.py`
- Modify: `tests/unit/payload-coordinator-writer-resume.test.mjs`
- Modify: `docs/operations/payload-owner-news.md`

**Step 1: definir decisão por agenda importada**

Cada agenda recebe uma decisão auditável: ativar no instante futuro preservado,
cancelar/rejeitar, ou criar successor explícito. Agendas vencidas não executam em
rajada nem inventam ator; exigem decisão registrada.

**Step 2: testar idempotência e concorrência**

Cobrir dois workers, restart, lease expirada, job duplicado, edição posterior,
snapshot divergente, agenda vencida e resultado desconhecido. A chave de execução
deve impedir publicação duplicada.

**Step 3: criar gate próprio de worker**

Após authority CAS e smoke editorial, validar decisions/successors, adquirir lease
nova e liberar worker. Falha mantém Portal/CMS ativos com worker held e gera estado
operacional explícito; não reverte authority automaticamente.

**Step 4: verificar e commitar**

```sh
npm run test:cms
node --test tests/unit/payload-coordinator-writer-resume.test.mjs
npm run verify
git diff --check
git commit -m "feat(payload): gate imported schedule activation"
```

**Gate PR 6:** P6/P7-01/P7-03 implementados, mas produção continua sem cutover.

---

### Task 9: Construir o ensaio blue-green de ponta a ponta

**PR 7**

**Files:**
- Modify: `scripts/test-payload-integration.mjs`
- Modify: `cms/tests/integration/run-task9.mjs`
- Modify: `cms/tests/integration/task9-browser.mjs`
- Modify: `cms/tests/integration/task9-destination-acceptance.mjs`
- Modify: `tests/unit/payload-functional-matrix.test.mjs`
- Modify: `tests/unit/payload-functional-runtime.test.mjs`
- Modify: `tests/unit/payload-functional-isolation.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/reviews/2026-10-02-payload-owner-news-acceptance.md`

**Step 1: substituir o placeholder `npm run test:payload`**

Manter guard de alvo descartável. O runner real deve criar namespace isolado,
restaurar B0, instalar Payload, importar acervo de fixture representativa, aplicar
delta, selar, trocar authority e liberar worker. Nenhuma conexão remota permitida.

**Step 2: executar jornada browser nativa**

Com Portal/Firebase/PostgreSQL/CMS/Nginx reais no fixture:

1. login no Portal;
2. acesso a `/editorial/admin`;
3. criação de notícia do zero;
4. upload e leitura dos bytes originais;
5. draft e autosave;
6. consulta e restore de Versions;
7. publicação;
8. leitura em sessão independente no Portal;
9. execução de uma agenda aceita pelo worker;
10. confirmação de ausência de duplicação.

Não substituir dependência real por double não declarado.

**Step 3: ensaiar falhas e rollback**

Injetar falha em backup final, delta, seal, CAS, readiness, publicação da rota,
smoke e liberação do worker. Antes da primeira mutação nativa, provar fallback
legacy; depois, provar recuperação no floor Payload. Medir freeze editorial e
exigir `<= 30 minutos`.

**Step 4: publicar evidência sanitizada no candidate-only**

O workflow deve gerar report assinado/vinculado aos três digests e manter deploy
production SKIPPED. Artefato de falha é preservado com `always()`, mas elegibilidade
de release exige sucesso direto dos jobs obrigatórios.

**Step 5: verificar e commitar**

```sh
npm run test:payload
npm run verify
npm run security
npm run sbom
git diff --check
git commit -m "test(payload): qualify blue green cms cutover"
```

**Gate PR 7:** P7-02 aceito e ensaio completo dentro da janela; sem produção.

---

### Task 10: Integrar release `payload-v1` ao deploy protegido

**PR 8**

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `ops/deploy-from-production-ci.sh`
- Modify: `ops/deploy-from-ci.sh`
- Modify: `ops/compose.payload.production.yaml`
- Modify: `nginx/nginx.conf`
- Modify: `tests/unit/cms-image-pipeline.test.mjs`
- Modify: `tests/unit/operations-invariants.test.mjs`
- Modify: `tests/unit/payload-candidate-admission.test.mjs`
- Modify: `tests/unit/payload-candidate-qualification.test.mjs`
- Modify: `tests/unit/payload-candidate-package.test.mjs`
- Modify: `docs/operations/deployment.md`

**Step 1: adicionar contratos RED do job de go-live**

Exigir três digests imutáveis API/cron/CMS, candidate/qualified/report artifact IDs,
commit/run/attempt exatos, environment protegido e concurrency de produção.
Rejeitar PR, ref não-main, modo conflitante, validação/candidato incompleto,
cancelamento e approval antigo.

O deploy CMS não deve ser acoplado ao push normal de `main` antes do primeiro
cutover. Usar dispatch explícito e protegido para o go-live; push normal continua
com contrato API/cron vigente até a ativação ser concluída e documentada.

**Step 2: transportar `payload-v1` sem tag mutável**

O archive e `.image-env` devem carregar API/cron/CMS por digest. Receiver valida os
mesmos bytes já admitidos. Não fazer `source`/`eval` do manifesto nem permitir path
fornecido pelo caller para verifier/policy/record.

**Step 3: separar instalação, cutover e rota**

O job protegido chama fases receipted; não executa shell arbitrário. Nginx mantém o
Portal público e só publica `/editorial` quando CMS privado está ready e authority
foi confirmada. Se publicação de rota falhar, não liberar escrita/worker.

**Step 4: preservar deploy normal e rollback existente**

Garantir que API/cron legacy continuam com backup, migration, smoke, retry e rollback
inalterados. Testar matriz extraída do YAML, não uma cópia independente da policy.

**Step 5: verificar e commitar**

```sh
node --test \
  tests/unit/cms-image-pipeline.test.mjs \
  tests/unit/operations-invariants.test.mjs \
  tests/unit/payload-candidate-admission.test.mjs \
  tests/unit/payload-candidate-qualification.test.mjs \
  tests/unit/payload-candidate-package.test.mjs
npm run verify
npm run security
git diff --check
git commit -m "feat(ci): wire protected payload production cutover"
```

**Gate PR 8:** P8-01 pronto. Fazer revisão final de todo o programa e abrir PR. O
merge não dispara automaticamente o primeiro cutover.

---

### Task 11: Qualificar o candidato final e emitir go/no-go

**Operação pré-go-live; sem edição de código durante a janela**

**Step 1: gerar candidato final**

Executar `publish_candidate_only=true` no commit exato que será implantado. Registrar:

- SHA de 40 hex;
- digests API/cron/CMS;
- workflow run/attempt;
- IDs de candidate, qualification e recovery report;
- PASS/fail/skip de cada prova;
- versão do contrato de state/coverage/protocol.

**Step 2: confirmar infraestrutura e baseline**

Com leases novas, executar observação read-only de source, segurança, fence,
inventory, capacidade, disco, clocks e grants. Confirmar imagem CMS disponível por
digest e backups sem expor conteúdo.

**Step 3: repetir ensaio com bytes finais**

Executar exatamente as imagens finais em fixture Linux equivalente, incluindo dois
restores, browser, worker e falhas injetadas. Qualificação anterior de outro SHA é
inválida.

**Step 4: reunião go/no-go**

Checklist obrigatório:

- [ ] PRs 1–8 mergeadas e CI verde;
- [ ] candidato final e artefatos vinculados;
- [ ] B0/B1 e restores PASS;
- [ ] freeze medido abaixo de 30 minutos;
- [ ] backup/storage disponível;
- [ ] editor de aceite e leitor independente disponíveis;
- [ ] rollback pre-floor e recovery pós-floor entendidos;
- [ ] nenhum drift de source/security/fence/inventory;
- [ ] nenhum alerta high/critical ou finding de revisão aberto;
- [ ] autorização explícita para executar o dispatch protegido.

Qualquer item ausente resulta em **NO-GO**. Não corrigir código durante a janela;
cancelar, abrir nova PR e qualificar novo candidato.

---

### Task 12: Executar o primeiro cutover em produção

**Operação protegida**

**Step 1: iniciar e manter o Portal em legacy**

Acionar o dispatch protegido com os seletores exatos do candidato. Adquirir lease.
Instalar CMS blue-green privado, banco e mídia; manter rota pública fechada, worker
held e authority legacy. Confirmar readiness privada.

**Step 2: importar acervo em sombra**

Executar importação base e reconciliação enquanto o Portal continua disponível.
Nenhuma divergência de IDs, bytes, contagens, referências, versões ou agendas pode
ser aceita. Falha encerra antes do freeze.

**Step 3: iniciar freeze editorial**

Registrar timestamp monotônico. Bloquear somente criação/edição/publicação de Owner
News; manter leituras e demais áreas do Portal. Drenar writers em andamento e provar
o fence antes de qualquer etapa destrutiva.

**Step 4: backup final e delta**

Capturar backup coordenado `payload-v1`, validar manifestos e restaurabilidade;
importar delta final; reconciliar novamente. Seal só pode usar o run/delta exatos.

**Step 5: selar e trocar authority**

Executar seal, CAS curto `legacy -> payload`, confirmação durável fresca e auditoria.
Se o resultado do COMMIT for desconhecido, manter escrita fechada e reconciliar em
nova sessão; nunca repetir CAS cegamente.

**Step 6: publicar rota e smoke antes de reabrir**

Publicar `/editorial` para o CMS ready. Executar:

- health/readiness públicos e privados;
- login Portal real;
- upload original;
- draft/autosave;
- Versions e restore;
- publicação;
- leitura independente no Portal;
- validação de TLS, headers, assets e permissões.

Falha antes de mutação nativa permite fallback legacy testado. Falha depois de
mutação nativa usa recovery Payload; não fazer downgrade de autoridade que descarte
edições.

**Step 7: liberar worker e reabrir escritas**

Validar decisões/successors das agendas, liberar worker por gate próprio e observar
uma execução controlada sem duplicação. Reabrir barreira editorial. Registrar fim do
freeze e recusar conclusão se duração exceder 30 minutos, ainda que o serviço esteja
funcional.

**Step 8: marcar deployment**

O GitHub deployment só recebe `success` depois de smoke editor/reader e worker. Em
qualquer falha, registrar `failure`, preservar receipts/logs sanitizados e executar
o caminho de recuperação correspondente.

---

### Task 13: Monitorar, reconciliar e entregar handoff

**Files:**
- Modify: `docs/operations/deployment.md`
- Modify: `docs/operations/payload-pendencias-e-plano-de-conclusao-2026-10-14.md`
- Modify: `docs/reviews/2026-10-02-payload-owner-news-acceptance.md`
- Add: `docs/reports/YYYY-MM-DD-payload-first-production-go-live.md`

**Step 1: observar imediatamente**

Durante a primeira hora, conferir 5xx, restarts, readiness, DB pool, disco, mídia,
auth, erro do worker, jobs duplicados, barrier/head e leitura Portal. Não consultar
ou copiar conteúdo privado para o relatório.

**Step 2: reconciliar novamente**

Após cutover e após a primeira execução do worker, comparar baseline selado,
contagens, IDs, versões, bytes/hashes de mídia, agendas e audit ledger. Divergência
abre incidente e congela novas escritas; não aplicar reparo silencioso.

**Step 3: atualizar o contrato de deploy normal**

Somente após estabilidade, decidir em PR posterior se pushes normais de `main`
passam a implantar o trio API/cron/CMS. Não fazer essa mudança dentro da janela do
primeiro go-live.

**Step 4: registrar handoff**

Documentar sem segredos:

- commit e três digests implantados;
- run/attempt e artifact IDs;
- deployment ID e tempos medidos;
- epoch/state/coverage/protocol finais;
- evidência do editor, leitor e worker;
- localização **privada** de backups/receipts, sem seu conteúdo;
- incidentes, skips e pendências residuais;
- decisão sobre monitoramento prolongado.

**Step 5: verificação documental final**

```sh
npm run verify
git diff --check
git commit -m "docs(payload): record first production go live"
```

## 4. Critério de conclusão global

O novo CMS só está live quando todos os itens abaixo forem verdadeiros:

- P1–P8 e B0/B1 aceitos para os bytes finais;
- Portal público permaneceu disponível durante o corte;
- freeze editorial medido em até 30 minutos;
- authority Payload confirmada em epoch esperado;
- `/editorial/admin` funciona via HTTPS com login Portal real;
- criação, upload original, draft/autosave, Versions/restore e publicação passam;
- leitor independente apresenta exatamente a publicação;
- todo o acervo e mídia foram reconciliados sem perda;
- agendas possuem decisão auditável e worker está ativo sem duplicação;
- backup final foi validado e recuperação compatível permanece disponível;
- GitHub deployment está `success` e o handoff foi registrado.

Readiness isolada, imagem publicada, admin aberto, teste offline, relatório SHIP ou
importação sem autoridade **não** completam o objetivo.

## 5. Referências obrigatórias durante a execução

- `docs/operations/payload-pendencias-e-plano-de-conclusao-2026-10-14.md`
- `docs/operations/payload-runtime-recovery.md`
- `docs/operations/deployment.md`
- `docs/operations/owner-news-payload-migration.md`
- `docs/operations/owner-news-import.md`
- `docs/operations/owner-news-payload-read-bridge.md`
- `docs/operations/payload-owner-news.md`
- `docs/reviews/2026-10-02-payload-owner-news-acceptance.md`
- `docs/reviews/2026-10-08-payload-native-admin-acceptance.md`
- `docs/superpowers/plans/2026-10-13-payload-production-execution.md`
- `docs/superpowers/plans/2026-10-13-payload-receiver-admission.md`
