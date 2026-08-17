# Inventário da Implementação Funcional

Atualizado em 20 de julho de 2026.

Este documento relaciona as capacidades descritas no `README.md` e no brief do
produto com o que está efetivamente implementado no código. Roadmap, intenção e
capacidade nativa de serviços externos não são considerados implementação sem
fluxo correspondente no Portal.

## Legenda

- **Operacional:** fluxo principal implementado; pode depender de serviço externo.
- **Parcial:** implementação utilizável com uma limitação relevante identificada.
- **Não implementada:** não há fluxo executável correspondente.
- **Fora do escopo:** decisão explícita do produto atual.

## Autenticação, Sessão e Admissão

| Funcionalidade | Estado | Implementação e evidência |
| --- | --- | --- |
| Login por email e senha | Operacional | Firebase Auth no frontend; a API valida token não revogado, email verificado, UID admitido no PostgreSQL e conta ativa. `public/js/login.js`, `public/js/auth.js`, `api/middleware/auth.js` |
| Persistência de sessão | Operacional | Firebase restaura a sessão; respostas 401/403 encerram a sessão local. `public/js/auth.js` |
| Logout | Operacional | Encerra a sessão Firebase e retorna ao login. `public/js/auth.js`, `public/js/sidebar.js` |
| Recuperação de senha | Operacional | Envio de email pelo Firebase a partir do login ou perfil. `public/js/login.js`, `public/js/profile.js` |
| Admissão fechada | Operacional | Não há cadastro público nem autoprovisionamento; o UID precisa existir no banco. `api/middleware/auth.js`, `api/routes/users.js` |
| Criação administrativa de usuário | Operacional | Firebase Admin cria a identidade sem trocar a sessão do administrador e compensa falha de persistência. Exige `manageUsers`; role e permissões exigem super-admin. `api/routes/users.js` |
| Convite administrativo por e-mail | Operacional | Administrador provisiona a conta sem senha inicial; o Portal gera link seguro do Firebase para definição de senha e envia o convite pelo SMTP existente. Falhas de envio desfazem a identidade e o registro. `api/routes/users.js`, `api/integrations/password-reset-email.js`, `public/js/admin.js` |
| Primeiro super-admin | Operacional | Ferramenta one-shot valida identidade, email verificado e ausência de outro super-admin ativo. `api/db/bootstrap-admin.js` |
| Administrador local | Operacional | Em desenvolvimento, cria identidade no Auth Emulator e o primeiro super-admin no banco. `api/db/create-local-admin.js`, `firebase-emulator/Dockerfile` |
| Desativação e reativação | Operacional | Desabilita Firebase, revoga tokens e bloqueia localmente; protege a própria conta, superiores e o último super-admin. `api/routes/users.js` |
| Cadastro público, login social e MFA | Não implementada | Não existem providers ou fluxos correspondentes no frontend/API. |

## Dashboard

| Funcionalidade | Estado | Implementação e evidência |
| --- | --- | --- |
| Saudação personalizada | Operacional | Exibe nome ou email do perfil autenticado. `public/js/dashboard.js` |
| Conteúdo por contrato PJ/CLT | Parcial | Mostra links diferentes por contrato; a indicação de nota fiscal PJ foi removida até existir um fluxo real. Sólides permanece desligada na V1. `public/js/dashboard.js` |
| Próximos lembretes | Operacional | Endpoint autenticado calcula no servidor as ocorrências dos próximos sete dias com regra de fim do mês e audiência individual; o dashboard não depende de uma primeira página arbitrária. `public/js/dashboard.js`, `api/routes/reminders.js` |
| Links rápidos | Operacional | Atalhos internos conforme o contrato; Sólides permanece desligada na V1. `public/js/dashboard.js` |
| Destaques da Academy | Operacional | Exibe até três cursos com estados de carregamento, vazio, erro e nova tentativa. `public/js/dashboard.js` |

## AutoCard

