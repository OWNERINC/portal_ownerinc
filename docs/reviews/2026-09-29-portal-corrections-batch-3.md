# Correções do Portal — lote 3 (F03/F05/F06/F07 e feedback PNG)

Data: 29/09/2026. Implementação localizada no frontend e nas regressões
autorizadas. Base de verificação recebida após o lote 2: **590 testes**.
Entrega ainda sujeita à inspeção, revisão independente e aceitação local pela
sessão principal; este documento não substitui o registro de aceitação.

## Arquivos deste lote

Frontend:

- `public/js/dashboard.js`
- `public/dashboard.html`
- `public/css/dashboard-home.css`
- `public/autocard/app.js`
- `public/autocard/asset-catalog.js` — novo
- `public/autocard.html`
- `public/cards-pos/preview-layout.js`
- `public/cards-pos/app.js`
- `public/cards-pos.html`

Testes e documentação:

- `tests/helpers/frontend-feedback-harness.mjs` — novo
- `tests/unit/owner-news-frontend.test.mjs`
- `tests/unit/autocard-invariants.test.mjs`
- `tests/unit/autocard-asset-search.test.mjs` — novo
- `tests/unit/pos-cards-layout.test.mjs`
- `tests/unit/pos-cards-frontend.test.mjs`
- `tests/unit/pos-cards-history.test.mjs` — novo
- `docs/reviews/2026-09-29-portal-corrections-batch-3.md` — novo

Não houve alteração de API, cron, manifests, engines, deploy, geometria de
impressão, templates, crop, bibliotecas ou arte. Os estilos próprios do AutoCard
e dos Cards Pós não precisaram mudar. Preservados os diffs/relatórios dos lotes
1 e 2, auditoria histórica, `.openchamber/`, plano e aceitação da sessão
principal. Sem delegação, commit, push, deploy, inspeção de credenciais ou
operação em serviços em execução. Compose foi usado apenas pelo check de
configuração em modo de leitura da verificação existente.

## Comportamento implementado

### F03 — Dashboard

- HTML inicial e montagem representam carregamento, sem anunciar uma publicação
  inexistente. O destaque tem estados `loading`, `empty`, `error` e `populated`.
- Uma resposta vazia mantém o mesmo `h1` visível, reduz a altura do destaque,
  oculta a seção redundante de notícias e oferece **Acessar áreas** em
  `#quick-links`. Não há link inventado para o CMS ou personalização de saudação.
- Falha de consulta informa que o Owner News não pôde carregar e oferece retry
  próprio, sem confundir erro com catálogo vazio.
- Publicações restauram destaque completo, capa, ID real no link e rail. O
  ciclo publicado → retirado/vazio → nova publicação é exercitado, mantendo
  descarte de blobs privados, tokens de consulta, loaders e segurança de texto.

### F06 — Biblioteca do AutoCard

- Extraídos apenas IDs e metadados de apresentação/busca. As listas originais
  das linhas 22/23 continham **38 ícones e 16 ilustrações**, não 22/23 itens.
  IDs e ordem continuam iguais às allowlists inalteradas da API.
- Cada item tem título descritivo e aliases em português; a pesquisa normaliza
  maiúsculas, espaços nas extremidades e diacríticos, preservando busca pelo ID
  inglês. `alerta`/`alert` encontram `triangle-alert`; `aniversário`,
  `aniversario` e `cake` encontram o bolo nas duas bibliotecas.
- Busca sem resultados tem status acessível e **Limpar busca**, com foco de
  volta ao campo. Reabrir a biblioteca limpa o filtro. Selecionar o mesmo asset
  não incrementa `editRevision`; trocar incrementa. O payload continua usando
  apenas os IDs canônicos, sem trocar Lucide ou desenhos.

### Feedback PNG

- Botão/status informam **Gerando PNG…**. Após a captura ainda atual e o clique
  de download, o status informa **PNG gerado; download solicitado ao navegador.**
  Isso não afirma que o navegador concluiu a gravação do arquivo.
