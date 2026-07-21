# Auditoria Estrutural, Arquitetural e de Segurança

Data: 20 de julho de 2026
Escopo: Portal Ownerinc, exceto `ownerinc-novo-agente/`
Método: revisão estática integral, rastreamento de rotas e fluxos, `npm audit`,
validação do Compose e execução de `npm run verify`.

> Este documento registra o baseline anterior à implementação. Os achados
> críticos e altos foram corrigidos; consulte
> [`../reports/2026-07-20-roadmap-implementation.md`](../reports/2026-07-20-roadmap-implementation.md)
> para o estado final e riscos residuais.

## Veredito

A base é pequena, compreensível e adequada ao estágio do produto. A separação
entre Nginx, frontend estático, API Express, PostgreSQL e cron deve ser
preservada. O Portal ainda não está pronto para exposição pública ou produção:
há bloqueadores de admissão, autorização, XSS armazenado, upload, ciclo de vida
de contas e confiabilidade de notificações.

## Pontos Fortes

- PostgreSQL não publica porta no host.
- Autorização relevante existe na API, não apenas na interface.
- Tokens Firebase são validados pelo Firebase Admin.
- Consultas SQL usam parâmetros para os valores fornecidos pelo usuário.
- Banco e uploads usam volumes persistentes.
- PostgreSQL possui healthcheck e dependências aguardam sua inicialização.
- Lockfiles e `npm ci` tornam builds reproduzíveis.
- Segredos, uploads e o agente separado estão ignorados pelo Git.
- CI, checks de sintaxe, teste de fronteiras, secret scan e validação do Compose
  estão operacionais.
- Produto, arquitetura e operações estão documentados.

## Bloqueadores Críticos

### SEC-01 - Admissão pública em produto interno

Evidências: `public/login.html:551-610`, `api/middleware/auth.js:23-34`.

Cadastro por email e login Google estão expostos. Qualquer identidade aceita
pelo Firebase é criada automaticamente como viewer no PostgreSQL. Isso também
faz um usuário removido reaparecer.

Correção mínima: desativar cadastro público, negar UIDs ausentes do banco e
provisionar contas somente por um fluxo administrativo no servidor.

### SEC-02 - XSS armazenado em conteúdo e dados pessoais

Evidências: `public/js/admin.js:74-86`, `public/js/admin.js:253-263`,
`public/js/admin.js:343-354`, `public/js/admin.js:429-437`,
`public/js/knowledge.js:21-29`, `public/js/knowledge.js:51-79`,
`public/js/reminders.js:28-40`, `public/js/dashboard.js:57-67`,
`public/js/dashboard.js:105-118`, `public/js/academy.js:24-37` e
`public/js/benefits.js:24-41`.

Valores vindos do banco entram em `innerHTML`. Um usuário comum pode armazenar
payload na ouvidoria ou no perfil e executar JavaScript quando um administrador
visualizar o registro.

Correção mínima: construir nós com `createElement`, preencher texto com
`textContent`, validar URLs e adicionar CSP depois de remover scripts e handlers
inline incompatíveis.

### SEC-03 - Escalada de `manageUsers` para `superAdmin`

Evidências: `api/routes/users.js:44-68`, `api/middleware/auth.js:44-46`.

Quem possui `manageUsers` controla `role` e `permissions` no endpoint de criação,
que também funciona como upsert. O próprio usuário pode se promover.

Correção mínima: somente super-admin altera função ou permissões. Delegados de
usuários devem editar apenas campos operacionais explicitamente permitidos.

### SEC-04 - Upload pode publicar conteúdo ativo na origem do Portal

Evidências: `api/routes/upload.js:8-22`, `api/index.js:10-11`.

O MIME informado pelo cliente é confiado e a extensão original é preservada.
HTML ou SVG ativo pode ser servido pela mesma origem da aplicação.

Correção mínima: atualizar para Multer 2, aceitar somente JPEG, PNG e WebP,
verificar assinatura, gerar nome e extensão no servidor e enviar
`X-Content-Type-Options: nosniff`.

### SEC-05 - Revogação e exclusão de conta não são confiáveis

