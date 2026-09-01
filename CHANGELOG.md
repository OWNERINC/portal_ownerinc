# Changelog

## 2026-07-27

- Aponta o frontend, o exemplo de runtime e o emulador local para o projeto
  Firebase institucional `ownerinc-portal-interno-prod`.
- Remove dependências opcionais não utilizadas da imagem da API, preservando
  somente os binários musl exigidos pelo Sharp no runtime de produção.

## Unreleased

- Cards Pós agora possui os módulos editáveis Convidado e Owner, com alternância na tela, template Owner baseado no frame 2 do Figma e histórico compatível com os dois formatos.
- O convite Owner foi alinhado ao Frame 2 do Figma: capa vertical, conteúdo editorial longo, serviços com ícones, consumo em três colunas, assets locais e exportação em página longa.
- Guest e Owner agora seguem as proporções atuais dos Frames 01 (`1448 × 2347`) e 02 (`1448 × 3896`) na pré-visualização e na exportação PDF.
- O bloco de endereço foi reposicionado nos dois convites e o footer passou a manter logos e composição fixos, com somente o telefone editável.
- Campos de texto dos módulos Guest e Owner agora aceitam formatação rica segura com negrito, itálico, sublinhado, tachado e listas.
- Added the block-based CMS for Knowledge, Academy, Benefits, Announcements, and Reminders with permission-scoped editing, safe rendering, publication scheduling, and protected assets. Static release verification passed; PostgreSQL migration and live acceptance evidence remain pending.
- AutoCard exports now preserve preview proportions and the employee card uses a contained stacked layout with a wordmark-only footer.
- Implementado localmente o editor de enquadramento de imagens do AutoCard para
  os templates `aniversariante` e `novo_funcionario`, com arrastar, zoom,
  centralizar/resetar, cancelar/aplicar e `mediaCrop` persistido; o rendering
  responsivo e o mesmo enquadramento são reutilizados nas variantes e na
  exportação PNG.
- O hardening local do AutoCard passou a tratar erros das ações de histórico,
  prontidão e falhas da exportação PNG e a limpar previews inválidos de upload;
  a migration `012_autocard_media_crop` e a retenção cron de mídias órfãs
  também fazem parte da branch local.
- Mídias privadas do AutoCard agora carregam por URLs `blob:` autenticadas; o
  histórico e as variantes usam o mesmo fluxo sem emitir URLs protegidas
  quebradas durante o carregamento.
- AutoCard agora usa `public/autocard.html` como rota canônica dentro do shell
  compartilhado do Portal; `/autocard/` permanece como redirect compatível.
- Exportação PNG do AutoCard teve o SRI do `html2canvas` corrigido e a rota foi
  validada em produção com aceitação manual autenticada.
- CI/deploy e smoke live foram concluídos no commit `fd45dc1`; o README e o
  checklist V1 registram o estado final e os riscos remanescentes.
- Corrigido o limite do Nginx para mídias do AutoCard: a borda aceita até 4 MB
  para que a API aplique corretamente o limite de 3 MB e normalize a imagem.
- Corrigidas as chamadas do AutoCard para usar o token Firebase compartilhado;
  upload, histórico e salvamento deixam de retornar `Authentication required`.
- Estrutura local com Docker Compose, Firebase Auth Emulator e migrations reais.
- API, cron e frontend preparados para deploy por imagens imutáveis no GHCR.
- Verificações de segurança, governança, retenção, backup, restore, smoke e rollback.
- Integração Sólides preparada, read-only e desligada por padrão (`off`).
- Rollout Sólides documentado por estágios, sem ativar credenciais ou endpoints
  externos antes da homologação.
- Sharp atualizado para a linha 0.35 após novos advisories high do libvips,
  preservando o gate de segurança sem aceitar correção forçada.
- Namespace de runtime normalizado para `ghcr.io/ownerinc` na interface de
  configuração e na documentação de deploy.

### Homologações externas ainda pendentes

- Validar desativação de usuário e expiração de sessão no Firebase real.
- Homologar lembretes SendGrid, histórico, retry e alertas SMTP do cron.
- Executar restore integral de uploads, transferência S3 e rollback real na VPS.
- Reunir evidências de TLS, firewall, rotação de logs e aprovação LGPD.
- Concluir Gate 0 externo da Sólides antes de qualquer promoção de estágio.
