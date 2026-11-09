# Conecta V3.5 — evidências de redesign e release

## Escopo

Redesign das áreas atuais do Portal segundo a especificação aprovada em
`docs/superpowers/specs/2026-11-08-conecta-orange-redesign-design.md`.
Execução na branch `feat/conecta-orange-redesign`.

## Referência e assets

- Canvas V3.5 acessado via MCP no documento `Conecta-Ownerinc-V2.pen`.
- Paleta `v35-*` e Manrope confirmadas diretamente nos nós.
- Logo e símbolo extraídos dos componentes originais; proveniência em
  `public/assets/conecta/README.md`. A fonte é local com licença OFL.

## Base local

Em `952a038`, após instalar as dependências dos lockfiles:

- `npm run verify`: 810 PASS, zero falhas, dois skips específicos de Linux.
- `git diff --check`: sem problemas.
- `npm run security`: zero vulnerabilidades no escopo de produção auditado de
  API e cron (`--omit=dev --omit=optional --audit-level=high`). O audit geral
  do bootstrap inclui um escopo diferente e não substitui esse gate.

## Ambiente de inspeção visual

`tests/visual/serve-conecta.mjs` serve o frontend em loopback com fixtures de dados
e autenticação. As páginas exibem identificação explícita de prévia. Gravações
são recusadas; o servidor não encaminha requisições para APIs de produção.
`tests/visual/check-conecta.mjs` usa Chrome/Playwright externo ao projeto para
conferir reflow, headings, imagens, menu por teclado e navegação persistente.

Esses resultados comprovam somente o comportamento observado com fixtures.
Autenticação Firebase real, persistência, envio de email e exportação autenticada
exigem evidência própria do ambiente integrado.

## Deploy existente — inspeção de base

- Repositório: `OWNERINC/portal_ownerinc`.
- Workflow `41833661738`, SHA `952a038d528f72dbf20f11cb8e7ac7fcbff7639b`:
  jobs `validate` e `Deploy production` concluídos com sucesso em 04/11/2026.
- Job de deploy `126587657485`: etapa de backup, migration, smoke e rollback
  concluída com sucesso segundo o GitHub Actions.
- Logs desse job confirmam `0 migrations applied`, `current schema ok`, smoke
  aprovado e estado final `ready` com SHA `952a038d528f72dbf20f11cb8e7ac7fcbff7639b`.
  Há um aviso não fatal de limpeza incompleta da retenção de backups. O log
  confirma a release validada, mas não comprova que essa limpeza foi regularizada.
- Workflow inspecionado em `.github/workflows/ci.yml`: PR executa validação,
  integração PostgreSQL, build, scans, audit e SBOM. Publicação de imagens e
  deploy exigem `main` via push ou workflow_dispatch; o pacote usa o SHA exato
  validado e referências de imagens por digest. Não foi acionado deploy.
- Smoke público read-only em 08/11/2026:
  `BASE_URL=https://portal.ownerinc.com.br SMOKE_ATTEMPTS=1 bash scripts/smoke.sh`
  retornou `{"check":"smoke","status":"ok","attempt":1}`.

Essa inspeção se refere à versão já publicada, **não ao redesign**. O pipeline
publica a revisão de `main`; abrir o PR não publica esta branch. A thread Astra
xhigh confirmou que aconselhamento técnico não substitui autorização humana
para merge e acionamento de produção.

## Estado desta evidência

Implementação dos quatro lotes concluída. Verificação integrada e revisões
frescas finais aprovadas. PR aberto, CI aprovado e merge/produção aguardando
autorização humana, conforme a especificação.

### Lotes 1–2 revisados

- Base visual, marca, shell, dashboard, conhecimento, lembretes e Academy
  implementados. Dashboard consulta retomada real e usa catálogo como fallback.
- Testes do lote de conteúdo: 141 PASS. Integração inicial encontrou seis
  expectativas antigas de marca/fonte/markup; as quatro suítes afetadas passaram
  com 110 testes após a atualização dos contratos visuais aprovados.
