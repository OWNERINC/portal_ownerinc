# Correções do Portal — aceitação da sessão principal

## Referência e ambiente

- Plano aprovado: [execução por lotes](../superpowers/plans/2026-09-29-portal-corrections.md).
- Auditoria histórica: [29/09/2026](2026-09-29-portal-functional-audit.md).
- Base Git: `ff14c66`. Entrega parcial preparada na branch
  `fix/portal-functional-audit-20260929` para PR em rascunho; sem implantação em
  produção. O estado de aceite por lote está discriminado abaixo.
- Homologação autorizada: stack `ownerinc-owner-news-local`, frontend em
  `http://localhost:8080`, PostgreSQL local e Firebase Auth Emulator.
- Fixtures identificadas: conta principal `qa-correcoes-20260929`, 55 usuários
  `qa-plan-20260929-*`, 105 cargos `ZZZ QA Cargo *`, seis identidades adicionais,
  dois eventos `qa.correcoes.fixture` e dois documentos `QA Correcoes CMS A/B`.
  Os manifestos de IDs e os scripts de execução estão no diretório temporário
  aprovado do OpenCode, fora do código da aplicação.
- Baseline repetido pela sessão principal: **537 testes aprovados**.

## Lote 1 — F01/F02 aceito

Implementação: `sol-advisor-implementer`. Revisão independente:
`sol-advisor-reviewer`, parecer **ship** após ler os arquivos, dependências,
regressões e o diff completo contra a base. A sessão principal inspecionou o
diff e repetiu as verificações.

| Evidência | Resultado |
| --- | --- |
| `npm run verify` | **578 testes**, zero falhas/cancelamentos/pulados; sintaxe, scan de segredos e Compose aprovados. |
| `node scripts/generate-public-shell.mjs --check` | Aprovado. |
| `git diff --check` | Aprovado. |
| Chromium local: UUID inválido | Erro associado ao campo; cron consultado independentemente e sem falso diagnóstico de falha. |
| Chromium local: HTTP 503 injetado no histórico | Erro só no histórico; saúde do cron preservada. |
| Chromium local: HTTP 503 injetado na saúde | Histórico carregado; badge perde classe verde e informa falha de consulta. |
| Chromium local: CMS A → área sem seleção | Revisões, paginação, prévia e estado de salvamento anteriores removidos. |
| Chromium local: CMS A → B com HTTP 503 | Nenhum conteúdo de A permanece; retry abre B persistido. |
| Erros de página nesses percursos | Zero. |

As falhas HTTP foram injetadas no navegador; gravação e leitura dos documentos
usaram a API e o PostgreSQL locais. Os testes automatizados complementares usam
o lifecycle e o renderer reais com transportes controlados, inclusive limpeza
de recursos privados, respostas fora de ordem e bloqueios de alterações.

[Captura F01 corrigido](../../.openchamber/screenshots/correcao-f01-filtro-independente-2026-09-29T14-53-59-850.jpg).

## Lote 2 — F04 aceito

Revisão independente: **ship**, após inspeção do diff completo, arquivos,
manifests instalados e metadados públicos do registry/advisories. A sessão
principal repetiu `npm run verify`: **590 testes aprovados**, zero falhas,
cancelamentos e pulados; Compose aprovado.

| Dependência | Antes | Resolvida, instalada e confirmada na imagem local |
| --- | --- | --- |
| Express | 4.22.2 | **4.22.3** |
| body-parser | 1.20.6 | **1.20.8** |
| qs | 6.15.3 | **6.16.0**, cópia compartilhada |
| Multer | 2.3.0 | **2.4.0** |

- A sessão principal reconstruiu somente API e cron da stack local autorizada.
  Ambos concluíram `docker compose up --wait` saudáveis; `/api/ready` retornou
  `ready`. Os três workers passaram a ter `last_error = null`, inclusive
  `retention`, que havia registrado a falha de consulta no início da sessão.
- A instalação da imagem, sem dev/opcionais, reportou **zero vulnerabilidades**.
  A cadeia opcional de Google Storage não está instalada nessa imagem local.
- A auditoria integral da API local continua com **seis entradas moderadas**
  da cadeia opcional Firebase/Google Storage/uuid, inalterada neste lote; zero
  altas/críticas. O escopo `--omit=dev --omit=optional` retorna zero. Os três
  advisories subjacentes de F04 foram resolvidos. Detalhes no
  [relatório do lote 2](2026-09-29-portal-corrections-batch-2.md).
