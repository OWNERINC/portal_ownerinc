# Academy e Vaga — Implementation Plan

> **For agentic workers:** execução nesta sessão, tarefa por tarefa, no worktree
> isolado Consent-wall existente. Revisão independente após os checks.

**Goal:** corrigir D01–D07 e repetir as jornadas com evidências novas.

**Resultado:** concluído. 17/17 cenários Academy, 29/29 exportações e verify
1.270 PASS / 4 SKIP / 0 FAIL. Revisão independente concluída após corrigir três P2.
Relatório: `docs/reviews/2026-11-17-academy-vacancy-revalidation.md`.

**Architecture:** preservar o DTO resumido do aluno e ampliar somente a leitura
autorizada de gestão. Os editores mantêm rascunhos por item durante refresh;
o lifecycle Academy delega a guarda ao editor ativo. Vaga usa geometria proporcional
à largura real do canvas, mantendo a validação e o exportador compartilhado.

**Tech Stack:** JavaScript nativo, Express, Node 18+, testes node:test, Playwright
e PGlite locais externos ao repositório.

## Global Constraints

- Especificação aprovada: `../specs/2026-11-17-academy-vacancy-corrections-design.md`.
- Sem migration ou dependências novas; preservar limites api/public/cron/nginx.
- Novas evidências em pasta inédita; preservar a homologação de 17/11.
- PNG 1080×1080; manter overflow real e limite de quatro itens.
- Identidades/entrega sintéticas; produção e capacidade100 mantêm escopo próprio.

## Task 1: Curso e projeção autorizada

**Files:** `public/academy/course-editor.js`, `api/academy/catalog.js`,
`tests/unit/academy-catalog.test.mjs`.

**Interfaces:** `getCourseView(pool,user,id,{preview})` mantém módulos/aulas; quando
preview autorizado acrescenta description/media_type/youtube_video_id/media_url.
`createCourseEditor({root,page,course,onSaved,onCancel})` mantém handle
`{isDirty,dispose}`. Salvar chama onSaved apenas após confirmação da API.

- [x] Acrescentar regressão HTTP para aluno sem mídia e gestor com mídia/descrição:
  `assert.equal(view.modules[0].lessons[0].description, lesson.description)`.
- [x] Executar `node --test tests/unit/academy-catalog.test.mjs`; confirmar falha
  no DTO autorizado antes da correção.
- [x] Aplicar `select.value = savedValue` após inserir opções, `for: id` nos
  labels e type explícito nos inputs. Desabilitar controles enquanto PUT.
- [x] Projetar os quatro campos apenas com preview:
  `...(preview ? {description, media_type, youtube_video_id, media_url} : {})`.
- [x] Reexecutar teste; navegador compara PUT/SQL/reload ao alterar só título.

## Task 2: Currículo e navegação

**Files:** `public/academy/curriculum-editor.js`, `manage-view.js`, `app.js`,
`tests/unit/academy-management.test.mjs`, `docs/operations/academy-content.md`.

**Interfaces:** currículo mantém `Map<itemKey,draft>`; cada draft contém os
valores dos controles. Após PUT bem-sucedido remove apenas a chave salva e
recarrega dados oficiais. Refresh reaplica drafts dos demais itens. Criação
mantém título/URL por módulo; cancelamento confirma apenas esse formulário.
Manager usa `navigate(params)` fornecido por app. Guarda principal chama
`scope.canLeave()`; navegação interna consulta a mesma guarda antes de pushState.
Popstate já validado pelo router não reconfirma no render.

- [x] Trocar garantias regex de payload vazio e dirty por testes de digitação,
  erro/retry, dois itens, confirmação e operação em andamento.
- [x] Executar `node --test tests/unit/academy-management.test.mjs` e registrar
  falhas dos novos casos antes de implementar.
- [x] Implementar captura de draft nos eventos input/change; durante mutação
  desabilitar controles, manter saving até refresh terminar, sem remover árvore
  antes da resposta. Falha de refresh conserva os controles atuais.
- [x] Formulário inline: título/URL required, labels, Criar/Cancelar, foco e
  feedback local. Payload usa `media: {type, url}`; erro preserva entradas.
- [x] Curso salvo continua montado. Cancelar usa navigate com guardas; criar
  curso navega após resolver mutação. Manager usa uma confirmação agregada para
  curso+currículo. Vincular scope ao lifecycle principal.
- [x] Reexecutar testes focados; documentar o contrato operacional.

## Task 3: Composição Vaga

**Files:** `public/autocard/styles.css`, `public/autocard/vacancy-enhancements.js`
(somente se medição exigir), runner de exportações local.

**Interfaces:** o canvas continua quadrado e exportado pelo fluxo existente.
Dimensões relativas à largura devem ser resolvidas antes da captura.

- [x] Reproduzir a fixture original em 402px e registrar medidas de corte.
- [x] Ajustar apenas dimensões Vaga: padding, gaps, fontes e rodapé proporcionais
  ao preview; usar a largura do canvas como referência.
- [x] Repetir 1366/402 e larguras próximas, modos claro/escuro e variantes.
  Inspecionar PNG inteiro, dimensões e presença de contato/prazo/logo/rodapé.
- [x] Verificar excesso de texto e cinco itens impedem download; repetir demais
  modelos pelo mesmo exportador.

## Task 4: Jornadas e relatório

**Files:** runners locais derivados dos originais, novo REPORT.md, matrix.json,
defeitos.md, manifesto SHA-256; referência de revalidação em docs/reviews.

- [x] Criar pasta inédita `portal-corrections-20261117-*`; adaptar harness original
  para registrar checkout/HEAD/diff reais, sem escrever na pasta histórica.
- [x] UI→API→SQL/reabertura: curso interno/externo, cargos/metadados, criação aula,
  erro/retry/cancelar, edição título preservando mídia/descrição/versão/progresso.
- [x] Navegação: permanecer/descartar, sidebar, Back/Forward, mutação bloqueada,
  dois itens pendentes, salvar curso preservando currículo, reordenação.
- [x] Permissões: GET preview negado sem manageAcademy e DTO aluno resumido.
- [x] Executar `npm run verify` e `git diff --check`; revisão final do diff.
- [x] Atualizar matriz J e D01–D07 com provas e limitações; gerar manifesto novo
  incluindo hashes do código testado e capturas. Resumo final com links.

## Revisão do plano

Cobertura: D01/D02/D06 Task1; D04 Task1+4; D03/D05 Task2+4; D07 Task3+4.
Interfaces seguem as assinaturas existentes com onCancel/navigate opcionais.
As duas aprovações já foram recebidas; execução inline continua nesta sessão.
