# Roadmap do Portal Ownerinc

Atualizado em 21 de julho de 2026.

## Status de Implementação

| Gate | Estado | Evidência principal |
| --- | --- | --- |
| Gate 0 - Exposição insegura | Concluído | Admissão fechada, autorização, DOM seguro, imagens normalizadas e edge hardened |
| Gate 1 - Fundação técnica | Concluído | Node 24, migrations, constraints, roles PostgreSQL e testes em CI |
| Gate 2 - Jornadas e acessibilidade | Concluído no código | Mobile, teclado, dialogs, estados e deep links; validação física ainda necessária |
| Gate 3 - Notificações | Concluído | Ledger, claim/sending, retry, catch-up, heartbeat, histórico e retenção |
| Gate 4 - Governança | Concluído | Audit log, exportação, erasure e política de retenção |
| Gate 5 - Produção recuperável | Concluído no código | Digests, backup consistente, restore transacional, smoke e rollback |
| Gate 6 - Expansões condicionais | Não iniciado por decisão | Somente após demanda validada |

Os checks locais passam. Testes com Firebase, SendGrid, VPS, restauração real,
NVDA e VoiceOver permanecem gates operacionais antes do lançamento, pois exigem
credenciais, serviços ou dispositivos externos. A integração Sólides permanece
em `off` até o Gate 0 externo.

## Como Usar

O roadmap é organizado por gates, não por datas. Uma fase termina quando seus
critérios de aceite passam; a seguinte não deve contornar riscos deixados pela
anterior. O inventário atual está em
[`feature-inventory.md`](feature-inventory.md), e os riscos detalhados estão na
[auditoria da plataforma](../reviews/2026-07-20-platform-audit.md) e na
[auditoria de UI/UX](../design/2026-07-20-ui-ux-audit.md).

## Princípios

- Preservar Nginx + frontend estático + Express + PostgreSQL + cron.
- Corrigir segurança e dados na fronteira compartilhada, não em cada tela.
- Não adicionar framework, fila ou serviço sem pressão comprovada.
- Preferir constraints e migrations SQL a validações duplicadas.
- Tratar acessibilidade e LGPD como requisitos, não acabamento.
- Cada comportamento novo deixa um teste executável.

## Gate 0 - Bloquear Exposição Insegura

Objetivo: tornar o ambiente seguro para testes internos controlados.

### Admissão e contas

- Remover cadastro público e definir convite, domínio ou UID provisionado.
- Negar identidades Firebase ausentes/inativas no PostgreSQL.
- Exigir email verificado conforme a política escolhida.
- Criar usuário pela API com Firebase Admin sem trocar a sessão do administrador.
- Compensar falha parcial para nunca deixar conta órfã.
- Desabilitar/revogar antes de remover o registro local.
- Impedir autoescalada, autoexclusão indevida e remoção do último super-admin.
- Restringir função e permissões ao super-admin.

### Conteúdo e upload

- Remover todos os sinks de stored XSS e handlers inline com dados armazenados.
- Validar URLs externas e aceitar somente `http:`/`https:` quando aplicável.
- Atualizar Multer, validar assinatura e normalizar JPEG/PNG/WebP.
- Gerar nomes aleatórios, remover foto anterior e decidir privacidade das fotos.
- Corrigir `/uploads/` no Nginx e alinhar body size.

### Borda HTTP

- Restringir/remover CORS para operação same-origin.
- Adicionar CSP, `nosniff`, frame protection, referrer e permissions policy.
- Aplicar rate limit de borda e por usuário em writes/uploads.
- Retornar erros genéricos com request ID e log interno.
- Desabilitar `X-Powered-By`.

### Critérios de aceite

- Identidade não convidada recebe 403 e nenhum dado do Portal.
- `manageUsers` não altera role/permissões nem consegue se promover.
- Criar usuário preserva a sessão admin e é atômico entre Firebase e banco.
- Usuário desativado não volta com token existente.
- Payload HTML aparece como texto em todas as páginas.
- HTML, SVG ativo e MIME falso são rejeitados no upload.
- Testes de autorização cobrem todas as rotas sensíveis.

## Gate 1 - Fundação Técnica Suportada

Objetivo: criar uma base evolutiva antes de ampliar funcionalidades.

### Runtime e dependências

