# Importação privada da Owner News

Para o fluxo editorial revisado e o inventário parcial A1, consulte
[Preparação de pacotes privados](owner-news-bundles.md). O fluxo abaixo documenta
primeiro a aplicação A2; a seção **Importador legado** mantém o fluxo anterior.

## Pacote revisado — A2

`scripts/import-owner-news-bundle.mjs` aplica somente itens `approved`, com
procedência, decisões completas, EditorialV1 válido e mídias conferidas. As cinco
candidatas reais de A1 continuam `needs_review`; os 14 registros publicados
pendentes e o PDF adiado não foram aplicados, publicados ou retirados nesta etapa.
Uma decisão `exclude` de preparação não retira um documento existente. Retirada
exige um item separado `action: withdraw`, aprovado, com origem importada
identificada, decisão de exclusão e snapshot completo.

### Configuração e modos

Requisitos: dependências de `api/`, schema migrado e ator real do banco, habilitado,
administrador com permissão CMS `manageKnowledge` (ou superAdmin). O processo
confere banco/papel efetivos, permissões de cada operação e ausência de recovery.
Use Node 24 para os checks; o código novo usa APIs de Node 18, sem declarar
compatibilidade das dependências instaladas com esse runtime.

Forneça explicitamente, por ambiente privado:

```sh
export OWNER_NEWS_TARGET_DATABASE_URL='postgresql://USUARIO:SENHA@127.0.0.1:5432/portal_test'
export OWNER_NEWS_TARGET_UPLOAD_DIR='/privado/uploads-da-api'
export OWNER_NEWS_ACTOR_UID='uid-do-administrador'
node scripts/import-owner-news-bundle.mjs --bundle /privado/pacote/bundle.json
node scripts/import-owner-news-bundle.mjs --bundle /privado/pacote/bundle.json --apply-draft
node scripts/import-owner-news-bundle.mjs --bundle /privado/pacote/bundle.json --dry-run
# Após revisão explícita dos drafts:
node scripts/import-owner-news-bundle.mjs --bundle /privado/pacote/bundle.json --publish
```

Não usa `DATABASE_URL`, não carrega `.env`, não inicia serviços. A URL explícita
não aceita query/fragmento. Os guards locais do importador antigo são preservados.
O novo CLI admite destino explicitamente configurado; autorização de operação
local não autoriza executar contra produção. Esta implementação foi exercitada
somente no PostgreSQL isolado autorizado.

`--bundle` é absoluto, privado e limitado a 32 MiB. A raiz do pacote e uploads
precisam estar fora de checkouts Git/public, sem symlinks. O diretório de uploads
deve existir e ser o armazenamento real compartilhado com a API; cabe ao operador
confirmar o volume/mapeamento. O importador resolve `realpath` e usa somente
`cms-private/`. Não é feita uma chamada remota para descobrir ou confirmar o
volume da API.

Dry-run é o padrão: transação read-only/repeatable-read, sem escrita no banco ou
uploads. `--apply-draft` e `--publish` são exclusivos. Dry-run com conflitos retorna
contagens/códigos e exit 1. Erros de bibliotecas/DB não são reproduzidos: a CLI
emite somente códigos controlados, sem conteúdo, credenciais ou connection string.

### Reconciliação e hashes

O destino é encontrado por identidade determinística de documento/origem, compatível
com a importação anterior (`identity('document', external_id)`), nunca por título.
Colisão de título com outro documento bloqueia o pacote. Um `target: null` não
permite sobrescrever uma importação anterior: dry-run detecta o documento e exige
revisão da fotografia atual. Para obter uma variante privada, no mesmo diretório:

```sh
node scripts/import-owner-news-bundle.mjs --bundle /privado/pacote/bundle.json \
  --target-output /privado/pacote/destino.json
```

