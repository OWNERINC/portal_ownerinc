# Payload Owner News — validação real das Tasks 1–4

## Resultado — 02/10/2026

**35 casos de banco/HTTP PASS / 2 casos FAIL**, com PostgreSQL, Firebase Auth
Emulator, Express e Next/Payload reais. A revisão independente confirmou a
contagem e manteve as duas falhas abertas. A sessão principal acrescentou
**6 casos delimitados de navegador PASS**. Uma jornada posterior em Edge isolado
registrou **7 PASS / 3 FAIL em 10 cenários**, com edição real, persistência e
capturas; os três novos FAILs são descritos abaixo. As contagens de navegador são
por execução e possuem cobertura sobreposta, não devem ser somadas como casos
únicos. Esta rodada não declara aceite integral.

Base validada: `2aacdd548684594a6f770d0b7c61c12a6d4005b1`, branch
`feat/payload-owner-news`. Não houve correção de código de produto nesta rodada.
Este registro complementa, sem substituir, a evidência unitária das Tasks 1–4.

## Ambiente efetivo

- Projeto Compose exclusivo `ownerinc-payload-local`, volume novo descartável
  `ownerinc-payload-local-validation-20261002`; containers de outros projetos
  preservados.
- PostgreSQL **16.15**, imagem `postgres:16-alpine` prevista pelo repositório;
  bases vazias distintas `portal_upgrade`, `portal_bootstrap` e `cms_validation`.
- CMS migrado pelo CLI instalado **Payload 3.90.2**, papel `cms_migrator`
  sem superuser/createdb/createrole. Runtime `cms_runtime`, sem DDL e sem acesso
  às bases Portal; Express usa `portal_api`, sem acesso ao banco CMS.
- Firebase Emulator real, projeto sintético `demo-ownerinc-payload-local`,
  oito identidades sintéticas. Nenhuma conta de produção, Supabase, banco remoto,
  envio de email ou integração externa foi usada.
- Node **24.15.0** no host Windows; Next **16.3.8** em development e origem
  loopback HTTP `http://localhost:18080`. Não comprova runtime Linux/Node 18.
- Proxy/helper descartável de validação mantém Host, Origin, cookies, bytes das
  requisições e rotas/ações Next nativas. **Não é a infraestrutura/Nginx/CSP da
  futura Task 13.** A exceção HTTP de desenvolvimento já entregue foi respeitada.
- Segredos e uploads temporários ficam fora do checkout/public. O helper obtém
  ID token do Emulator e chama `POST /api/cms/session` real; nenhuma sessão ou
  projeção de identidade foi inserida diretamente para autenticar.

## Evidência executada

| Grupo | Casos | Resultado observado |
|---|---:|---|
| Migrations Portal upgrade/bootstrap | 2 PASS | `scripts/test-migrations.mjs` completo em duas bases vazias, opt-in explícito; ledger repetido, constraints, grants, expiração inclusiva, limpeza limitada, cascatas, autoridade e idempotência reais |
| Migration CMS | 1 PASS | `20261002_181423_owner_news_initial` aplicada pelo CLI; segunda execução sem reaplicar, um ledger/batch; 38 tabelas |
| Papéis/schema | 2 PASS | Identidades de conexão reais; CREATE/ALTER recusados com 42501, IDs UUID e índice único `portal_uid`; conexões cruzadas recusadas |
| Sessão, acesso e isolamento | 19 PASS / 1 FAIL | Bearer Emulator → cookie Portal → `/me`; hash persistido, duas contas isoladas, contas negadas, Origin, senha/first-user/refresh negados, permissão atual, bridge, concorrência, logout, expiração, indisponibilidade/recuperação e revogação Firebase; reemissão no mesmo segundo falha, abaixo |
| Conteúdo nativo | 6 PASS | Rascunho incompleto quote/richText/image, dois autosaves reais, rejeição de publicação incompleta, publicação rich text, draft posterior isolado, histórico/restore e validação de PATCH completo |
| Abertura | 1 PASS | Draft/publicação/draft posterior; atualização parcial nativa validada contra documento completo; publicação inválida recusada. API nativa global usa POST, não PATCH HTTP |
| Mídia fail-closed | 1 PASS | Leitura e criação `news-media` negadas, tabela sem arquivos; não é aceite de mídia real |
| Reinício CMS | 1 PASS | Processo reiniciado; mesma sessão válida; documentos/versões UUID persistentes, OIDs/colunas e ledger sem alteração/DDL |
| Importação sintética | 1 PASS / 1 FAIL | `editorial:null` e opcionais nulos preservados no banco e em atualização HTTP; DTO omite opcionais vazios; UUID explicitamente fornecido foi substituído, abaixo |
| Documento Next nativo | 1 PASS | Dashboard/documento autenticados HTTP 200. Login não autenticado usa resposta streamed HTTP 200 com instrução `NEXT_REDIRECT` para a entrada futura; navegação confirmada posteriormente em BROWSER-06 |

