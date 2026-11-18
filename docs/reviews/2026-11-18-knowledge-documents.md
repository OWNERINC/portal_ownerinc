# Documentos da Base de Conhecimento — evidências

## Estado

Publicado e verificado em produção em **18/11/2026 às 05:08 UTC**: nove posts,
207 páginas WebP e oito capas. Release
`31de9142b9ad5c8feef0d1754768f6b1ab3e938b`, [PR #103](https://github.com/OWNERINC/portal_ownerinc/pull/103).
Especificação aprovada em
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
igual a `origin/main` antes desta entrega. O candidato delimitado e a publicação
estão registrados abaixo.

### Candidato delimitado

Branch `feat/knowledge-documents`, baseada na release acima, recebeu somente a
especificação (`3802077`) e a feature (`ada60e9`, origem `cc41694`).
`npm run verify`: **1.234 testes / 1.230 PASS / 4 SKIP / 0 FAIL**.
`npm run security`: zero vulnerabilidades no escopo produtivo.
SQL/API/importação com os pacotes reais passou também neste candidato.

A primeira rodada visual do candidato encontrou HTTP 429. O diagnóstico
registrou 196 respostas estáticas e 110 respostas de API bem-sucedidas antes
do bloqueio: o harness encaminhava HTML/CSS/JavaScript pelo limitador da API,
diferentemente do Nginx produtivo. O checkout de desenvolvimento tinha uma
alteração anterior do limite que mascarava essa divergência do teste.

O harness foi corrigido para servir `public/` separadamente e encaminhar somente
`/api` e `/uploads` para a aplicação real, preservando o limite produtivo.
Passou nos **12 cenários**, com 186 respostas API 200, uma 503 deliberadamente
injetada para testar retry e nenhuma 429. Agora salva tráfego e diagnóstico
da página quando falha. Nenhuma mudança no limite produtivo foi necessária.

Evidências: `Temp/opencode/knowledge-visual-release-diagnostic-20261118` e
`Temp/opencode/knowledge-visual-release-final-20261118`. A rodada final conserva
os limites anteriores: Firebase sintético, SQL PGlite e viewports emulados.

## Publicação produtiva concluída

O [workflow 44241073670](https://github.com/OWNERINC/portal_ownerinc/actions/runs/44241073670)
concluiu `validate` e `Deploy production` com sucesso. Incluiu PostgreSQL 16
nativo, migrations fresh/upgrade/bootstrap/readiness, ensaio de recuperação,
build, scans e imagens imutáveis. O receiver aplicou `043_knowledge_documents`
e confirmou `migration verification: current schema ok`.

O ponteiro `current-release`, a migration e os módulos do container foram
conferidos antes da importação. O script manteve o lock de deploy e exigiu a
release exata `31de9142b9ad5c8feef0d1754768f6b1ab3e938b`.

### Backup e integridade

- Backup adicional imediatamente anterior à importação:
  `/opt/ownerinc/backups/portal-ownerinc/knowledge/uniformes-20261118/attempt-20261118T050821Z-8VIKmg/postgres.dump`.
- Dump com inventário `pg_restore --list` conferido e SHA-256:
  `b5ada2cc3d8685007227280826f2f87a164f1a539ef7d7422d85400a8f8ef9a4`.
- Pacote transferido com 29.782.168 bytes e SHA-256:
  `1e5cfc4a3a43ed34baadddcd767fa18ecc3e0eb0608da24e7dd1ebcc06effa69`.
- Manifesto de importação produtivo SHA-256:
  `048f0f8ce08f138cf1d6347e2b08c82bfbffa4c3f975c9b2ec259f6df995fe83`.

A revisão operacional corrigiu previamente as permissões do diretório-pai
privado (`1000:1000 / 0750`) e a retomada do wrapper, com evidências por tentativa
e delta baseado no dry-run. A revisão incremental encerrou sem bloqueios.

### Resultado e preservação

Dry-run: `wouldCreate:9`, `unchanged:0`, sem escrita. Aplicação:
`created:9`, uma auditoria `knowledge.documents_import`, lote
`uniformes-20261118`. Nova conexão confirmou os nove registros, títulos,
categorias, descritores e disponibilidade dos oito PDFs. Os IDs dos PDFs constam
na tabela anterior; o Código institucional é
`ae3ca720-b9ba-5528-a27c-eefec1a44563`.

O processo Node do container leu e verificou todos os 207 WebPs e oito capas
pelos módulos produtivos, incluindo tamanhos, hashes e assinatura. A comparação
dos snapshots confirmou fingerprints idênticos para usuários, cargos, aceites,
AutoCard, Cards Pós, mídias, benefícios, Academy, notificações e Pages.

Código oficial preservado: versão `1.0`, `mock:false`, hash de conteúdo
`1d6b2211bea3920f8e0f2dc665483ea9f7010e695a55ce974f1fa94aa94ae1fb`.
Os oito aceites existentes permaneceram idênticos.

### Conferência HTTP e limites

- `/api/health` e `/api/ready`: 200, estados `ok` e `ready`.
- HTML, CSS e módulos Knowledge publicados: 200 e bytes iguais ao candidato.
- Manifesto, capa e primeira página dos oito PDFs: 401 sem autenticação.
- Tentativas de acessar os pacotes por `/uploads/knowledge-private`: 404.
- `/api/ethics`: 401 sem autenticação.

Não foi usada sessão Firebase produtiva para uma nova leitura visual no browser.
A evidência visual é do candidato exato com identidades sintéticas; a conferência
produtiva cobre release, banco, arquivos, integridade, proteção HTTP e saúde.

Evidências locais: `Temp/opencode/knowledge-publish-20261118`, incluindo
`workflow-result.json`, `deploy.log`, `preflight.log`, `publication.log`,
`before.json`, `after.json`, `dry-run.json`, `import-result.json`,
`manifest.sha256` e `public-verification.json`.

Acesso: https://portal.ownerinc.com.br/knowledge.html.
