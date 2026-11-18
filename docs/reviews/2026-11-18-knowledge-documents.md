# Documentos da Base de Conhecimento — evidências

## Estado

Implementação e pacote conferidos localmente em 18/11/2026. Publicação ainda
pendente nesta revisão. Especificação aprovada em
`docs/superpowers/specs/2026-11-18-knowledge-documents-design.md`.

## Conversão

Oito PDFs originais: **428.186.803 bytes**. Páginas WebP:
**207 páginas / 30.091.182 bytes**, além de oito capas. Todas as páginas possuem
texto extraível. WebP qualidade 88, lado maior até 2400 px; capas até 720 px.

| Documento | Páginas | Amostra com texto | ID estável |
| --- | ---: | ---: | --- |
| Apresentação geral | 68 | 4 e 8 | `75575632-48ab-5107-81c6-0ad0e8d9342c` |
| Garçom | 19 | 12 | `508e66aa-0191-57a8-9b48-b91a088041bd` |
| Motoristas | 21 | 16 | `b08a484e-07ec-5df8-a295-6b1cde9ae6a3` |
| Pós-venda | 20 | 12 | `08f75ba9-7100-5406-942b-cb30fe1f906e` |
| Promotores feminino | 21 | 14 | `ccbd3028-69e0-5692-848b-1093d1212f34` |
| Promotores masculino | 22 | 15 | `21d25505-58b6-569d-8ece-fe793dcd7353` |
| Recepção | 19 | 12 | `0eb7da63-dd99-5330-855d-7edd5809d66c` |
| Recreação | 17 | 6 e 12 | `5c3e5101-3246-50bd-b102-e1256b9003ac` |

Conferidos assinatura e SHA-256 dos originais, contagem com PyMuPDF e
decodificação integral de todas as imagens/capas com Pillow, incluindo dimensões,
bytes e SHA-256. Backend também leu e validou os 207 arquivos. Capas e amostras
de cada documento foram inspecionadas visualmente; texto pequeno permanece
legível em ampliação.

Os avisos MuPDF `No common ancestor in structure tree` ocorreram na marcação
estrutural dos originais; não impediram a geração. A conferência considera
imagens e texto efetivamente produzidos, não apenas o exit code do conversor.

Pacote/evidência local fora do Git:
`Temp/opencode/knowledge-documents-20261118/{sources,knowledge-private,import.json,verification.json}`.
Os SHA-256 completos ficam nos manifestos e em `verification.json`.

## SQL, arquivos e API

`tests/database/check-knowledge-documents.mjs` passou usando PGlite e os pacotes
reais, com Express, rotas e middleware reais:

- migration 043 aplicada duas vezes; artigo comum preservado;
- CHECK de descritores, dry-run sem escrita, nove artigos e uma auditoria;
- reexecução sem duplicatas e conflito com edição humana recusado;
- rollback atômico após falha no segundo INSERT;
- resposta perdida ao COMMIT com persistência e sem persistência; sem replay;
- 401 sem autenticação, 403 sem aceite e 200 para leitor admitido;
- manifesto, capa e página com cache privado; static privado negado;
- parâmetros inválidos rejeitados e edição comum preservando o descritor.

As identidades Firebase são sintéticas. PGlite é PostgreSQL-WASM, não o serviço
PostgreSQL 16 nativo; o CI continua responsável pelos gates nativos.

## Navegador

`tests/visual/check-knowledge-documents.mjs`: **12 cenários PASS**, Chromium,
API real, SQL PGlite e pacotes reais. Sem erros JavaScript.

- catálogo de nove posts e oito capas;
- 320/390/1366 px sem overflow horizontal;
- 68 páginas da apresentação na ordem, carregamento gradual, zoom real e ajuste;
- Escape retorna foco, blobs descartados ao sair;
- todos os oito PDFs, total e texto da página amostral;
- falha de imagem, retry e navegação durante carregamento;
- Código: 148 textos normalizados, digest
  `ed3b1e78e12b58c21630d000aabb4159d65b2dfbedc665870c798cbf0f27b468`,
  27 seções e três tabelas, iguais à proveniência oficial.

Capturas e `results.json`: `Temp/opencode/knowledge-visual-20261118-1`.
Viewport emulado não equivale a teste em aparelho físico.

## Checks e publicação

A primeira rodada completa detectou um teste legado que proibia qualquer
`fetchAPIAsset` em Knowledge, inclusive leitura privada nova. A asserção foi
ajustada mantendo as proibições de upload PDF/CMS legado. Rodada final:
**1.295 testes / 1.291 PASS / 4 SKIP / 0 FAIL**, `verify: ok`.
`npm run security` encontrou zero vulnerabilidades no escopo produtivo;
`git diff --check` passou.

Revisão independente read-only concluída sem achados P0/P1/P2 pendentes.
O revisor também executou os dez testes focais e SQL/API em Node 18.20.8 e
percorreu todas as 207 páginas em 320 px: 250 respostas de API, todas 200.
Conferiu proporção reservada de 244×137 CSS px para página 2400×1350.
A captura foi estabilizada esperando `decode()` antes do screenshot.

Base produtiva consultada: `dfe991db1a8aa89921262345ce72acee1279dd0e`,
igual a `origin/main`. Preparar candidato delimitado e registrar aqui a release,
backup, auditoria e conferência após a importação.
