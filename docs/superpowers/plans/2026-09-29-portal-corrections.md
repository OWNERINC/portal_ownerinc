# Portal Corrections Implementation Plan

> **For agentic workers:** execução autorizada pelo usuário com
> `sol-advisor-implementer` como único implementador e um
> `sol-advisor-reviewer` novo, somente leitura, por lote. A sessão principal
> especifica, confere o diff, repete verificações e aceita cada entrega.

**Goal:** executar as correções F01–F08 e as melhorias administrativas do plano
aprovado após a auditoria funcional de 29/09/2026.

**Architecture:** manter o frontend estático, Express/PostgreSQL, Firebase e as
fronteiras atuais. Corrigir estados locais e ampliar contratos de consulta
administrativa com validação, filtros SQL e paginação coerente.

**Tech Stack:** JavaScript, Node, Express 4, PostgreSQL, Firebase Auth, HTML/CSS,
testes `node:test` e navegação local em Chromium.

## Restrições globais

- Referência inicial: `ff14c66`; `npm run verify`: 537 testes aprovados.
- Preservar o relatório de auditoria e as capturas preexistentes, ainda não
  versionados. Novas evidências não substituem o registro histórico.
- Preservar URLs `.html`, lifecycle, guards de alterações pendentes, enumerações
  da API, revisões e assets privados; sem migração de banco prevista.
- Não alterar scripts de produção, credenciais, configuração de deploy,
  produtos vizinhos ou as proteções do importador local de Owner News.
- Impressão: Convidado 108 × 175,1 mm; Owner 108 × 250,68 mm; AutoCard PNG 1080 px.
- Instruções pedem compatibilidade Node 18; manifests e verificações existentes
  usam Node 24. Não alterar o runtime incidentalmente; registrar a divergência.
- O usuário autorizou usar a stack `ownerinc-owner-news-local`, recriar apenas
  API/cron quando necessário e cadastrar contas/dados sintéticos identificados.
- Não atribuir testes locais à produção. Publicação oficial e alterações de
  cargos reais dependem dos responsáveis; recebimento externo exige caixa de
  teste monitorada.

## Lote 1 — Estado de Lembretes e CMS

**Arquivos:** `public/js/reminders.js`, `public/reminders.html`,
`public/js/cms.js`, `public/cms.html`,
`scripts/generate-public-shell.mjs` apenas para o status inicial gerado,
`tests/unit/reminder-delivery-ui.test.mjs`,
`tests/unit/cms-selection-state.test.mjs`; aproveitar os harnesses existentes.

**Contratos:** entregas e `/api/reminders/cron-status` continuam independentes;
o backend mantém validação UUID. CMS usa os mesmos endpoints e enums.

- [x] Validar UUID, UID e datas dos filtros com feedback associado ao campo.
- [x] Separar saúde, erro de consulta e erro de filtro; respostas antigas e
  continuations de uma página desmontada não podem atualizar a interface.
- [x] Limpar seleção, revisões, paginação, metadados, prévia, bloco e status no
  CMS quando a transição for aceita; cancelamento mantém o rascunho.
- [x] Executar regressões: falhas parciais, consultas fora de ordem, seleção
  A→B, A→área vazia, cancelamento e abertura inicial sem documento.
- [x] Conferir no navegador local e obter revisão independente.

```sh
node --test tests/unit/reminder-delivery-ui.test.mjs tests/unit/cms-selection-state.test.mjs
npm run verify
git diff --check
```

## Lote 2 — Dependências da API

**Arquivos:** `api/package.json`, `api/package-lock.json` e regressões de
parser/upload necessárias. Não atualizar dependências do cron sem evidência.

- [x] Consultar versões corrigidas e atualizar dentro dos majors vigentes.
- [x] Preservar `memoryStorage`, limites, parsing e respostas HTTP.
- [x] Instalar do lockfile, exercitar JSON/query/multipart e auditar novamente.
- [x] Registrar versões resolvidas e resultado integral de severidades.

```sh
npm --prefix api ci
npm run security
npm run verify
git diff --check
```

## Lote 3 — Dashboard e ferramentas

**Arquivos:** `public/js/dashboard.js`, `public/dashboard.html`,
`public/css/dashboard-home.css`, `public/cards-pos/preview-layout.js`,
`public/cards-pos/app.js`, `public/cards-pos/styles.css` se necessário,
`public/autocard/app.js`, novo `public/autocard/asset-catalog.js`,
testes de Owner News, layout/feedback Cards Pós e busca/exportação AutoCard.

- [ ] Dashboard distingue carregamento, vazio, falha e publicação; estado vazio
  compacto leva aos atalhos e não promete uma leitura inexistente.
- [ ] Agendar medições do ResizeObserver por frame, evitar escritas idênticas e
  cancelar frames no descarte; manter medidas de impressão e exportação.
