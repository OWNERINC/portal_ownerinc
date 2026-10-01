# Entrega e homologação das issues abertas — 30/09/2026

## Objetivo e autorização

Executar o plano aprovado na conversa para entrega até 15h de Brasília, com
subagente executor e outro subagente responsável por testes independentes de
cada entrega. Base: `3abc068b04d3bc785998dae05742a5bd230eee4d`.
O usuário autorizou worktree isolada, ambientes Docker descartáveis e pausa
breve dos serviços do Portal para backup consistente, se necessária.

## Restrições globais

- Preservar os limites de `api/`, `cron/`, `public/` e `nginx/`.
- Usar somente `gabriel.garcia@ownerinc.com.br`, sem aliases, para email externo.
- Manter a conta de QA ativa ao concluir; não alterar a conta do operador para testes.
- Não expor segredos, tokens, dados pessoais ou dumps nas evidências públicas.
- Isolar containers, redes, volumes, portas, banco, Firebase, SMTP e backups dos ensaios.
- Não iniciar workers com dados de produção e provedores reais em clones.
- Distinguir SMTP aceito de email recebido; viewport de dispositivo físico;
  unit tests de execução operacional; deploy aprovado de rollback executado.
- Registrar bloqueios reais sem encerrar issues por ausência de evidência.
- Um único subagente de implementação por vez; revisão independente após cada entrega.
- Executar `npm run verify`, `git diff --check` e testes específicos antes de integração.

## Mapa de arquivos

- `scripts/backup-s3.sh`: invocação da AWS CLI e validação da cópia local.
- `scripts/backup.sh`: backup consistente e chamada portátil do helper S3.
- `scripts/restore.sh`: restauração integral e tratamento de falhas.
- `ops/deploy-from-ci.sh`: receptor versionado; confrontar com o instalado.
- `cron/checkReminders.js`, `cron/health.js`: entregas, deduplicação e alertas.
- `cron/autocard-media-retention.js`: retenção dos dois namespaces de cards.
- `public/cards-pos/app.js`, `public/autocard/`, `api/routes/upload.js`:
  fluxos autenticados de upload/exportação.
- `tests/unit/`: regressões para defeitos efetivamente reproduzidos.
- `docs/reviews/2026-09-30-issue-delivery.md`: resultados consolidados.
- `.superpowers/sdd/2026-09-30-issue-delivery/`: ledger e relatórios temporários ignorados.

## Task 1: Corrigir execução do backup S3 (#4)

Corrigir a ausência do executável `aws` em `backup-s3.sh` e chamar o helper
via Bash em `backup.sh`, pois o receptor extrai arquivos com modo 0644.
Adicionar regressões comportamentais: endpoint padrão/personalizado, argumentos
com espaços, manifesto inválido, retorno não zero e preservação do backup local,
incluindo helper sem permissão de execução. Atualizar documentação operacional.
Também corrigir o pre-backup do restore: falha de S3 herdado hoje ocorre antes
da instalação do trap do restore e deixa serviços parados. O backup de proteção
do restore deve ser local e independente do envio externo, com teste de falha.
Executor altera somente esses scripts, `restore.sh`, teste dedicado e seção S3/restore do guia.
Tester independente executa os casos em Linux/Bash e inspeciona o diff real.

## Task 2: Validar uploads e PDFs (#36, #37, #38)

Produção HTTPS autenticada: Convidado/Owner com foto padrão e personalizada,
salvar/reabrir e inspecionar os PDFs baixados. AutoCard: foto, persistência e PNG.
Perfil: usar identidade apropriada de QA e preservar seu estado anterior.
Falhas de POST, GET de mídia e bytes inválidos simuladas somente no navegador
de QA; conferir mensagem, requestId, foto anterior e recuperação com o mesmo arquivo.
Registrar órfãos criados e respeitar limite de uploads (5/min, burst 2).
Tester independente reabre artefatos e repete casos críticos. O caso original
da #38 e iPhone/Safari permanecem distintos dos cenários novos.

## Task 3: Inspecionar infraestrutura (#5, pré-requisitos #1/#4/#6/#11)

Conferir acesso SSH administrativo, revisão/digests, receiver instalado, bindings,
firewall, proxy, TLS, renovação, headers e configuração efetiva de origem.
Localizar bucket/perfil S3 e agendamento sem imprimir credenciais.
Tester independente verifica evidências e executa sondas externas limitadas.