Os grupos somam **37 casos distintos: 35 PASS, 2 FAIL**. Não são 37 testes
unitários: cada caso reúne suas próprias asserções reais. Autosaves sucessivos
podem atualizar a mesma versão nativa de autosave; não se exige uma nova versão
imutável para cada tecla. O artigo completo conservou cinco versões nativas após
publicação, restauração e novo draft.

## FAILs abertos

### 1. UUID fornecido ao import local não é preservado

Com a configuração entregue, `payload.create({ collection:'news-articles',
overrideAccess:true, context:legacyNewsImportContext, data:{id,...} })` salvou
um UUID novo. Reproduzido em criações reais; não foi convertido em PASS por
diagnóstico ou por trocar a asserção para o ID gerado.

- Último solicitado: `571b7111-ee33-41ea-918f-24edb19a628e`.
- Efetivamente persistido: `63851549-198d-4c01-be5b-8ad763f2872e`.
- A configuração atual define `idType:'uuid'`, mas não habilita
  `allowIDOnCreate`; a implementação instalada do adapter só usa `data.id`
  quando essa opção está ativa. UUID como tipo não garante preservação do ID.
- O importador operacional da Task 10 ainda não existe. A revisão deve decidir
  o ajuste do contrato/configuração do importador confiável e sua cobertura,
  mantendo criação comum e identidade protegidas. Nenhuma opção do runtime
  foi alterada nesta validação.

### 2. Reemissão de sessão no mesmo segundo falha no Emulator

Duas emissões sequenciais para a mesma conta, com a cookie anterior na segunda:
primeira **201**, segunda **503**, cookie anterior depois **401**, hash com
`revoked_at` preenchido. Caracterização independente com Firebase Admin real
confirmou duas cookies de sessão idênticas no mesmo segundo.

O router revoga o hash anterior antes de emitir; o store tenta INSERT exclusivo
do mesmo hash e o serviço converte a falha em `editorial_unavailable`. Repetir
após o segundo seguinte recupera a emissão, mas não corrige o caso anterior.
O caso temporal permanece FAIL. Os demais cenários foram espaçados para serem
independentes, com a colisão testada explicitamente em separado.

O Emulator usa JWT **`alg:none`** e validação em modo emulator. Isso comprova
a falha nesse ambiente e a resolução/revogação pelo SDK real, **não** a
equivalência criptográfica ou temporal do Firebase de produção. Qualquer ajuste
de idempotência/rotação deve preservar a proibição de ressuscitar cookies
revogadas; não foi aplicada uma flexibilização para obter resultado verde.

## Inspeção real do navegador — sessão principal

Origem `http://localhost:18080`, conta sintética `editorA`, cookie real emitida
pelo Emulator/API através do helper descartável. O helper não substitui a futura
entrada do Portal. Interações realizadas no navegador OpenChamber:

