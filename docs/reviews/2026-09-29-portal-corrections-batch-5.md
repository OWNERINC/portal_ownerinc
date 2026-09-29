# Correções do Portal — lote 5: linguagem e documentação

Data: 29/09/2026. Implementação sobre `3cf25b1`, na branch
`fix/portal-functional-audit-20260929`, preservando as alterações locais de R3 e
4B. Escopo: especificação completa
`.openchamber/reviews/batch-5-specification.md`, com o refinamento do despacho
que **exclui `public/admin.html`** deste lote.

**Estado desta entrega:** implementação e checks locais concluídos; o lote 5 e
o diff final ainda dependem da revisão independente e do aceite editorial da
sessão principal. Este relatório não declara o plano inteiro concluído nem
atualiza o PR #42. O [registro de aceitação](2026-09-29-portal-corrections-acceptance.md)
é a fonte dos resultados reais e do estado de cada lote.

## Arquivos alterados neste lote

- `public/js/cms.js`: mapa de rótulos das revisões e nome visível da área.
- `public/cms.html`: título do painel e ajuda de rascunho/publicação, associada
  aos controles por `aria-describedby`; label nativo do agendamento com `for`.
- `public/js/knowledge.js`: ajuda contextual legado/CMS e link editorial.
- `public/knowledge.html`: textos e associações nativas dos campos e da ajuda.
- `docs/product/feature-inventory.md`: capacidades, geometria e limites reais.
- `docs/architecture/data-flow.md`: consultas administrativas e edição editorial.
- `docs/operations/local-development.md`: runtime e alcance dos checks.
- `tests/helpers/cms-harness.mjs`: somente exportação do parser HTML já existente.
- `tests/helpers/knowledge-editorial-harness.mjs`: harness montado de Knowledge.
- `tests/unit/cms-selection-state.test.mjs`: somente o seletor pelo rótulo novo
  “Base de Conhecimento”, mantendo todas as asserções de estado anteriores.
- `tests/unit/editorial-guidance.test.mjs`: 24 novas regressões comportamentais.
- Este relatório.

Não houve edição de CSS, Admin, ferramentas, API, cron, banco/schema, deploy,
manifests/engines, `AGENTS.md`, plano, ledger de aceitação, relatórios históricos
ou scripts/artefatos de QA da sessão principal.

## Comportamento entregue

### CMS: tradução somente na apresentação

- `draft`, `published`, `scheduled` e `archived` são apresentados como
  **Rascunho**, **Publicado**, **Agendado** e **Arquivado** no histórico.
  `Map` evita colisões com propriedades como `__proto__`/`constructor`.
  Código desconhecido permanece literal, inserido por `element(..., { text })`,
  nunca interpretado como HTML nem convertido em outro estado.
- A área aparece como **Base de Conhecimento**, mas continua sendo `knowledge`
  nos filtros/endpoints/payloads. O painel aparece como **Configuração e publicação**;
  seus IDs e classes permanecem iguais.
- A ajuda explica que Salvar rascunho/autosave **não publicam**. Publicar e
  Agendar continuam explícitos, salvam antes da ação e enviam os mesmos IDs e
  datas. A ajuda está dentro de `.cms-publish-controls`, sem criar outra célula
  na grade responsiva existente.
- Não houve refatoração de handlers, renderer, lifecycle, reset da seleção,
  request ownership, autosave ou upload do lote 1.

### Base de Conhecimento: orientação sem mudar a persistência

- O editor simples explica título/categoria/anexo PDF. Artigo legado mantém
  texto simples editável e obrigatório; artigo `cms_managed=true` explica o
  corpo desabilitado para preservar blocos/revisões.
- Para artigo gerenciado, o link **Editor CMS** só é criado com `role=admin` e
  `can(user, 'manageKnowledge')`, incluindo super-admin. É um `<a>` comum para
  **`./cms.html`**, sem parâmetros, nova aba ou handler que contorne o router.
  A orientação pede selecionar a área Base de Conhecimento e o documento
  existente para corpo/blocos, revisões, publicação e agendamento.
- A ajuda limpa o link ao voltar a artigo legado/novo. Refresh do estado busy
  não recria um link já presente, evitando remover o nó focado após falha.
- Payload de artigo CMS continua omitindo `content`; o legado continua enviando
  o texto simples. Manter/remover/substituir PDF altera apenas os campos de
  anexo previstos. Não se apaga o asset existente referenciado pelo artigo.
- Link normal passa pelos guards reais: recusar descarte mantém o formulário;
  gravação/upload bloqueiam a saída; descarte de PDF temporário espera a limpeza;
  limpeza falha mantém o editor e permite tentar novamente.

### Documentação alinhada

