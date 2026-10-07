# Desenvolvimento Local

## Stack completa

1. Crie `.env` a partir de `.env.example` e preencha credenciais de desenvolvimento.
2. Use `NODE_ENV=development` e `FIREBASE_AUTH_EMULATOR_HOST=firebase-auth:9099`; as credenciais Firebase Admin podem ficar vazias nesse modo.
3. Execute `docker compose --profile local up -d --build`.
4. Crie o primeiro administrador local:

```sh
docker compose --profile local --profile admin run --rm bootstrap-admin node db/create-local-admin.js admin@ownerinc.local 'SENHA_COM_8_OU_MAIS_CARACTERES' 'Admin Local'
```

5. Acesse o Portal em `http://localhost:8080` e, se necessário, o Emulator UI em `http://localhost:4000`.
6. Consulte os logs com `docker compose --profile local logs -f`.
7. Encerre com `docker compose --profile local down`.

Não use `docker compose down -v` se precisar preservar o banco e os uploads.
O perfil `local` publica o Auth Emulator apenas no loopback da máquina e não usa o projeto Firebase real.

## Integração Sólides

A integração permanece oculta por padrão com `SOLIDES_RELEASE_STAGE=off`. Para
homologação interna, configure o token somente no `.env` ignorado e use:

```text
SOLIDES_RELEASE_STAGE=internal
SOLIDES_TOKEN=<token de integração>
SOLIDES_EMPLOYER_BASE_URL=https://employer.tangerino.com.br/
SOLIDES_PUNCH_BASE_URL=https://apis.tangerino.com.br/punch/
```

Recrie a API e use a tab Sólides no painel administrativo. O botão **Testar
conexão** executa apenas GETs e não exibe o conteúdo pessoal retornado. Para o
probe por terminal, defina também `SOLIDES_TEST_EMPLOYEE_ID` e execute
`npm run solides:probe`. Nunca registre ou compartilhe o token em logs, issues ou
mensagens.

Para encerrar a homologação, volte o estágio para `off` e recrie a API. Os
vínculos permanecem armazenados, mas todas as rotas de produto voltam a 404.

## Serviços Node isolados

O runtime atual dos manifests e imagens da API/cron é **Node 24**. Execute os
checks com esse runtime para reproduzir esta rodada. `AGENTS.md` ainda solicita
compatibilidade Node 18; a verificação em Node 24 não comprova compatibilidade
integral com Node 18, e essa divergência preexistente não foi resolvida alterando
engines, dependências ou instruções no lote de linguagem/documentação.

A API e o cron podem ser executados em seus diretórios com `npm install` e
`npm start`. Use `API_DATABASE_URL` como `DATABASE_URL` da API,
`CRON_DATABASE_URL` como `DATABASE_URL` do cron e execute `npm run db:migrate`
na raiz com `MIGRATION_DATABASE_URL` e as duas senhas de roles definidas.

## Verificação

Execute `npm run verify`. O comando não inicia containers nem altera
dados.

O verificador reúne sintaxe, testes, nomenclatura DHO, scanner de segurança e
validação read-only da configuração Compose quando disponível. Esse scanner
não é `npm audit`, e os testes com
doubles não substituem migrations, persistência ou jornadas reais no navegador.
Para conferir o shell gerado sem escrever arquivos, use
`node scripts/generate-public-shell.mjs --check`; confira também `git diff --check`.

### Persistência de enquetes Owner News

A migration `035_owner_news_polls` cria enquetes, opções e votos. A API recebe
SELECT/INSERT/UPDATE/DELETE nas três tabelas após o REVOKE do provisionamento;
o cron não recebe acesso. O banco garante uma enquete aberta por vez, posições
únicas de 0 a 5 por enquete e um voto por usuário/enquete. A FK composta impede
votar em opção de outra enquete. Totais são agregados dos votos, sem contadores
persistidos. A validação de 2–6 opções ao publicar e o lifecycle de votação
pertencem à camada de serviço.

Excluir um usuário remove seus votos e torna nulas as referências de autoria,
preservando enquetes/opções. Excluir uma enquete diretamente no banco remove
suas opções e votos; excluir isoladamente uma opção votada é bloqueado pela FK.
Esse schema não oferece uma rota de exclusão.

Em banco **local descartável**, configure `MIGRATION_DATABASE_URL`,
`MIGRATION_TEST_DISPOSABLE=true` e as senhas das roles; execute
`npm run test:migrations` e `node scripts/test-owner-news-integration.mjs`.
Os checks cobrem grants de API/cron, constraints reais, exclusões e operações
com `SET LOCAL ROLE portal_api` em transação revertida. Fixtures são sintéticas.

Resultados de homologação e aceites das correções de setembro estão no
[registro da sessão principal](../reviews/2026-09-29-portal-corrections-acceptance.md).
Uma fixture local aprovada não comprova produção, dados/cargos oficiais,
recebimento externo de e-mail ou uso em dispositivo físico. Operações Docker
que afetem serviços em execução continuam exigindo autorização explícita.

