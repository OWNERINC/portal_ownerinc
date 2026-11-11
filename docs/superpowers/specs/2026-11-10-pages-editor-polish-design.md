# Polimento visual do editor de Pages

## Aprovação

Em 10/11/2026 o usuário apontou botões fora do padrão e falta de alinhamento.
Após inspeção do editor local, aprovou no formulário a direção
**Polimento completo do editor (recomendado)**: controles, alinhamento,
espaçamento e organização visual, com ajustes localizados de CSS e markup.

## Diagnóstico observado

- Selects permanecem com borda/tipografia nativas, diferentes dos inputs.
- O handle de arraste substitui as classes padrão do botão e parece um controle do navegador.
- Ações de seção/linha são anexadas sem uma barra flex/grid e ficam coladas.
- Metadados, status, ferramentas contextuais e ações não têm hierarquia consistente.
- Controles técnicos como `two_equal`, `rich_text` e presets em inglês não ajudam a leitura.

## Direção aprovada

- Preservar a identidade Conecta: Manrope local, índigo `--primary`, laranja
  `--accent`, fundos/superfícies claros e bordas discretas dos tokens existentes.
- Cabeçalho com breadcrumb/título à esquerda e status/ações agrupados com wrap
  previsível. Distinguir salvar/publicar de arquivar/recarregar sem esconder funções.
- Grade de metadados alinhada, com alturas consistentes e resumo com espaço suficiente.
- Modos Editar/Prévia desktop/Prévia mobile como grupo coeso e seleção clara.
- Seção e linha com cabeçalhos próprios, controles compactos e gaps uniformes.
- Blocos com handle discreto, seleção nomeada, foco visível e conteúdo bem separado dos controles.
- Ferramentas contextuais agrupadas por movimentação, apresentação e formatação.
- Botões, selects, upload, inputs e textos auxiliares com tamanhos e estados consistentes.
- No mobile, campos/ações empilham sem overflow; alvos continuam pelo menos 44×44 px.

## Fronteiras e preservação

Somente editor e componentes Pages necessários. Não redesenhar o shell, catálogo,
conteúdo publicado ou demais produtos. Não alterar backend, banco, permissões,
schema, payloads, conteúdo do usuário, workflows de publicação ou arquivos históricos.
Manter IDs, accessible names usados por automação quando possível, guardas, CAS,
snapshot/retry, instâncias ProseMirror e ciclo de vida de arraste/mídias.
Sem bibliotecas/fontes/assets novos, commit, merge ou deploy.

## Aceite

Conferir editor vazio/selecionado, duas colunas, campos de botão/mídia e prévias em
360, 402, 768, 1366 e 1920 px. Verificar reflow, alinhamento geométrico, estilos
computados, foco/teclado e axe. Repetir verificadores do primeiro lote e piloto,
`npm run verify`, bundle/shell/diff e revisão fresca. Atualizar a prévia local
sem substituir o banco sintético em uso ou descartar edições locais do usuário.