| Caso | Resultado observado | Estado |
|---|---|---|
| BROWSER-01 — sessão e navegação | Helper retornou 201; dashboard nativo e catálogo com as três fixtures abriram com a cookie do navegador | PASS |
| BROWSER-02 — autosave e reload | Título alterado para “Validação navegador — rascunho persistido”; UI confirmou salvamento, versões 5→6; recarregamento completo manteve o texto | PASS |
| BROWSER-03 — histórico/restauração | Comparação nativa mostrou título/status; restaurar draft com confirmação retornou “Restored Successfully.”, título anterior e versão 7 | PASS |
| BROWSER-04 — publicação | Botão nativo do artigo completo mudou status para Published, versão 8 e estado salvo | PASS |
| BROWSER-05 — abertura | Headline “Abertura validada no navegador” salva automaticamente, mantida após reload e publicada; versões 3→4→5 e mensagem “Updated successfully.” | PASS |
| BROWSER-06 — revogação/redirect | DELETE pelo helper retornou 204; nova navegação ao painel foi redirecionada no navegador para a entrada ainda ausente (404) | PASS no encerramento/negação; jornada de entrada BLOCKED pela Task 9 |

O artigo exercitado é `02906bd0-17a8-4393-87d1-4971f6b69260`. A restauração
usou o draft `b120c1e3-2984-40cf-919d-a19624459265`; o caso atesta a ação nativa,
não todas as regras de preservação de publicação/agenda previstas na Task 6.
Artigo e abertura ficaram publicados apenas no banco sintético. A sessão do
navegador foi revogada ao terminar. Uma aba já renderizada continuou visível;
limpeza entre abas depende do observador ainda previsto na Task 9.

### Bloqueio observado nos campos dos blocos

No artigo completo e na fixture incompleta
`29582cb4-f0b5-468f-b762-49cec361fb94`, o navegador apresentou cabeçalhos
Rich Text/Quote/Image, mas não disponibilizou os controles internos de conteúdo,
texto, mídia, alt ou layout. Toggle block, Show All e reload não os expuseram.
Título/categoria e ações de salvamento permaneceram operacionais.

**Edição/colagem não foi verificada por essa inspeção OpenChamber.** O diagnóstico
posterior em Edge independente, pela mesma origem/proxy e com sessões reais de
editorA/editorB, renderizou os controles e valores dos dois documentos. Permissões
reais retornaram `body:true`; não se confirmou indisponibilidade geral causada
pelo schema/acesso. O Payload monta os campos internos via IntersectionObserver;
viewport/lazy-render do painel é uma hipótese restante, cuja causa exata continua
não comprovada. A observação original acima é preservada.

Também foi confirmado que o snapshot acessível do Monaco expõe apenas “Editor
content”/buffer IME vazio enquanto oito linhas visuais do DOM contêm JSON correto,
sob `aria-hidden=true`. Isso explica a ausência no snapshot, sem aprovar a
usabilidade editorial de um formulário JSON. A jornada seguinte verificou gestos
reais de edição, com limites e falhas próprios.

### Limites da evidência visual

Houve tentativa de viewport desktop 1440×900 e mobile 390×844. Os snapshots de
mobile devolveram dimensões/posições incompatíveis com a viewport declarada,
inclusive campos de 32px fora dela marcados como visíveis. Assim, o aceite
responsivo é **INCONCLUSIVO**, não PASS. A captura de tela falhou na ferramenta
com `UnknownVizError`; nenhuma imagem foi salva. A evidência acima são interações,
valores após reload, mensagens nativas e snapshots textuais, sem afirmar aprovação
visual ou renderização em dispositivo físico.

## Jornada independente de edição — Edge isolado

Execução posterior sobre `86b7e7bec029b312fb72480ffa398cd9fafa51a4`, com produto
inalterado. Edge **154.0.4258.48** headless/Playwright **1.63.0**, sessão sintética
nova de editorB na mesma stack. Foram **gestos automatizados reais de navegador**,
não ensaio manual: inputs, seleção/teclado, Ctrl+B, formulário de link, dropdown de
lista e clipboard sintético + Ctrl+V. Nenhuma injeção de estado no editor, escrita
direta por API/SQL ou alteração dos documentos anteriores/abertura/permissões.
As screenshots foram lidas pelo agente; não representam aparelho físico.