- Após o rebuild, o ciclo real de persistência descrito abaixo foi repetido e
  passou novamente: foto/crop/limites, JSON/multipart, PDF privado, CMS,
  Academy e Lembretes. Assim, a evidência desse lote inclui a imagem Linux
  atualizada e PostgreSQL, além dos doubles usados nos testes unitários.

## Lote 3 — validação em andamento, correções adicionais exigidas

- Sessão principal repetiu `npm run verify`: **616 aprovados**, zero falhas,
  cancelamentos e pulados; gerador e `git diff --check` aprovados.
- Dashboard no Chromium: publicação real tem link de leitura com ID; resposta
  vazia tem um único heading, CTA útil e primeiro atalho em **y=379,75 px** no
  viewport **390 × 844**; em desktop, y=486,44 px. Erro HTTP 503 injetado ficou
  distinto de vazio, e o retry restaurou publicações reais. Zero erros de página.
- Cards Pós: repetidas **24 combinações** de modelo/tamanho/modo, sem oscilação
  nos dez frames finais de 60 e sem erro de página. PDFs recuperados continuam
  em 108 × 175,1 e 108 × 250,68 mm. Renderização com PyMuPDF a 2× comparada à
  baseline: **nenhuma diferença de pixels** nos dois modelos sem foto.
- Revisor independente: **fix-first**. Encontrou concorrência entre duas ações
  de excluir/duplicar em IDs diferentes: o refresh da primeira incrementa o
  token e descarta o resultado/erro da segunda. Correção exigida: serializar
  as mutações do histórico até o refresh ou distinguir esses tokens, com
  regressões de duas ações sobre IDs diferentes.
- A homologação encontrou também o F09 descrito abaixo. O lote ainda não recebeu
  aceite; o relatório do worker representa a implementação anterior à revisão.

### Rodada complementar para o PR

- Implementador corrigiu a serialização das mutações até o refresh, retirou os
  headers JSON redundantes dos callers e ajustou a cascata tipográfica do título
  Novo Funcionário. O adendo do relatório do lote 3 descreve os deltas.
- Sessão principal repetiu `npm run verify`: **683 aprovados**, zero falhas,
  cancelamentos ou pulados; os hashes dos arquivos de código/testes permaneceram
  estáveis durante toda a execução. Gerador `--check` e `git diff --check` passaram.
- Nova execução Chromium/API real: **Convidado e Owner** passaram em POST/PUT/leitura
  com um único header JSON, conteúdo e mídia preservados. PDFs com foto recuperados
  nas medidas corretas. Duplicação em um ID bloqueou a ação no outro até o refresh;
  exclusão real removeu o item e preservou o feedback. Zero erros de página.
- AutoCard: a rodada percorreu POST/reabertura/PUT/leitura dos modelos Comunicado,
  Vaga e Aniversariante; também salvou e exportou Novo Funcionário em desktop.
  Os quatro PNGs foram recuperados com largura 1080 px, sem override de CSS.
- **Pendência encontrada no mobile:** Novo Funcionário preenchido, em 390 × 844,
  com título `Árvore Colaborador Silva de Almeida`, cargo `Equipe local`, data
  `29/09`, mensagem curta e imagem sintética válida. Após fontes prontas e **60
  frames** de estabilização, o título de duas linhas mede `clientHeight=37` e
  `scrollHeight=40`, mantendo o bloqueio de exportação por corte. O título curto
  passa após estabilizar; uma medição inicial de altura zero foi transitória.
  A correção do corte desktop de 1 px não comprova o aceite móvel. Evidência:
  [captura móvel](../../.openchamber/screenshots/qa-employee-mobile-clipping-20260929.png).
- Revisão independente nova: **fix-first**. Confirmou a correção de concorrência,
  mas identificou o F11 descrito abaixo. O PR permanece em rascunho e o lote 3
  não está aceito enquanto o ícone padrão e a pendência móvel não forem resolvidos.

## Lote 4A — contratos de leitura da API aceitos

Revisor independente: **ship**, após ler o diff completo, rotas, helper,
regressões, política e callers. A sessão principal inspecionou os mesmos
artefatos e repetiu `npm run verify`: **654 testes**, zero falhas, cancelamentos
ou pulados; Compose, gerador `--check` e `git diff --check` aprovados.

