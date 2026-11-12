# Cadastro com senha e aprovação — evidências locais

Registro histórico da implementação em 11/11. A integração posterior com a
`main` remota e a preservação de Ética/Pages estão no
[relatório de 12/11](2026-11-12-registration-integration.md).

Data: 11/11/2026. Base: `67d553d`. Execução na sessão principal, sem
delegação, a partir da especificação e do plano aprovados em 10/11 e da
confirmação do usuário em 11/11. Alterações permanecem no working tree;
nenhum commit, push, deploy ou escrita em serviços externos foi realizado.

## Comportamento implementado

1. “Cadastre-se” recebe nome, email, senha e confirmação. Somente
   `{name,email,password}` vai para a API. Senha aceita 12–128 unidades UTF-16,
   espaços e Unicode, sem trim/normalização e sem ser composta só por espaços.
2. Firebase recebe a senha escolhida e cria a identidade desabilitada e não
   verificada. Cadastro não gera link nem envia email de confirmação. A senha
   não é enviada para SQL, filas, auditoria, logs, URLs ou storage do navegador.
3. A interface limpa os dois campos de senha em validações, erros, conclusão
   e abandono. Durante o envio, bloqueia duplicidade e navegação de saída.
4. A administração mostra “Pendente de aprovação” sem consulta Firebase por
   linha. Operador com `manageUsers` confere identidade/email, cargo ativo e
   contrato CLT/PJ. Aprovação cria viewer e habilita a identidade sem trocar
   senha ou marcar email artificialmente como verificado.
5. Token válido e não revogado, usuário admitido, conta ativa, habilitação
   concluída e permissões continuam obrigatórios. Email verificado não é
   requisito de aprovação nem de autorização da API.
6. Reenvio não troca senha, nome, idade ou decisão de solicitação existente e
   não adota órfãos por email. Identidade ausente de solicitação ainda pendente
   pode ser reconstruída sob locks, atualizando apenas o UID. Consulta prévia
   da solicitação impede criar uma identidade órfã antes de descobrir uma
   duplicidade no INSERT. Cargo, contrato, auditoria e reconciliação permanecem.
7. “Esqueci minha senha” atende admitidos ativos não verificados e cadastros
   antigos ainda pendentes/desabilitados, sem aprovar ou habilitar contas.
   Conta desativada, habilitação incompleta, cleanup e identidade divergente
   não recebem link. Respostas públicas permanecem genéricas. Endpoint antigo
   de criação de senha permanece compatível, mas sua tela separada foi removida.

Email passa a ser identificador de login, não prova de posse da caixa postal.
A conferência do endereço e da identidade pelo administrador é necessária.
Convites administrativos, importação CSV, bootstrap, schema, dependências,
cron, Nginx e scripts de deploy não foram alterados.

## Evidências automatizadas

- RED: `node --test tests/unit/api-security.test.mjs` falhou no novo caso
  de cadastro com senha antes da alteração da validação (14 PASS, 1 FAIL).
- Testes de serviço preservam compensação pós-rollback, retenção, locks,
  contratos CLT/PJ, rejeição e commit ambíguo.
- `tests/unit/registration-http.test.mjs` executa routers Express reais,
  serviços e middleware real com Firebase, banco e SMTP falsos, em HTTP
  efêmero no loopback. Cobre cadastro → negativa antes de aprovação → lista
  administrativa → aprovação sem email verificado → acesso local, permissões,
  cargo/contrato inválidos, duplicidade, reconstrução, limites, SQL/commit,
  habilitação incompleta, recuperação e não exposição da senha em erros.
- `tests/unit/registration-admission.test.mjs` mantém negativas por token
  ausente/inválido, conta não admitida/desativada e habilitação pendente;
  exige `verifyIdToken(token, true)`.
- `tests/unit/registration-recovery.test.mjs` cobre repetição antiga,
  órfãos, decisões anteriores, cleanup, reconstrução somente de UID,
  identidade divergente, commit ambíguo, decisão alterada na releitura e
  update sem linha afetada. Os dois últimos simulam mudanças, não concorrência
  real PostgreSQL.
- Validação da API cobre limites, Unicode e espaços. Harness DOM de login
  cobre política de senha, espaços, confirmação,
  limpeza, falha com dados não sensíveis preservados, resposta 202 estrita,
  envio concorrente e foco. Template legado não alega confirmação ou liberação.
- Gate final: `npm run verify` → **867 testes, 865 PASS, 0 FAIL, 2 SKIP**;
  sintaxe, nomenclatura, scanner de segurança e configuração Compose passaram.
  SKIPs existentes dependem de `flock`/symlinks Linux. Verificação em Node 24
  não comprova execução integral em Node 18; nenhum recurso novo incompatível
  foi adicionado ao runtime de produção.
- `git diff --check` e `node scripts/generate-public-shell.mjs --check`
  passaram no fechamento.

O primeiro teste HTTP encontrou limitações do próprio double SQL e excedeu o
limite real de recuperação por IP. O double passou a reconhecer as queries de
cleanup e os cenários foram separados, sem remover ou afrouxar rate limits do
produto. Gates completos posteriores passaram.

## Navegador local

Executado `tests/visual/check-login-approved.mjs` com Playwright/Chrome e axe
instalados fora do repositório, contra `tests/visual/serve-conecta.mjs` no
loopback. Frontend real, autenticação e transportes substituídos.

- Login, recuperação e cadastro em 320, 360, 402, 768, 769, 1000, 1001,
  1366, 1440 e 1920 px: PASS, sem overflow horizontal e sem violações axe
  WCAG A/AA automatizadas.
- 360 × 480/568/667: rolagem natural e acesso aos campos, confirmação,
  botão e retorno do cadastro; composição de login preservada.
- Foco e teclado, senha de login visível/oculta, confirmação divergente sem
  request, envio com senha preservada, limpeza após envio e PodFalar isolado:
  PASS. Capturas mobile/desktop inspecionadas.
- Evidências locais não versionadas:
  `C:/Users/Criação/AppData/Local/Temp/opencode/registration-approval-only-20261111/browser/`.

## Revisão e limites

Revisão inline do diff, sem subagentes conforme a restrição do plano. Verificados
senha apenas no payload Firebase, ausência de confirmação, manutenção das
fronteiras de admissão e de locks, negação de órfãos/reabertura, lista sem
dependência de verificação e nenhuma alteração de infraestrutura. Essa revisão
não constitui revisão independente nem homologação externa.

Não foram iniciados Docker, PostgreSQL, Firebase ou SMTP reais. Não houve
recebimento em caixa postal, aplicação de link, autenticação com senha real,
persistência/concorrência real ou alteração de cadastro de funcionário.

## Pendências externas — autorização separada

- Testar cadastro sintético no ambiente autorizado, sem email de confirmação,
  login negado antes do aceite e login com a senha original após aprovação.
- Validar entrega e aplicação dos links de recuperação, especialmente para
  pendentes disabled; se Firebase impedir, registrar e revisar sem habilitar
  antecipadamente para contornar a restrição do provedor.
- Validar desativação e repetição com dados persistidos e links antigos sem
  bypass de aprovação; remover somente fixtures autorizadas.
- Conciliar a revisão publicada com o checkout antes de publicar: uma consulta
  GET no diagnóstico encontrou frontend publicado com `portal-destination.js`
  e encaminhamento para `ethics.html`, ausentes na revisão local de base.
  Essa diferença não foi sobrescrita nem atribuída a esta mudança.
- Decidir integração Git e deploy separadamente. Não afirmar que produção já
  usa o novo cadastro com base nestas provas locais.
