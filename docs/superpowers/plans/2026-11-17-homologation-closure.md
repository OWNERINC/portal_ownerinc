# Fechamento da homologação — plano de execução

**Objetivo:** corrigir D09/D08 e executar a CI Linux autorizada na branch
`fix/portal-readiness`. Especificação aprovada:
`docs/superpowers/specs/2026-11-17-homologation-closure-design.md`.

**Execução:** inline no worktree isolado existente, revisão independente read-only
após implementação. Runtime base `02a3e54`, especificação `e729e3e`.
Preservar os dois documentos e todos os pacotes da homologação anterior.
Nova evidência em `Temp/opencode/portal-closure-20261117-r1/`.

## Steps

- [x] Confirmar especificação, isolamento e baseline: 1270 PASS / 4 SKIP.
- [x] D09: regressões de paginação e navegação, falha antes da correção.
- [x] D09: implementação e atualização do manual Academy.
- [x] D08: contraste localizado e provas de preview/exportação.
- [x] Revalidar jornadas, verificações completas e revisão independente.
- [ ] Commitar/publicar candidato e executar CI Linux na branch explícita.
- [ ] Consolidar evidências e atualizar gates e dependências operacionais.

## 1. D09 — regressões e implementação

Arquivos: `public/academy/manage-view.js`, `public/academy/app.js`,
`tests/unit/academy-management.test.mjs`, `docs/operations/academy-content.md`.

1. Ampliar o harness VM/FixtureNode existente com location/history, requests
   deferred e callbacks de editor. Usar UI/helpers reais para os links e botões.
2. Executar regressões que percorrem 105 cursos em seis páginas (20/20/20/20/20/5),
   verificam total, links, navegação, criação/cancelamento, URL inválida,
   fallback de página removida, erro/retry, acesso negado, vazio e resposta tardia.
   Comando: `node --test tests/unit/academy-management.test.mjs`.
   Registrar RED antes de alterar o runtime.
3. Usar `fetchAPIPage` com `all=true&limit=20&offset=...`. Normalizar
   `manage_offset` para inteiro seguro não negativo/múltiplo de20.
   Corrigir a URL via `page.history.replaceState`, preservando estado do router.
4. Reutilizar `routeLink` e aparência `.academy-pagination`; manter contexto nos
   links de editor/criação, cancelamento e sucesso da criação.
   Exibir posição/total em região de status, h1 focalizável e nav identificada.
5. Controlar carregamento único e descarte por dispose/lifecycle. Retry lê o
   mesmo lote. Uma única tentativa corretiva quando offset exceder total;
   mudanças concorrentes adicionais devem resultar em erro recuperável.
6. Encaminhar `page.history` ao lifecycle interno. Histórico do catálogo só
   deve ser salvo ao sair do catálogo; remover `manage_offset`/`new` ao retornar.
7. Executar GREEN e testes de navegação Academy existentes. Atualizar o manual
   para explicar paginação/retorno/erro, mantendo os contratos dos editores.

## 2. D08 — alteração mínima e exportações

Arquivo de runtime: `public/cards-pos/styles.css`, regra
`.guest-body .benefit-box h3`: trocar `#a49581` por `#6f6250`.

1. Confirmar os dois alvos em 1366/402px, cor computada/fundo e contraste>=4,5.
2. Reexecutar axe com o runner anterior copiado para a pasta nova.
   Conservar resultados incomplete como pendência manual.
3. Reexecutar exportações Convidado/Owner em ambos os viewports. Gerar e
   renderizar PDFs, registrar hashes/geometria e consistência de conteúdo.
   Manter cópias dos runners históricos sem edição.

## 3. Provas integradas e revisão

1. Criar runner novo sobre o harness local de navegador/API/SQL já disponível,
   declarando explicitamente seu uso de PGlite e autenticação de fixture.
   Percorrer105cursos, abrir último, cancelar, reload, Back/Forward, retry;
   confirmar rede e ausência de erros. Reexecutar Academy17/exportações29.
2. `npm run verify`; `npm run security`; checks shell/build Pages existentes;
   `git diff --check`. Preservar logs e lista/hash de fontes testadas.
3. Solicitar revisão independente read-only do diff e evidências. Corrigir
   achados, repetir somente verificações afetadas e consolidar resultado.

## 4. CI Linux e entrega

1. Commitar arquivos do candidato e documentos pertinentes, sem incluir
   credenciais, dependências temporárias ou artefatos binários no Git.
2. Conferir `.github/workflows/ci.yml`: publicação de imagens/deploy somente
   para main. Publicar `HEAD:refs/heads/fix/portal-readiness` sem force.
3. Disparar `gh workflow run ci.yml --repo OWNERINC/portal_ownerinc
   --ref fix/portal-readiness`; registrar run ID e head SHA.
4. Acompanhar job por mecanismo de notificação/background; obter logs e
   artefatos ao término. Verificar cada gate executado, inclusive skipped.
5. Atualizar relatório e conhecimento: Linux/PG16/migrations/grants/Academy/
   DB-only recovery/nginx config/build/scans conforme evidência real.
   Carga representativa, proxy vivo, Firebase/SMTP reais, uploads/off-host,
   aparelhos físicos e aceite humano conservam seus critérios próprios.
6. Solicitar apenas os parâmetros ainda ausentes, com segredos em cartão
   privado. Não encerrar a homologação integral enquanto gates faltarem.

## Evidência local concluída

- D09/D08 integrados: 8/8 PASS; Academy: 17/17 PASS; exportações: 29/29 PASS.
- Axe: 20/20 estados sem violações; 7 ocorrências incomplete/33 alvos pendentes.
- Contraste computado: 4,758:1. Quatro PDFs de uma página, pixels idênticos
  desktop/mobile por modelo. Owner igual ao baseline; Convidado muda somente
  4.350 pixels na região dos dois títulos.
- Verify final: 1.276 PASS / 4 SKIP / 0 FAIL; security API/cron zero
  vulnerabilidades; shell/build Pages em --check e diff aprovados.
- Review independente: fix-first para offset acima do máximo da API; regressão
  RED, correção e nova prova integrada. Reavaliação: **ship** para D09/D08.
- Primeira repetição Academy: dois seletores href antigos rejeitaram o novo
  parâmetro e bloquearam dois cenários dependentes. Runner original preservado;
  somente os dois seletores foram atualizados; repetição completa 17/17 PASS.
- Quatro harnesses finais: 300 requisições, zero pageerror/serverErrors e
  18 tabelas idênticas após reabertura em cada um. Limites PGlite/fixtures mantidos.