- Inspeção integrada inicial: 11 rotas em 1920/402 px sem overflow, imagens
  quebradas ou erros JavaScript. Drawer/Escape/retorno de foco e navegação
  persistente recolhida aprovados.
- Auditoria axe dos quatro destinos principais: 8 combinações rota/largura
  aprovadas após corrigir contraste sobre lavanda e semântica das paginações.
  Revisão independente também aprovou a sala de aula em 1366/402 px, incluindo
  contraste da seleção e região nomeada do player.
- Harness de interação: 24 estados em 1920/402/360 px, cobrindo detalhe/modal de
  artigo, modal/validação de lembrete, curso/aula e falha/retentativa independente
  da Academy no dashboard.
- Revisão fresca solicitou quatro ajustes: isolamento das fontes das artes,
  contraste da aula selecionada, links da marca de 44 × 44 px e captura
  recolhida estabilizada. Re-review aprovou todos, com 66 testes direcionados.
- Comparação inicial com `public/` extraído do SHA-base `952a038`: 12 casos
  aprovados, sem diferenças nas propriedades/caixas dos nós das artes. São os
  quatro modelos AutoCard e os dois Cards Pós, em canvases de 540 e 320 px.
  A comparação fixa a largura antes da montagem para evitar falsos diffs do
  ajuste assíncrono. A repetição após o redesign dos editores também passou.

### Acesso, conta e administração

- Login claro com marca oficial, perfil em duas colunas e usuários administrativos
  em linhas/cartões responsivos. Os fluxos de recuperação, cadastro, convite,
  upload/crop, abas e permissões continuam usando os contratos existentes.
- Fotografia do login omitida: a referência não estava disponível entre os assets
  locais do Portal. Não foi substituída por fotografia de outra origem.
- Em 09/11, a frase abaixo da marca no login foi substituída pelo botão PodFalar,
  disponível também no mobile e sem autenticação. O link informado pelo usuário
  (`https://app.denouncefy.com/portal/canaldedenunciaownerinc`) abre em nova aba,
  sem acesso à aba de origem e sem envio de referrer.
- Revisão posterior aprovada em 09/11: seguir `Conecta-Ownerinc-V3.5-Aprovado.pen`,
  pranchetas `V5ZIg` (P17D-R1, 1440 × 900) e `rbBzt` (P17M-R1, 402 px),
  em vez da imagem antiga com fotografia. Marca como H1, logo desktop de 320 px,
  símbolo mobile de 104 px e frase como H2 de 22/17 px. A frase volta a coexistir
  com um único bloco público PodFalar, sem duplicá-lo no formulário. O acesso
  inicial usa a região “Acesso ao portal” sem título visível, com Entrar no portal
  e Cadastre-se em larguras iguais e intervalo de 12 px. Criação de senha retorna
  para dentro do cadastro, preservando os endpoints, a confirmação do e-mail e a
  aprovação administrativa. Títulos específicos e retorno de foco cobrem os
  fluxos secundários; navegação autenticada e Cards Pós não mudam.
- O usuário também aprovou a aplicação da logo horizontal original do PodFalar
  dentro do botão, substituindo somente seu texto visual. Os três SVGs fornecidos
  foram preservados em `public/assets/podfalar/`, sem recoloração, com teste de
  integridade SHA-256. Alt, nome acessível, destino e isolamento da nova aba
  permanecem; o navegador confere carregamento, proporção e reflow da logo.
- Ajuste de composição solicitado em seguida: PodFalar deixa a coluna da marca e
  passa para a parte inferior do cartão de acesso, após as ações de login/cadastro,
  com divisória e espaçamento. Segue fora de todos os formulários e disponível nos
  fluxos secundários. Essa posição substitui a da prancheta de origem por decisão
  do usuário; os testes conferem posição dentro do cartão e ordem por teclado.
