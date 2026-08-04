# Integracao do AutoCard ao Portal Ownerinc

Data: 4 de agosto de 2026
Status: aprovado pelo usuario

## Objetivo

Integrar o AutoCard ao Portal Ownerinc como um modulo autenticado para criacao,
exportacao e historico compartilhado de cards internos. O modulo sera acessivel
somente por usuarios cujo cargo exato esteja na lista de DHO.

## Cargos autorizados

O acesso sera determinado pelo cargo relacionado em `users.job_title_id` e pelo
nome atual de `job_titles`, sem depender de tags ou de uma verificacao apenas no
frontend:

- `Analista de DHO`
- `Assistente de DHO`
- `Coordenador de DHO`
- `Gerente de DHO`

A comparacao ignora maiusculas/minusculas e espacos nas extremidades. Nao ha
correspondencia parcial. Um usuario com `role=admin` ou `superAdmin` mas sem um
desses cargos nao recebe acesso ao AutoCard.

Os quatro cargos antigos de RH serao renomeados em migration:

- `Analista de RH` para `Analista de DHO`
- `Assistente de RH` para `Assistente de DHO`
- `Coordenador de RH` para `Coordenador de DHO`
- `Gerente de RH` para `Gerente de DHO`

Se o cargo DHO ja existir, os usuarios do cargo RH serao reassociados ao cargo
DHO e o registro RH sera removido quando nao houver mais referencias.

## Integracao da aplicacao

- A interface sera migrada para `public/autocard/` e servida pelo Nginx do
  Portal.
- `autocard.html` usara o shell autenticado existente, skip link, menu mobile e
  estilos compartilhados sem expor a aplicacao a usuarios nao autorizados.
- O AutoCard deixara de usar `server.mjs`, `cards.json` e a API local separada.
- Templates, editor, biblioteca de icones/ilustracoes, variacoes visuais,
  upload de imagem e exportacao PNG serao preservados.
- O historico sera compartilhado por todos os quatro cargos autorizados.

## Autorizacao

O backend tera uma funcao unica de politica para determinar acesso ao AutoCard,
usada por todas as rotas e pelo endpoint de descoberta:

- `GET /api/autocard/access` retorna `{ allowed: true }` somente para cargos DHO.
- Rotas de cards e midias retornam `403` para qualquer usuario nao autorizado.
- A pagina e o link de navegacao sao escondidos para usuarios nao autorizados,
  mas essa camada e apenas UX; a API continua sendo a barreira real.
- A autorizacao consulta o cargo atual no PostgreSQL em cada requisicao atraves
  de `authMiddleware`, portanto uma troca de cargo tem efeito sem confiar em
  cache de sessao.

## Persistencia

Serão criadas duas tabelas:

### `autocard_cards`

- `id` UUID.
- `name` e `template` validados por allowlist.
- `values` JSONB com os campos do template.
- `icon`, `illustration`, `mode`, `variant` e `media_size` com limites/enums.
- `media_id` opcional referenciando uma mídia do AutoCard.
- `created_by`, `created_at` e `updated_at`.

### `autocard_media`

- `id` UUID.
- `filename`, `content_type` e `byte_size` validados no servidor.
- `created_by` e `created_at`.

Os arquivos serão armazenados no volume de uploads já usado pelo Portal, com
nomes UUID e acesso somente pelas rotas autenticadas do AutoCard. O endpoint de
mídia também verificará o cargo DHO antes de transmitir o arquivo.

O usuario de runtime `portal_api` receberá somente os grants necessários nas
duas tabelas. A migration sera registrada no ledger e verificada pelo script de
provisionamento.

## API

- `GET /api/autocard/access`
- `GET /api/autocard/cards?search=&template=`
- `POST /api/autocard/cards`
- `GET /api/autocard/cards/:id`
- `PUT /api/autocard/cards/:id`
- `POST /api/autocard/cards/:id/duplicate`
- `DELETE /api/autocard/cards/:id`
- `POST /api/autocard/media`
- `GET /api/autocard/media/:id`

Cards terao allowlist de templates ativos e limites para campos. Uploads
aceitarao JPEG, PNG e WebP, serao limitados por tamanho, validados por
assinatura e normalizados antes de persistir. Operacoes de escrita em cards
serao auditadas com o usuario autenticado.

## Testes e aceite

- Cargo DHO autorizado recebe `allowed=true` e acessa cards e midias.
- Cargo RH antigo, cargo nao relacionado, viewer sem cargo e admin sem cargo
  DHO recebem `403` depois da migration.
- A migration renomeia/reassocia RH para DHO sem quebrar foreign keys.
- Historico e busca retornam cards de todos os usuarios DHO.
- CRUD, duplicacao e exclusao mantem validacao, auditoria e escopo.
- Upload rejeita formato/tamanho invalidos e nao expoe arquivos a usuarios sem
  cargo autorizado.
- A navegacao nao apresenta AutoCard para usuarios nao autorizados.
- A pagina nao funciona por acesso direto quando a API retorna `403`.
- `npm run verify` passa com schema fresco, migrations, grants e testes de
  frontend.
