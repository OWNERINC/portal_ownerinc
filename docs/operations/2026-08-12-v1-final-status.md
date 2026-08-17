# V1 Final Status

Data do registro: 12 de agosto de 2026

## Release

- Repositório: `OWNERINC/portal_ownerinc`
- Branch: `main`
- Commit publicado: `fd45dc1`
- Workflow CI/deploy: `31436331884`
- Domínio validado: `https://portal.ownerinc.com.br`
- Firebase oficial: `ownerinc-portal-interno-prod`

## Mudanças Finais

- AutoCard passou a usar `public/autocard.html` como página canônica no mesmo
  nível das demais áreas do Portal.
- Sidebar, topbar, `main.page-body`, skip link, menu mobile e logout agora são
  entregues pelo mesmo shell estrutural do Portal.
- Todos os links da navegação apontam para `./autocard.html`.
- A rota antiga `/autocard/` continua funcionando como redirect compatível para
  `../autocard.html`.
- Redirects de autenticação e retorno do guard foram alinhados à profundidade
  da página canônica.
- O SRI do `html2canvas` foi corrigido para manter a exportação PNG funcional
  sob a CSP de produção.
- Smoke tests passaram a verificar a rota canônica e o redirect legado.
- Invariantes cobrem as nove páginas de navegação alteradas, caminhos de assets,
  controles de shell, guard, redirect sem script inline e dependência de exportação.
- README, changelog e checklist de release foram atualizados.

## Post-V1 local hardening

- A branch local implementa o editor de enquadramento descrito na [especificação
  do AutoCard](../superpowers/specs/2026-08-13-autocard-image-crop-editor-design.md)
  e no [plano de implementação](../superpowers/plans/2026-08-13-autocard-image-crop-editor.md).
- Os templates ativos com foto suportam arrastar, zoom, centralizar/resetar,
  cancelar/aplicar e `mediaCrop` persistido. O rendering recalculado para frames
  responsivos é reutilizado pelo preview, pelas variantes e pela exportação PNG.
- Foram resolvidos localmente os erros das ações de histórico, a prontidão e as
  falhas da exportação PNG, a limpeza de previews inválidos de upload e a
  limpeza de mídias órfãs. A migration `012_autocard_media_crop` e a retenção
  cron correspondente fazem parte da branch.
- A verificação local posterior passou com 83 testes. O último deploy continua
  sendo o commit `fd45dc1`; os commits de hardening não foram enviados nem
  publicados, e a aceitação manual do crop no browser/live ainda está pendente.
- PostgreSQL para a nova migration, VPS, S3, TLS, acessibilidade física,
  serviços externos e aprovação LGPD continuam pendentes e não são declarados
  concluídos por esta verificação local.

## Evidências

- Histórico pré-hardening: `npm run verify`: 72 testes aprovados.
- `git diff --check`: aprovado.
- `bash -n scripts/smoke.sh`: aprovado.
- CI: validação, migrations, build, scans, SBOM e publicação das imagens
  concluídos com sucesso.
- Deploy: backup, migration, smoke, rollback gate e verificação pública
  concluídos com sucesso.
- Live:
  - `/api/health` retornou `{"status":"ok"}`;
  - `/api/ready` retornou `{"status":"ready"}`;
  - `/autocard.html` entregou sidebar, topbar, page body e entry do AutoCard;
  - `/autocard/` entregou o redirect compatível.
- Aceitação manual autenticada concluída com usuário autorizado: shell,
  criação, histórico, edição, duplicação, exclusão, upload e exportação.
- Recuperação de senha e convite administrativo foram homologados com email
  real.

## Pendências e Riscos

- Não foi comprovada ainda a perda de acesso de um usuário desativado usando
  token anterior nem a expiração de sessão Firebase em produção.
- O lembrete via Resend SMTP end-to-end, histórico de entrega, retry e alertas SMTP
  deduplicados/recuperados ainda precisam de evidência operacional.
- O restore PostgreSQL descartável foi validado; o restore integral dos uploads
  ainda requer ambiente Linux/Bash.
- A transferência S3 real, o rollback real da VPS, TLS, firewall, rotação de
  logs e retenção operacional ainda dependem do operador da infraestrutura.
- Testes físicos com NVDA/VoiceOver e zoom de 400% ainda não foram executados.
- A política de retenção e os textos LGPD ainda precisam de aprovação jurídica.
- Gate 0 externo da Sólides continua pendente; a integração permanece `off`.

Esses itens não representam uma falha conhecida no código do commit publicado,
mas impedem declarar a V1 plenamente pronta para produção sem evidência externa
e aprovação dos responsáveis.
