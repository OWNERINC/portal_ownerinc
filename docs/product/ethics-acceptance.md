# Aceite obrigatório do Código de Ética

## Escopo

Todas as contas autorizadas a entrar no Portal devem aceitar o termo vigente:
usuários comuns, administradores e superadministradores, incluindo contas já
ativas. Não há bypass por cargo, permissões ou data de criação. Contas desativadas,
pendentes de aprovação ou de habilitação continuam bloqueadas; aceitar o termo
não concede permissões adicionais. No autocadastro com senha e aprovação, email
verificado deixou de ser requisito de admissão, mas o aceite do termo continua
obrigatório após a aprovação administrativa. O login encaminha a conta aprovada
sem aceite para a tela de Ética antes de abrir as áreas protegidas.

`api/ethics/term.json` contém o **Código de Ética e Conduta Ownerinc, versão 1.0,
2026**, com `mock: false`. O texto foi transcrito integralmente do DOCX fornecido:
mensagem institucional, 23 seções, dois anexos, controle do documento e três
tabelas. A única substituição textual aprovada foi o responsável pela governança
do canal na seção 18: o marcador `xxxxxxxxxxx` foi substituído por **DHO**.

O servidor calcula SHA-256 de todo o documento JSON, incluindo listas e tabelas.
Alterar o conteúdo ou a versão exige novo aceite. A versão demonstrativa anterior,
`mock-2026-11-v1`, não libera o documento oficial, mesmo quando o titular já usava o
Portal. Seus registros são preservados: um novo aceite acrescenta a versão 1.0,
sem atualizar ou excluir os anteriores. Isso vale também para admins e superadmins.

O texto mantém inclusive os campos impressos do Anexo I como conteúdo estático:
eles não são novos inputs, não recebem preenchimento automático e não afirmam
assinatura eletrônica. A confirmação continua vinculada à conta autenticada.

## Experiência

Após o login, `public/ethics.html` apresenta a área de leitura antes do acesso às
áreas do Portal. A checkbox fica desabilitada até alcançar o final do conteúdo.
Rolar ao final apenas habilita a escolha, sem marcar automaticamente. O botão
“Aceitar e entrar no portal” depende da checkbox marcada e da ausência de gravação
em andamento. Conteúdo integralmente visível não exige rolagem artificial.

A leitura aceita mouse, toque e teclado. A região tem nome acessível e foco; é
possível usar Ctrl+End e depois Tab/Espaço para confirmar. Chegar ao final não
comprova leitura, compreensão ou assinatura eletrônica.

Não existe opção de pular. “Sair da conta” encerra a sessão sem registrar aceite.
Falhas de consulta mantêm o bloqueio e oferecem nova tentativa. Falha de gravação
preserva a leitura e a escolha para retry explícito. Conflito de versão exige
recarregar, ler e confirmar o novo termo. A página só continua após confirmação do
servidor e nunca reutiliza uma resposta de outra conta.

## Contrato técnico

- `GET /api/users/me`: permanece disponível para bootstrap da sessão; retorna
  `ethics_accepted`, calculado no servidor para UID + versão + hash atuais.
- `GET /api/ethics`: exige autenticação e conta ativa; retorna `{ term, accepted }`.
- `POST /api/ethics/accept`: exige autenticação e corpo exato
  `{ version, contentHash, accepted: true }`. UID e data não são aceitos do cliente.
  Retorna `{ accepted, version, contentHash, acceptedAt }`.
- O middleware compartilhado bloqueia as demais rotas autenticadas com HTTP 403 e
  `reason: ethics-required` até existir aceite. Somente os métodos e caminhos
  exatos dos três endpoints de bootstrap acima são isentos.
- A camada frontend trata esse 403 como encaminhamento ao termo, não como logout.
  A navegação persistente e os acessos diretos aguardam a validação de perfil.
- O destino de retorno aceita documentos `.html` na mesma origem e aliases Pages
  estritos `/conteudos/<slug>` (ASCII minúsculo, 1–120 caracteres, hífens simples).
  Exclui login/termo/index/announcements, API/uploads, dotdot e separadores
  codificados; preserva query/fragmento. Destino inválido usa `/dashboard.html`.
- O estado no navegador nunca é autoridade para liberar API ou registrar aceite.
  Detectar rolagem é um requisito da interface, não uma evidência antifraude.