| Funcionalidade | Estado | Implementação e evidência |
| --- | --- | --- |
| Acesso por cargo RH | Operacional | O módulo só libera os cargos exatos Analista de RH Sênior e Gerente de RH; a API bloqueia acesso direto para os demais usuários. `api/middleware/policy.js`, `api/routes/autocard.js`, `public/autocard/guard.js` |
| Criação e exportação de cards | Operacional | Templates, variações visuais, biblioteca de assets, upload e exportação PNG migrados para o Portal. `public/autocard/` |
| Histórico compartilhado | Operacional | Cards persistidos no PostgreSQL e visíveis para todos os usuários autorizados de RH, com busca, edição, duplicação e exclusão auditadas dentro do shell padrão do Portal. `api/db/migrations/010_autocard.sql`, `api/routes/autocard.js`, `public/autocard/index.html` |
| Renomeação RH para DHO | Operacional | Migration 010 reassocia usuários e renomeia cargos antigos sem quebrar a referência de usuários. `api/db/migrations/010_autocard.sql` |

## Perfil Pessoal

| Funcionalidade | Estado | Implementação e evidência |
| --- | --- | --- |
| Visualizar e editar perfil | Operacional | Nome, bio, telefone e LinkedIn persistidos no PostgreSQL; email é somente leitura. `public/js/profile.js`, `api/routes/users.js` |
| Visualizar cargo profissional | Operacional | Cargo atribuído pela administração é exibido no perfil; usuários comuns não podem alterá-lo. `public/js/profile.js`, `api/middleware/auth.js` |
| Validação de dados | Operacional | Allowlist, limites de tamanho e URL HTTP(S); telefone possui limite, mas não valida formato regional. `api/middleware/validation.js`, `api/db/schema.sql` |
| Sincronizar nome com Firebase | Operacional | Salva o banco e tenta atualizar o display name; falha externa é informada sem desfazer os dados persistidos. `public/js/profile.js` |
| Upload de foto | Operacional | Aceita JPEG, PNG e WebP até 3 MB, valida assinatura, decodifica, redimensiona, remove metadados e normaliza para WebP. `api/routes/upload.js`, `api/middleware/validation.js` |
| Substituir e remover foto | Operacional | Atualiza a referência e remove o arquivo anterior quando aplicável. `api/routes/upload.js`, `public/js/profile.js` |
| Privacidade da foto | Parcial | O nome é um UUID aleatório, mas `/uploads/` é público para uso direto em `<img>`; fotos sensíveis não são suportadas. `api/index.js`, `nginx/nginx.conf` |
| Exportar dados pessoais | Operacional | Exporta perfil, notificações e eventos de auditoria associados em JSON e audita a ação. `api/routes/users.js`, `public/js/profile.js` |

## Base de Conhecimento

| Funcionalidade | Estado | Implementação e evidência |
| --- | --- | --- |
| Listar e ler artigos | Operacional | Possui loading, vazio, erro, retry, paginação server-side e leitura por ID para links diretos fora da página atual. `public/js/knowledge.js`, `api/routes/knowledge.js` |
| Busca por título e conteúdo | Operacional | Busca server-side em título e conteúdo e persiste `q`, categoria e offset na URL. `public/js/knowledge.js`, `api/routes/knowledge.js` |
| Filtro por categoria | Operacional | Lista categorias no servidor e aplica o filtro na consulta paginada. `public/js/knowledge.js`, `api/routes/knowledge.js` |
| Link direto para artigo | Operacional | `article` na URL e histórico Back/Forward selecionam o detalhe. `public/js/knowledge.js` |
| CRUD de artigos | Operacional | Criar, editar e excluir com validação, transação, auditoria e `manageKnowledge`. Conteúdo é renderizado como texto. `api/routes/knowledge.js`, `public/js/knowledge.js` |
| Draft, revisão, anexos e rich text | Não implementada | O modelo atual armazena texto simples e categoria. |

## Academy

| Funcionalidade | Estado | Implementação e evidência |
| --- | --- | --- |
| Catálogo ativo por categoria | Operacional | Usuários comuns recebem somente itens ativos, com categorias server-side, paginação e filtros restauráveis pela URL. `api/routes/academy.js`, `public/js/academy.js` |
| Links externos | Operacional | Apenas HTTP(S), com `noopener noreferrer`; URL inválida não é oferecida como link. `api/route-utils.js`, `public/js/academy.js` |
| CRUD, ordenação e ativação | Operacional | Administração paginada, validada e auditada para `manageAcademy`. `api/routes/academy.js`, `public/js/admin.js` |
| Matrícula, progresso e certificado | Fora do escopo | Academy é um catálogo, não um LMS. |

## Benefícios