A saída é exclusiva (`wx`) e mantém os caminhos relativos das mídias. Apenas
targets nulos ainda não reconciliados recebem propostas; targets já aprovados e
expectativas anteriores de drafts aplicados não são rebaseados. Revise a variante
e execute novo dry-run antes de aplicar. O comando ainda retorna exit 1 pelos
conflitos do manifesto de entrada. Snapshots incluem os nove campos de target,
UUIDs canônicos minúsculos e timestamps ISO UTC completos; `source_id: null` é
preservado em mapeamentos explícitos de upsert. Withdraw requer origem identificada.

`bundle_sha256` cobre os bytes exatos do arquivo de entrada, inclusive espaços/LF;
`content_sha256` segue a serialização A1 excluindo somente target. Alterar apenas
target conserva o hash de conteúdo. Cada destino tem seu próprio hash do bundle;
execute dry-run na variante final para registrá-lo. Publicação exige a auditoria
de aplicação dos drafts com **os mesmos bytes**, revisão intacta e ponteiros ainda
compatíveis. Não reformate ou altere o manifesto entre apply-draft e publish.

Revisões são identificadas pelo checksum canônico de título, categoria, blocos e
EditorialV1 normalizados, após resolver `asset_key` para assets reais. Não persiste
UUID temporário da validação. Assets novos têm identidade por SHA-256. Reuso é
restrito às mídias de targets mapeados ou das mesmas fontes importadas, exigindo
hash/MIME/tamanho/arquivo compatíveis. Mídia privada de outra origem não é reusada
arbitrariamente. Arquivo existente ausente/corrompido e órfão com mesmo storage key
bloqueiam; não há reparo ou sobrescrita silenciosa.

### Atomicidade, publicação e recuperação

Cada pacote usa uma transação, advisory lock CMS `7193029`, documentos em ordem
de UUID, depois revisões/assets. Targets são relidos sob lock. Os mesmos limites
A1/CMS são aplicados antes da transação: 5 MiB por revisão, 50 MiB por asset,
300 MiB agregado; imagens decodificadas por sharp. PDF tem assinatura verificada,
vídeo tem assinatura de container; não há OCR nem validação integral de codecs.

Apply-draft mantém título/categoria/corpo publicados, cria revisão imutável e
atualiza apenas o ponteiro draft. Withdraw só é planejado nesse modo. Publish
promove somente drafts preparados, arquiva a publicação anterior e preserva sua
data; documentos novos recebem o horário de publicação no Portal. Data civil
editorial fica em `source_date`. Agendamento existente bloqueia upserts que
escreveriam. Um pacote já publicado, confirmado por corpo/status/identidade, é
somente leitura e preserva drafts/agendamentos posteriores.

Withdraw arquiva a publicação e o agendamento explicitamente fotografados, limpa
seus ponteiros/datas e preserva o draft posterior. Auditoria na mesma transação
registra hashes, fontes, revisões e draft preservado, sem corpo editorial. Retirada
repetida exige essa prova e os ponteiros/metadados preservados; drift bloqueia.

Arquivos novos usam `wx` e fsync antes do INSERT. Falha antes de enviar COMMIT
reverte todo o pacote e remove somente arquivos criados pelo run. Se a resposta
do COMMIT se perde, o resultado é `commit_outcome_unknown`: arquivos são mantidos,
nenhum sucesso é impresso. Execute dry-run com o mesmo manifesto para reconciliar
DB e hashes. Se o commit não ocorreu e restaram arquivos órfãos, investigue os
UUIDs e a ausência de linhas/referências antes de removê-los; não limpe o diretório.

O relatório separa `prepared`, `draftsCreated`, `published`, `withdrawn`, `existing`,
`assetsCreated`, `assetsReused`, `verifiedPublications` e `verifiedAssets`.
`verifiedAssets` confirma bytes privados no armazenamento, não um teste HTTP de
leitura autenticada da API. Esta etapa não declara publicação/leitura real das
candidatas A1 nem conclusão do acervo/PDF.

### Verificação A2

