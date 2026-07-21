# Relatório de Implementação do Roadmap

Data: 20 de julho de 2026
Escopo implementado: Gates 0 a 5
Escopo mantido condicional: Gate 6

## Resultado

O Portal manteve a arquitetura Nginx + frontend estático + Express +
PostgreSQL + worker cron. Não foi introduzido framework de frontend, ORM, fila
externa ou novo serviço permanente.

A revisão final independente não encontrou achados críticos ou altos no código.
Os checks locais passam com 31 testes, sintaxe, secret scan e validação do
Compose. Dependências não possuem advisory alto/crítico; 6 advisories moderados
transitivos do Firebase/Google permanecem sem upgrade compatível oferecido pelo
`npm audit`.

## Segurança e Identidade

- Removidos cadastro público e login Google irrestrito.
- Identidades Firebase desconhecidas são negadas; não existe auto-provisionamento.
- API exige token não revogado, email verificado e conta local ativa.
- Criação de usuário ocorre no servidor com Firebase Admin, sem trocar a sessão
  do administrador e com compensação de falhas.
- Somente super-admin altera role/permissões; autoescalada, autodesativação,
  alteração de superior e remoção do último super-admin são bloqueadas.
- Desativação revoga tokens; reativação está disponível na API e interface.
- Primeiro super-admin usa ferramenta one-shot que valida UID, email, status e
  verificação no Firebase.
- API aplica CORS same-origin/allowlist, request IDs, erros genéricos, limites de
  body/rate e remove `X-Powered-By`.
- Nginx aplica CSP sem script inline, HSTS, nosniff, frame denial, referrer e
  permissions policy, real IP e limites separados para API/upload.

## Conteúdo e Uploads

- Removidos sinks de stored XSS; dados armazenados são renderizados com DOM e
  `textContent`.
- URLs externas aceitam somente HTTP(S).
- Upload usa Multer 2 + Sharp, decodifica JPEG/PNG/WebP, limita pixels e dimensões,
  remove metadados e normaliza para WebP até 1024x1024.
- Nomes de arquivo são UUIDs sem UID do usuário.
- Substituição e remoção limpam o arquivo anterior.
- Fotos foram deliberadamente mantidas como arquivos públicos de nome aleatório
  para uso direto em `<img>`; a política proíbe conteúdo sensível.
- Lucide permanece em CDN versionado, agora com SRI e CSP restritiva.

## Dados, Migrations e Least Privilege

- Criado runner de migrations com advisory lock e ledger.
- Migrations 001 a 006 cobrem schema inicial, notificações, governança,
  constraints, claim state e erasure.
- Migrations falham com diagnóstico em dados legados incompatíveis; não truncam
  nem removem duplicatas silenciosamente.
- Constraints cobrem role, contrato, coerência PJ, dias, canais, estados, formas
  JSON, URLs e limites de conteúdo.
- Emails possuem índice único case-insensitive.
- API e worker usam roles PostgreSQL separadas e grants mínimos.
- Credencial de owner existe somente no container one-shot `migrate`.
- Bootstrap Firebase/DB usa serviço de ferramenta separado e não amplia o
  container de migração normal.
- CI aplica migrations duas vezes em PostgreSQL real para provar upgrade
  idempotente e provisionamento de roles.

## Funcionalidades

- Dashboard calcula ocorrências entre meses/anos e mostra apenas audiência
  aplicável; CTA fictício de NF foi removido.
- Knowledge possui busca/categoria/artigo refletidos na URL, CRUD com
  `manageKnowledge`, render seguro e estados recuperáveis.
- Reminders filtra audiência no servidor, pagina, mantém CRUD gerencial e expõe
  histórico de entregas e saúde do worker.
- Academy e benefits ocultam inativos de usuários comuns, validam conteúdo e
  oferecem administração paginada.
- Ombudsman possui rate limit, status, responsável, notas, resolução,
  paginação e auditoria de leitura/alteração.
- Administração possui paginação server-side, desativação/reativação,
  gerenciamento seguro de permissões e visualização de eventos de auditoria.
- Perfil permite atualizar dados, enviar/remover foto e exportar perfil,
  notificações e eventos de auditoria em JSON.

## Notificações