Evidências: `api/routes/users.js:106-121`, `api/middleware/auth.js:21-34`.

O banco é apagado antes do Firebase, falhas do Firebase são descartadas e um
token ainda válido recria o usuário local.

Correção mínima: desabilitar ou excluir a identidade primeiro, verificar
revogação, confirmar o resultado e somente depois desativar o registro local.

## Achados de Alta Prioridade

### SEC-06 - Criação administrativa de usuário está quebrada

Evidências: `public/js/admin.js:205-216`.

`createUserWithEmailAndPassword` troca a sessão do navegador para a conta nova.
O POST seguinte passa a ser feito como viewer e pode deixar uma conta órfã.

Correção: criar a identidade pela API com Firebase Admin e compensar qualquer
falha do banco removendo a identidade recém-criada.

### SEC-07 - Demissão pode preservar privilégios

Evidências: `api/routes/users.js:80-97`.

Permissões só são substituídas em uma condição específica. Um usuário rebaixado
pode continuar com `superAdmin`; não existem regras para autoexclusão, superior
hierárquico ou último super-admin.

Correção: política centralizada de função/permissão e invariantes para impedir
autoescalada e remoção do último administrador.

### SEC-08 - Fotos públicas expõem UID e não têm ciclo de vida

Evidências: `api/routes/upload.js:10-13`, `api/index.js:10-11`,
`nginx/nginx.conf:15-19`.

O nome contém UID Firebase e timestamp, o acesso é público e arquivos antigos
nunca são removidos.

Correção: nomes aleatórios, decisão explícita sobre acesso autenticado, remoção
da foto anterior, exclusão manual e quota por usuário.

### SEC-09 - Serviços recebem segredos e acesso ao banco além do necessário

Evidências: `docker-compose.yml:4-8`, `docker-compose.yml:23-25`,
`docker-compose.yml:43-46`, `api/db.js:3-5`, `cron/db.js:3-5`.

API, cron e PostgreSQL recebem o mesmo arquivo de ambiente. API e cron usam a
mesma identidade proprietária no banco.

Correção: variáveis por serviço e roles PostgreSQL separadas; cron precisa apenas
ler lembretes/usuários e gravar resultados.

### ARCH-01 - Notificações não são idempotentes

Evidências: `cron/checkReminders.js:8-57`, `api/db/schema.sql:74-81`.

Envio ocorre antes do log, não existe chave única por ocorrência e uma falha
interrompe todos os destinatários seguintes. Canal desativado pode ser marcado
como enviado.

Correção: ocorrência única por lembrete, usuário, data e canal; claim `pending`
antes do envio; processamento isolado; estados `sent`, `failed` e `skipped`.

### ARCH-02 - Deploy inclui projeto fora do escopo

Evidências: `deploy.sh:9-13`, `.gitignore:16-17`.

O rsync percorre a árvore de trabalho e não exclui `ownerinc-novo-agente/`, que
pode conter dados locais.

Correção: excluir a pasta imediatamente e, depois, publicar artefato gerado de um
commit limpo em vez da árvore de trabalho.

### OPS-01 - Backup e rollback existem apenas como intenção

Evidências: `docs/operations/deployment.md:5-14`,
`docs/operations/rollback.md:3-12`, `deploy.sh:15-16`.

Não há backup automático, retenção de imagens, health gate ou restauração
testada.

Correção: backup versionado de PostgreSQL e uploads antes do deploy, registro de
commit/digests, smoke test e rollback automático quando readiness falhar.

### OPS-02 - TLS e proteção da origem dependem de configuração externa

Evidências: `docker-compose.yml:31-35`, `nginx/nginx.conf:1-3`,
`deploy.sh:18`.

O Compose publica HTTP em todas as interfaces. Se proxy e firewall não
restringirem a origem, tokens e dados podem trafegar sem TLS.

Correção: confirmar a topologia; vincular a porta a loopback/rede privada quando
TLS terminar em proxy externo ou terminar TLS no Nginx.

### GOV-01 - LGPD sem retenção, trilha de acesso ou política de exclusão