- Após aprovar a composição, o usuário solicitou centralizar todo o conjunto no
  mobile, nos eixos vertical e horizontal. O container mantém altura mínima de
  viewport e respiros simétricos de 24 px, respeitando safe areas; cresce e permite
  rolagem natural quando a altura disponível não comporta marca e cartão.
  Os testes medem centralização nos quatro estados e acesso ao rodapé/campos em
  viewports reduzidos de 360 × 480/568/667 px, sem simular um teclado físico real.
- Evidência local dessa revisão: 54 testes direcionados aprovados; navegador em
  dez larguras de 320 a 1920 px, quatro estados por largura sem violações axe
  WCAG A/AA automatizadas, reflow e retorno de foco aprovados. Cadastro, recuperação,
  criação de senha e abertura do canal foram simulados; não comprovam envio de
  e-mail, autenticação Firebase nem publicação dessa revisão.
- Lote validado com 130 testes direcionados, 75 checks responsivos nas cinco
  larguras, cinco checks de crop e zero violações axe nas 15 combinações de
  página/largura e nos cinco diálogos de crop. Sucessos de escrita nessas
  inspeções foram simulados no navegador, sem envio real.
- `npm run verify` integrado após os três primeiros lotes: **817 PASS, dois skips
  Linux, zero falhas**, seguido de `verify: ok`.
- Review fresco identificou que o novo label “Alterar foto” permitia escolher
  um arquivo durante outra ação. O input agora participa do bloqueio; eventos
  tardios do seletor são ignorados antes de alterar feedback. Regressão com
  requisição adiada e os testes de foco/crop passaram: 30 PASS.
- Re-review do perfil aprovado após reprodução em 402/1366 px: seletor bloqueado
  durante a ação, resposta tardia ignorada e nova seleção funcional ao terminar.
- A tela inicial de verificação de acesso também usa a marca/paleta Conecta;
  o encaminhamento autenticado permanece no mesmo módulo `js/index.js`.
- Benefícios e Sólides mantêm a disponibilidade atual e recebem os componentes
  compartilhados. Auditoria axe desktop/mobile dessas rotas: quatro casos PASS.

### AutoCard e Cards Pós

- Galerias, barras, editor/prévia, históricos, ações persistentes e diálogos
  adaptados à identidade Conecta. Renderizadores e exportadores preservados.
- 128 testes direcionados PASS; 68 capturas/estados nas cinco larguras sem
  overflow horizontal, controles visíveis subdimensionados ou erros de página.
- 19 auditorias axe dos editores. As ocorrências restantes são de contraste
  original das artes Cards Pós: Guest `#a49581` sobre `#e9e6de` (aproximadamente
  2,34:1) e endereço/nota Owner sobre branco (aproximadamente 2,91:1).
  Essas cores foram preservadas conforme a restrição das artes; não se declara
  conformidade integral de acessibilidade das peças.
- Comparação final com a base `952a038`: **12/12 PASS**, zero diferenças de
  texto, estilos computados e geometria dos nós amostrados, incluindo quatro
  modelos AutoCard e Guest/Owner Cards Pós em 540/320 px. Essa comparação não
  é uma comparação de bytes de arquivos PNG/PDF exportados.

### Verificação integrada final

- `npm run build:public`: shell regenerado após todos os lotes.
- `npm run verify`: **818 PASS, dois skips Linux, zero falhas**, `verify: ok`.
  Repetido após as correções finais de foco/viewport dos editores com o mesmo
  resultado: 818 PASS, dois skips, zero falhas.
- `npm run security`: zero vulnerabilidades de produção de API e cron no escopo
  `--omit=dev --omit=optional --audit-level=high`.
- Matriz visual: **55/55 PASS**, 11 rotas × 1920/402/360/768/1366 px, com
  drawer mobile, Escape, retorno de foco e navegação recolhida persistente.
