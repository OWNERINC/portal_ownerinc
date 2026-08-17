# V1 Release Checklist

Use esta lista para separar o que foi validado localmente do que exige
homologação com serviços e infraestrutura reais. Marque cada item com data,
responsável e evidência; não marque uma validação externa usando apenas
`npm run verify`.

## Environment Variables

- [ ] `.env` existe somente no ambiente operacional e possui modo `0600`.
- [ ] PostgreSQL usa URLs distintas para migration, API e cron.
- [ ] Firebase Admin está configurado somente no servidor.
- [ ] Resend SMTP possui chave de API válida em `SMTP_PASSWORD` e remetente verificado.
- [ ] SMTP possui endereço, porta, usuário e senha válidos.
- [ ] `OPERATIONAL_ALERT_EMAIL` aponta para uma caixa monitorada.
- [ ] `S3_BUCKET`, `S3_PREFIX` e endpoint S3-compatible foram revisados.
- [ ] Nenhum segredo aparece no GitHub, archive, logs ou bundle frontend.

## Firebase

- [x] Login real com email verificado funciona no projeto
  `ownerinc-portal-interno-prod`.
- [x] Convite administrativo cria identidade e envia link de definição de senha.
- [x] Recuperação de senha funciona.
- [ ] Usuário desativado perde acesso mesmo com token anterior.
- [x] Logout retorna ao login sem loop.
- [ ] Expiração de sessão retorna ao login sem loop.

## PostgreSQL and Migrations

- [ ] Backup pré-release foi criado e seu checksum foi validado.
- [ ] Migration passa em banco vazio.
- [ ] Migration passa sobre banco existente até `010_autocard`.
- [ ] Segunda execução não altera nem duplica o ledger.
- [ ] `011_cron_alert_state` existe e possui os grants esperados.
- [ ] `012_autocard_media_crop` existe e foi validada em PostgreSQL.
- [ ] Roles `portal_api` e `portal_cron` têm somente os privilégios necessários.

## AutoCard Access

- [ ] Analista de RH Sênior acessa o AutoCard.
- [ ] Gerente de RH acessa o AutoCard.
- [ ] Usuário sem título aprovado recebe acesso negado pela API.
- [ ] Admin sem título aprovado continua sem acesso.
- [x] O AutoCard aparece dentro do `page-body` com sidebar e topbar do Portal.
- [x] Criação, histórico, edição, duplicação, exclusão, upload e exportação funcionam
  na aceitação manual autenticada.
- [ ] Editor de enquadramento passa por aceitação manual autenticada: arrastar,
  zoom, centralizar/resetar, cancelar/aplicar e persistência de `mediaCrop` nos
  templates com foto.

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

- [x] `/api/health` retorna liveness.
- [x] `/api/ready` confirma PostgreSQL.
- [x] Login e logout passam.
- [ ] Dashboard passa sem CTA de nota fiscal inexistente.
- [ ] Perfil e upload passam.
- [ ] Base de Conhecimento, Academy e Benefícios passam.
- [ ] Lembretes e histórico de entregas passam.
- [ ] Admin e Ouvidoria passam.
- [ ] AutoCard passa para `Analista de RH Sênior` e `Gerente de RH`.
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

- [x] `npm run verify` passou com 83 testes.
- [x] `npm audit --omit=dev` do cron passou sem vulnerabilidades após atualizar
  o transporte SMTP.
- [x] `git diff --check` passou.
- [x] Migration integration test executado em PostgreSQL local; ledger até
  `011_cron_alert_state` e segunda execução passaram.
- [x] Smoke Docker equivalente executado dentro da rede Compose: health,
  readiness, Portal e `/autocard/` retornaram HTTP 200.
- [x] Dump PostgreSQL restaurado em banco descartável e `autocard_cards`,
  `cron_status` e `alert_signature` foram verificados.
- [ ] Restore dos uploads executado separadamente; o restore PostgreSQL foi
  validado, mas a execução integral de `scripts/restore.sh` requer Bash local.
- [x] Invariantes estáticas cobrem AutoCard, enquadramento de imagem, retenção
  de mídia, paginação, dashboard, lembretes, filtros administrativos, alertas,
  backup S3 e acessibilidade.
- [x] Rota canônica `/autocard.html` e redirect legado `/autocard/` foram
  verificados no domínio live após o deploy do commit `fd45dc1`.
- [x] Aceitação manual autenticada do AutoCard foi concluída: shell, criação,
  histórico, edição, duplicação, exclusão, upload e exportação.
- [ ] Teste físico com NVDA/VoiceOver executado; requer dispositivo/ambiente
  externo.
- [ ] Aceitação manual do editor de enquadramento executada; requer browser
  autenticado e não foi realizada nesta verificação local.

## Final Status

- O último código publicado e validado no domínio live permanece no commit
  `fd45dc1`; o workflow CI/deploy correspondente foi o `31436331884`.
- A branch local contém commits posteriores de hardening do AutoCard e ainda
  não foi enviada nem publicada novamente.
- Push, novo CI/deploy e validação manual no browser/live do hardening permanecem
  pendentes.
- O projeto Firebase oficial permanece `ownerinc-portal-interno-prod`.
- A produção não deve ser declarada plenamente pronta enquanto os itens
  externos pendentes abaixo não tiverem responsável e evidência registrados.

## Remaining Risks and Pending Evidence

- **Firebase:** ainda falta comprovar em produção a perda de acesso de usuário
  desativado com token anterior e o comportamento de expiração de sessão.
- **Email/cron:** convite e recuperação foram homologados; ainda falta validar
  lembrete via Resend SMTP end-to-end, histórico de entrega, retry e alertas
  SMTP deduplicados/recuperados.
- **Backup/restore:** o restore PostgreSQL descartável foi validado, mas o
  restore integral de uploads requer execução Linux/Bash e o upload S3 real
  ainda depende do bucket operacional.
- **Infraestrutura:** TLS, firewall, rotação de logs, retenção operacional e
  rollback real da VPS precisam de evidência do operador.
- **Acessibilidade física:** faltam NVDA/VoiceOver e teste manual com zoom de
  400% em ambiente suportado.
- **Documentação jurídica:** a política de retenção e os textos LGPD ainda
  precisam de aprovação formal.