`ethics_acceptances` usa chave primária composta por usuário, versão e hash.
`accepted_at` vem do PostgreSQL; retries preservam a data original. O runtime da
API tem somente SELECT/INSERT; o cron não recebe acesso. Não há backfill: contas
antigas começam pendentes. Exclusão de usuário remove seus aceites em cascata.

O documento usa `preamble` e seções com blocos `paragraph`, `list` e `table`,
mantendo a ordem do DOCX. As tabelas preservam cabeçalhos semânticos de coluna
(seções 8 e 20) ou de linha (controle do documento). Conteúdo é renderizado
literalmente com `textContent`, nunca como HTML. Um bloco desconhecido interrompe
o carregamento, sem permitir aceitar um documento renderizado parcialmente.

As rotas públicas de cadastro, recuperação de senha e health checks permanecem
públicas com seus contratos atuais. O gate não protege HTML estático ou fotos de
perfil já públicas; ele impede montar conteúdo autenticado e usar funcionalidades
protegidas antes do aceite.

## Disponibilização

A migration `039_ethics_acceptances` precisa ser aplicada antes de executar a API
nova. O runner existente aplica migrations e provisiona os privilégios. A ausência
da tabela falha de forma fechada, sem liberar acesso. Não foram alterados scripts
de deploy, Nginx, cron ou serviços de produção nesta entrega.

A substituição do mock pela versão oficial **não exige nova migration** ou
limpeza de aceites. O mecanismo existente consulta a versão e o hash atuais.
O arquivo Word é a fonte textual, não é executado nem convertido por uma
dependência de produção. Elementos gráficos do papel timbrado não são copiados:
a tela mantém a identidade visual Conecta.

O PDF não é necessário nesta fase: o texto na página permite observar a rolagem
de forma consistente sem depender do visualizador nativo. Upload, gestão de
documentos, download de PDF e painel de relatórios de aceites estão fora do escopo.

## Verificação reproduzível

```sh
npm run verify
git diff --check
```

Os testes unitários executam as rotas e o middleware reais com transportes
substituídos. Cobrem os três perfis, contas sem aceite, validação de payload,
versão/hash, idempotência, isolamento entre contas, erros, guard de sessão,
rolagem, checkbox e retorno seguro.

`tests/fixtures/ethics-official-provenance.json` registra o SHA-256 do DOCX
original e o digest dos 148 textos normalizados (espaços/quebras de linha), na
ordem do arquivo, após a única correção autorizada de DHO. O teste de conteúdo e
o navegador comparam esse digest com o documento efetivamente apresentado.
`tests/fixtures/ethics-mock-v1.json` mantém a identidade exata do mock anterior
para testar reaceite e preservação do histórico, sem depender do arquivo externo.
O teste não modifica o DOCX original enviado.

Para testar no Chrome, instale Playwright e `@axe-core/playwright` fora do projeto:

```sh
PLAYWRIGHT_MODULE_PATH=/caminho/externo/node_modules/playwright/index.mjs \
AXE_MODULE_PATH=/caminho/externo/node_modules/@axe-core/playwright/dist/index.mjs \
node tests/visual/check-ethics.mjs
```

O script inicia e encerra seu próprio servidor loopback. Usa frontend, helpers de
autenticação, rotas e middleware reais, substituindo somente Firebase e transporte
SQL. Confere login, link direto, resposta de API, segundo contexto de navegador,
teclado, falhas/retries, conflito de versão, logout e troca de conta com gravação
pendente. Audita fidelidade textual, tabelas, reflow e WCAG A/AA em 320, 360, 402,
768, 1366 e 1920 px. Evidências
ficam em `opencode/ethics-acceptance` na pasta temporária; `VISUAL_OUTPUT` altera o
destino.

Para executar a migration e o serviço real em PostgreSQL WASM descartável, instale
`@electric-sql/pglite` externamente:

```sh
PGLITE_MODULE_PATH=/caminho/externo/node_modules/@electric-sql/pglite/dist/index.js \
node tests/database/check-ethics.mjs
```

Esse teste confere repetição da migration, ausência de backfill, constraints,
aceites por versão/hash, retries, privilégios e exclusão em cascata. Não substitui
o gate PostgreSQL 16 da CI, nem comprova integração Firebase/produção. Nenhum dos
testes acessa banco remoto ou precisa de credenciais de produção.
