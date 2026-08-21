# Integracao do Cards Pos ao Portal Ownerinc

Data: 21 de agosto de 2026
Status: aprovado pelo usuario

## Objetivo

Adicionar o projeto `C:\Ownerinc\projects\cards_pós` ao Portal Ownerinc como
uma pagina propria para criar, visualizar, salvar, duplicar, editar e excluir
convites de Pos-Vendas. A interface administrativa deve seguir o shell e os
padroes visuais do Portal, enquanto o convite exportado preserva a composicao
Owntime do projeto original.

## Acesso

O modulo tera uma politica propria, separada de `canUseAutoCard`:

- `canUsePosCards(user)` sera a unica funcao usada pela API e pela descoberta de
  navegacao.
- Enquanto os cargos de Pos nao forem definidos, usuarios com `role=admin`
  terao acesso temporario.
- A politica tambem tera uma allowlist vazia de cargos de Pos para ser
  preenchida posteriormente.
- Quando os cargos forem definidos, o bypass temporario de admin sera desligado
  em uma alteracao pequena e testada.
- Usuarios sem acesso nao verao o item de menu e receberao `403` em qualquer
  rota do modulo.

Ocultar o link sera apenas uma camada de UX. A API continuara sendo a barreira
real e consultara o usuario autenticado em cada requisicao.

## Integracao da aplicacao

- Criar `public/cards-pos.html` com o mesmo shell autenticado do Portal.
- Criar um modulo frontend isolado em `public/cards-pos/`.
- Migrar a estrutura do editor, preview, historico, upload e exportacao do
  projeto original sem transportar `server.mjs`, `cards.json` ou a API local.
- Criar o item `Cards Pos` no sidebar, inicialmente oculto, com visibilidade
  controlada pelo resultado de acesso retornado pelo backend.
- Reutilizar `public/css/tokens.css`, `layout.css` e `components.css` como base
  da interface administrativa.
- Preservar no preview o formato vertical do convite, a imagem de capa, os
  textos, o bloco de beneficios, os logos Owntime/Ownerinc/Casa e a exportacao
  para PDF.
- Substituir o carregamento de Raleway por uma fonte local disponivel no Portal
  ou por uma escolha ja aprovada pelo design system, sem depender de uma nova
  biblioteca de UI.
- Manter o layout editor + preview em telas grandes e empilhar os dois blocos
  em telas pequenas.
- Garantir skip link, labels visiveis, foco, alvos de toque, estados de
  carregamento/erro/vazio e `prefers-reduced-motion`.

## API e persistencia

O modulo tera rotas proprias em `/api/pos-cards` e armazenamento proprio para
nao misturar historicos, midias ou politicas com o AutoCard de DHO:

- `GET /api/pos-cards/access`
- `GET /api/pos-cards/cards?search=`
- `POST /api/pos-cards/cards`
- `GET /api/pos-cards/cards/:id`
- `PUT /api/pos-cards/cards/:id`
- `POST /api/pos-cards/cards/:id/duplicate`
- `DELETE /api/pos-cards/cards/:id`
- `POST /api/pos-cards/media`
- `GET /api/pos-cards/media/:id`

As rotas usarao `authMiddleware`, `canUsePosCards` e `withAudit`. O payload
aceitara somente o template `convite_owntime`, campos JSON objeto, nome entre 1
e 120 caracteres e imagem JPEG/PNG/WebP dentro do limite atual do Portal.

Serão criadas tabelas e constraints proprias para cards e midias de Pos,
incluindo UUID, timestamps, usuario de origem, tipo de conteudo, tamanho,
storage key e foreign keys. Os arquivos serao armazenados no volume de uploads
com chaves UUID que nao se confundam com as chaves do AutoCard.

## Migracao de dados

O historico existente em `C:\Ownerinc\projects\cards_pós\data\cards.json` nao
sera importado automaticamente nesta primeira integracao. A migracao deve
preservar o contrato novo do Portal e evitar inserir dados sem auditoria ou sem
um usuario autenticado de origem. Os assets estaticos do convite serao copiados
para `public/cards-pos/assets/` somente quando forem necessarios para o preview.

## Verificacao

- Testar `canUsePosCards` para admins temporarios, cargos futuros e usuarios
  comuns.
- Testar que a navegacao do modulo depende de `pos_cards_access`.
- Testar que todas as rotas e midias retornam `403` sem acesso.
- Testar CRUD, duplicacao, exclusao, busca e upload.
- Testar que a pagina sem acesso nao inicializa o editor.
- Testar caminhos de assets, exportacao PDF e layout mobile.
- Atualizar invariantes de migration, grants e limites de storage.
- Rodar `npm run verify` e `git diff --check`.

## Fora do escopo

- Definir agora os cargos finais de Pos-Vendas.
- Alterar o AutoCard existente ou sua allowlist.
- Criar uma biblioteca visual nova ou adicionar GSAP/React Bits ao modulo.
- Manter o servidor local do projeto original dentro do Portal.