O teste real de `scripts/test-owner-news-integration.mjs` inclui duas matérias
sintéticas compartilhando um asset, apply/publish repetidos, CLI dry-run padrão,
papel `portal_api`, reconciliação legada, snapshot concorrente, schedule, corrupção
de revisão/arquivo, publicação alterada com draft intacto, retirada auditada,
preservação de source_id null, rollback por falha de auditoria e COMMIT realmente
efetivado cuja resposta foi perdida. Fixtures são limpas por IDs/diretório próprios.
Use apenas banco descartável explicitamente autorizado:

```sh
node --test tests/unit/owner-news-bundle.test.mjs tests/unit/owner-news-import.test.mjs tests/unit/cms-reader.test.mjs
node scripts/test-migrations.mjs
node scripts/test-owner-news-integration.mjs
npm run verify
git diff --check
```

Migrações/integração exigem `MIGRATION_TEST_DISPOSABLE=true` e
`MIGRATION_DATABASE_URL` explícitos. Na worktree autorizada, as duas execuções usam
o wrapper privado `run-local-check.mjs` de coordenação; credenciais não entram em Git.

## Importador legado

Suas regras de data e publicação não se aplicam ao pacote novo.

O importador lê somente `GET https://owner-news.ownerinc-developers.chatgpt.site/api/cms`
(`store.articles`) e as mídias referenciadas pelas matérias publicadas. Não salva
o JSON da origem no repositório. Não inicia Docker nem modifica serviços.

## Execução

Requisitos: dependências existentes de `api/` instaladas (`pg` e `sharp`),
schema CMS migrado, banco **local de desenvolvimento** e acesso ao diretório
real de uploads da API. Nenhuma dependência adicional é necessária. O código
do importador usa APIs disponíveis no Node 18; o manifesto atual de `api/`
exige Node 24 (incluindo sua versão de `sharp`). A execução verificada aqui
usou Node 24.15.0; compatibilidade dessas dependências no Node 18 não foi
validada nem seus manifests foram modificados.

Preparação sem banco, sem escrita de arquivos e sem publicação:

```sh
node scripts/import-owner-news.mjs --dry-run
```

O mesmo comportamento é o padrão quando nenhuma opção é fornecida. O comando
baixa, valida e mantém as mídias apenas em memória; informa contagens, sem
imprimir matérias, credenciais ou URLs de conexão.

Para conferir o destino e depois aplicar, configure no ambiente do processo:

```sh
export NODE_ENV=development
export OWNER_NEWS_DATABASE_URL='postgresql://USUARIO:SENHA@127.0.0.1:5432/portal_dev'
export OWNER_NEWS_UPLOAD_DIR='/caminho/absoluto/dos/uploads-da-api'
node scripts/import-owner-news.mjs --dry-run
node scripts/import-owner-news.mjs --apply
node scripts/import-owner-news.mjs --dry-run
```

No PowerShell, use `$env:NODE_ENV = 'development'` e atribuições equivalentes
para as outras duas variáveis. Forneça a credencial real por mecanismo privado;
os valores acima são exemplos. O script não carrega `.env` automaticamente e
não usa `DATABASE_URL` implicitamente. O hostname deve ser `localhost`,
`127.0.0.1` ou `::1`; o nome do banco deve conter um segmento `dev`,
`development`, `local` ou `test`. Opções na query da URL são recusadas. Não use
túnel para produção: loopback deve apontar ao PostgreSQL local confirmado.

`OWNER_NEWS_UPLOAD_DIR` deve existir e corresponder ao `UPLOAD_DIR` da API;
o importador cria apenas `cms-private/`, com arquivos nomeados por UUID, fora
de `public/`. Montagens de containers precisam apontar ao mesmo armazenamento.
Não há autorização implícita para iniciar/recriar containers ou mudar volumes.

## Contrato e segurança

- Exige exatamente 19 matérias publicadas; ignora rascunhos, edições, enquetes,
  módulos de home e mídias sem referência. Matérias de teste que a origem
  publicou são preservadas, sem decisão editorial automática.
