# Marca PodFalar

SVGs originais fornecidos pelo usuário em 09/11/2026, da pasta corporativa
`RH/2026/PODE FALAR/Marca/SVG`. As cópias conservam os bytes, os viewBoxes,
os paths e as cores originais; não houve redesenho nem recoloração.

- `logo-horizontal.svg`: original `Pode_logo_hor.svg`, usado no botão do login.
- `logo.svg`: original `Pode_logo.svg`, assinatura completa alternativa.
- `symbol.svg`: original `pode_simb.svg`, símbolo isolado.

O login referencia a assinatura horizontal como imagem externa, com largura de
108 px e altura proporcional na parte inferior do cartão de acesso, fora dos
formulários. O botão conserva alvo mínimo de 48 px e nome
acessível “PodFalar (abre em nova aba)”. As classes internas dos SVGs não afetam
o CSS do Portal. As outras variantes ficam disponíveis sem serem exibidas no
login nem substituir a marca Conecta Ownerinc.

`tests/unit/podfalar-brand-assets.test.mjs` verifica a integridade SHA-256 das
três cópias e a ausência de conteúdo ativo ou dependências remotas.
