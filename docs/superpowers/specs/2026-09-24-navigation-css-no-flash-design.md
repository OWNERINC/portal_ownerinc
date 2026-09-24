# Design: troca de CSS sem flash durante a navegação

## Objetivo

Eliminar o frame momentâneo sem estilos — fundo branco com tipografia e cores
do navegador — que aparece quando o usuário troca de módulo dentro do shell
persistente do Portal.

## Escopo

A mudança será restrita ao ciclo de estilos do roteador em
`public/js/router.js` e às regressões correspondentes em `tests/unit/`.
Navbar, sidebar, conteúdo dos módulos, URLs, autorização e contratos de API
não serão alterados.

## Comportamento aprovado

Durante uma navegação interna, o conjunto de folhas de estilo da página atual
permanece ativo enquanto as folhas da página destino são carregadas em estado
inativo (`media="not all"`). A troca só ocorre depois que todas as folhas
destino resolvem com sucesso:

1. preparar e carregar as novas folhas sem alterar a aparência atual;
2. desativar o conjunto anterior e ativar o novo conjunto no mesmo ciclo de
   atualização;
3. substituir o conteúdo e montar o módulo destino.

Em caso de falha no carregamento, as folhas atuais continuam ativas e a
navegação preserva o comportamento de erro existente.

A ocultação de `main[data-route-pending]` continua válida para a inicialização
do shell, mas não será usada para esconder a página já montada durante uma
troca interna.

## Abordagens consideradas

- **Troca atômica recomendada:** mantém o visual atual até os estilos destino
  estarem prontos e evita conflito entre páginas.
- **Overlay de carregamento:** esconderia o conteúdo com uma camada visual,
  mas mudaria a experiência aprovada e adicionaria uma superfície desnecessária.
- **Manter todas as folhas ativas:** reduziria o flash, mas permitiria
  conflitos entre estilos de módulos diferentes.

## Testes e critérios de aceite

- Uma navegação interna não deixa nenhuma folha previamente ativa com
  `media="not all"` antes de as folhas destino terem resolvido.
- Folhas destino permanecem inativas durante o carregamento.
- Uma falha de folha destino remove apenas o recurso falho do cache e mantém a
  aparência da página atual.
- `npm run verify` e `git diff --check` passam.
- O comportamento permanece compatível com o shell persistente e com a
  preparação assíncrona de scripts.