- Ordem: capa, resumo, autoria, data, blocos originais. Parágrafos e quebras
  permanecem legíveis, imagens inline mantêm posição, citações conservam
  atribuição e perfis conservam imagem, nome, cargo e texto. Para perfis/imagens,
  `image` tem precedência sobre o campo auxiliar `url`, conforme o renderer da
  origem. Variantes `html`, `titleHtml`, `excerptHtml` e `captionHtml` têm a mesma
  precedência da origem e são convertidas para texto; legendas são preservadas.
- Remove marcação HTML; nunca entrega HTML arbitrário ao CMS. Conteúdo convertido
  passa pelo validador real de blocos. Tipos desconhecidos ou conteúdo inválido
  interrompem a importação, em vez de serem silenciosamente omitidos.
- Preserva `publishedAt`. Quando ausente, usa `updatedAt` em português e inclui
  no corpo a identificação **Data da fonte (atualização)**. Datas sem horário
  são armazenadas às 12:00 UTC; não se inventa a data atual como publicação.
- URLs e cada redirect ficam limitados à origem HTTPS aprovada e aos caminhos
  `/api/cms`, `/api/media` e `/assets/`. Não aceita credenciais ou fragmentos.
  Há timeout de 60 s por resposta, máximo de três redirects, JSON de 5 MiB,
  mídia de 50 MiB e orçamento agregado de 300 MiB.
- MIME declarado deve concordar com assinatura binária e tipo do bloco.
  Imagens JPEG/PNG/WebP também são decodificadas por `sharp`, com limite de
  80 milhões de pixels. Vídeos MP4/QuickTime/WebM têm assinatura de container
  verificada; não há transcodificação ou verificação integral de codecs.
- Mídias entram em `cms_assets` com origem e SHA-256 no `metadata`; os blocos
  usam `asset_id`. Leituras continuam passando pela autorização CMS existente.
  Autoria editorial fica no corpo; não são criados usuários falsos para preencher
  `created_by`/`uploaded_by` (campos ficam nulos).

## Reexecução e falhas

UUIDs determinísticos separados para documento, identidade da origem, revisão
e URL de mídia evitam duplicação. O importador recusa colisões de identidade ou
título com outros anúncios. Documento já importado deve manter conteúdo,
categoria, data e revisão publicados idênticos; alterações na origem ou no
Portal exigem revisão manual. Nunca sobrescreve uma publicação existente.
Mídias existentes também são conferidas por metadados e hash do arquivo privado.

A aplicação inteira usa uma transação e o mesmo advisory lock da retenção CMS.
Arquivos são criados exclusivamente (`wx`), sincronizados antes do commit e
removidos se a transação falhar antes da tentativa de commit. Uma resposta de
commit perdida é ambígua: arquivos são mantidos para não quebrar referências
que podem já estar publicadas. Execute dry-run com banco para reconciliar.

Interrupção abrupta do processo pode deixar arquivos privados sem linha no banco.
Uma nova aplicação recusará sobrescrevê-los. Antes de removê-los manualmente,
confirme pelo UUID que não existe `cms_assets.id`/`storage_key` correspondente,
que não há importação em andamento e que o commit anterior não foi efetivado.
Nunca limpe o diretório inteiro nem remova arquivos de outras importações.

O resultado JSON distingue `prepared`, `applied`, `existing`, `media`,
`databaseChecked` e, após aplicar, `verifiedPublications`/`verifiedAssets`.
Dry-run sem banco não comprova publicação, colisões ou integridade no destino.

## Evidência desta implementação — 22/09/2026

Preparação real concluída: **19 publicadas**, **1 rascunho ignorado**,
**24 mídias únicas**, **41.910.710 bytes** validados.
Nenhum conteúdo ou mídia foi gravado em `public/` ou incorporado ao Git.

Na primeira tentativa, aplicação bloqueada pelo ambiente: Docker Desktop Linux Engine indisponível
(`docker ps` não conectou ao named pipe); nenhum listener local nas portas
5432, 5433, 3000, 8080, 4000 e 9099; nenhuma `DATABASE_URL` configurada nesta
sessão. Falta um banco local confirmado, migrado e acessível, suas credenciais
e o caminho compartilhado de uploads. Nenhum serviço foi iniciado para contornar
esse bloqueio e `--apply` não foi executado contra um destino não confirmado.
A tentativa local de `--apply` foi interrompida pelo guard de configuração,
antes de baixar conteúdo ou abrir uma conexão com banco.