| Funcionalidade | Estado | Implementação e evidência |
| --- | --- | --- |
| Catálogo ativo por categoria | Operacional | Exibe descrição e instruções dos itens ativos com categorias server-side, paginação e filtros restauráveis pela URL. `api/routes/benefits.js`, `public/js/benefits.js` |
| CRUD, ordenação e ativação | Operacional | Administração paginada, validada e auditada para `manageBenefits`. `api/routes/benefits.js`, `public/js/admin.js` |
| Cupom, validade, elegibilidade e resgate | Não implementada | Não há campos, persistência ou fluxo de utilização. |

## Lembretes e Notificações

| Funcionalidade | Estado | Implementação e evidência |
| --- | --- | --- |
| Listagem segmentada | Operacional | Filtra ativos e audiência `all`, `pj`, `clt` ou UID no servidor; página possui paginação. `api/routes/reminders.js`, `public/js/reminders.js` |
| CRUD de lembretes | Operacional | Validação, auditoria, ativação e canais para `manageReminders`. `api/routes/reminders.js`, `public/js/reminders.js` |
| Público individual | Operacional | Formulário permite informar UIDs explícitos, preserva a audiência na edição e rejeita valores vazios, duplicados ou acima do limite. `api/route-utils.js`, `cron/scheduling.js`, `public/js/reminders.js` |
| Agendamento mensal | Operacional | Worker roda no fuso de Brasília; dias 29 a 31 usam o último dia de meses curtos e o catch-up é limitado a sete dias. `cron/index.js`, `cron/scheduling.js` |
| Envio por email | Operacional | Resend SMTP com registro prévio, isolamento por destinatário e até três tentativas para 421/451, 429 e 5xx. Depende de credenciais externas válidas. `cron/checkReminders.js`, `cron/sendEmail.js` |
| Ledger e idempotência | Operacional | Uma ocorrência por lembrete, usuário, data e canal, com estados `pending`, `sending`, `sent`, `failed` e `skipped`. `api/db/schema.sql`, `cron/checkReminders.js` |
| Histórico de entregas | Operacional | Interface expõe filtros por status, canal, usuário e data, com paginação server-side. `api/routes/reminders.js`, `public/js/reminders.js` |
| Saúde do worker | Parcial | Heartbeat e healthcheck possuem estado de alerta deduplicado e envio SMTP configurável; falta homologação com caixa operacional real. `cron/health.js`, `cron/sendOperationalAlert.js`, `api/db/migrations/011_cron_alert_state.sql` |
| WhatsApp | Não implementada | Canal permanece desativado e é registrado como `skipped`; não existe envio real. `cron/sendWhatsApp.js`, `cron/checkReminders.js` |
| Lido, concluído e preferências | Não implementada | Não há estado por usuário nem opt-in/opt-out por canal. |

## Ouvidoria

| Funcionalidade | Estado | Implementação e evidência |
| --- | --- | --- |
| Enviar mensagem | Operacional | Usuário autenticado envia texto validado; limite de cinco envios por hora por usuário. `api/routes/ombudsman.js`, `public/js/ombudsman.js` |
| Minimização da identidade | Operacional | UID e email não são gravados na mensagem, sem promessa de anonimato técnico absoluto diante de logs e infraestrutura. `api/routes/ombudsman.js`, `api/db/schema.sql` |
| Leitura restrita e auditada | Operacional | Exige `viewOmbudsman`; toda listagem autorizada gera auditoria. `api/routes/ombudsman.js`, `public/js/admin.js` |
| Tratamento da mensagem | Operacional | Status nova/em análise/resolvida, responsável e notas internas. `api/routes/ombudsman.js`, `public/js/admin.js` |
| Filtros operacionais | Operacional | Interface filtra status e responsável e mantém paginação server-side. `api/routes/ombudsman.js`, `public/js/admin.js` |
| Retenção | Operacional | Worker exclui mensagens resolvidas após o período configurado, padrão de 730 dias. `cron/retention.js` |

## Administração e Permissões