Apenas a API da stack local autorizada foi reconstruída/recriada; healthcheck
ficou saudável e `/api/ready` retornou `ready`. `portal-correcoes-api-check.cjs
--filters` executou os queries reais via Nginx/API/PostgreSQL e confirmou:

- 55 usuários filtrados em páginas de 50 + 5, totais corretos, combinações de
  perfil/estado/cargo e vínculo inativo informado por `job_title_active`.
- Buscas por acentos e pelos caracteres literais `%`, `_` e barra invertida.
- 105 cargos filtrados em páginas de 100 + 5; `active` explícito prevalecendo
  sobre `all=true`, com 103 ativos e dois inativos.
- Auditoria: fronteira 02:59:59Z/03:00:00Z separada pelos dias civis de São Paulo;
  nome atual do ator e ator nulo preservados.
- 12 consultas malformadas/repetidas retornaram 400; eventos `user.list`
  continuaram sem termos brutos de pesquisa nos detalhes.
- As 12 fronteiras de autorização anteriores passaram novamente.

Consulta complementar de leitura no PostgreSQL confirmou que as mesmas
expressões de limite civil representam dias de **23, 25 e 24 horas**, nas
transições históricas de São Paulo e no dia atual. Não houve alteração de
schema, mutações da API, regras de retenção ou configuração de produção.

Este é o aceite do backend 4A; a interface administrativa 4B ainda está pendente.

## Evidências de preparação e preservação

- **12 verificações de autorização** passaram com API real e identidades locais:
  usuário comum, gestor de usuários, super-admin, ferramenta por cargo ativo,
  cargo inativo, conta desativada, conta aguardando habilitação e proibição de
  desativar a própria conta/super-admin protegido.
- Documentos A/B de QA: rascunhos ficaram ocultos no leitor; A foi publicado e
  sua revisão persistida ficou legível pelo endpoint autenticado.
- PDFs baseline recuperados e renderizados: uma página em cada arquivo;
  Convidado **108 × 175,1 mm**, Owner **108 × 250,68 mm**.
- Prévia Cards Pós baseline: **24 combinações** de modelo, viewport e modo;
  medidas estabilizadas nos dez frames finais de uma janela de 60 frames;
  nenhum erro de página/ResizeObserver nessa execução. Isso não reproduziu
  o aviso registrado na auditoria de produção nem isolou sua causa.
- A healthcheck local inicialmente indicou falha do worker `retention`, com `fetch failed`
  registrado às 12:59 UTC. O worker de lembretes e o de importação têm registros
  de sucesso. Essa falha local preexistente deixou de ocorrer depois da
  recriação autorizada, com a API pronta antes do cron; não é um resultado de F01.

## Aceitação ainda em execução

### Achado adicional F09 — gravação das ferramentas

Ao exercer o botão Salvar real do AutoCard, a sessão principal recebeu 400 com
um payload válido. A captura da requisição mostrou
`Content-Type: application/json, application/json`: o caller fornece o header
em minúsculas e `fetchForSession` adiciona outro com capitalização diferente.
O navegador combina ambos e o parser não reconhece o tipo JSON. O mesmo
padrão foi reproduzido no botão Salvar dos Cards Pós, após preencher e confirmar
o diálogo de nome: HTTP 400 e o mesmo header combinado.

Este comportamento é preexistente e não foi detectado na auditoria inicial,
que abriu/cancelou formulários sem gravar cards. O aceite de persistência das
ferramentas aguarda correção localizada dos callers e nova verificação com
POST/PUT reais. As barreiras de autenticação e upload binário devem ser
preservadas.

### Achado adicional F10 — título do Novo Funcionário bloqueia PNG

No Chromium desktop (1440 × 900), o modelo `novo_funcionario` com o título
curto `QA local 20260929` e uma imagem válida mantém Exportar desabilitado.
A medição do `h2` de `.employee-copy` mostrou `clientHeight=23` e
`scrollHeight=24`, com `overflow:hidden`; o bloqueio de corte reage a esse
pixel. A foto estava no estado pronto. Captura preservada em
`.openchamber/screenshots/correcao-f10-employee-export-blocked.png`.

Um experimento apenas no DOM do navegador, aumentando o `line-height` para
`1.1`, eliminou esse corte e permitiu recuperar o PNG de 1080 × 1080 px.
Esse experimento isola o ajuste tipográfico candidato, mas **não constitui
aceite do código**: aguarda correção revisada e nova execução sem override.
Não se deve relaxar a detecção de overflow real para resolver o sintoma.