Fixture própria: **`4e742ca5-129c-4391-913b-c1f9ea7b6321`**, título
`VALIDATION ONLY - Edge native editing 2026-10-02`. Estado final: publicado com
draft posterior; quatro versões. A versão publicada é
`5f141ff7-d720-474c-bee7-a5a31de216db`; último autosave
`379965ec-d320-4ba5-8c51-052fd1684328`. Só o draft contém o marcador
`LATER DRAFT ONLY - Edge isolation marker.` em um terceiro item da lista.

| Caso | Estado | Evidência |
|---|---|---|
| EDGE-01 — criação única por navegação | FAIL | Duas navegações ao formulário nativo create produziram quatro drafts, em dois pares; criação/edição funcionaram, mas a unicidade esperada falhou neste ambiente dev |
| EDGE-02 — metadados no Monaco | PASS | Clique no editor, Ctrl+A/Ctrl+V, autosave200, GET e linhas visuais após reload confirmaram summary/data/source_label; usabilidade de negócio permanece sem aceite |
| EDGE-03 — Rich Text/negrito | PASS | Add Body → Rich Text, texto digitado e Ctrl+B; `<strong>`/Lexical `format:1` persistiram por autosave/reload |
| EDGE-04 — link com checkbox padrão | FAIL | URL HTTPS e label válidos, “Open in new tab” intocado: nó sem `newTab`, autosave400 `invalid_rich_text`; DOM local não persistiu |
| EDGE-05 — link explícito/lista/colagem | PASS | Checkbox marcado via UI, Unordered List de dois itens e duas linhas coladas; autosave200, reconhecimento nativo, reload e GET preservaram texto/href/formatação |
| EDGE-06 — publicação inválida | PASS | Summary vazio salvo como draft; Publish changes400 e toast `article_requires_summary_and_body`, continuou Draft; qualidade da mensagem não aprovada |
| EDGE-07 — publicação válida | PASS | Summary restaurado pela UI; Publish changes200, Status Published e “Updated successfully.”; GET/SQL corroboraram |
| EDGE-08 — draft posterior isolado | PASS | Marcador digitado/autosalvo/recarregado só no draft; body publicado idêntico ao anterior em GET e SQL somente leitura |
| EDGE-09 — geometria/foco desktop | PASS delimitado | 1440×900 sem overflow global, campos dentro da largura, Title → Category → Monaco por Tab e foco Lexical por clique; não certifica toda UX |
| EDGE-10 — geometria narrow | FAIL | Em390×844 documento409px; em320×844 documento365px. Cabeçalho/avatar ultrapassam a viewport; corpo/toolbar cabem. Reproduzido também em carga fresca |

**7 PASS / 3 FAIL / 0 BLOCKED nesta jornada.** Autosave/publicação corroboram
domínios já presentes nos seis casos primários; não adicioná-los novamente ao
total de 37 casos de banco/HTTP nem criar um total único somando execuções.

### Novos FAILs preservados, sem correção

1. **Create duplicado no ambiente local:** pares criados às 20:45:04.621/.864 e
   20:46:26.241/.492 UTC. O Payload instalado executa `payload.create(...draft:true)`
   no render de `views/Document/index.js:243–275` e depois redireciona. Não houve
   POST REST de criação pelo oracle. A razão exata da execução dupla e ocorrência
   em build de produção não foram determinadas. Investigar reexecução/render e
   idempotência desse caminho; não confundir com UUID de importação.
   Os três extras foram preservados e rotulados pela UI como `VALIDATION ONLY -
   create-route artifact 1/2/3 - Edge 2026-10-02`:
   `2bca4372-f0d7-4615-872a-5ef0748a585f`,
   `52d0c425-9189-4c24-9956-0cf5855f24cc`,
   `d6e0990a-4af7-48bc-8d98-b7689ab6cbec`.