- Migrar API, cron e CI de Node 18 para Node 24 LTS.
- Atualizar Firebase Admin com teste de autenticação/provisionamento.
- Atualizar `node-cron` e remover advisories corrigíveis.
- Adicionar `npm audit --omit=dev` com política explícita de severidade.
- Fixar versões/digests das imagens essenciais e executar processos sem root.

### Banco e configuração

- Introduzir migrations SQL numeradas e tabela de versões.
- Adicionar constraints para role, contract type, channel, status e datas.
- Validar payloads, URLs, limites e formas JSON na API.
- Separar roles PostgreSQL de API e cron.
- Separar variáveis por serviço e validar configuração no startup.
- Adicionar paginação e seleção explícita de colunas em listas administrativas.

### Testes de base

- Extrair criação do `app` Express do `listen` para testes sem porta real.
- Testar rotas com PostgreSQL temporário.
- Criar matriz de autenticação/autorização por role e permission.
- Testar migrations em banco vazio e banco na versão anterior.
- Testar erros 400/401/403/404/409/500 sem detalhes internos.

### Critérios de aceite

- Fresh install e upgrade de banco existente produzem o mesmo schema.
- Node e dependências diretas estão em versões suportadas.
- Configuração ausente falha no startup com nome da variável, sem seu valor.
- API e cron funcionam com grants mínimos distintos.
- CI executa testes comportamentais e política de vulnerabilidades.

## Gate 2 - Jornadas Corretas e Interface Acessível

Objetivo: garantir que as funcionalidades atuais funcionem em desktop, mobile,
teclado e leitor de tela.

### Autenticação e perfil

- Diferenciar sessão ausente de indisponibilidade da API e eliminar redirect loop.
- Sincronizar nome entre Firebase e PostgreSQL com resultado explícito.
- Tornar email somente leitura ou implementar alteração verificada no servidor.
- Adicionar remoção de foto e limpeza dos arquivos substituídos.
- Validar telefone e LinkedIn.

### Dashboard e conteúdo

- Calcular próximas ocorrências com datas reais entre meses e anos.
- Mostrar somente lembretes ativos destinados ao usuário.
- Remover CTA de nota fiscal até existir URL ou fluxo real.
- Corrigir texto de prazo para não afirmar conclusão inexistente.
- Adicionar loading, empty, error e retry a toda chamada.
- Restringir Academy e benefits inativos no servidor.

### Acessibilidade e responsividade

- Adicionar skip link, landmarks, um `h1` e `aria-current` por página.
- Associar labels, transformar grupos em forms e anunciar erros/status.
- Tornar cards, avatar, password reveal e tabs operáveis por teclado.
- Implementar dialog com foco preso, Escape, restauração e scroll interno.
- Corrigir contraste e foco visível.
- Implementar sidebar como drawer abaixo do breakpoint definido.
- Adaptar tabelas, topbar, forms, safe areas e alvos touch.
- Respeitar `prefers-reduced-motion`.
- Persistir busca, categoria, artigo e tab na URL.

### Conteúdo e design system

- Padronizar termos em português e marcas deliberadas.
- Formalizar painel informativo, link-card e formulário.
- Separar tokens de marca, foco, links, estados e texto inverso.
- Adotar tipografia editorial para artigos sem redesenhar o shell.

### Critérios de aceite

- Jornadas de login, reset, logout, perfil e sessão expirada não entram em loop.
- Todo usuário vê apenas conteúdo ativo e lembretes destinados a ele.
- Toda chamada tem estado de rede recuperável.
- Fluxos principais passam somente com teclado e NVDA/VoiceOver.
- Não existe scroll horizontal global entre 320 e 1440 px.
- Contraste de texto atende 4,5:1 e foco/componentes 3:1.
- URL restaura filtros, artigo e tab com Back/Forward.

## Gate 3 - Notificações Confiáveis

Objetivo: transformar o cron atual em operação rastreável sem adicionar fila.

### Entregas

- Definir ocorrência por lembrete, usuário, data e canal.
- Criar unique constraint e registrar `pending` antes do provider.
- Atualizar para `sent`, `failed` ou `skipped` por destinatário.
- Isolar falhas e aplicar retry limitado com backoff.
- Não marcar WhatsApp/both como enviado enquanto o canal estiver desativado.
- Definir regra para dias 29 a 31 e catch-up após indisponibilidade.
- Tornar audiência por usuário configurável se houver necessidade operacional.

### Operação