Evidências: `api/db/schema.sql:6-20`, `api/db/schema.sql:67-81`.

Perfis, vínculo de trabalho, fotos e ouvidoria são dados pessoais. Não há log de
leitura da ouvidoria, alteração de permissões, retenção ou processo de titular.

Correção: definir base legal e retenção por conjunto, registrar ações
privilegiadas e esclarecer o nível real de anonimato da ouvidoria.

### DEP-01 - Runtime fora de suporte e dependências vulneráveis

Evidências: `package.json:11-13`, `api/Dockerfile:1`, `cron/Dockerfile:1`,
`api/package-lock.json`, `cron/package-lock.json`.

Node 18 está fora de suporte. Em 20/07/2026, `npm audit --omit=dev` encontrou
8 vulnerabilidades moderadas na API, ligadas principalmente ao Firebase Admin,
e 2 no cron, ligadas a `node-cron`/`uuid`. Não houve achado alto ou crítico.

Correção: Node 24 LTS, Multer 2, `node-cron` mantido e atualização testada do
Firebase Admin. Adicionar política de audit no CI, sem `npm audit fix --force`.

## Achados Médios

### SEC-10 - Ausência de limites de abuso

Não há rate limit global, por usuário, quota de uploads ou retenção automática.
Ombudsman e disco podem ser saturados por uma conta válida. Evidências:
`api/index.js:7-8`, `api/routes/upload.js:24-33`.

### SEC-11 - CORS e headers permissivos

`cors()` aceita qualquer origem e o Nginx não define CSP, frame protection,
`nosniff`, referrer policy ou permissions policy. Dependências de navegador vêm
de CDN sem SRI. Evidências: `api/index.js:7`, `nginx/nginx.conf:1-37`.

### SEC-12 - Erros internos retornam ao cliente

Rotas respondem `err.message`, expondo detalhes de banco, arquivos ou parsing.
Exemplos: `api/routes/users.js:26-28`, `api/routes/knowledge.js:48-50`,
`api/routes/upload.js:31-33`.

### ARCH-03 - Rota de upload conflita com cache estático

O regex de arquivos estáticos pode vencer o prefixo `/uploads/`, e o limite
padrão do Nginx é menor que os 3 MB permitidos pela API. Evidências:
`nginx/nginx.conf:15-28`, `api/routes/upload.js:16-18`.

Correção: `location ^~ /uploads/` e `client_max_body_size` alinhado.

### ARCH-04 - Schema é inicialização, não migração

`schema.sql` roda somente quando o volume nasce. Alterações futuras não chegam a
bancos existentes. Evidência: `docker-compose.yml:9-11`.

Correção: migrations SQL numeradas e uma tabela simples de versões.

### DATA-01 - Validação e constraints incompletas

Função, contrato, canal, status, URLs e formas JSON são livres; `pj_due_day` não
tem range. Limites da Academy aceitam valores inválidos. Evidências:
`api/db/schema.sql:6-81`, `api/routes/academy.js:16-18`.

### DATA-02 - Leituras sem paginação e com colunas excessivas

Usuários, ouvidoria e lembretes retornam coleções completas e, em alguns casos,
`SELECT *`. Evidências: `api/routes/users.js:37`,
`api/routes/ombudsman.js:10-12`, `cron/checkReminders.js:18-19`.

### OPS-03 - Healthcheck não mede dependências

`/api/health` sempre responde OK e cron não possui heartbeat. Evidências:
`api/index.js:22-23`, `cron/index.js:5-15`.

### FUNC-01 - Redirecionamento pode entrar em loop

Qualquer erro da API vira “usuário inexistente”, enquanto a tela de login detecta
a sessão Firebase e retorna ao dashboard. Evidências: `public/js/auth.js:24-40`,
`public/login.html:460-462`.

### FUNC-02 - Visibilidade de lembretes ignora audiência

Usuários comuns podem receber lembretes inativos ou destinados a outro grupo.
O dashboard também ignora a audiência. Evidências: `api/routes/reminders.js:6-19`,
`public/js/dashboard.js:43-52`, `public/js/reminders.js:17-20`.