Após autorização explícita para iniciar Docker Desktop e a stack local, a
aplicação foi concluída no projeto Compose `ownerinc-owner-news-local`:

- PostgreSQL 16.14, banco `portal_local`, confirmado por consulta dentro do
  container `ownerinc-owner-news-local-postgres-1`; migrações encerradas com código 0.
- API, cron, PostgreSQL e Auth Emulator saudáveis; Nginx em `http://localhost:8080`.
- Configuração exclusivamente local em arquivo temporário fora do repositório;
  `.env` do usuário preservado. Auth usa emulator; SMTP aponta para loopback.
- Importador executado como usuário `node`, compartilhando o namespace de rede
  do PostgreSQL (loopback real) e o volume `ownerinc-owner-news-local_uploads_data`
  montado em `/app/uploads`, exatamente como a API.
- Resultado: `applied=19`, `verifiedPublications=19`, `verifiedAssets=24`.
- Reexecução dry-run: `existing=19`, `applied=0`, `databaseChecked=true`, com
  conferência dos hashes dos 24 arquivos privados.
- Leitura autenticada de **24/24 assets via `/api/cms/assets/:id`**, HTTP 200,
  totalizando **41.910.710 bytes**.
- Administrador local provisionado pelo helper `create-local-admin.js` com
  perfil Compose `tools` (nome efetivo em `docker-compose.yml`). Credencial não
  registrada nesta documentação.
- Browser visível: login, Dashboard, lista Owner News e abertura da matéria
  “Propriedade compartilhada: por que tanta dúvida?” funcionaram.
- A medição inicial do painel embutido retornou largura inconsistente. A
  verificação independente no Edge, com viewport real de 1440 × 900, confirmou
  área principal de 1189 px e composição desktop correta. Capturas também
  conferidas em 390 e 320 px, sem transbordamento horizontal.
- Smoke autenticado passou: imagens privadas, filtro Saúde, destaque global
  preservado ao filtrar, detalhe com ID, voltar, paginação de 10/9 matérias e
  ausência de erros JavaScript após login. A URL foi aberta também no navegador
  padrão do Windows, além do painel OpenChamber.

A primeira subida usou `ownerinc-portal-local`, cujo volume preexistente recusou
a senha local. Os containers criados nessa tentativa foram removidos sem `-v`;
o volume anterior foi preservado. Uma tentativa do importador sem montagem de
`/public` falhou com `ENOENT`, antes de conectar ao banco; a montagem read-only
resolveu a verificação do diretório público. Duas tentativas de invocação de
`su` não executaram a importação; a forma válida é
`su -s /usr/local/bin/node node -- /scripts/import-owner-news.mjs --apply`.
Um probe HTTP inicial usou `/api/cms-assets/:id` e recebeu 404; o endpoint
correto acima passou integralmente.

O runtime efetivo da stack é **Node 24.12.0**, conforme os Dockerfiles existentes.
O requisito solicitado de Node 18 **não foi atendido nem validado** nesta operação;
nenhuma dependência ou arquivo frontend/backend foi alterado para isso.

Os testes específicos cobrem conversão, HTML, datas, MIME/decodificação, redirects,
limites, idempotência, colisões, rollback de arquivos e commit ambíguo.
O harness antigo de Anúncios foi atualizado para as novas dependências e
inicialização. Verificação global final: **464 testes passaram**, nenhum falhou;
`npm run verify` e `git diff --check` concluídos com sucesso. Uma regressão
adicional garante que reconciliação recuse assets ausentes quando referenciados
por uma publicação já importada, sem confundir com assets de novas publicações.

Verificações reproduzíveis:

```sh
node --test tests/unit/owner-news-import.test.mjs
node scripts/import-owner-news.mjs --dry-run
npm run verify
git diff --check
```