- [ ] Catálogo de assets aceita português, acentos e IDs originais, informa
  ausência de resultados e mantém os identificadores persistidos.
- [ ] Histórico Cards Pós usa uma mensagem por estado e oferece limpar busca
  ou repetir consulta; avisos de mídia independentes permanecem válidos.
- [ ] PNG informa geração e download solicitado ao navegador; continua sujeito
  aos bloqueios de mídia, overflow e mudança de documento.
- [ ] Alternar modelos/ampliação/tamanhos, navegar e recuperar PNG/PDF reais.
- [ ] Revisão do lote: serializar ações do histórico até o refresh, preservando
  proteção contra consultas obsoletas e feedback de falha.
- [ ] F09 adicional, reproduzido na homologação: eliminar o header JSON duplicado
  nos callers de gravação das ferramentas e confirmar POST/PUT reais.
- [ ] F10 adicional, reproduzido na homologação: corrigir o corte de 1 px no título
  do Novo Funcionário com ajuste tipográfico localizado em
  `public/autocard/styles.css`, mantendo o bloqueio de overflow verdadeiro.
- [ ] Aceitação móvel adicional: título de duas linhas do Novo Funcionário em
  390 × 844 ainda apresenta corte após estabilizar; ajustar o orçamento de layout
  mantendo a geometria e o bloqueio de corte real.
- [ ] F11 adicional: ícone padrão `user-plus` do Novo Funcionário é recusado como
  ícone pela API; usar default válido sem alterar os catálogos canônicos e
  regressão com o validador real.

```sh
npm run verify
git diff --check
```

## Lote 4 — Consultas e operação administrativa

**Arquivos:** `api/routes/users.js`, `api/routes/job-titles.js`,
`public/js/admin.js`, `public/admin.html`, testes de governança, filtros e
comportamento administrativo. Política server-side permanece autoritativa.

**Contratos:** filtros são aplicados antes de `LIMIT/OFFSET` e `COUNT` com o
mesmo predicado; valores são parametrizados. Leitura de usuários exige
`manageUsers`; auditoria permanece restrita a super-admin.

| Endpoint | Parâmetros adicionais aceitos |
| --- | --- |
| `GET /api/users` | `q` até 200 caracteres, substring literal sem distinção de maiúsculas em nome/e-mail; `role=viewer|admin`; `state=active|disabled|enable_pending`; `job_title_id` UUID |
| `GET /api/job-titles` | `q` até 200 caracteres, substring literal do nome; `active=true|false`; `all=true|false` legado. Sem `active`, `all=true` inclui todos e o default continua ativo. |
| `GET /api/users/audit` | `action` código exato não vazio, até 120 caracteres; `from` e `to` datas civis válidas `YYYY-MM-DD`, anos 0001–9999, `from <= to` |

Listagens continuam arrays com `X-Total-Count`, limite máximo 100 e ordenação
estável. Estado de conta mantém precedência `disabled` → `enable_pending` →
`active`; propriedades JSON ausentes não excluem contas ativas. Pesquisa escapa
`%`, `_` e `\\`. Auditoria acrescenta apenas `actor_name` do usuário atual;
usuários acrescentam `job_title_active`, nulo quando não há cargo.

Parâmetros de UI: `users_q`, `users_role`, `users_state`, `users_job_title_id`,
`users_page`; `titles_q`, `titles_active`, `titles_page`; `audit_action`,
`audit_from`, `audit_to`, `audit_page`. Páginas na URL são base 1. Não encaminhar
parâmetros de UI diretamente ao backend. Filtros vazios são omitidos; valores
repetidos/objetos/arrays/nomes desconhecidos na API retornam 400.

Subetapas: **4A (backend) aceito**, com revisão independente `ship`, 654 testes
e consultas executadas no PostgreSQL local. **4B (interface) pendente**;
especificação delimitada em `.openchamber/reviews/batch-4b-specification.md`.

- [ ] Usuários: nome/e-mail, role, estado e cargo; retornar `job_title_active`.
- [ ] Cargos: nome, ativo/inativo, paginação da tabela separada do carregamento
  integral das opções dos formulários.
- [ ] Auditoria: período civil São Paulo e ação; nome atual do ator, código
  técnico e request ID; fallback para sistema/ator removido/ação desconhecida.
- [ ] Filtros persistem na URL, reiniciam a página e rejeitam respostas antigas.
- [ ] Própria conta e super-admin protegido têm ações indisponíveis e explicadas;
  cargo inativo gera aviso, sem alterar dados reais automaticamente.
- [ ] Associar label e instruções ao CSV, preservando parser e limite de 500.
- [ ] Testar caracteres literais `%`/`_`, combinações de filtros, totais, mais
  de 50 usuários/100 cargos, voltar/avançar e perfis sem autorização.

```sh
npm run verify
git diff --check
```

## Lote 5 — Linguagem, documentação e aceitação