- Dashboard descrito pelo destaque Owner News e estados distintos, sem a
  saudação personalizada inexistente. Atalhos atuais são iguais para PJ/CLT.
- Geometria canônica: Owner **1448 × 3361 px / 108 × 250,68 mm**;
  Convidado **1448 × 2347 px / 108 × 175,1 mm**; AutoCard PNG **1080 × 1080 px**.
- Filtros administrativos server-side, namespaces `users_*`/`titles_*`/`audit_*`,
  histórico na mesma aba, catálogo completo e independente dos cargos,
  auditoria por nome atual/fallback de ator removido e fuso São Paulo.
- Separação editor simples/CMS e tradução só visual; checks locais não são
  aceitação de produção ou entrega externa. Runtime atual Node 24, sem alegar
  comprovação integral da instrução preexistente de Node 18.

## Verificações executadas

Ambiente do worker: Windows, **Node 24.15.0 / npm 11.12.1**. Nenhuma dependência
foi instalada/atualizada. Resultados:

| Check | Resultado real |
| --- | --- |
| Nova suíte `editorial-guidance.test.mjs` antes da implementação | 24 testes: 10 aprovados e 14 falhos por rótulos/ajuda/link ainda ausentes. |
| Foco intermediário de CMS/Knowledge/guards | 92 aprovados, zero falhas/cancelamentos/pulados, após ajuste dos testes descrito abaixo. |
| Foco ampliado, comando abaixo | **183 aprovados**, zero falhas/cancelamentos/pulados. |
| `npm run verify` | **758 aprovados**, zero falhas/cancelamentos/pulados; `verify: security`, Compose read-only e `verify: ok`. Total = 734 anteriores + 24 novos. |
| `node scripts/generate-public-shell.mjs --check` | Aprovado, exit 0; sem regenerar arquivos. |
| `git diff --check` | Aprovado, exit 0. |
| `node --check` nos dois helpers e dois testes alterados | Quatro aprovados, exit 0; sintaxe dos JS de produção também coberta por `verify`. |

Comando do foco ampliado:

```sh
node --test tests/unit/editorial-guidance.test.mjs tests/unit/cms-selection-state.test.mjs tests/unit/cms-blocks.test.mjs tests/unit/cms-contracts.test.mjs tests/unit/cms-reader.test.mjs tests/unit/cms-routes.test.mjs tests/unit/cms-frontend.test.mjs tests/unit/cms-editor-ui.test.mjs tests/unit/cms-asset-retention.test.mjs tests/unit/navigation-review-regressions.test.mjs tests/unit/task-7-shell-mobile.test.mjs
```

O primeiro foco integrado teve três falhas de teste: dois casos ainda buscavam
o botão pelo rótulo antigo e o teste novo de autosave buscava o textarea na
coluna errada, em vez das configurações do bloco. Foram corrigidos os seletores,
não o comportamento testado. O double de anchor também foi ajustado para expor
`.href` absoluto como no navegador; os testes positivos de navegação passaram
a exigir montagem do destino **e ausência de erro**, não apenas URL alterada.

Permanecem avisos preexistentes `MODULE_TYPELESS_PACKAGE_JSON` na suíte geral.
Logs de falhas de rede/permissão em testes negativos existentes são intencionais;
as novas jornadas positivas não aceitam erros de navegação. O scanner
`verify: security` não é uma nova execução de `npm audit`. Compose foi apenas
`config --quiet` com `.env.example`, chamado pelo verificador; nenhum serviço
foi iniciado, parado ou recriado.

### Alcance e preservação

- CMS monta o módulo completo, HTML, editor, renderer, UI e lifecycle reais;
  DOM, permissões/transporte e timers são doubles. Knowledge usa seu HTML e
  módulo completos, renderer, UI, paginação e router/lifecycle reais, com
  DOM/formulários, autenticação e transportes controlados. O destino CMS na
  jornada de saída é um marcador de montagem do router; o editor CMS real é
  exercitado separadamente pelo seu harness.
- As 24 regressões verificam textos renderizados e contratos observáveis,
  inclusive enums desconhecidos, criação `type=knowledge`, autosave, payload de
  publicar/agendar, perfis sem permissão, legado/CMS, metadados, PDF e guards.
  O foco ampliado reexecuta a preservação de corpo publicado, parágrafos do
  draft, rejeição de PDF ambíguo, assets privados/retenção e seleção/lifecycle.
- Snapshot de preservação: 297 caminhos fora da mudança principal foram
  comparados. **296 ficaram byte a byte iguais**; o único delta adicional é o
  rótulo autorizado em `cms-selection-state.test.mjs`. Normalizando somente
  esse seletor ao texto original (confirmado contra HEAD), o digest agregado
  coincide com o obtido antes da implementação:
  `b40d22605b86da7186a92dab0d7cce0b550123df1f19fbb6261364d1119940d1`.
  Inclui Admin/4B e seus arquivos novos, ferramentas/R3, API, cron, Nginx,
  scripts, manifests e relatórios anteriores. O diff CMS/Knowledge foi
  conferido separadamente para limitar a alteração à apresentação/ajuda.
