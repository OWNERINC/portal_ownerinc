# Portal — homologação operacional local de SMTP e primeiro acesso

Data: 29/09/2026. **Execução operacional: sessão principal.** Este documento
registra os artefatos dessa execução; o implementador apenas os leu, documentou
e executou os checks locais do repositório. Não repetiu operações na stack.

**Resultado:** fluxo local de convite/importação, compensação, retry manual e
login aprovado no alcance abaixo, com recuperação necessária para o usuário
individual. Configuração original restaurada. **Merge do PR #42, autodeploy,
entrega externa, cargos/conteúdo oficiais e testes de produção ainda pendentes.**

- HEAD da rodada: `4f3e51c236085503d1fdf2434427db4a1a84e6de`.
- [PR #42](https://github.com/OWNERINC/portal_ownerinc/pull/42) aberto; CI verde
  informada pelo primário para esse HEAD, sem nova consulta remota deste worker.
- Complementa o [aceite técnico por lotes](2026-09-29-portal-corrections-acceptance.md),
  sem substituir seu histórico ou converter homologação local em aceite de produção.

## Autorização e síntese da análise

O usuário autorizou SMTP de captura local e recriação/restauração somente de
API/cron para QA; após QA positivo, autorizou merge, autodeploy e testes em
produção. A análise A/B e sua única rodada de crítica já estavam concluídas
pelo primário. A decisão foi validar **três identidades sintéticas** e restaurar
a stack antes de prosseguir para o merge. Essa autorização não comprova a
execução das etapas de produção.

- **Fatos da rodada:** pré-checagem de backlog zero informada pelo primário;
  hashes de sete fontes de API/cron em execução iguais aos de HEAD; sink local
  sem relay; operações reais de API, cron, PostgreSQL e Auth Emulator; resultados
  de SMTP, persistência, login e restauração detalhados abaixo.
- **Divergência resolvida na análise:** a recusa controlada em `RCPT TO` pôde ser
  **550**, em vez de 451, porque o retry manual de linha falha exercitado não
  depende dessa classificação SMTP. Isso não demonstra retry automático de
  erro transitório nem muda a classificação de um 550 como recusa permanente.
- **Hipóteses ainda dependentes de observação:** recebimento na caixa externa,
  comportamento do handler de senha real e uso no iPhone. Captura SMTP local,
  handler do Emulator e viewport desktop não substituem essas observações.
- **Risco residual:** o cenário não prova garantia universal de entrega
  exatamente uma vez, inclusive em falhas/commits ambíguos fora desta execução.

## Fontes e alcance da evidência

Diretório primário, local e fora do repositório:
`C:/Users/Criação/AppData/Local/Temp/opencode/portal-smtp-acceptance/`.

| Fontes lidas | O que sustentam |
| --- | --- |
| `baseline.json`, `source-hashes.json` | HEAD, baseline de imagens/ambiente/mounts/redes e igualdade das sete fontes selecionadas. |
| `manifest.json`, `individual-response.json` | Identidades/cargo sintéticos, job e resposta do convite individual. |
| `preview.json`, `confirm.json`, `first-completion.json`, `failure-compensation.json` | Validação/confirmação do CSV, primeira execução e compensação da linha PJ recusada. |
| `retry-response.json`, `final-completion.json`, `no-op-retry.json`, `duplicate-refused.json` | Retry de uma linha, resultado final, retry sem trabalho e recusa da duplicata individual. |
| `correlations.json`, `durable-evidence.json`, `stable-after-tick.json` | Correlação Message-ID/auditoria/captura, estado persistido e estabilidade após ticks posteriores. |
| `first-login-results.json`, `individual-login.json` | Login real pela UI, identidades/contratos retornados e ressalva da recuperação individual. |
| `restoration.json` | Readiness e comparação da configuração restaurada com a baseline. |
| `qa.cjs`, `operations.cjs`, `first-login.cjs` | Método: ações API e polling, configuração temporária/restauração e login em contextos novos. Os roteiros foram lidos, não executados pelo documentador. |

Não foram abertos nem copiados arquivos `*.private.json` ou e-mails brutos.
Senhas, tokens, códigos OOB e URLs de ação com seus valores não foram copiados
para estes documentos. Não há PDF oficial
versionado nesta entrega. Os IDs publicados abaixo pertencem somente às
fixtures locais. A descrição de eventos de instrumentação/encerramento
informados pelo primário é identificada como tal, não inferida de campos que
não registram esses eventos.

## Ambiente e isolamento

- Stack `ownerinc-owner-news-local`; Portal em `http://localhost:8080` e
  Firebase Auth Emulator em loopback, porta 9099. Baseline em
  **2026-09-29 19:56:35 UTC**.
- Sink **Mailpit 1.27.4**, conforme registro do primário, com imagem fixada em
  `operations.cjs` por digest
  `sha256:df6c2541907e1be6fac21f509927cf6ed771617a1f4b361ef66d97bd05593d2d`.
  Sem relay; HTTP/API de captura publicado somente em `127.0.0.1:18025`.
  SMTP acessível pela rede Compose, sem porta SMTP publicada no host.
- AUTH com valores dummy de QA, sem credenciais reais. A configuração SMTP
  local de teste não demonstra TLS/autenticação do provedor de produção.
- Allowlist restrita a `qa-smtp-20260929-individual@ownerinc.local`,
  `qa-smtp-20260929-clt@ownerinc.local` e `qa-smtp-20260929-pj@ownerinc.local`.
  Inicialmente PJ ficou fora da allowlist para produzir a recusa; depois apenas
  essa terceira fixture foi admitida. A base de captura foi mantida na transição.
- `source-hashes.json` registra `matches: true` para `api/routes/users.js`,
  `api/routes/user-imports.js`, `api/services/user-invitation.js`,
  `api/services/bulk-user-import.js`, `api/integrations/password-reset-email.js`,
  `cron/index.js` e `cron/user-imports.js`. Não é uma alegação de hash individual
  de todos os arquivos das imagens.
- O roteiro operacional recriou API/cron usando as imagens existentes, sem
  build/pull; manteve o cron natural habilitado. `qa.cjs` aciona os endpoints e
  consulta o job até sua conclusão, sem chamar diretamente o processador interno.
  Convite e preview/confirmação/retry do CSV foram exercitados **pela API**, não
  submetidos pelo formulário administrativo nesta rodada. O login foi pela UI.

## Convites, compensação e retry observados

Job: **`7e954c71-e34d-42ea-b950-a028725178dd`**. Cargo exclusivamente sintético:
`ZZZ QA Cargo 102`, ID `eb778c9e-4b06-4ddf-ac92-7e77d028e3c5`, ativo.
Horários desta seção em UTC.

| Etapa | Resultado observado |
| --- | --- |
| Convite individual — `POST /api/users` | **201**, `invitation.state=accepted_by_smtp`, contrato CLT, role `viewer`, permissões `{}`. A resposta inicial ainda tinha `firebase_enable_pending=true`; o estado final persistido/login passou a `false`. |
| Preview do CSV | **200**, duas linhas, ambas `ready`: CLT sem dia PJ; PJ com dia 15. |
| Confirmação | **202**, mesmo job acima em `queued`, total/prontas = 2. |
| Primeiro tick — 20:02:00 | Job `completed`, **1 invited / 1 failed / 0 pending**. CLT: tentativa 1; PJ: tentativa 1, `firebase_uid=null`, recusa SMTP **550 5.1.0**. |
| Compensação da falha PJ | Nenhum usuário PostgreSQL da fixture PJ; Firebase `auth/user-not-found`; fila de cleanup correspondente com contagem **0**. Não ficou uma identidade ativa órfã nessa observação. |
| Retry manual após admitir PJ no sink | **202**, `retried=1`. Não houve nova confirmação do CSV inteiro. |
| Tick do retry — 20:04:00 | **2 invited / 0 failed / 0 pending**. CLT manteve o mesmo UID e tentativa 1; PJ concluiu na tentativa 2, com seu UID final. |
| Retry sem linhas elegíveis | **202**, `status=completed`, `retried=0`. |
| Repetição do convite individual | **409**, `Account already exists.` |

`durable-evidence.json` registra o worker `user-imports` com execução concluída
em **20:06:00 UTC**, `last_success_at` preenchido e `last_error=null`.
Isso complementa os resultados dos ticks naturais; não é prova de envio por
outros workers ou de recebimento externo.

### Correlação das três mensagens de convite

Para cada convite aceito, o evento `user.create` contém
`invitation.state=accepted_by_smtp`, resposta **250**, `accepted_count=1` e
`rejected_count=0`. Esses contadores pertencem aos **três aceites**, não apagam
a recusa 550 da primeira tentativa PJ. `correlations.json` associa os
Message-IDs auditados às capturas:

| Fixture | ID de auditoria | Message-ID | ID de captura |
| --- | --- | --- | --- |
| Individual | `2799035b-5871-4882-a5f5-b68831eb51f6` | `<8be852b3-50fb-a7ae-185d-3b01ff7cf646@ownerinc.local>` | `ifXetgAZMJpAcAnKxuiXMS` |
| CLT do CSV | `7034809e-ddc4-490b-b9e0-33423f488fd0` | `<be862f05-8f0f-9cfb-f896-8f79e87d80ed@ownerinc.local>` | `97EJLQC96Bg7J3YMr7Fp3E` |
| PJ do CSV | `e96b2ce2-0c6f-46de-9ff5-d94f0bc459e1` | `<14898872-fbc9-f1ff-d2c8-3f1c4c02ab36@ownerinc.local>` | `84ApksHrJSwEjgAuzhiW8P` |

Os eventos CLT/PJ referenciam o mesmo job; seus UIDs correspondem à tabela de
fixtures abaixo. Uma **quarta mensagem, de recuperação de senha do individual**,
foi capturada por causa da interrupção do roteiro de QA descrita a seguir.
Ela não é um quarto convite nem uma segunda execução do convite individual.

Às **20:16:24 UTC**, `stable-after-tick.json` registrou `rowsUnchanged=true`,
**4 mensagens = 3 convites + 1 recuperação**, após ticks posteriores. Houve um
convite aceito por fixture no período observado, sem alteração posterior das
linhas/tentativas. Isso não estabelece uma garantia universal de exactly-once.

## Definição de senha e logins: alcance e ressalva obrigatória

O primário relatou que o primeiro roteiro consumiu o OOB individual antes de
conseguir concluir sua observação da UI. A espera `waitForResponse` baseada em
`endsWith` travou; uma query na URL é uma **hipótese de instrumentação**, não
uma causa comprovada nem um defeito de produto demonstrado nesta documentação.
Foi necessário usar uma mensagem de **recuperação/reset capturada** para o
individual. CLT/PJ usaram as mensagens originais de convite capturadas.

O handler do **Auth Emulator** é `GET /emulator/action`, recebendo `newPassword`;
não é o formulário hospedado usado em produção. O roteiro acrescenta esse
parâmetro para a ação local, sem reproduzir aqui seu valor. O primário registrou
o host original **`127.0.0.1:9099`**, sem rewrite; os resultados trazem
`originalHostPreserved=true`. O destino de continuação validado era o login
local do Portal.

Em `first-login.cjs`, CLT/PJ abrem a ação capturada e verificam HTTP 200 e ausência
de erro no corpo. **A execução final pula essa navegação para o individual**, cuja
credencial de recuperação já havia sido estabelecida; nesse ramo, `actionStatus`
fica inicializado em 200. Portanto esse campo isolado **não é uma nova observação
HTTP do handler individual**. `individual-login.json` e o resultado final
sustentam o login UI efetivo, não um percurso individual com único link original
e sem reemissão.

`first-login-results.json`, concluído às **20:15:43 UTC**, registra três contextos
novos de navegador, submissão pela UI de login, chegada ao Dashboard e
`GET /api/users/me` **200**, sem erros de página. O roteiro usa Chromium/MS Edge
headless em **1440 × 900**, não um iPhone físico.

| Fixture mantida localmente | UID final | Contrato/dia | Origem da credencial no percurso concluído |
| --- | --- | --- | --- |
| Individual | `clMFZeW9JVUwLTQheXdrc0RTgfOo` | CLT / `null` | Recuperação capturada após interrupção do harness. |
| CLT do CSV | `WU84KFQ2DJLFJV0s7ey4bjTiNldn` | CLT / `null` | Convite original capturado. |
| PJ do CSV | `77xCy41VmitBJHOFQY1FWxB03iZm` | PJ / 15 | Convite original capturado, aceito no retry. |

As três respostas finais têm role **`viewer`**, permissões **`{}`**, conta não
desativada e `firebase_enable_pending=false`, com o cargo sintético esperado.
Os contratos coincidem entre a evidência persistida e os logins novos. Não se
atribui a esta execução validação de caixa externa ou do handler de produção.

## Restauração e estado retido

`restoration.json`, de **20:16:40 UTC**, registra readiness positivo e
`envFileHashUnchanged=true`. A comparação com a baseline confirmou:

| Serviço | Imagem / hash do ambiente / mounts / redes | Identidade do container |
| --- | --- | --- |
| API e cron | Iguais à baseline nos quatro critérios. | Recriados conforme autorizado; não se reivindica preservação dos IDs. |
| Nginx, PostgreSQL e Firebase Auth Emulator | Iguais à baseline nos quatro critérios. | IDs originais preservados nos três serviços. |

O arquivo de ambiente original não foi reescrito. O primário confirmou o sink
**parado e removido**, mantendo o volume exclusivo
`portal-smtp-qa-20260929-data` com evidência privada local. Em `operations.cjs`,
o JSON de restauração é gravado **antes** de parar/remover o sink: essas últimas
operações são confirmação do primário, não dedução apenas da presença do JSON.

As três fixtures continuam ativas localmente e o job acima permanece concluído,
sem linhas pendentes; UIDs, cargo e job foram preservados para rastreamento ou
limpeza posterior pelos IDs exatos. O worker documental não removeu fixtures,
mensagens, volume, imagens ou arquivos temporários.

## Produção e decisões autorizadas ainda pendentes

QA local positivo e restauração não significam execução das próximas etapas.
No fechamento deste registro, **nenhuma operação de produção foi concluída**:

| Etapa autorizada | Estado e limite |
| --- | --- |
| Merge do PR #42 e autodeploy | **Pendentes**. QA/restauração são a evidência local anterior ao merge; este documento não aciona Git, CI ou deploy. |
| SMTP/recebimento externo e testes de produção | **Pendentes**. Usar exclusivamente a mailbox autorizada `gabriel.garcia@ownerinc.com.br`; nenhuma captura no sink comprova entrega nessa caixa. |
| Cargos oficiais | **Pendente executar/verificar**: reativar **Coordenador de DHO** e **Liderança**; renomear **Tecnologia → Tech & Inovação** e reativar, preservando as flags existentes. O cargo sintético usado neste QA não representa essas alterações. |
| iPhone | **Pendente observação no dispositivo**; Chromium desktop e emulação de viewport não equivalem a homologação física. |
| Conteúdo oficial em PDF | Escopo aprovado: **“edição 4 maio 2026”** (identificação transcrita literalmente do despacho), com **capa e anexo completos**. Publicação/validação operacional **pendentes**; nenhum PDF foi lido, copiado ou versionado por este worker. |

Essas pendências não são um pedido de nova autorização: distinguem a autorização
já explícita da execução e de seus resultados, que cabem à sessão principal.

## Checks desta entrega documental e limites

- Somente este arquivo e um adendo append-only no ledger de aceitação foram
  alterados. App, testes, configuração, runtime e deploy não foram modificados.
- Worker: **Node 24.15.0 / npm 11.12.1**. `npm run verify`: **788 aprovados**,
  zero falhas/cancelamentos/testes pulados; sintaxe, testes, nomenclatura e scanner
  do repositório concluídos. Isso não é um novo `npm audit` nem comprovação Node 18.
- **Compose não foi executado**: Docker foi retirado somente do PATH do processo
  de verificação para respeitar a proibição operacional deste despacho. O
  verificador registrou `Docker Compose unavailable, skipping compose validation`;
  o PATH foi restaurado ao término. Não houve alteração persistente de configuração.
- `git diff --check`: aprovado. Os testes locais usam doubles e, quando previsto
  pela suíte, servidores efêmeros de loopback; não acessam a stack homologada nem
  constituem nova evidência de SMTP/produção.
- Conferência read-only dos artefatos: sete hashes de fonte iguais a HEAD, três
  correlações de convite, três resultados de login, contagens/tentativas e cinco
  comparações de restauração consistentes. Histórico do ledger preservado
  integralmente como prefixo do arquivo; nenhum diff rastreado fora do escopo.
- Os limites de captura, recuperação individual, handler do Emulator e garantia
  de entrega permanecem explícitos acima. A verificação documental não refaz a
  operação primária e não eleva suas hipóteses a fatos.
- Sem rede externa, DB, Docker, navegador, commit, push, merge, deploy, alteração
  de PR ou delegação por este worker. Nenhuma leitura de `*.private.json` ou
  cópia de e-mails brutos/segredos; nenhum dado de outros usuários oficiais.
