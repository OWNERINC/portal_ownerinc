# Home Editorial em Formato de Catálogo

Data: 25 de agosto de 2026
Status: proposta aprovada para implementação da prévia isolada

## Contexto

A home atual do Portal Ownerinc já reúne anúncios, lembretes, Academy e links
rápidos, mas a composição ainda se comporta como um dashboard funcional. A
direção aprovada transforma essa primeira tela em uma publicação interna: uma
capa editorial grande, trilhos de conteúdo e um diretório claro para as áreas
disponíveis.

O Portal continua sendo uma MPA estática, com o shell existente, autenticação
Firebase e autorização fornecida pela API. Esta etapa começa com uma prévia
isolada usando mock editorial para validar a experiência sem depender de sessão
ou de dados variáveis.

## Objetivos

- Dar à home uma entrada editorial forte, com uma capa visual grande.
- Organizar conteúdos em trilhos que convidem à leitura e descoberta.
- Expor as áreas funcionais em um diretório explícito, sem exigir swipe para
  descobrir uma ferramenta.
- Manter a identidade Ownerinc de preto, dourado e superfícies contidas.
- Entregar uma hierarquia equivalente em desktop e mobile.
- Preservar teclado, leitores de tela, foco visível e redução de movimento.

## Fora de Escopo

- Alterar autenticação, autorização ou contratos da API.
- Criar um novo CMS ou alterar a estrutura persistida dos conteúdos.
- Introduzir SPA, framework frontend ou dependência visual nova.
- Transformar a home em uma tela de métricas, gráficos ou KPIs.
- Substituir definitivamente as imagens de placeholder nesta prévia.

## Direção Visual Aprovada

### Revista assimétrica

A home usa uma grande capa editorial como primeiro campo visual. A capa tem
imagem em proporção fixa, tratamento escuro para legibilidade, título serifado
de alto contraste, resumo curto, metadados e uma ação primária para abrir o
conteúdo.

Os blocos seguintes são organizados nesta ordem:

1. Capa editorial principal.
2. Trilho "Também pode interessar" com cards de postagens.
3. Diretório "Acessar áreas" com cards funcionais.
4. Trilhos adicionais para Academy, anúncios ou lembretes quando houver dados.

No desktop, a sidebar existente continua persistente. No mobile, a capa ocupa a
largura disponível, os conteúdos editoriais usam trilhos horizontais com
`scroll-snap` e as áreas funcionais usam grid de duas colunas.

### Tipografia e cor

- Preservar os tokens de marca existentes em `public/css/tokens.css`.
- Usar a serifada apenas em títulos editoriais de capa e cards de leitura.
- Manter textos operacionais em sans-serif para leitura e navegação.
- Aplicar dourado como acento e ação, não como fundo de texto pequeno.
- Garantir contraste mínimo de 4,5:1 para texto normal e 3:1 para componentes
  e foco.
- Não usar emoji como ícone estrutural; reutilizar o sprite SVG existente.

## Componentes

### Capa editorial

Responsável por exibir uma publicação em destaque. Recebe título, resumo,
categoria, data ou duração, imagem, alt text e link. A imagem deve declarar
dimensões ou usar `aspect-ratio` para evitar deslocamento de layout. Se não
houver imagem, o componente usa uma superfície neutra com o mesmo espaço
reservado.

### Trilho de histórias

Responsável por uma coleção curta de cards editoriais. Cada card é um link
semântico, mostra thumbnail, título, categoria e metadado secundário. No
mobile, o trilho pode rolar horizontalmente, mas deve ter indicação visual de
continuação e não pode ser a única forma de acessar áreas funcionais.

### Diretório de áreas

Responsável por links para módulos como Academy, Base de Conhecimento,
Lembretes, Benefícios, Anúncios e Meu Perfil, além de módulos condicionais
como Admin, CMS, AutoCard, Cards Pós e Sólides. A visibilidade segue o mesmo
estado de autorização usado pelo shell e pela sidebar; a home não inventa
permissões.

### Estados

Cada bloco dinâmico precisa ter estados de carregamento, vazio, erro com retry e
conteúdo carregado. A prévia isolada usará conteúdo estático para que todos os
estados visuais possam ser revisados sem login.

## Fluxo de Dados

1. O shell inicializa autenticação e permissões como hoje.
2. A home monta a estrutura visual e mantém os espaços de imagem reservados.
3. Dados de anúncios, Academy e lembretes são convertidos em modelos de
   apresentação seguros antes de renderizar.
4. Conteúdo textual continua sendo inserido pelos helpers seguros existentes;
   não adicionar `innerHTML` para dados vindos da API.
5. Links externos passam por validação de URL e recebem
   `rel="noopener noreferrer"`.
6. Falhas de uma seção não impedem a montagem das demais seções.

## Acessibilidade e Responsividade

- Manter skip link e um único `h1` de página.
- Usar `h2` para títulos de trilho e diretório.
- Usar links reais para cards navegáveis, com nome acessível completo.
- Manter foco visível e ordem de tabulação igual à ordem visual.
- Garantir alvos de toque mínimos de 44 por 44 px.
- Respeitar `prefers-reduced-motion`; movimento não é necessário para entender
  o conteúdo.
- Testar em 320, 360, 390, 768, 1024 e 1440 px.
- Evitar scroll horizontal global; apenas trilhos editoriais podem rolar.
- Reservar espaço inferior quando controles fixos do mobile estiverem presentes.

## Performance

- Usar imagens de placeholder apenas na prévia; a integração real deve preferir
  WebP/AVIF e tamanhos responsivos.
- Aplicar `loading="lazy"` às imagens abaixo da capa.
- Declarar largura, altura ou proporção para thumbnails.
- Não adicionar biblioteca de carrossel; CSS e controles nativos cobrem o caso.
- Manter a capa como único asset crítico visual da primeira dobra.

## Limites de Implementação

- A prévia isolada deve ficar em uma página ou rota própria, sem substituir
  `public/dashboard.html` nesta primeira entrega.
- Reutilizar `public/css/tokens.css`, `public/css/layout.css`,
  `public/css/components.css`, `public/js/auth.js`, `public/js/ui.js` e o
  sprite `public/assets/icons.svg` quando a prévia deixar de ser estática.
- Não copiar imagens, CSS ou código dos sites usados como referência visual.
- A próxima etapa deve priorizar a composição e os contratos de componentes;
  não incluir refatorações gerais da home atual sem necessidade direta.

## Validação

- Abrir a prévia em desktop e mobile no navegador.
- Conferir que a capa é legível sobre as fotos de placeholder.
- Conferir que os cards funcionais permanecem visíveis sem interação horizontal.
- Conferir foco de teclado e nomes acessíveis.
- Conferir `prefers-reduced-motion`.
- Rodar `git diff --check` e `npm run verify` após qualquer mudança oficial no
  repositório.

## Critério de Aprovação

A prévia está pronta quando a direção C é reconhecível em uma tela, a capa
domina a primeira impressão sem virar um banner genérico, os trilhos comunicam
conteúdo editorial e todas as áreas principais continuam localizáveis em
desktop e mobile.