### Persistência da sessão editorial e autoridade Payload

A migration `036_payload_editorial_control` é aplicada pelo migrator do Portal,
inclusive após `schema.sql`. O provisionamento concede CRUD de
`cms_editor_sessions` apenas a `portal_api`, SELECT/UPDATE de `owner_news_authority`
à API e somente SELECT da autoridade ao cron. O singleton começa em `legacy`;
reexecutar a migration não muda modo, epoch, manifesto, autoria ou sessões.

O store faz limpeza de até 100 expirados na própria emissão, sem job adicional.
Os helpers e a ordem de locks estão no
[contrato de arquitetura](../architecture/overview.md#controle-de-sessão-e-autoridade-editorial-payload).
A Task 3 conecta a emissão/resolução/revogação de cookies, sem ativar a origem
Payload nos leitores. Veja o
[contrato de autenticação](../architecture/overview.md#autenticação-editorial-revogável-payload-task-3)
e o [README do CMS](../../cms/README.md#portal-authentication-boundary).
Configure `PORTAL_PUBLIC_URL` canônica e `PAYLOAD_TO_PORTAL_SECRET` na API para
usar a ponte; ausência dessas variáveis afeta somente as rotas editoriais. O
startup/rotas legadas continuam disponíveis. A página de entrada/saída e a
sincronização de contas entre abas são dependências explícitas da Task 9.

A correção local de 03/10/2026 torna a rotação atômica e serializa a única emissão
Firebase por UID usando estado compartilhado no PostgreSQL. Não espaçar chamadas
no teste para ocultar colisões: o oracle deve enviar requisições imediatas/concorrentes
e conferir hashes distintos, nova cookie200, anterior401 e rollback em falhas.
Há espera pré-emissão limitada; 503 por colisão/contensão não autoriza retry automático
nem significa logout confirmado. O import local confiável usa um processo separado
com `cms/src/payload.import.config.ts` e `createLegacyNewsArticle`; papel restrito,
`push:false` e migrations apenas CLI. Nunca habilitar a opção de IDs no adapter web
em execução. Ver [correções e evidência](../reviews/2026-10-03-payload-five-fixes.md).

Checks sem serviços:

```sh
node --test tests/unit/editorial-control.test.mjs tests/unit/schema-invariants.test.mjs
node --test tests/unit/editorial-session.test.mjs
npm --prefix cms run test:unit
npm --prefix cms run typecheck
npm --prefix cms run build
npm run verify
git diff --check
```

Para os checks reais, fornecer **duas bases vazias descartáveis autorizadas**, uma
por cenário, `MIGRATION_TEST_DISPOSABLE=true`, `MIGRATION_DATABASE_URL` e as senhas
`PORTAL_API_DB_PASSWORD`/`PORTAL_CRON_DB_PASSWORD` por ambiente privado. Nunca usar
produção. Em cada base, configurar `MIGRATION_TEST_SETUP=upgrade` ou `bootstrap`
e executar `npm run test:migrations`. O script recusa bases não vazias nesses
modos, roda o migrator duas vezes e verifica o ledger e grants reaplicados.
O upgrade conserva a fixture legada anterior à Academy e aplica também 034–036;
o bootstrap confirma que 036 e suas tabelas estavam ausentes antes do runner.

Ambos exercitam constraints, datas/defaults, unicidade de hash/singleton,
expiração inclusiva, revogação idempotente, lote de limpeza, cascata de usuário,
preservação de autoridade na exclusão do ator e reaplicação direta da migration.
Executam os helpers sob `SET LOCAL ROLE portal_api`, a leitura sob `portal_cron`,
e escritas proibidas reais, além de `has_table_privilege`. Fixtures de controle
editorial e alterações de teste são revertidas por transação.

**Pendente nesta entrega:** executar os dois cenários PostgreSQL; não houve
autorização para banco ou serviços Docker. PASS unitário/estático não comprova
constraints, locks concorrentes ou grants em um servidor PostgreSQL real.

### Overlay Payload (Task13)

O arquivo opcional `docker-compose.payload.yml` separa CMSDB, provisionador,
migrator, web e worker, com volumes próprios e imagem CMS comum. O parser pode
ser exercitado sem iniciar serviços:

```sh
docker compose --env-file .env.example -f docker-compose.yml -f docker-compose.payload.yml config --quiet
```

Placeholders servem somente a esse parse. Runtime requer configuração privada e
papéis provisionados. O primary coordena leases de build/serviços; não usar a
amostra ou seus volumes para ensaio de recuperação. CSP/Next produção, grants,
worker e restore reais continuam dependentes do ensaio autorizado. Contratos e
bloqueios em [Runtime e recuperação Payload](payload-runtime-recovery.md).