- Exportações concorrentes são bloqueadas, inclusive quando callbacks de
  overflow atualizam o botão durante a espera. Texto/disabled são restaurados
  em página ativa, respeitando overflow que apareça durante a operação.
- Permanecem as barreiras de geração/revisão, mídia, dimensões, fontes, decode,
  overflow e rechecagem após captura; escala continua `1080 / width`. Edição,
  troca de documento, erro ou descarte não produzem anúncio de sucesso.
- Feedback de mídia é independente: rejeição de mídia opcional sem imagem
  confirmada não se transforma em falha de exportação; imagem retida com estado
  de erro continua sujeita à barreira de exportação anterior.

### F05 — Layout da prévia dos Cards Pós

- ResizeObserver e eventos de resize/visualViewport são coalescidos em um frame
  pertencente ao lifecycle. O updater explícito permanece síncrono e retorna
  a geometria, preservando chamadas de modelo, modo, fontes e retorno do histórico.
- Valores idênticos não são reescritos. O cache também evita repetir a altura
  móvel quando a serialização CSS arredonda uma medida fracionária.
- Descarte desconecta o observer, cancela frame pendente e invalida callbacks
  retidos; eles não escrevem em uma página descartada. O topo relativo ao
  documento continua estável durante scroll móvel.
- Permanecem Convidado **1448 × 2347 px / 108 × 175,1 mm** e Owner
  **1448 × 3361 px / 108 × 250,68 mm**. Não foi alterado `card-geometry.js`,
  conteúdo seguro, estado de rascunhos, mídia ou cálculo de impressão/exportação.

Trata-se de endurecimento preventivo, não de causa-raiz isolada. A sessão
principal informou que seu baseline Chromium de 24 combinações de modelo,
modo e viewport já não reproduzia o erro e estava estável após 60 frames. Os
testes deste lote verificam coalescimento, contagem de escritas e convergência
com medidas controladas; não substituem uma nova medição no navegador.

### F07 — Histórico dos Cards Pós

- Estado da consulta centralizado em `history-status`, sem segunda mensagem
  vazia: biblioteca vazia oferece criar convite; busca sem correspondência
  oferece limpar; erro oferece retry da consulta que falhou.
- Limpar reinicia o offset. Uma página que ficou fora do total é consultada
  novamente no último offset válido, inclusive zero, antes de anunciar vazio.
- Linhas/paginação antigas saem durante a consulta. Controles carregam o token
  da resposta e verificam pertencimento à lista atual. Sucessos e erros antigos,
  retries destacados e callbacks após saída/descarte não retomam controle.
- Mensagens do editor/foto não são reescritas por carregamento de lista.
  `setStatus` continua espelhando ações de duplicar/excluir no histórico; uma
  falha de refresh não é substituída por sucesso e ações antigas não sobrescrevem
  uma consulta mais recente.

## Regressões e resultados reais

O helper novo monta os módulos completos com lifecycle real. DOM, medidas,
transporte HTTP, ResizeObserver e `html2canvas` são doubles explícitos; não há
requisição à stack, persistência real ou PNG/PDF recuperado por esses testes.
O harness anterior do AutoCard passou a carregar o catálogo importado. Os
testes de layout agora disparam frames, mantendo verificações de proporção,
fit/width, ambos os modelos, viewport visual, scroll, fontes, histórico oculto,
descarte e ausência de escritas repetidas por 60 frames controlados.

Ambiente: Windows, Node **24.15.0**, npm **11.12.1**.

```sh
node --test tests/unit/owner-news-frontend.test.mjs tests/unit/autocard-invariants.test.mjs tests/unit/autocard-asset-search.test.mjs tests/unit/pos-cards-layout.test.mjs tests/unit/pos-cards-frontend.test.mjs tests/unit/pos-cards-history.test.mjs tests/unit/frontend-invariants.test.mjs tests/unit/home-preview.test.mjs
npm run verify
node scripts/generate-public-shell.mjs --check
git diff --check
```

