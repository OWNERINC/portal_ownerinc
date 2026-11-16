# Pages v3 — preparação de deploy em 16/11/2026

## Estado desta rodada

**Preparação e conciliação local concluídas; revisão da sessão principal, CI nativo
e deploy pendentes.** O usuário autorizou “deploy” após o aceite
da prévia com as diferenças descritas. Este registro complementa o
[aceite de referência](2026-11-11-pages-reference-fidelity.md), cujo estado anterior
não incluía essa autorização. Não registra uma publicação concluída.

A sessão principal iniciou merge limpo de `origin/main` (`a0d85ef92a15bdc1300d8bd4033dab38def9276b`)
sobre `feat/conecta-pages-editor` (`f6d370237f98b25462f8b7b04c7b34b6715f1b1c`),
com `--no-commit --no-ff`. O índice do merge contém a atualização de cadastro
autorizada pelo usuário. Esta preparação acrescenta somente testes e evidência;
o índice, o cadastro, as capturas existentes e os arquivos operacionais foram
preservados. Integração, CI e operação pertencem à sessão principal.

## Gate nativo de aliases acrescentado

`scripts/test-migrations.mjs` chama `testPagesAliasConcurrency()` depois de aplicar,
repetir e verificar migrations. Isso utiliza os três passos de migrations já
existentes no CI PostgreSQL 16; não cria workflow nem serviço adicional.

`scripts/test-pages-alias-concurrency.mjs` usa o `pg.Pool` nativo e o `ensureSlug`
de produção. Reutiliza a autorização de ambiente descartável e confere a identidade
do cluster em cada conexão antes de criar fixtures. Exige PostgreSQL 16 e três PIDs
distintos: dois escritores transacionais e um observador.

- Mesma base, vencedor **COMMIT**: segundo escritor aguarda o advisory lock e
  recebe o sufixo determinístico com seu UUID.
- Mesma base, vencedor **ROLLBACK**: segundo escritor aguarda o mesmo lock e
  recebe a base livre; a inserção revertida não permanece.
- Bases diferentes concorrendo pelo mesmo sufixo, vencedor **COMMIT**: o índice
  real `pages_slug_unique_idx` bloqueia a segunda escrita e retorna SQLSTATE
  `23505`. O perdedor é revertido integralmente.
- Mesma colisão entre bases, vencedor **ROLLBACK**: o segundo escritor conclui
  usando o alias liberado.

Cada caso exige evidência de `pg_stat_activity`, lock não concedido em `pg_locks`,
lock correspondente concedido ao primeiro backend e `pg_blocking_pids`. O primeiro
escritor só é liberado depois dessa observação; esperar um tempo não é tratado como
prova. Os logs incluem os PIDs, tipo/evento de espera e bloqueador observado.

Há limites de conexão (5 s), observação (5 s), lock (10 s), statement (15 s) e
query do cliente (20 s). Rejeições pendentes são capturadas imediatamente. As
transações são revertidas em `finally`, as conexões próprias são encerradas e a
limpeza só exclui IDs sintéticos cujo INSERT teve sucesso. Não há DDL, remoção de
índice ou erro de unicidade injetado nesse helper.

**PENDING:** os quatro casos ainda não foram executados em PostgreSQL nativo nesta
rodada. Os checks unitários negativos do observador não substituem essa execução.

## Ensaio de recuperação ampliado

O passo existente `scripts/test-pages-recovery.mjs` conserva as recusas de segurança,
o SQL/classificador exatos do receiver, os restores pré-Pages/pré-042, re-upgrade e
o cenário v1. Acrescenta uma página sintética v3 com cinco seções, categoria,
aparência, FAQ, galeria e download, validada pelo validador de produção. A mídia é
WebP real gerada de PNG sintético em diretório temporário privado próprio; não usa
uploads ou identidades de produção.

O dump passa a conter alias, publicação e rascunho distintos, duas revisões v3,
metadados de mídia, associações de cargo/mídia e recibo. O teste altera todos os
seis conjuntos após o backup e exige restauração exata de todas as colunas em JSON
textual, incluindo documentos e precisão integral de timestamps. Compara também
ledger/timestamps e schema completo contra referência restaurada independentemente.

**PENDING:** `pg_dump`/`pg_restore` nativos e paridade final. O preflight local em
PGlite validou somente a construção do grafo e as mutações SQL: 1 página,
2 revisões, 1 mídia, 2 referências de mídia, 2 associações de cargo e 1 recibo.
O hash dos bytes privados também é conferido pelo ensaio, mas isso não é um teste
de restauração de `uploads.tar.gz` nem de recuperação da VPS.

## Evidência local inicial e bloqueios encontrados

Ambiente: Windows, Node 24.15.0, dependências já existentes; PGlite externo em
`<temp>/opencode/consent-db-tools/`. Nenhum serviço PostgreSQL/Docker/Firebase foi
iniciado e nenhum banco remoto foi consultado.

- **PASS:** 32 testes focados de aliases, transações e guardas de recuperação.
- **PASS:** `npm run check:pages-build`; bundle, aparência e notices atuais,
  sem escrita.