- Evidência integrada local: diretório temporário `conecta-final/`; evidência
  de arte: `.superpowers/sdd/2026-11-08-conecta-orange-redesign/task-4-art/`.
  Capturas locais não são enviadas ao runtime nem tratadas como dados reais.

### Revisões finais

- Revisão independente do diff completo: aprovada para implementação/PR, com
  24 testes direcionados, shell gerado e diff check aprovados, além de inspeção
  baseline/atual em navegador. Não equivale a autorização de produção.
- Review específico dos editores encontrou dois P2 em estados ainda não cobertos:
  foco coberto pelas ações sticky do AutoCard e painel inline do Cards Pós sob
  teclado virtual. Ambos corrigidos e fechados em re-review direcionado.
- AutoCard: regressão de navegador usa Tab/Shift+Tab reais e hit-testing do
  controle focado em 360×874, 768×874 e 1366×768. Após ajuste de rolagem no foco,
  os 12 controles do formulário Vaga passaram nas três dimensões.
- Re-review do AutoCard fechou o P2 e verificou a sensibilidade do teste:
  desativar somente o listener em memória faz a regressão falhar nas três
  larguras. 58 testes de invariantes também passaram.
- Cards Pós: posicionamento agora considera altura e offset do visualViewport,
  sincroniza abertura/resize/scroll e limpa overrides ao fechar ou desmontar.
  Regressão sintética em layout 402×874 com área visível de 450 px manteve o
  painel em y=69–438, campo em y=133–253 e Concluir/Cancelar em y=313–361.
  Offset não zero, restauração, abertura com teclado já reduzindo a área,
  mudança de breakpoint e limpeza SPA passaram. Não é captura de teclado físico.
  70 testes direcionados e nova comparação das artes 12/12 passaram.
- Re-review final dos Cards Pós aprovado: seis estados de geometria, fechamento,
  breakpoint e limpeza SPA passaram. Restaurar em memória a âncora inferior
  antiga faz o teste falhar, confirmando que detecta a regressão. Não há achados
  pendentes nas revisões dos quatro lotes e do diff completo.
- Harness integrado ampliado: **39/39 PASS** em 1920/402/360 px, incluindo
  superfície off-white, Manrope, heading único e documento persistente nas
  transições AutoCard → Cards Pós → perfil → administração → dashboard.
- A navegação Cards Pós → perfil exige confirmação de descarte já na base
  `952a038`, devido à normalização inicial de texto rico. O harness de navegação
  confirma o diálogo real explicitamente; não desativa a proteção de rascunho.

## PR e CI

- PR: [#89 — Conecta Ownerinc V3.5](https://github.com/OWNERINC/portal_ownerinc/pull/89),
  base `main`, branch `feat/conecta-orange-redesign`.
- Implementação: `6a48b3f`; evidências iniciais: `78afac8`.
- [CI 42535343501](https://github.com/OWNERINC/portal_ownerinc/actions/runs/42535343501)
  aprovado no SHA `78afac80c0257153aa0a9a413e72c261d42557b6`.
- Logs do job `validate` confirmam **828 testes PASS, zero falhas e zero skips**
  no Linux. A contagem inclui os subtestes Linux que não executam no Windows.
- Migrações fresh/upgrade/bootstrap, readiness sem relações editoriais e seis
  testes de integração Academy/PostgreSQL aprovados. Builds das imagens API/cron,
  scans, audit de produção e geração dos SBOMs aprovados.
- PR consultado sem conflitos (`MERGEABLE`, `CLEAN`), sem comentários/reviews
  externos pendentes naquele momento. Revisões dos agentes estão consolidadas
  neste relatório e não representam aprovação de outro usuário no GitHub.
- `Deploy production` ficou `SKIPPED`, como esperado em `pull_request`.
  **Não há deploy do redesign.** O merge em `main` dispara publicação e continua
  dependendo de autorização humana explícita.
- Este fechamento altera somente documentação. O estado do CI do HEAD mais
  recente deve ser consultado nos checks do PR; o run acima identifica a
  evidência verificada da implementação.
