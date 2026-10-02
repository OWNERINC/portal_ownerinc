# Payload Owner News — validação real das Tasks 1–4

## Resultado — 02/10/2026

**35 casos de banco/HTTP PASS / 2 casos FAIL**, com PostgreSQL, Firebase Auth
Emulator, Express e Next/Payload reais. A revisão independente confirmou a
contagem e manteve as duas falhas abertas. A sessão principal acrescentou
**6 casos delimitados de navegador PASS**; edição interna dos blocos e aceite
visual responsivo continuam bloqueados/inconclusivos, conforme abaixo.
Esta rodada não declara aceite integral.

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

**Edição/colagem de conteúdo rico não aprovada.** O diagnóstico específico está
em andamento para distinguir código de produto, proxy descartável e limitações
da ferramenta. Não atribuir a causa antes dessa confirmação. O editor JSON dos
metadados também não recebeu aceite de usabilidade nesta inspeção.

### Limites da evidência visual

Houve tentativa de viewport desktop 1440×900 e mobile 390×844. Os snapshots de
mobile devolveram dimensões/posições incompatíveis com a viewport declarada,
inclusive campos de 32px fora dela marcados como visíveis. Assim, o aceite
responsivo é **INCONCLUSIVO**, não PASS. A captura de tela falhou na ferramenta
com `UnknownVizError`; nenhuma imagem foi salva. A evidência acima são interações,
valores após reload, mensagens nativas e snapshots textuais, sem afirmar aprovação
visual ou renderização em dispositivo físico.

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

- Browser: edição/colagem dos blocos, metadados, responsividade e apresentação de
  todos os erros; os seis casos acima não equivalem a aceite completo da interface.
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

Os logs mantêm os diagnósticos esperados de fixtures negativas e avisos anteriores.
Esses checks não anulam os dois FAILs reais. A revisão independente do backend
foi concluída; os bloqueios de interface e as correções ainda impedem aceite integral.