## Task 4: Executar S3 e restore integral (#4, #1)

Backup consistente, manifesto, upload/download real e verificação dos hashes.
Restaurar a cópia baixada executando `restore.sh` inteiro em Linux isolado,
com ambiente alvo previamente inicializado. Desabilitar upload S3 no pre-backup.
Verificar dados, arquivos, referências, migrations, roles/grants, login, readiness,
serviços e tempo de recuperação (meta 4h). Conferir agenda diária e RPO 24h.
Tester independente compara antes/depois e comprova isolamento.

## Task 5: Executar rollback real (#6)

Identificar release anterior e equivalência do receiver. Executar o receptor em
alvo staging isolado com falha controlada após iniciar migration e antes de
expor ingresso público. Comprovar trap, restauração esperada de DB, digests,
ponteiro da release, integridade dos uploads e smoke. Se houver ensaio pós-ingresso,
registrar explicitamente que DB é preservado. Tester valida logs e estado final.

## Task 6: Homologar serviços externos (#3)

Banco de fixtures com audiência de UID único e bloqueio de outros destinatários;
executar função real de lembretes com data/created_at controlados (cutoff 08h).
Validar recebimento, retry transitório e reexecução sem duplicata. Alertas: falha,
deduplicação e recuperação com único checker. Revogação Firebase requer token
válido anterior, conta QA autorizada, administrador separado e reativação final.
Expiração real é cenário separado. Tester correlaciona registros e evidência
de caixa/provedor. Aceitação SMTP isolada não encerra recebimento externo.

## Task 7: Homologar retenção de mídias (#11)

Nos dois namespaces, criar fixtures antiga referenciada, órfã recente, órfã
elegível e arquivo órfão; executar a função real com role cron e volume isolado.
Conferir linhas/arquivos/auditoria, lock e idempotência. Em produção, inspeção
de heartbeat, agenda, grants, volume e auditoria concluída. Tester confere
preservação/removidos e recuperação por backup sem executar limpeza ampla.

## Task 8: Completar acessibilidade (#2)

Teclado, foco, nomes, status, diálogos, abas e reflow em 320/768/desktop;
zoom real 400%. NVDA e VoiceOver exigem participante com o ambiente real.
Usuário informou indisponibilidade para o iPhone; buscar substituto se possível.
Tester independente repete os percursos automatizáveis e mantém cobertura
física pendente quando não observada.

## Task 9: Corrigir falhas encontradas e consolidar entrega

Correções pequenas, teste de regressão e revisão independente por alteração.
Consolidar relatório por issue com revisão, ambiente, hora, comando, resultado,
artefatos e limitações. Rodar verificação integral, revisar branch, integrar pelo
fluxo autorizado e conferir publicação. Atualizar GitHub com critérios atendidos
e pendentes; encerrar somente quando o aceite da issue estiver demonstrado.

### Correções adicionais autorizadas após os ensaios reais

- Nodemailer 10.0.13: patch de segurança para API/cron; testes SMTP reais em loopback.
- Verificador PostgreSQL 16: casts de array e representação canônica da constraint;
  integração passa a executar o verificador real, inclusive negativos.
- Smoke de recuperação: acompanhar o bootstrap do router atual com assets reais.
- AutoCard PNG móvel: fixar apenas a geometria do canvas clonado pelo exportador;
  remover o recorte indevido decorrente da diferença de scrollbar.
- Rotina operacional: agenda local diária de backup, alertas para Gabriel,
  receiver versionado incluindo cron e renovação TLS exclusiva do Portal.
- S3: usuário confirmou em30/09 que ainda não há configuração. Bucket/provedor/
  credenciais continuam dependência externa; backup local não aceita esse critério.
- Renovação TLS: usuário autorizou reload gracioso do proxy compartilhado após
  renovação; o container não será parado para essa operação.
- Avatar do perfil: retirar a imagem do fluxo flex para aplicar o recorte salvo
  a partir da origem correta; verificar fotos horizontais/verticais e zoom.
- Headers de assets: remover a declaração Cache-Control redundante que suprime
  a herança dos headers de segurança do servidor Nginx.
- Acessibilidade: nome da marca recolhida, contraste de foco conforme a superfície
  e estados aria-pressed sincronizados com as seleções do AutoCard.