| Verificação | Resultado |
| --- | --- |
| Suítes focadas acima | **137 passaram**, zero falhas/cancelamentos/skips. |
| `npm run verify` final | Exit 0; **616 passaram**, zero falhas/cancelamentos/skips; sintaxe, scanner local de segurança, nomenclatura e Compose passaram. |
| Gerador `--check` | Exit 0; nenhum arquivo gerado alterado por este lote. |
| `node --check` do helper e dos dois novos arquivos de testes | Exit 0 nos três arquivos. |
| `git diff --check` | Exit 0. |

Há **26 testes adicionais líquidos** em relação aos 590 recebidos. As primeiras
execuções focadas apontaram expectativas antigas de estado/sincronia e lacunas
dos doubles de DOM/cleanup; foram corrigidas com regressões comportamentais,
sem remover asserções de segurança/geometria. A rodada integral intermediária
passou com 613; os três casos finais de mídia/fontes/altura fracionária elevaram
o total para 616. Permanece o aviso preexistente `MODULE_TYPELESS_PACKAGE_JSON`
dos módulos Cards Pós; manifests não foram alterados incidentalmente.

## Limites e próximos responsáveis

- Inspeção do diff e revisão independente ainda pertencem à sessão principal.
- A posição real do primeiro atalho em **390 × 844**, renderização/teclado,
  sequência de resize/ampliação e erros do navegador precisam de aceitação
  Chromium pela sessão principal. CSS e DOM unitários não medem o fold real.
- Recuperar PNG de 1080 px e os dois PDFs reais, conferir conteúdo/dimensões e
  persistência com API/banco locais também permanece com a sessão principal.
  Nenhuma dessas saídas foi recuperada por este implementador.
- Não há verificação de produção, imagem Linux atualizada ou dispositivo físico.
  A sintaxe acrescentada é compatível com Node 18, mas a execução foi em Node 24;
  não se estabelece suporte geral da aplicação a Node 18.
- Não houve nova auditoria npm neste lote sem mudanças de dependências.
  `verify: security` é o scanner local, não `npm audit`; o risco residual de seis
  entradas moderadas descrito no relatório do lote 2 não foi declarado resolvido.

Nenhum bloqueio de implementação identificado dentro do escopo autorizado.

---

## Adendo — correções exigidas após revisão e navegador (29/09/2026)

O conteúdo acima permanece **integralmente como baseline da primeira entrega**,
incluindo os 616 testes e a ausência de mudanças no CSS naquela etapa. Este
adendo registra somente os três deltas autorizados em
`.openchamber/reviews/batch-3-required-corrections.md`, depois da entrega do lote
4A. O parecer anterior do revisor foi **fix-first (P2)**; este documento não o
substitui por aprovação nem transforma o PNG diagnóstico com override DOM em
aceitação.

### Arquivos alterados nesta rodada

- `public/cards-pos/app.js`
- `public/autocard/app.js`
- `public/autocard/styles.css`
- `tests/unit/pos-cards-history.test.mjs`
- `tests/unit/autocard-invariants.test.mjs`
- `tests/unit/card-save-headers.test.mjs` — novo
- `docs/reviews/2026-09-29-portal-corrections-batch-3.md` — somente este adendo

Não foram alterados `auth.js`, uploads binários, API do lote 4A, Admin,
manifests, helpers compartilhados, gerador, documentos primários, snapshots em
`.openchamber/` ou scripts temporários de navegador. Comparação somente leitura
com os snapshots primários dos lotes 1/2/3/4A confirmou **35 arquivos preservados**
fora deste escopo. A reconstrução em memória do snapshot do lote 3 confirmou:
o delta do `autocard/app.js` é exatamente a retirada dos dois headers de save;
renderização/exportação/mídia dos Cards Pós e seu save ticket permanecem iguais,
salvo a retirada do header JSON. Auth, módulos de crop/employee/variantes,
geometria de impressão, draft-state e Admin continuam iguais ao HEAD.