- Ledger único por lembrete, usuário, data e canal.
- Estados `pending`, `sending`, `sent`, `failed` e `skipped` distinguem claim de
  chamada ao provider.
- Claims `pending` são retomáveis sem aguardar; `sending` interrompido vira falha
  de resultado desconhecido para evitar duplicação.
- Retries ocorrem somente em rejeições explicitamente não aceitas pelo provider.
- Falha de um destinatário não interrompe os demais.
- WhatsApp desativado é registrado como `skipped`, nunca como enviado.
- Dias 29 a 31 usam o último dia de meses curtos.
- Catch-up é limitado a 7 datas e protegido por advisory lock.
- Worker registra heartbeat, duração e contadores; Compose verifica sua saúde.

## LGPD e Governança

- Audit log registra ator, ação, alvo, request ID e detalhes mínimos.
- Leituras da ouvidoria e mutações privilegiadas são auditadas.
- Usuário exporta seus dados em formato legível.
- Erasure exige desativação e super-admin, exclui identidade Firebase, perfil,
  foto e referências estáveis em notificações, auditoria e públicos individuais.
- Histórico operacional permanece sem UID do titular.
- Worker aplica retenção diária: 730 dias para notificações/ouvidoria resolvida
  e 5 anos para auditoria.
- Política completa está em `docs/product/privacy-retention.md` e ainda requer
  aprovação jurídica antes de produção.

## Design, UX e Acessibilidade

- Shell mobile usa drawer com `inert`, `aria-hidden`, foco preso, Escape e
  restauração de foco.
- Todas as páginas autenticadas têm skip link, landmark e um `h1`.
- Login mantém heading visível no mobile.
- Labels, forms, captions, scopes, tabs, dialogs e live regions foram corrigidos.
- Dialogs prendem foco, restauram origem e protegem alterações não salvas.
- Forms persistentes de perfil/ouvidoria alertam antes de navegação com mudanças.
- Contraste, foco visível, touch targets, safe areas e reduced motion foram
  ajustados.
- Loading, vazio, erro e retry foram padronizados.
- Interface evita scripts/eventos inline e preserva identidade preta/dourada.

## Operação e Recuperação

- Node 24 está fixado por versão/digest e containers Node executam sem root.
- PostgreSQL e Nginx estão fixados por digest no Compose.
- CI verifica, audita, gera SBOM, escaneia imagens com Trivy e publica API/cron
  no GHCR com tag de commit.
- Release resolve tags para digests e grava `.image-env`; Compose executa
  referências imutáveis.
- Deploy publica somente `git archive` de commit limpo.
- Backup interrompe Nginx, API e cron, captura PostgreSQL/uploads com checksum e
  reinicia somente quando apropriado.
- Restore exige confirmação, valida checksum, cria backup de segurança, usa
  transação única, reaplica migrations/grants e mantém serviços parados em erro.
- Readiness consulta PostgreSQL; smoke valida frontend e `/api/ready`.
- RPO inicial: 24 horas. RTO inicial: 4 horas.

## Verificações Executadas

- `npm run verify`: 31 testes aprovados.
- `npm run security`: aprovado; 0 high/critical, 6 moderate transitivos na API,
  0 no cron.
- `npm run sbom`: SPDX da API e cron gerados.
- `docker compose config --quiet`: aprovado pelo verify.
- `git diff --check`: aprovado.
- Revisão independente final: nenhum achado crítico/alto no código.

## Validações Externas Pendentes

Não são implementações ausentes, mas exigem serviços ou ambiente não disponível
nesta estação:

1. Firebase real: bootstrap, criação, revogação, reativação e erasure.
2. SendGrid real: aceitação, rejeição, retry e reconciliação de duplicidade.
3. VPS/GHCR: pull privado, digest, TLS, firewall, deploy e rollback.
4. PostgreSQL descartável: migração de cópia do banco legado, backup e restore.
5. UX física: 320-1440 px, zoom 400%, teclado, NVDA e VoiceOver.
6. Jurídico: bases legais, retenções, RPO/RTO e texto da ouvidoria.

## Gate 6

Não implementado por ser explicitamente condicionado a demanda validada:
cupons/resgate em benefícios, LMS/progresso da Academy, conclusão de lembretes,
fluxo de nota fiscal, WhatsApp e tema escuro.
