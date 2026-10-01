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

A migration `034_owner_news_polls` cria enquetes, opções e votos. A API recebe
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