| Funcionalidade | Estado | Implementação e evidência |
| --- | --- | --- |
| Perfis `viewer` e `admin` | Operacional | Role persistida e permissões granulares efetivas somente para admins. `api/db/schema.sql`, `api/middleware/policy.js` |
| Gate do painel | Operacional | Interface exibe abas permitidas; toda autorização real é repetida na API. `public/js/auth.js`, `public/js/admin.js`, `api/middleware/policy.js` |
| Permissões granulares | Operacional | `manageUsers`, `manageReminders`, `manageAcademy`, `manageBenefits`, `manageKnowledge` e `viewOmbudsman`; somente super-admin atribui privilégios. `api/middleware/policy.js`, `api/routes/users.js` |
| Gestão de usuários | Operacional | Listagem paginada, criação, edição, desativação e reativação para `manageUsers`, com restrições de hierarquia. `api/routes/users.js`, `public/js/admin.js` |
| Gestão de cargos | Operacional | Superfície administrativa para cadastrar, editar, ativar e desativar cargos; cargos desativados permanecem associados ao histórico dos usuários. `api/routes/job-titles.js`, `public/js/admin.js`, `api/db/migrations/009_job_titles.sql` |
| Apagamento de dados pessoais | Operacional | Super-admin remove identidade Firebase, perfil, foto e referências estáveis após desativação. `api/routes/users.js` |
| Auditoria administrativa | Operacional | API e interface registram, paginam e exibem ator, ação, alvo, request ID e horário para super-admin. `api/route-utils.js`, `api/routes/users.js`, `public/js/admin.js` |

## Navegação, UX e Acessibilidade

| Funcionalidade | Estado | Implementação e evidência |
| --- | --- | --- |
| Navegação desktop | Operacional | Sidebar consistente e estado recolhido persistido em local storage. `public/js/sidebar.js` |
| Navegação mobile | Operacional | Drawer com `inert`, `aria-hidden`, Escape, foco preso e restauração do foco. `public/js/sidebar.js` |
| Teclado e foco | Operacional | Foco visível, tabs por setas/Home/End e elementos interativos sem div clicável. `public/css/components.css`, `public/js/admin.js` |
| Diálogos | Operacional | `role=dialog`, `aria-modal`, foco preso, Escape, restauração e proteção contra descarte acidental. `public/js/ui.js` |
| Leitores de tela | Parcial | Há idioma, headings, landmarks, labels, skip links e live regions no código; falta validação física com NVDA/VoiceOver. `public/`, `public/js/ui.js` |
| Estados de interface | Operacional | Fluxos de dados possuem loading, vazio, erro e retry. `public/js/ui.js`, scripts das páginas |
| Movimento reduzido | Operacional | Respeita `prefers-reduced-motion`. `public/css/layout.css`, `public/login.html` |
| Dark mode | Fora do escopo | Apenas tema claro está implementado. |

## Segurança, LGPD e Governança

| Funcionalidade | Estado | Implementação e evidência |
| --- | --- | --- |
| Autorização server-side | Operacional | Todas as rotas de recurso exigem autenticação e políticas conforme role/permissão. `api/middleware/auth.js`, `api/middleware/policy.js`, `api/routes/` |
| Validação e integridade | Operacional | Payloads com allowlist e limites; enums, URLs e formas JSON reforçados por constraints PostgreSQL. `api/middleware/validation.js`, `api/db/schema.sql` |
| Proteção contra stored XSS | Operacional | Dados persistidos são inseridos no DOM como texto, não como HTML. `public/js/ui.js`, scripts das páginas |
| Segurança HTTP | Operacional | CORS, proteção cross-site, rate limits, CSP, HSTS, `nosniff`, bloqueio de frames e request IDs. `api/middleware/security.js`, `nginx/nginx.conf` |
| Rate limit distribuído | Parcial | Limite da API é em memória por processo; Nginx cobre a borda de uma única instância. |
| Menor privilégio no banco | Operacional | Roles separadas para migração, API e cron; serviços de runtime não recebem DDL. `api/db/provision.js`, `docker-compose.yml` |
| Exportação, bloqueio e exclusão | Operacional | Existem mecanismos técnicos para correção, exportação, desativação e erasure. `api/routes/users.js` |
| Retenção automática | Operacional | Padrões de 730 dias para notificações/ouvidoria resolvida e 1.825 dias para auditoria. `cron/retention.js` |
| Política jurídica e bases legais | Parcial | `docs/product/privacy-retention.md` é uma política técnica inicial e requer validação jurídica. |
| Preferências de comunicação | Não implementada | Não há consentimento ou preferência individual por canal. |

## Plataforma e Operação

