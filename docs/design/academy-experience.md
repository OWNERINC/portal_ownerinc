# Ownerinc Academy: identidade e movimento

## Origem e entrega

Fonte editorial: `ownerinc academy + manifesto.pdf`, 15 páginas, revisadas em
30 de setembro de 2026. O arquivo `ACADEMY_V8.ai` permanece como original de
autoria; a extração usa o PDF fornecido, sem redesenhar curvas ou redistribuir
os documentos originais. O SHA-256 dos bytes do PDF está em
[`public/assets/academy/manifest.json`](../../public/assets/academy/manifest.json).

As páginas 1–7 definem marca, manifesto, ícones, grid, versões positiva/negativa,
tipografia e cores. As páginas 8–9 mostram composição modular e peças gráficas;
10–12 aplicam a identidade a caneca, caderno e banner; 13–14 mostram referências
digitais e materiais de aprendizagem; 15 aplica a marca a camisetas. Os mockups
são referências visuais, não contratos de funcionalidade do Portal.

## Contrato dos vetores

Os nove SVGs em `public/assets/academy/` usam geometria vetorial original
exportada pelo PyMuPDF. `d`, `transform` e `fill-rule` dos paths permanecem
intactos; somente a cor de preenchimento é normalizada. Cada path está em um
`<g data-part="N">`, permitindo animar o grupo sem alterar a transformação do
path. O recorte usa a união dos bounds originais com margem de 2 unidades.

| Chave | Página (1-based) | Seleção de paths | Partes | Preenchimento |
| --- | --- | --- | --- | --- |
| `symbol` | 3 | `#97c21e`, índice 0 | 1 | `currentColor` |
| `icon-01` | 3 | `#97c21e`, índices 1:3 | 2 | `currentColor` |
| `icon-02` | 3 | `#97c21e`, índices 3:5 | 2 | `currentColor` |
| `icon-03` | 3 | `#97c21e`, índices 5:7 | 2 | `currentColor` |
| `icon-04` | 3 | `#97c21e`, índices 7:9 | 2 | `currentColor` |
| `icon-05` | 3 | `#97c21e`, índices 9:11 | 2 | `currentColor` |
| `icon-06` | 3 | `#97c21e`, índices 11:13 | 2 | `currentColor` |
| `logo-dark` | 1 | 16 paths `#141414` | 16 | `#141414` |
| `logo-light` | 1 | mesmos 16 paths | 16 | `#F6FAF5` |

Os intervalos são zero-based e excluem o limite superior. O manifesto registra
`source_sha256` e, por asset, `key`, `file`, `page`, `viewBox` e `parts`.
O extrator rejeita contagens diferentes de 13 formas verdes ou 16 formas da marca.
Trocas do PDF exigem nova revisão visual: contagens sozinhas não comprovam identidade.

### Reprodução editorial

Python com PyMuPDF é necessário apenas na preparação (extração revisada com
PyMuPDF 1.27.2.3). Na raiz do repositório:

```sh
python scripts/extract-academy-assets.py --source "/caminho/ownerinc academy + manifesto.pdf" --output public/assets/academy
node --test tests/unit/academy-assets.test.mjs
npm run verify
```

A aplicação serve apenas os arquivos finais. Não requer Python no servidor,
dependências de frontend, imagens rasterizadas ou fontes retiradas do PDF.

Na aplicação, `public/academy/brand.js` carrega exclusivamente os nove arquivos
do manifesto, valida o SVG antes de inseri-lo inline e clona os vetores sem IDs
duplicados. As telas mantêm um fallback `<img>` enquanto os arquivos locais são
carregados; quando disponíveis, marca, capas e ícones passam a usar os grupos
inline originais. `public/academy/motion.js` limita a entrada e a confirmação a
`transform`/`opacity`, cancela animações no `AbortSignal` e aplica a composição
final quando o usuário prefere movimento reduzido.

## Linguagem visual

- Paleta Academy: **#97C21E**, **#F6FAF5**, **#141414**.
- Direção tipográfica: Helvetica Bold/Light; pilha `Helvetica, Arial, sans-serif`.
  Não incorporar WOFF2 sem arquivo web autorizado. O logotipo vetorial preserva
  o lettering original; nenhum arquivo de fonte foi extraído para redistribuição.
- Manter proporções e espaços negativos, sobretudo o recorte central do símbolo.
- Símbolo e ícones herdam `currentColor` quando usados inline. Como `<img>`,
  `currentColor` não herda a cor do documento hospedeiro; usar a marca de cor fixa
  apropriada ou inline para controlar a cor.
- Marca escura sobre fundo claro; marca clara sobre fundo escuro. Verde é destaque
  gráfico, não texto pequeno sobre fundo claro.
- CSS da prancha é local a `.academy-reference`.

## Movimento

| Situação | Duração | Composição |
| --- | --- | --- |
| Entrada | 600 ms por peça, defasagem de 70 ms | Deslocamento horizontal ±6 px e vertical 4 px, rotação ±3°, escala .96 → 1 e opacidade 0 → 1. Ease-out `cubic-bezier(0.16, 1, 0.3, 1)`. |
| Foco/hover | 180 ms | Ênfase 1 → 1.015 → 1, ease-in-out. |
| Confirmação de conclusão | 450 ms | Escala 1 → 1.035 → 1, ease-in-out. |

Os seis ícones animam seus dois grupos, terminando a entrada em 670 ms.
Símbolo e logotipos movem-se como unidades: não escalonar as 16 partes do lettering.
Transformações uniformes, curtas e finitas; sem loops. Não usar movimento para
simular progresso real. Reproduzir novamente cancela a animação anterior;
nenhuma transformação persiste ao fim. As propriedades animadas são transform
e opacity, sem alterar layout ou geometria dos paths.

Com `prefers-reduced-motion: reduce`, não iniciar animação; apresentar a composição
final imediatamente. Mudanças da preferência cancelam também animações ativas.
O estado visual e os botões permanecem acessíveis por teclado.

## Prancha e revisão

Sirva a **raiz do repositório** por HTTP, por exemplo:

```sh
python -m http.server 8765 --bind 127.0.0.1
```

Abra `http://127.0.0.1:8765/docs/design/academy-assets.html`.
A prancha busca o manifesto e os próprios SVGs locais, sem cópias divergentes dos
paths. Os sete símbolos/ícones aparecem sobre fundos claro e escuro; as duas
marcas usam o fundo correspondente. Há reprodução geral de entrada/conclusão e
individual de entrada. A prancha é documentação editorial, não rota do produto.

Revisar recortes internos e composição final contra as páginas 1, 3 e 5 do PDF;
conferir desktop/mobile, foco por teclado, interrupção/reprodução e preferência
de movimento reduzido. O teste automatizado cobre integridade, metadados e
ausência de conteúdo SVG ativo ou imagens externas; aparência é revista no navegador.
