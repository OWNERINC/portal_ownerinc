# Pages deploy preparation — Implementation Plan

**Goal:** remover a dependência do temporário preparado pelo OpenCode e ensaiar
recuperação da primeira transição Pages antes de qualquer promoção à main.

**Architecture:** correção do helper de fixtures e regressão isolada; ensaio
PostgreSQL 16 no runner descartável existente, pois Docker Desktop local está
indisponível. Não iniciar o daemon nem conectar ao banco da VPS.

**Tech Stack:** Node 24, PostgreSQL 16, ferramentas pg_dump/pg_restore do CI.

## Autorização e limites

Em 11/11 o usuário aprovou “Corrigir, validar e retomar o deploy”. A aprovação
inclui preparação e CI da feature; main dispara produção automaticamente e fica
bloqueada até a recuperação ser validada e o procedimento instalado confirmado.
Atualizar o receptor instalado na VPS exige autorização operacional específica.

- Preservar `5143794`, screenshots locais e main divergente em outra worktree.
- Não alterar migrations históricas 040/041, contratos Pages, permissões reais ou
  conteúdo real; não publicar piloto sintético em produção.
- Nenhum SSH de produção, restore/DROP produtivo, restart de daemon ou alteração
  de receiver instalado durante a preparação.
- Usar os guards de banco descartável e cluster ID reais antes de qualquer DDL.
- CI em branch de feature não publica imagens nem executa deploy-production.

## Steps

- [x] Corrigir helper e testar temporário limpo sem enfraquecer o decode real.
- [x] Adicionar ensaio PG16 pré-Pages → 040/041 → falha pré-tráfego → recuperação.
- [ ] Executar verificações locais e revisão fresca; commitar preparação.
- [ ] Push da feature e validação CI sem promoção à main.
- [ ] Registrar evidência nativa e fechar gate operacional de recuperação.
- [ ] Somente após o gate: promoção remota, CI e deploy oficial, aceite externo.

## Task 1 — Fixtures portáteis

Owner: implementador único. Files: `tests/helpers/pages-media-fixtures.mjs` e
`tests/unit/pages-media-runner.test.mjs`.

Interface permanece `createPagesMediaFixtures()` retornando directory/files/close.
Criar pai `join(tmpdir(),'opencode')` com `mkdir(...,{recursive:true})` antes do
mkdtemp. Manter limites, ffmpeg real, cancelamento e limpeza do diretório único.
Regressão em processo filho com TEMP/TMP/TMPDIR apontando para diretório novo;
o helper precisa alcançar FFmpeg, não falhar em mkdtemp. Preferir geração real
para provar sucesso e limpeza, sem executar dois casos simultâneos que alterem
ambiente global. Nunca pular o teste em Linux.

Reproduzir falha antes da correção; rodar arquivo focado, `npm run verify`,
`git diff --check`. Nenhum commit do worker nem edição de arquivos da primária.

## Task 2 — Ensaio nativo de recuperação

Owner: primária. Create `scripts/test-pages-recovery.mjs`; modify
`.github/workflows/ci.yml`; document `docs/operations/pages-release-preflight.md`.

Novo banco `portal_test_pages_recovery` no mesmo PostgreSQL16 descartável do CI.
O script usa `requireDisposableMigrationEnvironment`, cluster ID verificado,
nome dedicado e banco inicialmente vazio. Sem `.env` produtivo. Aplicar baseline
até039, registrar ledger, inserir usuário/cargo sintéticos e criar dump custom.
Aplicar o runner real 040/041 e verificar schema/grants. Reproduzir o restore
legado pré-tráfego: deve falhar por dependências Pages e transação preservar dados.

Somente no banco descartável aprovado, testar a alternativa de remover as seis
tabelas Pages recém-criadas, sem CASCADE genérico, em ordem de dependências,
antes de restaurar o dump pré-Pages. Verificar schema, ledger, dados e capacidade
de aplicar novamente 040/041. Esta alternativa **não é instalada em produção**.
Não afirmar que se testou o receiver inteiro, readiness da API anterior ou cron
se o ensaio executar apenas pg_restore/SQL.

Tools subprocess recebem URLs/credenciais por ambiente, nunca logging de URL;
erros devem omitir connection strings. Artefatos somente em diretório temporário
único, removido em finally. Não reaproveitar banco não vazio nem apagar cluster.

## Task 3 — Aceite e publicação condicionada

Rodar verify, security, bundle, shell e diff; revisão read-only Astra high.
Commit corretivo separado; push apenas da feature; workflow_dispatch na feature.
Aguardar CI completo e inspecionar logs relevantes sem expor secrets. A main
local não será tocada. Sem gate operacional confirmado, não criar merge nem
acionar workflow em main; informar claramente o bloqueio restante ao usuário.

## Evidência local antes do commit de preparação

- `npm run verify`: 927 testes, 925 PASS, zero falhas e dois skips Linux locais.
- Oito testes de guards aprovados; casos de query overrides e porta omitida
  reproduzidos em RED antes da correção. URL exige porta e credenciais explícitas.
- Bundle, licenças, shell público e `git diff --check` aprovados.
- Revisão Astra high da preparação: `ship`, limitada ao código de preparação;
  não equivale a PASS nativo ou aceite do receptor instalado.
- Migration 040 preservada byte a byte, SHA-256
  `be822d6384830b775b397010929d87560e145f126c3d5fb953c09a32e59929bc`.
- Ensaio PG16 permanece pendente do CI na feature. Nenhuma mudança produtiva.