- Registrar last run, duração, contagens e heartbeat.
- Expor histórico autorizado de entrega e falhas.
- Alertar heartbeat atrasado e falhas repetidas.
- Definir se logs sobrevivem à exclusão de usuário/lembrete.

### Critérios de aceite

- Rodar a mesma data novamente não duplica email.
- Falha de um destinatário não bloqueia os demais.
- Toda tentativa possui estado durável e timestamp.
- Meses curtos e restart do cron seguem regra documentada e testada.
- Operação identifica último sucesso e motivo de cada falha.

## Gate 4 - Governança de Pessoas e Conteúdo

Objetivo: completar a administração necessária ao produto interno.

### Auditoria e LGPD

- Registrar actor, ação, alvo, horário e request ID em mudanças privilegiadas.
- Definir base legal, retenção, correção, exportação e exclusão por dataset.

### Módulos

- Unificar permissão de knowledge, decidindo se haverá `manageKnowledge`.
- Adicionar draft/publicado apenas se houver revisão editorial real.
- Adicionar busca/filtro de benefits quando o volume justificar.
- Paginar usuários, reminders e catálogos acima de 50 registros.

### Critérios de aceite

- Toda alteração privilegiada é investigável.
- Conteúdo inativo/draft é inacessível ao usuário comum pela API.
- Dados de titular podem ser localizados, corrigidos e tratados conforme política.
- Listas administrativas mantêm desempenho com 500 registros.

## Gate 5 - Produção Recuperável

Objetivo: publicar sem depender de procedimentos não testados.

### Observabilidade e saúde

- Adicionar `/api/ready` com consulta ao PostgreSQL.
- Adicionar healthchecks da API e estado observável do cron.
- Produzir logs estruturados com request ID e sem dados pessoais desnecessários.
- Definir rotação, retenção e alertas.

### Deploy e recuperação

- Excluir definitivamente `ownerinc-novo-agente/` do artefato de deploy.
- Construir imagem uma vez no CI e publicar tag imutável por commit.
- Registrar revisão e digest implantados.
- Automatizar backup de PostgreSQL e uploads antes da mudança.
- Testar restauração periodicamente em ambiente descartável.
- Executar readiness e smoke test antes de concluir deploy.
- Reverter imagem automaticamente se o gate falhar.
- Confirmar TLS, firewall e bloqueio de acesso direto à origem.
- Remover cache immutable de assets sem hash ou versionar filenames.

### Critérios de aceite

- Readiness falha quando o banco está indisponível.
- Deploy usa artefato de commit limpo, não working tree.
- Backup e restore são demonstrados e medidos.
- Rollback restaura versão anterior sem apagar dados compatíveis.
- Login, perfil, catálogos, lembretes, admin e upload passam no smoke.
- RPO e RTO aprovados são atendidos.

## Gate 6 - Refinamento e Expansões Condicionais

Itens abaixo não bloqueiam a primeira produção e só entram com demanda validada:

- Cupom, validade, elegibilidade e link estruturado em benefits.
- Progresso/matrícula na Academy; se crescer além de catálogo, avaliar LMS antes
  de construir um internamente.
- Estado lido/concluído para lembretes.
- Fluxo real de emissão/registro de nota fiscal PJ.
- WhatsApp com consentimento, provider oficial, idempotência e custos definidos.
- Tema escuro, somente após tokens semânticos e demanda de usuário.
- Self-host de Firebase/Lucide/fontes quando CSP, disponibilidade ou supply chain
  justificarem.

## Ordem de Implementação Imediata

1. Fechar admissão e impedir auto-provisionamento.
2. Corrigir escalada e criação administrativa de usuários.
3. Remover XSS armazenado.
4. Endurecer uploads e Nginx.
5. Criar testes de autorização e ciclo de conta.
6. Migrar Node/dependências e introduzir migrations.
7. Corrigir lembretes por audiência/data.
8. Implementar shell mobile e base acessível.
9. Tornar notificações idempotentes.
10. Preparar governança, backup, observabilidade e deploy.

## Métricas de Saída

- 0 achado crítico ou alto aberto antes da produção.
- 100% das rotas sensíveis cobertas por matriz de autorização.
- 0 duplicação no replay de um job diário.
- 100% das entregas com estado durável.
- 0 fluxo principal bloqueado em viewport de 320 px ou somente teclado.
- LCP <= 2,5 s, CLS <= 0,1 e INP <= 200 ms no perfil mobile.
- Backup restaurado dentro do RTO e perda máxima dentro do RPO aprovado.