**Arquivos:** `public/js/cms.js`, `public/cms.html`, textos e links em
`public/js/knowledge.js`, `public/knowledge.html`, `public/admin.html`;
`docs/product/feature-inventory.md`, documentos de arquitetura/operação
afetados e novo relatório de correções.

- [ ] Traduzir somente rótulos visíveis do CMS; payloads e URLs preservados.
- [ ] Explicar metadados/anexo na edição simples e corpo/publicação/revisões no
  CMS; links condicionados às permissões, sem parâmetros não suportados.
- [ ] Corrigir documentação sobre saudação, dimensões Owner e evidência/runtime.
- [ ] Homologar persistência, permissões, uploads, publicação e exportações com
  fixtures locais; registrar IDs criados para eventual limpeza exata.
- [ ] Registrar resultados por fluxo, limitações e decisões operacionais ainda
  abertas; não marcar e-mail, dispositivo físico ou produção sem evidência.
- [ ] Executar verificação final e obter parecer independente sobre o diff total.

## Critério de conclusão

Cada lote precisa de diff conferido pela sessão principal, checks aprovados e
parecer `ship`. `fix-first` retorna ao mesmo implementador com correção delimitada
e exige revisão nova. Aceitação local do código não significa publicação em
produção nem conclusão automática de todas as etapas operacionais.

## Analysis synthesis — 29/09/2026

### Decision suggested

Executar os lotes autorizados com um único implementador. A análise independente
de `explore` e `general` e uma rodada de crítica cruzada convergiram na abordagem
localizada. Não há requisito demonstrado de migração ou biblioteca adicional.

### Proven facts

- A sessão principal repetiu `npm run verify`: 537 testes aprovados; o gerador
  passou em `--check` antes das alterações.
- F01 foi reproduzido no navegador local autenticado. F02 decorre de limpeza
  incompleta da apresentação; os tokens de histórico já existem.
- O gerador é fonte do status superior do CMS; limpar o preview deve executar
  a limpeza de recursos do renderer, não apenas remover filhos do DOM.
- A tabela de cargos compartilha dados com convites, edição e aprovação;
  precisa ser separada das opções completas desses formulários.
- A auditoria apaga o vínculo do ator na exclusão da conta. O nome será uma
  consulta da identidade atual; ator nulo será “Sistema ou conta removida”.
- Runtime e dependências existentes não estabelecem suporte Node 18. Esta
  rodada preserva manifests/Docker/AGENTS e documenta a divergência.
- Há fixtures locais registradas por ID: 55 usuários, 105 cargos, seis
  identidades adicionais no emulator e dois eventos de auditoria.

### Unconfirmed hypotheses

- A causa específica do aviso ResizeObserver ainda não foi isolada. O percurso
  local inicial não registrou erro de página; algumas medições ainda variaram
  nos primeiros 12 frames após redimensionamento. A correção exige confirmar
  convergência e não apenas adiar a escrita.
- Versões de dependências implantadas em produção e recebimento externo de
  e-mails não foram verificados nesta execução.

### Resolved divergences

- F01 mantém identificadores técnicos com validação e ajuda contextual.
- Dashboard vazio aponta para os atalhos existentes com “Acessar áreas”.
- Usuários: `q`, `role`, `state`, `job_title_id` UUID; pesquisa literal sem
  tratar `%`, `_` e `\\` como curingas; sem novo filtro de super-admin/cargo nulo.
- Cargos: `q`, `active=true|false`; `active` explícito prevalece sobre
  `all=true`; `all=true` sozinho continua incluindo ativos e inativos.
- Auditoria: `action`, `from`, `to`; dias civis de São Paulo, com limite final
  exclusivo no início do dia seguinte. Sem identidade histórica reconstruída.
- A URL usa parâmetros próprios por seção; termos de busca não entram em
  eventos de auditoria nem em novo armazenamento local.
- F08 aplica regras por ação; editar a própria conta permanece possível nos
  campos permitidos. O último super-admin continua protegido no servidor.

### Residual risks

Respostas antigas dentro da mesma página, perda de seleção de cargo, recursos
privados retidos no CMS, divergência do HTML gerado e oscilação entre frames
precisam de regressões específicas. Acesso por cargo inativo não equivale a
conta desativada; a interface deve explicar essa diferença.

### Verification plan

Checks focados por lote, suíte integral, gerador `--check`, auditoria de todas
as severidades e `git diff --check`; API/PostgreSQL locais com mais de uma
página; navegador desktop/mobile; recuperação e inspeção de PNG/PDF reais.
PDFs baseline recuperados confirmam 108 × 175,1 e 108 × 250,68 mm.

### Conditions for implementation

A autorização já foi dada pelo usuário para implementar/revisar o plano e usar
o ambiente local. API/cron só serão recriados no projeto local identificado.
SMTP foi classificado como local/placeholder sem expor valores; envio externo,
conteúdo oficial, cargos reais e produção mantêm suas dependências operacionais.