- Atualizações concorrentes da sessão principal no plano, aceitação e
  evidências permaneceram preservadas; não são entregas deste worker.

## Relação com os achados históricos

Referências, sem reescrever a
[auditoria histórica F01–F08](2026-09-29-portal-functional-audit.md):

| Achado | Entrega de referência |
| --- | --- |
| F01 — filtro confundido com indisponibilidade do cron | [Lote 1](2026-09-29-portal-corrections-batch-1.md): estados/consultas independentes. |
| F02 — revisões CMS residuais ao trocar área | Lote 1: seleção e ownership; preservados e reexecutados neste lote. |
| F03 — ler notícia inexistente no Dashboard | [Lote 3](2026-09-29-portal-corrections-batch-3.md): estados corretos; inventário alinhado agora. |
| F04 — dependências sinalizadas | [Lote 2](2026-09-29-portal-corrections-batch-2.md): atualização e checks scoped; nenhum audit novo neste lote. |
| F05 — feedback de ResizeObserver em Cards Pós | Lote 3: convergência da prévia; geometria preservada. |
| F06 — busca de assets somente em inglês | Lote 3: termos em português e vazio explícito, preservando IDs. |
| F07 — vazio duplicado no histórico Cards Pós | Lote 3: estado único, busca e request ownership. |
| F08 — desativação da própria conta oferecida | [Lote 4B](2026-09-29-portal-corrections-batch-4b.md): ações alinhadas à política e explicação. |
| F09 — header JSON duplicado impedia gravar ferramentas | Correções do lote 3 e evidência da sessão principal; callers preservados neste lote. |
| F10 — corte do título Novo Funcionário bloqueava PNG | Correções/R3 do lote 3, sem relaxar o detector; dimensões documentadas agora. |
| F11 — `user-plus` inválido como ícone default | R3 do lote 3: default autorizado `user`, com teste contra o validador real; nenhuma alteração neste lote. |

F09/F10/F11 foram encontrados na homologação posterior e estão discriminados
no [registro de aceitação](2026-09-29-portal-corrections-acceptance.md), inclusive
os resultados reais de POST/reabertura/PUT e PNG/PDF da sessão principal. Este
worker não repetiu essas jornadas nem os percursos de 55 usuários/105 cargos do
4B nesta etapa, e não os atribui à nova suíte editorial.

## Riscos, limites e próximo aceite

1. **Divergência preexistente do tamanho de PDF:** a interface e o endpoint de
   upload permitem 100 MiB, mas `validatePdfAsset` em `api/cms/knowledge.js`
   impõe `byte_size BETWEEN 1 AND 52428800` (50 MiB) para a associação no editor
   simples. Identificado por leitura, não por upload grande real. Documentação
   corrigida para não prometer 100 MiB ponta a ponta; comportamento/limites não
   foram alterados fora do escopo. O teste anterior com título “Knowledge accepts
   PDF attachments up to 100 MB” verifica o limite da interface, não essa associação.
2. Não houve acesso à stack existente, banco, credenciais, produção, envio de
   e-mails, operação de serviços ou edição de dados oficiais. Testes de rotas
   usam servidores efêmeros e dependências controladas, não o PostgreSQL real.
3. Chromium/layout desktop/tablet/mobile, associação assistiva real e jornada
   editorial persistida permanecem com a sessão principal. Os doubles de DOM
   não comprovam layout, foco/validação nativos completos ou dispositivo físico.
4. Node 18 não foi executado. Os manifests e o verificador atuais exigem Node 24;
   não se reivindica compatibilidade integral Node 18 nem se muda a instrução.
5. Sem bloqueio de implementação dentro do escopo. A revisão independente do
   diff completo e o aceite final do lote 5 ainda faltam. Nenhum commit, push,
   merge, deploy, alteração de PR ou delegação foi realizado por este worker.

## Adendo — correções P2/P3 da revisão integrada final

Data: 29/09/2026. Despacho delimitado em
`.openchamber/reviews/batch-5-final-corrections.md`, após parecer **fix-first**
`ses_f11a78df3ffe3m84npVIbw9PEo` e confirmação dos dois achados pelo primário.
O histórico acima fica preservado; os totais e a regra do link descritos neste
adendo substituem os da primeira entrega para esta rodada. **Não é aceite final**:
o primário solicitará uma nova revisão do diff completo.

### Delta exclusivo desta correção