### FUNC-03 - Cálculo de próximos lembretes quebra na virada do mês

O dashboard subtrai números de dia, não datas. Evidência:
`public/js/dashboard.js:45-52`.

### FUNC-04 - Conteúdo inativo é recuperável pela API

Academy e benefícios deixam o cliente escolher se filtra ativos. Usuários comuns
podem chamar a rota sem filtro. Evidências: `api/routes/academy.js:6-20`,
`api/routes/benefits.js:6-20`.

### FUNC-05 - Semântica mensal é incompleta

Lembretes dos dias 29 a 31 somem em meses curtos e não há catch-up quando o cron
fica indisponível às 08:00. Evidências: `cron/checkReminders.js:5-11`,
`cron/index.js:5-13`.

### OPS-04 - Containers mutáveis e executados como root

Tags de imagens não são fixadas por digest, builds são refeitos no deploy e os
processos Node não declaram usuário não-root. Evidências: `api/Dockerfile:1`,
`cron/Dockerfile:1`, `docker-compose.yml:3,32`, `deploy.sh:15-16`.

## Achados Baixos

- Deletes de knowledge, reminders, Academy e benefits retornam sucesso mesmo
  quando o ID não existe: `api/routes/knowledge.js:53-59`,
  `api/routes/reminders.js:71-77`, `api/routes/academy.js:62-68`,
  `api/routes/benefits.js:61-67`.
- Assets sem hash recebem cache `immutable` por 7 dias:
  `nginx/nginx.conf:25-28`.
- Variáveis obrigatórias não são validadas no startup:
  `api/middleware/auth.js:5-10`, `cron/sendEmail.js:3-8`.
- Express expõe `X-Powered-By`: `api/index.js:5-8`.
- `ENV_FILE` não alimenta interpolação do Compose da mesma forma que `.env`:
  `docker-compose.yml:4-8`.

## Arquitetura-Alvo

Não reescrever nem dividir em novos serviços. Evoluir as fronteiras atuais:

1. Firebase comprova identidade; PostgreSQL decide admissão.
2. Provisionamento e desativação ocorrem no servidor.
3. Uma política única controla função, permissões e campos editáveis.
4. Frontend trata conteúdo armazenado como texto por padrão.
5. Upload normaliza imagem e controla acesso/ciclo de vida.
6. Migrations SQL numeradas substituem init-only.
7. PostgreSQL funciona como ledger idempotente de notificações.
8. API e cron recebem somente secrets e grants necessários.
9. Nginx aplica TLS/origin boundary, limites e headers.
10. Deploy usa artefato imutável, backup, readiness e rollback testado.
11. Logs estruturados, request ID, heartbeat e alertas formam a observabilidade
    mínima.

## Lacunas de Teste

- Matriz de autorização por rota, função e permissão.
- Identidade Firebase desconhecida, revogada, desabilitada e removida.
- Escalada, demissão e último super-admin.
- Renderização inerte de payloads HTML e URLs perigosas.
- Upload com MIME falso, SVG, HTML, polyglot, limite e limpeza.
- Idempotência, concorrência, retry e falha parcial do cron.
- Audiências all/PJ/CLT/UID e virada de mês/ano.
- Integração real com PostgreSQL e migrations.
- Nginx para `/`, `/api`, `/uploads`, headers e tamanho de body.
- Backup e restauração em ambiente descartável.
- Jornadas de navegador e responsividade.

## Decisões Necessárias

1. A admissão será por convite, domínio Ownerinc ou UID provisionado?
2. Quem pode alterar funções e permissões além do super-admin?
3. Fotos precisam ser privadas ou podem ser públicas com URL não identificável?
4. Qual nível de anonimato a ouvidoria promete e qual sua retenção?
5. O que acontece com lembretes dos dias 29 a 31?
6. Duplicar ou perder uma notificação é o pior resultado para a operação?
7. Quais são RPO e RTO de banco e uploads?
8. Onde TLS termina e a porta 80 da VPS pode ser alcançada diretamente?
9. Logs de notificação sobrevivem à exclusão de usuário/lembrete?
10. Dependências de frontend podem continuar em CDN ou serão locais?