| Funcionalidade | Estado | Implementação e evidência |
| --- | --- | --- |
| Stack Docker Compose | Operacional | PostgreSQL, migrations, API, Nginx, cron e Auth Emulator opcional no perfil local. `docker-compose.yml`, `firebase-emulator/Dockerfile` |
| Persistência | Operacional | Volumes nomeados para PostgreSQL e uploads. `docker-compose.yml` |
| Migrations | Operacional | SQL numerado, ledger, advisory lock e transação; schema fresco acompanha as migrations até `011_cron_alert_state`. `api/db/migrate.js`, `api/db/migrations/`, `api/db/schema.sql` |
| Liveness e readiness | Operacional | `/api/health` verifica processo e `/api/ready` consulta o banco. `api/index.js` |
| CI e segurança de dependências | Operacional | Sintaxe, testes, migrations reais, audit, SBOM, Trivy, builds e publicação no GHCR. `.github/workflows/ci.yml`, `scripts/verify.mjs` |
| Deploy imutável | Operacional | Publica archive de commit limpo, resolve imagens por digest e mantém release anterior para rollback. `deploy.sh`, `scripts/release.sh` |
| Smoke test | Parcial | Verifica frontend e readiness, sem autenticação ou fluxos de domínio. `scripts/smoke.sh` |
| Backup e restore | Operacional | Snapshot consistente de banco/uploads com checksum; restore confirmado, transacional e com backup prévio. `scripts/backup.sh`, `scripts/restore.sh` |
| Backup diário externo e cifrado | Parcial | Existe transferência configurável para S3-compatible com checksum e preservação do backup local; agendamento, credenciais, lifecycle e criptografia efetiva dependem da operação externa. `scripts/backup-s3.sh`, `scripts/backup.sh`, `docs/operations/deployment.md` |
| Observabilidade | Parcial | Request IDs, logs, heartbeat, contadores e alertas SMTP deduplicados existem; métricas externas e rotação de logs ainda dependem da operação. `api/middleware/security.js`, `cron/health.js`, `cron/sendOperationalAlert.js` |
| HTTPS | Parcial | O Nginx interno serve HTTP; TLS deve ser terminado por proxy externo na VPS. `nginx/nginx.conf`, `docs/operations/deployment.md` |

## Integração Sólides

| Funcionalidade | Estado | Implementação e evidência |
| --- | --- | --- |
| Liberação gradual | Operacional | Estágios `off`, `internal`, `pilot`, `general`, `manager` e `write`; padrão `off`. `api/integrations/solides-config.js` |
| Vínculo com colaborador | Operacional interno | UID é associado manualmente a `employeeId`/`externalId`, com unicidade, auditoria e tab administrativa descoberta somente após o gate. `api/db/migrations/007_solides_employee_links.sql`, `api/routes/solides.js`, `public/js/admin.js` |
| Resumo, histórico, escala e saldo | Parcial | Rotas e página read-only implementadas atrás do gate; respostas reais ainda exigem homologação com o token Ownerinc. `api/routes/solides.js`, `public/solides.html` |
| Descoberta oculta | Operacional | Em `off` a API responde 404; no piloto somente UIDs permitidos e vinculados recebem o acesso interno. `public/js/dashboard.js` |
| Probe de homologação | Operacional interno | A tab oculta testa endpoints read-only e exibe somente status, duração e forma da resposta. `api/routes/solides.js`, `public/js/admin.js` |
| Folha de ponto PDF | Não implementada | O serviço Report atual ainda precisa ser descoberto e homologado. |
| Sincronização incremental | Não implementada | Será adicionada somente se o piloto demonstrar necessidade de cache/polling. |
| Gestores e escritas | Não implementada | Estágios reservados, sem rotas liberadas nesta versão. |

## Funcionalidades Explicitamente Ausentes

- Envio real por WhatsApp.
- Upload, emissão ou conclusão de nota fiscal PJ.
- LMS com matrícula, progresso, conclusão e certificado.
- Cupons, validade, elegibilidade e resgate de benefícios.
- Confirmação de leitura ou conclusão de lembretes.
- Draft e revisão editorial da base de conhecimento.
- MFA e login social.
- Dark mode.
- Aplicativo móvel nativo.
- Ownerinc Brain, Discord e IA, que pertencem a outro projeto.

## Síntese

O núcleo implementado cobre autenticação fechada, perfil, conteúdos internos,
catálogos, lembretes por email, ouvidoria, administração granular, auditoria,
retenção e operação em Docker Compose. As limitações mais relevantes estão na
paginação de algumas visões comuns, controles reduzidos para históricos e
filtros, ausência de WhatsApp, validação assistiva ainda não executada em
dispositivos e dependências operacionais externas para TLS, alertas e backups
off-host.