1. **P2 — `public/js/knowledge.js`:** somente a autorização da nova ajuda/link em
   `syncLegacyContentField`. Agora exige `role === 'admin'` e
   (`permissions.manageKnowledge === true` ou `permissions.superAdmin === true`).
   Valores textuais, inclusive `'true'`/`'false'`, e outros truthy não concedem o
   link. `canManage` e o helper compartilhado `can()` continuam inalterados para
   os handlers preexistentes. A API já aplicava booleanos estritos; a correção
   alinha esta nova oferta de navegação, sem mudar autorização server-side.
   Link comum `./cms.html`, nó focado, guards, texto e payloads foram preservados.
2. **Regressões — `tests/unit/editorial-guidance.test.mjs`:** 30 casos montados
   adicionais. Ambos os campos são exercitados com `'true'`, `'false'`, número,
   array, objeto, `true`, `false`, `null` e ausência. Também há permissões
   ausentes/nulas, combinações dos dois campos, booleano válido combinado com
   string inválida e roles viewer/ausente/`Admin` não canônicas.
   Cada caso verifica a ajuda e o link efetivamente montados; os autorizados
   percorrem o router até a montagem do destino. Os testes executam a função
   `can()` extraída do **arquivo real `public/js/auth.js`**, sem carregar Firebase,
   e comparam seu resultado ao double do harness. Assim, o teste conserva a
   semântica truthy atual e não mascara o defeito com um double mais restritivo.
   **Nenhum helper de teste precisou ser alterado.** As 24 regressões anteriores
   permaneceram intactas, incluindo foco, gravação, upload, descarte e PDF.
3. **P3 — `docs/product/feature-inventory.md` e
   `docs/architecture/data-flow.md`:** retirada somente a promessa de UID de
   ator visível. A tabela renderiza nome/fallback, ação, alvo, request ID e
   horário; `actor_uid` continua no contrato da API, não na célula de ator.
   Não houve alteração do Admin/4B nem expansão do renderer.
4. Este adendo é a única mudança no relatório; nenhuma seção histórica foi
   reescrita. São **cinco arquivos alterados** nesta rodada.

### Checks e preservação desta rodada

| Check | Resultado real |
| --- | --- |
| Suíte editorial antes do fix | 54 testes: 42 aprovados e **12 falhos**, reproduzindo ofertas indevidas para flags textuais/outros truthy. |
| Foco ampliado — mesmo comando da entrega acima | **213 aprovados**, zero falhas/cancelamentos/pulados; inclui os 54 testes editoriais. |
| `npm run verify` | **788 aprovados**, zero falhas/cancelamentos/pulados; 758 anteriores + 30 novos, `verify: ok`. |
| Gerador `--check` | Aprovado, exit 0, sem regeneração. |
| `git diff --check` | Aprovado, exit 0. |
| `node --check tests/unit/editorial-guidance.test.mjs` | Aprovado, exit 0; JS de produção também verificado pelo `verify`. |
| Comparação exata dos três arquivos de produto/documentação com o início desta rodada | Aprovada: somente o gate local e as duas correções da afirmação de UID. |

Snapshot temporário do worker registrou **412 arquivos protegidos** antes das
edições. A primeira comparação estrita sinalizou uma diferença:
`docs/reviews/2026-09-29-portal-corrections-acceptance.md`, atualizado
concorrentemente pela sessão principal. Esse ledger não foi editado nem
restaurado pelo worker. Os **outros 411 arquivos ficaram byte a byte iguais**,
incluindo auth, CMS, HTML/CSS, Admin/4B, ferramentas/R3, API, cron, Nginx,
manifests, helpers, plano e snapshots/evidências anteriores. Digest agregado
do mapa de hashes desses 411 arquivos, igual antes/depois:
`05f05971400092c770e44ef839e4b98dc14da84849a59a517055b2982fd3acc2`.

O ambiente continua Node 24.15.0/npm 11.12.1, com o aviso preexistente
`MODULE_TYPELESS_PACKAGE_JSON`; compatibilidade integral Node 18 não foi
comprovada. `verify: security` é o scanner do repositório: não foi executado novo
audit de dependências pelo worker. O resultado scoped zero informado pelo
primário pertence à sua verificação, não a este adendo. Compose continuou
restrito à validação read-only da configuração dentro de `verify`.

O worker não acessou a stack, credenciais, banco ou scripts de QA, nem operou
containers ou mudou limites. A observação de HTTP 429 após QA acumulado e os
percursos editoriais/navegação reais pertencem ao primário e ficam no ledger de
aceitação; não foram repetidos por este worker. Nenhum bloqueio de implementação
permanece no escopo P2/P3, mas **nova revisão independente integral e aceite do
primário continuam obrigatórios**. Sem delegação, commit, push, PR, merge ou deploy.