2. **Link nativo default rejeitado:** request real contém
   `fields:{url:'https://example.com/owner-news-validation',linkType:'custom'}`,
   sem `newTab`. `cms/src/news/lexical-to-rich.ts:52` exige boolean; checkbox nativo
   instalado não define default. Reproduzido três vezes. Na terceira, DOM continha
   `DEFAULT LINK REJECTION PROBE`, mas GET antes/depois permaneceu idêntico e
   reload removeu o probe. Marcar explicitamente o checkbox gera `newTab:true` e
   permitiu concluir a jornada; esse cenário não corrige nem anula o FAIL.
   Direção mínima: alinhar o default nativo/projeção mantendo validação de tipos
   e HTTPS. Nenhuma alteração de produto foi aplicada.
3. **Overflow narrow:** account x383.734/right408.734 em 390px; x322.453/right347.453
   em 320px. Breadcrumb alcança 365.281 em 320px. O avatar fica cortado/fora da tela,
   inclusive em navegação fresca. Investigar flex/encolhimento de AppHeader e
   StepNav. O canvas interno enorme do Monaco é recortado pelo scroller e não foi
   confundido com a largura real do documento.

### Geometria e distinção de evidências

| Viewport | doc client/scroll | Title/Category x/largura/altura | Lexical x/largura |
|---|---|---|---|
| 1440×900 | 1440/1440 | 60 / 1320 / 40 | 81 / 1278 |
| 390×844 | 390/409 | 16 / 358 / 40 | 33 / 324 |
| 320×844 | 320/365 | 16 / 288 / 40 | 33 / 254 |

Toolbar bold/link 30×30px; Publish 118.328×32 desktop e 109.344×29.688 narrow;
texto dos inputs 13px/12px, Lexical 16px. Foco Title → Category → Monaco funcionou
em todos os tamanhos medidos; o JSON ocupa área de 144px com scroll/wrap. Botões da
toolbar aparecem sem nome no snapshot acessível. São observações limitadas de
foco/alvos/acessibilidade, não aceite completo. Um seletor inicial clicava a linha
do Monaco sob decoração/sticky controls; clicar a área visível do editor resolveu
o oracle, sem forçar eventos nem alterar produto.

DOM e screenshots demonstram renderização/gestos; GETs autenticados com
`draft=true|false` demonstram estado servido; SELECTs parametrizados em
`BEGIN READ ONLY`, como `cms_runtime`, confirmaram conteúdo publicado e versão
latest distintos para esta fixture. Os títulos dos extras estão nas versões
latest, enquanto suas linhas principais permanecem vazias, comportamento nativo
de draft. Nenhum INSERT/UPDATE SQL foi usado.

Relatório focado ignorado: `real-validation-edge-editing.md` no workspace de
coordenação. Capturas/JSON/oracle externo ao checkout em
`C:/Users/Criação/AppData/Local/Temp/opencode/ownerinc-edge-editing/`, especialmente
`06-rich-content-reloaded.png`, `07-invalid-publication.png`,
`10-default-link-dom-not-stored.png`, `11-default-link-reload-old-draft.png`,
`geometry-1440-body.png`, `geometry-390-body.png`, `geometry-320-body.png` e
`overflow-390-fresh-top.png`/`overflow-320-fresh-top.png`.
Sem segredos/cookies/PII nas capturas. Browsers diagnósticos fechados; backend
preservado para inspeção. Abas da sessão principal não foram operadas.

## Revisão independente da evidência

A revisão confirmou os 35 PASS/2 FAIL de banco/HTTP e aprovou a documentação
como registro fiel, mantendo estas ressalvas para futuras execuções:

- O teste de reemissão deve comprovar colisão efetiva e verificar nova cookie
  válida/antiga revogada antes de certificar uma correção. Seu FAIL observado é
  válido, mas um futuro 201 isolado não bastaria para provar a solução.
- A repetição da migration sobrescreveu o primeiro log do CLI. Ledger/schema
  reais corroboram a aplicação, mas reproduções futuras devem preservar os dois
  logs separadamente. Não se reexecutou setup sobre bases já povoadas.
