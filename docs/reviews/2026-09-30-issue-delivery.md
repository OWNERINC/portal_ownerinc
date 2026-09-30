# Homologação e entrega das issues — 30/09/2026

## Escopo e método

Este documento registra a homologação anterior e posterior à publicação da
[PR #45](https://github.com/OWNERINC/portal_ownerinc/pull/45). O resultado final
do deploy, digests efetivos e aceite por issue estão registrados abaixo e nas
issues vinculadas, mantendo identificável a ordem das evidências.

Plano aprovado para entrega até 15h de Brasília, a partir da revisão
`3abc068b04d3bc785998dae05742a5bd230eee4d`, em worktree isolada.
Cada implementação recebeu teste de outro agente; ensaios operacionais têm
evidência separada dos testes unitários. Este registro é atualizado durante a
entrega; a publicação final e o estado das issues são registrados no GitHub.

Preservados: conta QA ativa ao final, conta administrativa, cargos/vínculos,
permissões e Owner News edição 4. Emails externos de teste somente para
`gabriel.garcia@ownerinc.com.br`, sem aliases. Clones usam recursos exclusivos;
credenciais, tokens, dumps e snapshots de revisão não são versionados.

## Correções comprovadas

| Entrega | Revisão | Verificação independente |
| --- | --- | --- |
| Chamada real da AWS CLI, helper 0644 e backup de proteção local no restore | `e41b064` | 12 casos executando Bash real em Linux; argumentos, manifestos, retorno de erro, preservação local e traps |
| Nodemailer 10.0.13 em API/cron | `d8e7115` | 41 testes, incluindo servidor SMTP TCP loopback real; auditoria de produção com 0 vulnerabilidades |
| Gates PostgreSQL 16 e smoke do router atual | `2678c00` | 31 migrations, reexecução idempotente, verificador real, 12 negativos recusados e 23 checks HTTP com assets reais |
| PNG móvel do AutoCard fiel à prévia | `d64fffa` | 72 testes e 6 cenários em Chromium 153/html2canvas 1.4.1, com 12 PNGs reais |
| Backup diário e renovação TLS | `7803699` | 44 casos Linux e 10 probes adicionais independentes; quatro unidades systemd e calendários válidos |
| Origem correta do recorte no avatar | `a35a530` | Reteste independente: 12 cenários, 265 assertions e 15 testes automatizados; geometria/pixels aprovados |
| Headers de segurança dos assets | `c40fea6`, `89fb497` | Reteste independente: 10 GETs/60 verificações de headers, 21 testes e nginx -t aprovados; 20/20 assets publicados conferidos |
| Nomes, foco e seleções acessíveis | `c862971` | Reteste independente: 84 testes, 50 leituras AX, 12 amostras de pixels; três pares de PNGs byte-idênticos |
| Arraste contínuo da foto | `d275fc4` | Oito cenários aprovados independentemente; seis medições suplementares classificadas por comparação antes/depois |

Verificação final executada pela sessão primária em `d275fc4`: `npm run verify`
aprovado, **862 testes passaram, zero falhas e dois skips exclusivos de Linux no
Windows**. Esses dois caminhos foram executados na suíte Linux de timers. Auditoria
de dependências de produção: **zero vulnerabilidades** em API e cron.
CI da revisão final: [36748329056](https://github.com/OWNERINC/portal_ownerinc/actions/runs/36748329056),
tentativa 2 aprovada, incluindo migrations reais, build, scans e SBOM. A
publicação terminou às **14:18:51 de Brasília** na revisão
`a1414d89cbfcee7f2beeaefef21911cff1c1bfce`.

O helper S3 também foi executado por outro agente com **AWS CLI 2.37.6 real** e
endpoint S3-compatible SeaweedFS 4.48, em rede Docker descartável. Upload pelo
script versionado e download para diretório vazio preservaram os três arquivos
e seus hashes, incluindo caminhos/prefixos com espaços. Manifestos inválidos não
geraram objetos; credenciais inválidas/endpoint recusado falharam sem alterar o
backup local; acesso anônimo foi negado. Essa integração local não valida um
provedor externo, criptografia, retenção ou durabilidade operacional.

A diferença de largura do AutoCard foi medida: scrollbar de 15px deixava a prévia
com 301px e o clone com 316px, mas o recorte continuava 301px. Somente o clone agora
recebe as dimensões medidas, inclusive fracionárias/não quadradas. Rodapé/logo
completos no PNG móvel; PNG desktop de 420px idêntico byte a byte. O limite real de
texto de 26/27px continua bloqueando exportação.

## Restore integral Linux — #1

O ensaio inicial revelou falhas reais no verificador SQL e no smoke antigo.
Após `2678c00`, outro agente executou o script integral com snapshots de dados e
arquivos em Linux/PostgreSQL 16.14:

- Backup e restore retornaram 0; backup pré-restore e hashes conferidos.
- Restauração completa em **21.073s**, de **12:19:12 a 12:19:33 de Brasília**;
  reconstrução complementar em **23.758s**. Snapshot original às 12:18:55,
  backup de proteção às 12:19:12. Os três workers reais concluíram às 12:29:20.
- Usuário, card, mídia e `cron_status` recuperados; arquivo removido após snapshot
  voltou e arquivo criado depois dele desapareceu.
- Backup de proteção reteve os valores/arquivos mutados anteriores ao restore.
- Ledger com 31 migrations, roles separadas e grants verificados. CLI do verificador e smoke reais
  passaram após restart.
- Login pelo emulator próprio e leituras autenticadas retornaram 200; leitura
  de card/mídia sem autenticação retornou 401.
- Depois de preservar os snapshots, cron saiu do modo bootstrap; os três workers
  completaram execução real com heartbeat recente, sem falhas; health retornou 0.
- API/cron saudáveis; Nginx respondeu à readiness real. Seu Docker healthcheck
  adicional pertencia somente ao clone; o Compose base não define um para Nginx.

**Limite:** fixtures pequenas e sintéticas, não cópia de produção/S3. Os tempos
ficaram abaixo da meta de 4h nesse ensaio; não estimam recuperação de outro volume.
Usaram-se digests genuínos com código commitado read-only e Nodemailer 10.0.13
conferido pela integridade do lockfile. Recursos/segredos próprios foram removidos.

## Rollback do receptor real — #6

Executados dois cenários em staging Linux isolado na VPS, sem alterar o receiver:
SHA256 `30be4941fe15c1c75e16175625685e2f51acc6ceaa52db146d61684cdacce0f7`.

| Fase | Janela Brasília | Tempo | Resultado observado |
| --- | --- | --- | --- |
| Antes do ingresso | 12:12:55–12:13:53 | 58s | Mutation commitada, migration falhou, trap restaurou o banco e recuperou serviços anteriores |
| Depois do ingresso | 12:27:30–12:29:59 | 149s | Imagens diferentes realmente ativadas, smoke falhou por 404 controlado, imagens anteriores recuperadas e banco preservado |

O retorno 1 é o esperado para a falha induzida. `rolled_back` sozinho não foi
considerado sucesso: foram comparados sentinelas, digests, ponteiro, ledger,
uploads e health/smoke posteriores. No primeiro cenário, API/cron candidatos não
chegaram a ser ativados. O segundo usou digests GHCR distintos das releases 3abc/FDEC.
O verificador 2678 foi montado read-only no ensaio; não era build nativo dessa revisão.
A conferência independente passou: 159 artefatos originais íntegros, arquivos
dos archives comparados ao Git, backups verificados e estado recuperado consultado
diretamente. Outro replay pós-ingresso durou **147.831s**; após capturar o estado
recuperado, o tester adicionou fixtures de autenticação e confirmou login real no
Firebase Emulator, perfil/card/mídia com 200 e os mesmos acessos sem token com 401.
Essas fixtures adicionadas depois comprovam a recuperação do serviço autenticado,
não restauração daquelas novas linhas. Todos os recursos e segredos de teste foram
removidos; metadados de produção permaneceram iguais durante a revisão.

O receptor aprovado foi instalado às **13:08:43 de Brasília**, com os hashes
conferidos, cópia protegida do anterior e lock de deploy preservado. O wrapper
mantém a chave restrita à produção e a compatibilidade com o SHA enviado pelo CI.
Essa instalação não reiniciou serviços nem acionou um deploy.

## Uploads, PDFs e perfil — #36, #37, #38

Produção HTTPS em Edge 154, com código servido conferido por SHA-256:

- Convidado e Owner: foto padrão/personalizada, salvar/reabrir e exportação real.
- Executor rasterizou 16 PDFs; tester conferiu todos e gerou mais 6 PDFs próprios.
- POST 503, GET 503 após POST real e bytes inválidos foram induzidos somente no
  navegador. A foto anterior permaneceu nos PDFs; mensagem em português e
  referência sintética nos erros HTTP; retry do mesmo arquivo passou.
- Referências sintéticas identificam a simulação, não incidentes reais de servidor.
  Falha de decode comunica preservação/retry, sem inventar requestId.
- AutoCard desktop salvou/reabriu/exportou PNG com foto personalizada; o defeito
  móvel encontrado motivou `d64fffa` e sua verificação independente.
- Upload, crop persistido, reload e remoção de foto do QA passaram por HTTPS. Os
  dois agentes restauraram o perfil original e confirmaram 404 do arquivo removido.
- Os testes revelaram deslocamento visual adicional no avatar: flexcenter somava
  offset à tradução de crop top-left. Probe independente de posicionamento
  absoluto corrigiu pixels/geometria; a correção integrada `a35a530` passou em
  fotos horizontais/verticais, crop deslocado e zoom. O reteste independente
  confirmou gaps de 0px e erro médio avatar/diálogo abaixo de 0,48/255.
- O reteste identificou também um defeito preexistente no arraste contínuo do
  diálogo: o drag nativo da imagem cancela os eventos de pointer. O atributo
  `draggable="false"` em `d275fc4` passou nos oito cenários de arraste real, com
  cálculo completo, limites, captura, release e teclado. Seis assertions adicionais
  exigindo residual geométrico inferior a 0,001px falharam com 0,003–0,013px;
  pixels passaram. A comparação independente do mesmo crop nas duas revisões
  confirmou geometria igual e PNGs byte-idênticos nas seis superfícies. As medidas
  correspondem a `floor(ideal × 64) / 64`, sem centro de pixel de conteúdo
  descoberto: quantização preexistente do Chromium, não regressão do atributo.
  O agregado bruto de 250 pass/6 fail foi preservado; a classificação e os hashes
  sustentam o aceite, sem alterar tolerância ou código de geometria.

Cards sintéticos foram excluídos por seus IDs. Os seis órfãos criados por falhas
de GET após POST foram registrados privadamente e ficaram para a retenção normal.
Nenhum histórico alheio foi removido. Uploads foram espaçados para respeitar o limite.

**Limites:** Chromium/Edge não substituem Safari físico. O card/PDF e ambiente
originais da #38 não foram fornecidos; os novos cenários não reproduziram PDF sem foto.

## SMTP, revogação e retenção — #3 e #11

### Email e sessões

Quatro mensagens aceitas por Resend com TLS 1.3 validado e **recebimento das quatro
confirmado pelo usuário**: dois lembretes, um alerta e uma recuperação. O lote
final foi enviado pela imagem nativa publicada, Nodemailer 10.0.13, exclusivamente
para `gabriel.garcia@ownerinc.com.br`, entre 14:21:32 e 14:21:38. O retry injetou
421 antes da rede; contagens de 1/2 tentativas e reexecuções sem duplicatas.
Revisão independente confirmou 111/111 assertions, 19/19 hashes, quatro envelopes,
IDs distintos e nenhum envio adicional. O orçamento final foi 4/4.

Revogação real do QA: o mesmo token retornou 200 antes, 401 durante desativação e 401
após reativação, ainda com 3.594s antes da expiração. Auditoria confirmou ator,
alvo e requestIds. Houve uma única desativação/reativação. Login semloop e novo
login manual 200 foram confirmados; perfil/role/permissões/cargo originais mantidos.
Isso prova revogação. Separadamente, o token real permaneceu apenas na memória
do observador: GET de perfil 200 às **12:16:56**, o mesmo token 401 às **13:15:58**,
12 segundos após seu `exp`, e token fresco da mesma conta 200 às **13:15:59**.
Não houve alteração do token, relógio ou conta nessa observação de expiração natural.
O teste terminou com a conta ativa. Revisão independente confirmou a cadeia,
timing e novo GET 200 da QA. A API não registra o código específico Firebase;
não foi possível atribuí-lo independentemente por logs. Esta prova cobre expiração
do token na API; navegação sem loop e revogação têm evidências separadas.

O usuário autorizou mais quatro mensagens exclusivamente para o mesmo endereço,
após a publicação, para comprovar o transporte da nova imagem nativa com
Nodemailer 10.0.13. Recebimento desse novo lote será registrado separadamente.

### Retenção

Executor e tester independentes passaram 11 grupos com PG16 real, role `portal_cron`
e arquivos reais nos dois namespaces: referência antiga e órfã recente preservadas;
órfãs elegíveis removidas; lock, idempotência, falha de arquivo/retry e recuperação
por backup comprovados. Contagem ENOENT foi distinguida de remoção física.

Produção: hashes do módulo/DB correspondentes, grants e volume RW verificados;
cron nativo em `CRON_BOOTSTRAP_ONLY=false`, três workers com heartbeats concluídos
com sucesso às 14:20:48/14:21:00, retenção em janela de sete dias, zero remoções
e zero falhas nas auditorias finais. A primeira execução real do cron final ocorreu
após a publicação; não houve exclusão ampla de dados de produção.

## Infraestrutura e configuração — #4 e #5

Dois agentes confirmaram TLS 1.2/1.3, recusa de 1.0/1.1, redirect 301, readiness 200,
origem Portal aceita e origem não autorizada 403. Cadeia real NPM→Nginx→API,
firewall/bindings inspecionados; API/PostgreSQL/web interno sem portas publicadas.
Cabeçalhos de segurança presentes no HTML/API; a herança JS/CSS foi corrigida e
validada independentemente em Nginx Linux e nos 20 assets publicados.

- Certificado Portal foi renovado às 14:20:31 e passou a vencer em 29/12/2026
  16:21:58 UTC, fingerprint `7B:FF:AD:0D:AE:BB:2E:09:EA:A7:28:55:A0:22:28:0B:B4:36:A3:03:83:42:0E:9E:EB:E4:3F:FB:EF:6E:9D:9F`.
- O hook automático falhou porque backup e renovação foram iniciados em paralelo
  e o upstream estava pausado. O erro foi preservado; após a retomada, `nginx -t`
  passou e o reload gracioso manual foi confirmado no journal às 14:21:11, sem
  restart do proxy compartilhado, com novo certificado servido via TLS 1.3.
- Timer de renovação exclusivo instalado e habilitado; próxima ocorrência
  observada para 30/09 21:14:02 Brasília. Operações manuais devem ser sequenciais
  e conferir o journal do hook.
- Último backup de produção pré-release e primeira cópia diária têm manifestos
  íntegros. Agenda diária local habilitada, lock compartilhado e retenção 14 dias;
  primeira execução 14:20:21–14:20:47 validou dump/uploads.
- Usuário confirmou que **S3 ainda não está configurado**. Bucket, provedor e
  credenciais são dependência externa; o AWS CLI também não está instalado na
  VPS. Backup local não satisfaz essa cópia.
- Destinatário permanente de alertas foi autorizado e configurado no runtime
  protegido às 12:18:49 de Brasília; será ativado na recriação controlada do cron.
- Não havia backlog de convites/reconciliação/cleanup na inspeção às 12:20:20;
  marcador de lembretes já era 30/09.

## Pós-publicação — revisão final

O deploy da revisão `a1414d89cbfcee7f2beeaefef21911cff1c1bfce` passou na tentativa
2 do workflow. API e cron nativos conferiram os digests imutáveis publicados e
Nodemailer 10.0.13; o smoke HTTPS posterior ao backup/reload passou. A revisão
operacional independente obteve **29/29 checks**, incluindo nove hashes de assets,
seis headers de segurança exatamente uma vez em JS/CSS 200/404, unidades systemd,
backups, digests, grants, workers e certificado.

O reteste final de navegador em Edge 154/Windows conferiu 20/20 assets, perfil,
AutoCard, Owner News e estado da QA. Perfil: upload, oito movimentos de arraste,
save/reopen/reload, gaps zero, dez probes RGBA iguais, remoção 404 e fingerprint
original restaurado. AutoCard: foto própria, desktop/mobile 1080×1080, scrollbar
móvel de 15px, preview/clone delta 0, footer/logo completos e PNGs plain/
instrumented byte-idênticos. Owner News: PDF original de 25 páginas, 6.180.100
bytes, SHA `3af623eca820f912d25fc8283cf111be18a18be6ae758773e54c7402fab3132e`.
Card, mídia e foto temporários retornaram 404; nenhum órfão novo foi criado.

A comparação estrita de todo o diálogo continua registrada sem ser mascarada:
MAE bruto 2,638774/255 e referência pixel-snapped 1,373686/255 não satisfazem o
limiar histórico `<1`/`<3%`; avatar 0,899516/255 satisfaz. A revisão independente
reproduziu o resultado e comparou a fonte CSS dirigida à captura em 58.088 pixels
internos: MAE 0,0000057384/255, erro máximo de canal 1 e zero divergências acima
de 18. A diferença é explicada por alinhamento fracionário e rasterização
CSS/Canvas; não houve waiver numérico nem reivindicação de identidade do PNG
inteiro. O incidente de `Page.handleJavaScriptDialog` foi uma corrida do harness
com dois controladores, não defeito do Portal.

Issues fechadas com aceite demonstrado: **#1, #5, #6, #11, #36 e #37**.
Permanecem abertas: **#2** (NVDA/VoiceOver/Safari físico e zoom nativo 400%),
**#3** (S3 e retorno visual após expiração natural), **#4** (S3 externo,
lifecycle/criptografia/off-host/RPO) e **#38** (card/PDF e ambiente originais).
Os textos e critérios foram atualizados no GitHub apenas após conferir que os dez
corpos originais permaneciam inalterados.

## Acessibilidade física e fechamento

#2 continua dependente de participante para NVDA/VoiceOver e ambiente físico.
O teste autenticado de teclado/reflow percorreu nove rotas em 320, 768 e 1440px,
sem overflow horizontal global. Foram encontrados três defeitos P2: nome vazio
do link de marca recolhido, contraste de foco do AutoCard de 2,39:1 e ausência
de estado programático nas seleções de tema/histórico. Correções localizadas
implementadas em `c862971`, com contraste observado mínimo de 7,33:1, estados AX
e cancelamento coerentes; reteste independente aprovado. Zoom nativo de 400%
não foi comprovado.
Confirmações anteriores no iPhone não cobrem leitores de tela nem os defeitos
novos encontrados. Testes automatizados/viewport são identificados como tais.
Nenhum critério externo é encerrado apenas por CI verde ou ausência de erro local.

Evidências completas e harnesses ficam nos diretórios locais
`%LOCALAPPDATA%/Temp/opencode/portal-delivery-20260930-*`. As revisões e o ledger
temporários ficam ignorados em `.superpowers/sdd/2026-09-30-issue-delivery/`.
Dados sensíveis não devem ser anexados às issues; publique a síntese e os hashes.