Os PNGs dos outros três modelos foram recuperados sem override. Os PDFs dos
dois modelos Cards Pós com foto também foram recuperados nas medidas corretas;
a conferência visual final e a persistência das ferramentas continuam pendentes.

### Achado adicional F11 — ícone padrão inválido no Novo Funcionário

O revisor novo rastreou `defaultIcon: 'user-plus'` no template
`novo_funcionario` de `public/autocard/app.js`. Esse ID existe na allowlist de
ilustrações, mas não na de ícones em `api/routes/autocard.js`. O save envia o
valor no campo `icon` e a API rejeita o payload.

A sessão principal confirmou no Chromium/API real: selecionar Novo Funcionário,
preencher título, conservar o ícone padrão e salvar com nome válido retorna
**HTTP 400**, mesmo com um único `Content-Type: application/json` após F09.
Nenhum registro foi criado. Script temporário:
`portal-correcoes-default-icon-check.cjs`.

O problema é preexistente. Os percursos anteriores que selecionaram outro ícone
válido não cobriam o default, e o teste de composição de header usa um parser
Express real, mas não o validador completo de cards. Correção pendente: escolher
um default persistido autorizado pela API, preservar os catálogos 38/16 e cobrir
o fluxo padrão contra o validador real.

### Importação CSV — aceitação parcial local

`portal-correcoes-import-check.cjs` passou contra API/PostgreSQL e Auth Emulator:

- Preview de e-mail duplicado, cargo inativo, CLT válido, PJ válido e dia PJ
  inválido; cargo além da primeira página de 100 resolvido corretamente.
- **500 linhas aceitas** em preview, 501 linhas e cabeçalhos inválidos recusados.
- Confirmadas apenas três linhas inelegíveis: job durável concluído, três linhas
  ignoradas, zero convites e zero pendências. ID
  `a595b9e6-456a-48c4-9750-d682b364b35e`, registrado também no manifesto temporário.
- Leitura pelo criador/super-admin permitida; outro gestor recebe 404, leitor
  recebe 403; retry sem falhas elegíveis retorna zero.

O host SMTP da stack foi novamente classificado como local/placeholder. Essa
rodada não valida o caminho positivo de convites, envio/recebimento de e-mail
nem retry de uma linha efetivamente enviada; esses pontos continuam pendentes.

### Persistência local — rodada concluída

Script controlado `portal-correcoes-persistence-check.cjs`, utilizando HTTP pelo
Nginx e identidades sintéticas, confirmou:

- Perfil: biografia persistida, foto normalizada em WebP, crop persistido,
  substituição e remoção; imagem inválida retornou 400 e tamanho excedido 413.
- Base de Conhecimento: anexo PDF privado, ponte para conteúdo publicado,
  preservação do corpo ao editar metadados, permissões de leitura do asset.
- CMS: nova revisão, agendamento futuro, cancelamento, publicação e retirada;
  o leitor conservou a publicação anterior durante o agendamento e perdeu o
  acesso ao conteúdo/asset após a retirada.
- JSON truncado, multipart truncado e arquivo com assinatura incompatível:
  respostas controladas 400.
- Academy: criar, ler, editar, desativar e excluir; leitor não vê curso inativo,
  enquanto o administrador consegue consultá-lo.
- Lembretes: criar, ler, ativar, excluir e restringir a destinatário explícito;
  conta fora do público não recebe o item na listagem.
- Sessão: desativar uma conta sintética invalidou seu token anterior e bloqueou
  login no Firebase Emulator; após reativação, o token antigo continuou recusado
  e um novo login voltou a funcionar. A conta de teste foi restaurada ativa.

Os registros temporários desse ciclo foram excluídos pelos próprios endpoints,
usando seus IDs registrados; os documentos A/B permanecem como fixtures dos
testes de interface. A rotina respeitou o limite existente de uploads do Nginx:
um primeiro percurso rápido recebeu 503 de rate limit, e a rodada completa
passou com os uploads espaçados, sem modificar a configuração. Não houve teste
de entrega externa de lembretes.

Lotes seguintes e a matriz final serão registrados após suas verificações.
O recebimento externo de e-mails, dados/cargos reais, conteúdo editorial oficial,
produção e dispositivos físicos dependem da homologação operacional apropriada.
Node 24 é o runtime usado pelos manifests e pelas verificações atuais; a
instrução preexistente de compatibilidade Node 18 continua divergente das
dependências existentes e não é comprovada por esta rodada.
