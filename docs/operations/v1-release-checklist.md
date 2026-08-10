# V1 Release Checklist

Use esta lista para separar o que foi validado localmente do que exige
homologação com serviços e infraestrutura reais. Marque cada item com data,
responsável e evidência; não marque uma validação externa usando apenas
`npm run verify`.

## Environment Variables

- [ ] `.env` existe somente no ambiente operacional e possui modo `0600`.
- [ ] PostgreSQL usa URLs distintas para migration, API e cron.
- [ ] Firebase Admin está configurado somente no servidor.
- [ ] SendGrid possui chave e remetente válidos.
- [ ] SMTP possui endereço, porta, usuário, senha e remetente válidos.
- [ ] `OPERATIONAL_ALERT_EMAIL` aponta para uma caixa monitorada.
- [ ] `S3_BUCKET`, `S3_PREFIX` e endpoint S3-compatible foram revisados.
- [ ] Nenhum segredo aparece no GitHub, archive, logs ou bundle frontend.

## Firebase

- [ ] Login real com email verificado funciona.
- [ ] Convite administrativo cria identidade e envia link de definição de senha.
- [ ] Recuperação de senha funciona.
- [ ] Usuário desativado perde acesso mesmo com token anterior.
- [ ] Logout e expiração de sessão retornam ao login sem loop.

## PostgreSQL and Migrations

- [ ] Backup pré-release foi criado e seu checksum foi validado.
- [ ] Migration passa em banco vazio.
- [ ] Migration passa sobre banco existente até `010_autocard`.
- [ ] Segunda execução não altera nem duplica o ledger.
- [ ] `011_cron_alert_state` existe e possui os grants esperados.
- [ ] Roles `portal_api` e `portal_cron` têm somente os privilégios necessários.

## AutoCard Access

- [ ] Analista de DHO acessa o AutoCard.
- [ ] Assistente de DHO acessa o AutoCard.
- [ ] Coordenador de DHO acessa o AutoCard.
- [ ] Gerente de DHO acessa o AutoCard.
- [ ] Usuário sem cargo DHO recebe acesso negado pela API.
- [ ] Admin sem cargo DHO continua sem acesso.
- [ ] O AutoCard aparece dentro do `page-body` com sidebar e topbar do Portal.
- [ ] Criação, histórico, edição, duplicação, exclusão, upload e exportação funcionam.

## Content and Pagination

- [ ] Base de Conhecimento pesquisa título/conteúdo no servidor.
- [ ] Base de Conhecimento restaura busca, categoria, artigo e página pela URL.
- [ ] Academy pagina registros ativos.
- [ ] Benefícios pagina registros ativos.
- [ ] Nenhuma tela pública perde registros por limite silencioso de 50 itens.
- [ ] Admin consegue filtrar Ouvidoria por status e responsável.
- [ ] Admin consegue navegar o histórico completo de auditoria.

## Notifications

- [ ] Lembrete para todos chega somente a usuários ativos destinados.
- [ ] Lembrete PJ e CLT respeita contrato.
- [ ] Lembrete com UIDs explícitos preserva destinatários e rejeita duplicados.
- [ ] Reexecução do cron não duplica email.
- [ ] Dias 29, 30 e 31 seguem a regra de fim do mês.
- [ ] Falha de um destinatário não interrompe os demais.
- [ ] Histórico de entregas pagina e filtra por status, canal, usuário e data.
- [ ] WhatsApp permanece `skipped` e não é apresentado como enviado.

## Backup and Restore

- [ ] Backup local contém `postgres.dump`, `uploads.tar.gz` e `manifest.sha256`.
- [ ] `sha256sum --check` passa antes do upload externo.
- [ ] Upload S3-compatible funciona com endpoint configurado.
- [ ] Falha no S3 preserva a cópia local.
- [ ] Restore exige `--confirm RESTORE`.
- [ ] Restore em ambiente descartável passa migration verification e smoke.
- [ ] RPO máximo aprovado: 24 horas.
- [ ] RTO máximo aprovado: 4 horas.

## TLS and Firewall

- [ ] TLS termina no proxy externo com certificado válido.
- [ ] PostgreSQL não possui porta pública.
- [ ] API não possui porta pública.
- [ ] Nginx escuta somente no binding previsto.
- [ ] Firewall bloqueia acesso direto à origem.
- [ ] Headers de segurança e CSP estão presentes no domínio publicado.

## Smoke Tests

- [ ] `/api/health` retorna liveness.
- [ ] `/api/ready` confirma PostgreSQL.
- [ ] Login e logout passam.
- [ ] Dashboard passa sem CTA de nota fiscal inexistente.
- [ ] Perfil e upload passam.
- [ ] Base de Conhecimento, Academy e Benefícios passam.
- [ ] Lembretes e histórico de entregas passam.
- [ ] Admin e Ouvidoria passam.
- [ ] AutoCard passa para cargo DHO.
- [ ] Sólides permanece desligada.

## Monitoring and Alerts

- [ ] Healthcheck do cron está saudável.
- [ ] Falha de worker envia um alerta SMTP.
- [ ] Heartbeat atrasado envia um alerta SMTP apenas uma vez por estado.
- [ ] Recuperação envia alerta de retorno ao normal.
- [ ] Falha de alerta aparece nos logs sem expor senha.
- [ ] Logs possuem retenção e rotação definidas.

## Rollback and Sign-off

- [ ] Release anterior foi identificada.
- [ ] Rollback de containers foi testado.
- [ ] Dados não dependem de rollback destrutivo.
- [ ] Backup pré-release está disponível.
- [ ] Responsável técnico aprovou os resultados locais.
- [ ] Responsável operacional aprovou backup, alertas e restore.
- [ ] Responsável por LGPD aprovou retenção e tratamento de dados.
- [ ] Produção só foi declarada pronta após todas as validações externas.

## Local Verification Record

- [x] `npm run verify` passou com 72 testes.
- [x] `git diff --check` passou.
- [ ] Migration integration test executado em PostgreSQL local; pendente porque
  o Docker Desktop não está acessível neste ambiente.
- [ ] Smoke test Docker executado; pendente pelo mesmo bloqueio do daemon.
- [ ] Restore local executado; pendente pelo mesmo bloqueio do daemon.
- [x] Invariantes estáticas cobrem AutoCard, paginação, dashboard, lembretes,
  filtros administrativos, alertas, backup S3 e acessibilidade.
- [ ] Teste físico com NVDA/VoiceOver executado; requer dispositivo/ambiente
  externo.
