# Owner News — escopo aprovado

O usuário aprovou implementar a área completa, integrada ao shell do Portal,
substituindo Anúncios. Publicação contínua, destaque da publicação mais recente,
CMS existente e migração das 19 matérias publicadas observadas na referência
https://owner-news.ownerinc-developers.chatgpt.site/.

## Experiência

- Manter `announcements.html` como endereço compatível, com nome Owner News na
  navegação e no CMS. Evitar duplicar rotas e autenticação.
- Abertura editorial com matéria mais recente, editorias e cards com imagens,
  títulos e tempo estimado; detalhes com link direto `?id=UUID`.
- Filtro por editoria, paginação, estados vazio/erro/carregamento e teclado.
- Reutilizar blocos CMS e assets autenticados. Capa e resumo derivados do corpo
  publicado; tempo de leitura estimado a partir do texto.
- Manter sidebar desktop, drawer mobile e layout editorial responsivo.
- Publicação pelo Editor CMS com a permissão existente `manageKnowledge`.

## Dados e migração

O backend continua usando documentos `announcement`, revisões e assets CMS.
Listagem fornece filtros e categorias sobre conteúdo publicado validado, nunca
sobre rascunhos. A migração importa somente publicadas, preserva texto, autoria
e mídias em blocos compatíveis e precisa ser repetível sem duplicar documentos.
Não inserir conteúdo interno em arquivos públicos. O importador deve validar
URLs, MIME e limites, e documentar dependências de banco/armazenamento local.

## Limites

Não portar o segundo login, CMS monolítico, métricas demonstrativas, enquetes
efêmeras, edições numeradas ou controles de tipografia por fragmento.
Manter Node 18 e limites de serviço existentes; não alterar deploy.

## Verificação

Testes de filtros/publicação/autorização, transformação de conteúdo e navegação;
`npm run verify`, `git diff --check` e inspeção no navegador. Migração aplicada
e conteúdo apenas preparado devem ser reportados separadamente conforme evidência.