- A colisão foi demonstrada no Emulator; ocorrência no Firebase assinado de
  produção continua incerta. Preservar ID exige configuração confiável de importação;
  não basta o tipo UUID. Nenhuma dessas falhas foi corrigida nesta rodada.

## Pendências explícitas

- Browser: resolver os três FAILs da jornada Edge e a causa específica dos campos
  vazios no painel primário; avaliar usabilidade dos metadados, responsividade
  completa e apresentação dos demais erros. Os PASSs delimitados não equivalem
  a aceite completo da interface.
- Task 9: entrada/saída nativa pelo Portal, logout entre produtos e observação
  de troca de conta entre abas. `/editorial-entry.html` continua ausente (404).
- Task 5: upload/arquivo/PDF/imagem real, assinatura/hash/presença e entrega privada.
  Imagem incompleta salva sem mídia prova somente persistência do rascunho.
- Task 13: Nginx/CSP operacional, containers API/CMS de deploy, runtime Linux e
  topologia de produção. A ponte de validação não substitui esse aceite.
- Assinaturas Firebase reais, carga/quotas distribuídas e produção.
- Tasks posteriores: leitura Portal por Payload, agenda/snapshot, autoridade de
  escrita/cutover, acervo real e migração operacional. Autoridade continua `legacy`.

## Reprodutibilidade e handoff

Scripts, matriz caso a caso e instruções de navegador estão no workspace de
coordenação ignorado `.superpowers/sdd/2026-10-02-payload-owner-news-implementation/`:

- `real-validation-report.md`: comandos, resultados e diagnóstico completo.
- `real-validation-browser.md`: URL, controles sem credenciais, IDs e processos.
- `real-validation-browser-observations.md`: interações e limites observados pela
  sessão principal; `real-validation-review.md`: revisão independente do backend.
- `real-validation-browser-diagnosis.md`: renderização independente e distinção
  DOM/snapshot do Monaco; `real-validation-edge-editing.md`: jornada autoral,
  casos/FAILs, IDs, bounds, capturas e distinção DOM/HTTP/SQL.
- `validation-compose.yml`, `validation-setup.mjs`, `validation-server.mjs`,
  `validation-http.mjs`, `validation-extra.mjs`: infraestrutura e testes opt-in
  desta rodada, não instalados como infraestrutura operacional.

As duas bases Portal não podem ser reutilizadas nos modos empty-database de
setup: o próprio script as recusa. A reprodução integral exige novos bancos e
volume explicitamente descartáveis. A stack permanece ligada para a inspeção
da sessão principal; sua desmontagem deve ser restrita aos recursos próprios.

Verificação do checkout nesta rodada:

- `npm run verify`: **1144 PASS, 0 FAIL, 2 skips Linux conhecidos**, `verify: ok`.
- `npm --prefix cms run test:unit`: **72 PASS, 0 FAIL**.
- `npm --prefix cms run typecheck`: **exit 0**.
- `git diff --check`: exit 0, inclusive após acrescentar a evidência do navegador.

A sessão principal repetiu `npm run verify` após documentar as interações:
**1144 PASS / 0 FAIL / 2 skips**, `verify: ok`. Saída retida pelo harness:
`sh_0fe5447d0001DhDCAzpm9b7k2R.out` (diretório de logs registrado no relatório
de coordenação). Nenhum código de produto foi alterado para obter esses resultados.

A extensão documental de diagnóstico/Edge reutilizou esse verify recente em
produto inalterado, conforme escopo autorizado, e executou somente os diff checks;
não repetiu migrations, suite HTTP ampla ou serviços.

Os logs mantêm os diagnósticos esperados de fixtures negativas e avisos anteriores.
Esses checks não anulam os dois FAILs anteriores nem os três FAILs locais da jornada
Edge. A revisão independente do backend foi concluída; as falhas e pendências de
interface/integração ainda impedem aceite integral.