### P2 — serialização do histórico dos Cards Pós

- `historyMutation` passa a identificar a operação de duplicar/excluir,
  separadamente do token de consulta. Ambas as funções têm guarda própria,
  além do bloqueio no handler e da desabilitação de todas as ações das linhas.
- A guarda cobre **a escrita e o refresh aguardado**, inclusive quando
  `page.busy` já voltou a `false`. Navegação externa e `beforeunload` também a
  consideram. Confirmação cancelada, falha, sucesso e descarte liberam somente a
  operação dona da guarda; callbacks descartados não desbloqueiam outra visita.
- Busca e paginação continuam disponíveis. Linhas novas ficam sem ações enquanto
  a operação ainda está pendente e são reconciliadas ao terminar. Se uma escrita
  confirmar depois de uma nova busca, atualiza-se o filtro/página **atual**, sem
  ressuscitar a consulta anterior ou deixar um card já excluído visível. Só a
  consulta original ainda atual pode receber o anúncio de sucesso/erro da ação.
- Uma consulta que substitui o refresh continua sendo a dona dos resultados.
  Se ela terminar primeiro, as ações esperam a operação anterior encerrar; se o
  refresh antigo terminar primeiro, a consulta atual ainda pendente mantém o
  bloqueio. Falha de refresh não vira sucesso. Retry, editor, paginação e aviso
  independente de mídia foram preservados.
- Regressões exercitam dois IDs com sucesso/falha de cada ação, tentativas por
  clique e chamada direta, confirmação cancelada, refresh pendente, nova busca,
  as duas ordens de resposta e descarte durante escrita ou refresh. O descarte
  troca o DOM antes dos callbacks antigos, com outra operação já ativa.

### F09 — composição de Content-Type na gravação

- Removidos somente os headers JSON redundantes dos callers POST/PUT dos dois
  editores. O helper de autenticação inalterado continua acrescentando o header
  para body string; nomes, payloads, revisão/geração e save tickets não mudaram.
- A regressão monta os callers e usa o `auth.js` real, o `fetch`/serialização de
  headers reais e um parser Express local em porta efêmera de loopback. Verifica
  POST e PUT dos quatro modelos AutoCard e dos dois Cards Pós: **um único
  Content-Type efetivo `application/json`**, corpo JSON idêntico e autorização
  sintética preservada. Não é chamada à stack nem teste de persistência.
- Dois casos adicionais passam os uploads reais dos callers pelo mesmo helper
  e confirmam `image/png` e os bytes originais. Um controle negativo comprova que
  o MIME duplicado chega como `application/json, application/json`, deixa o
  corpo sem parse e produz HTTP 400 na sonda.
- Firebase, identidade, DOM e endpoint da sonda são doubles explícitos. Os
  testes anteriores de autorização, troca de sessão, geração/revisão, drafts
  separados e exportação foram mantidos e executados, não substituídos pela sonda.

### F10 — altura de linha do título de Novo Funcionário

- `.employee-copy h2` usa `line-height:1.1`; a regra posterior do container não
  volta a sobrescrevê-lo com `1.05`. Mantidos fonte, tamanhos, margens, clamp de
  três/duas linhas, `overflow:hidden`, altura do canvas, crop e templates.
- O detector de overflow não mudou nem ganhou tolerância. A regressão confirma
  que até **um pixel medido de corte** continua bloqueando a captura, além do
  caso de título realmente longo. Títulos curto, multilinha e com acentos passam
  pela exportação com medidas não cortadas controladas em larguras 420/280 px;
  a escala continua produzindo largura de 1080 px.
- Esses casos não calculam métricas reais de Novelin/Chromium: DOM e canvas são
  doubles. A cascata foi verificada no CSS, mas renderização desktop/mobile e
  PNG **sem overrides** continuam exigindo a aceitação da sessão principal.

### Checks desta rodada e resultados reais