- **PASS:** sintaxe dos scripts alterados e `git diff --check`, incluindo o
  índice de merge com `git diff --cached --check`; check de segredos local
  `node scripts/verify.mjs security`, executado separadamente.
- **PASS local:** preflight do grafo/mutações v3 em PGlite; migrations 041→042
  duas vezes com snapshots/grants preservados e hashes das seis referências,
  executados dentro do verify com variáveis externas configuradas.
- **FAIL:** `npm run verify`: **1.197 testes, 1.194 PASS, 1 FAIL, 2 skips Linux**.
  Falha em `tests/unit/login-approved-reference.test.mjs:282`: expectativa
  `./dashboard.html` versus destino canônico `/dashboard.html`. O cadastro
  aprovado preserva o encaminhamento obrigatório à Ética; a asserção trazida
  pela main precisa acompanhar a normalização de destino já presente na feature.
- **FAIL:** `tests/database/check-pages.mjs:159`: espera 403 por email não
  verificado; o cadastro aprovado não usa mais esse requisito e retorna 200.
- **FAIL:** `tests/database/check-pages-v3.mjs:382`: o loop ainda inclui
  `unverified` entre os bloqueios 403. A execução observou 404 de visibilidade;
  identidade não verificada agora deve seguir os gates reais de capacidade,
  audiência e publicação, mantendo bloqueios de conta desativada e Ética.

Esses três arquivos de testes foram posteriormente liberados para a continuação
delimitada abaixo. Os resultados iniciais e seus logs ficam preservados; checks
interrompidos não são anunciados como PASS.
Os dois skips restantes dependem de semântica Linux de flock/symlinks.

Logs e pacote incremental:
`.superpowers/sdd/2026-11-11-pages-editor-reference-fidelity/deploy-prep-report.md`.

## Continuação autorizada — expectativas conciliadas

Conferidos `api/middleware/auth.js` e os relatórios de cadastro de 11/12 de novembro:
conta admitida, ativa e habilitada não exige email verificado; Ética, capacidades,
autoria e audiência continuam obrigatórias. Foram alterados somente os três testes
identificados, além da atualização desta evidência e do pacote local.

- Login espera o destino canônico `/dashboard.html` dentro do retorno pela Ética.
- Baseline confirma catálogo permitido para o viewer não verificado, negativa ao
  remover seu próprio aceite de Ética e restauração pelo helper real. Criação,
  workspace e rascunho continuam negados; leitura requer publicação e cargo ativo.
- Aliases distinguem falta de capacidade (403), conteúdo não publicado (404) e
  slug inválido (400). Leitura autorizada retorna o mesmo snapshot publicado,
  inclusive após rascunho posterior; cargo inativo continua negando acesso.
- O percurso completo revelou outra expectativa antiga de email no download,
  no mesmo arquivo v3. Corrigida com comparação dos bytes privados reais para o
  viewer autorizado e negativas de Ética/conta, preview de revisão, cargo inativo
  e mídia removida da publicação. Não se afrouxou nenhum gate de produção.

**PASS local final:**

- `npm run verify`: **1.197 testes, 1.195 PASS, zero falhas, dois skips Linux**;
  sintaxe, nomenclatura, scanner e configuração Compose aprovados.
- `node tests/database/check-pages.mjs`: **81 asserções HTTP**.
- `node tests/database/check-pages-v3.mjs`: **122 checks de aliases/categorias e
  261 checks v3**, com SQL, uploads e decodificação de mídia reais no harness
  PGlite descartável. Firebase usa somente identidade sintética.

PGlite e fontes externas usam os paths existentes. O v3 requer também
`FFMPEG_PATH` e `FFPROBE_PATH` absolutos no Windows; a primeira tentativa sem essas
variáveis terminou em `media_tool_unavailable`, foi preservada e reexecutada com
os binários já instalados. Nenhuma dependência foi instalada. O pacote final
`deploy-prep-package-v2/` contém o delta de oito arquivos contra snapshots anteriores
às respectivas edições; preserva o pacote inicial e o índice do merge.

Esses PASS não comprovam concorrência PostgreSQL nativa, `pg_dump`/`pg_restore`,
Firebase real ou deploy. A sessão principal fará revisão e CI.

## Condições operacionais preservadas

Seguir [deploy](../operations/deployment.md) e
[rollback](../operations/rollback.md). A sessão principal deve registrar o commit
final, run de CI, digests, backup/hash e resultado do deploy antes de atualizar
este documento para publicado. Gates nativos de concorrência/restore, Linux/Nginx,
smoke, receiver instalado e validações autenticadas permanecem pendentes.

O rollout continua **leitor primeiro** e `PAGES_V3_WRITES_ENABLED` desligado por
padrão. Desligar o writer não converte snapshots v3; após criá-los, o rollback
precisa conservar leitor/validador compatível e migration 042. Não assumir que uma
release exclusivamente v1/v2 é fallback válido. Após `public_started=true`, o
receiver não restaura automaticamente o banco. Não houve concessão de capacidades
nem publicação de conteúdo sintético nesta preparação.
