# Owner News — construção visual e fontes

Registro A3, 30/09/2026. Implementação integrada examinada em
`7bb0e0dc5d9edcd250b226c5b451a9790dc89594`.

## Construção conferida

O CSS privado da referência previamente coletado define papel `#f3f1ed`, tinta
`#141414`, Manrope para sans e DM Mono para metadados. Sua regra final de masonry
usa colunas com cards de proporções variadas; a enquete é um painel escuro e o
hero do artigo posiciona título sobre a mídia com contraste por degradê.

O Portal adapta essa hierarquia ao shell existente. A inspeção de capturas
sintéticas verificou abertura grande, categorias, mosaico com variação de altura,
enquete com resultados persistidos e reader com título sobre capa, lead serif,
dupla left/right, imagem larga, perfil, citação e final. Sem capa, a marca mantém
uma área editorial intencional. O título longo permanece dentro do hero.

Viewports efetivamente medidos: 1440×900, 1024×768 e 390×844. O main mediu
1204, 788 e 390 px respectivamente. No reader, left/right ficaram na mesma linha
nas duas larguras maiores e empilhados em 390 px. Não houve overflow horizontal
nesses estados. Capturas e medidas estão na evidência privada A3, não em Git.

O teste de escala usou `zoom: 2` no documento (200% CSS): verifica reflow, mas
não substitui zoom nativo, leitores de tela ou inspeção em aparelho físico.
A comparação é estrutural contra a referência coletada, sem declarar identidade
pixel a pixel ou aprovação de conteúdo real. Fotos sintéticas uniformes não
permitem avaliar a curadoria/recorte das cinco candidatas ainda pendentes.

## Tipografia e licenças

| Uso | Família | Distribuição e licença |
| --- | --- | --- |
| Títulos, UI e blocos sans | Manrope variável | `public/assets/fonts/Manrope-Variable.ttf`; SIL Open Font License 1.1 em `Manrope-OFL.txt` |
| Metadados | DM Mono Regular | `public/assets/fonts/DMMono-Regular.ttf`; SIL Open Font License 1.1 em `DMMono-OFL.txt` |
| Lead e blocos serif | Georgia, Times New Roman, serif | Fontes de sistema; nenhum binário Georgia/Times redistribuído pelo recurso |

Fontes oficiais Manrope e DM Mono, obtidas em 30/09/2026 e mantidas sem alterações:

- <https://github.com/google/fonts/tree/main/ofl/manrope>
- <https://github.com/google/fonts/tree/main/ofl/dmmono>

O navegador confirmou `Georgia, "Times New Roman", serif` nos parágrafos serif.
Os arquivos OFL acompanham as fontes locais. O Portal não depende de requisitar
essas duas famílias ao Google Fonts durante a leitura.

Detalhes funcionais, hashes dos assets sintéticos, limites e estado de publicação:
[aceite integrado A3](../reports/2026-09-30-owner-news-acceptance.md).