Ambiente mantido: Windows, Node **24.15.0**, npm **11.12.1**. Não há nova
dependência ou declaração de suporte geral da aplicação a Node 18.

```sh
node --test tests/unit/card-save-headers.test.mjs tests/unit/pos-cards-history.test.mjs tests/unit/autocard-invariants.test.mjs
node --test tests/unit/owner-news-frontend.test.mjs tests/unit/autocard-invariants.test.mjs tests/unit/autocard-asset-search.test.mjs tests/unit/pos-cards-layout.test.mjs tests/unit/pos-cards-frontend.test.mjs tests/unit/pos-cards-history.test.mjs tests/unit/frontend-invariants.test.mjs tests/unit/home-preview.test.mjs tests/unit/card-save-headers.test.mjs tests/unit/pos-cards-draft-state.test.mjs tests/unit/pos-cards-invariants.test.mjs tests/unit/pos-cards-inline-editor.test.mjs tests/unit/auth-stability.test.mjs tests/unit/persistent-navigation.test.mjs tests/unit/navigation-review-regressions.test.mjs
npm run verify
node scripts/generate-public-shell.mjs --check
node --check tests/unit/card-save-headers.test.mjs
node --check tests/unit/pos-cards-history.test.mjs
node --check tests/unit/autocard-invariants.test.mjs
git diff --check
```

| Verificação | Resultado |
| --- | --- |
| Três suítes diretamente alteradas | **89 passaram**, zero falhas/cancelamentos/skips. |
| Foco ampliado com navegação, autenticação, drafts e invariantes PNG/PDF | **222 passaram**, zero falhas/cancelamentos/skips. |
| `npm run verify` | Exit 0; **683 passaram**, zero falhas/cancelamentos/skips; sintaxe, scanner local de segurança, nomenclatura e Compose passaram. |
| Gerador `--check`, três `node --check` e `git diff --check` | Exit 0 em todos. |
| Comparações de preservação descritas acima | Passaram; baseline textual anterior deste relatório preservado byte a byte. |

São **29 testes adicionais líquidos** sobre os 654 do lote 4A. Antes do fix de
headers, a sonda reproduziu seis falhas (um POST por modelo) e três casos
passaram. O primeiro ensaio dessa sonda excedeu 120 s porque o double de Image
dos Cards Pós não indicava `complete`; o double foi corrigido e os casos da
sonda ganharam timeout de 10 s. A primeira execução pós-fix teve 77 passes e uma
falha numa asserção nova de CSS: o helper de teste não reconhecia espaço antes
de `{`. A asserção foi corrigida sem mudar o CSS ou enfraquecer o bloqueio de
overflow. As rodadas finais acima não tiveram falhas. O warning preexistente
`MODULE_TYPELESS_PACKAGE_JSON` permanece; logs de erros intencionais dos testes
de navegação não são falhas da verificação.

Compose permaneceu **somente leitura** (`config --quiet` com `.env.example`).
Sem conexão ao banco, inspeção de credenciais, operação de serviço, delegação,
commit, push ou deploy. Não houve novo `npm audit`; o scanner de `verify` não
resolve nem substitui os achados residuais já descritos no lote 2.

### Pendências para a sessão principal

1. Inspecionar o delta, gerar novo snapshot **completo** do lote 3 e obter revisão
   independente **nova**, incluindo esta rodada.
2. Repetir POST → reabrir → PUT → ler nos seis modelos com API/banco locais reais.
3. Medir títulos curto, multilinha, com acentos e longos em desktop/mobile; obter
   PNG 1080 × 1080 sem override, mantendo o bloqueio de corte real. Revalidar os
   PDFs e demais gates de exportação da entrega inicial.
4. Completar os itens ainda pendentes da aceitação inicial do lote 3. Nenhum PNG
   ou PDF real foi recuperado por este implementador nesta rodada.

Sem bloqueio de implementação identificado no escopo delimitado. Aceitação
visual, persistência real e parecer fresh continuam pendentes do primário.
