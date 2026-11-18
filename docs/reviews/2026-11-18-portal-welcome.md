# Boas-vindas e destaques institucionais — verificação

## Escopo

Especificação aprovada em
`docs/superpowers/specs/2026-11-18-portal-welcome-design.md`.
Base de produto: `31de9142`; branch de implementação `feat/portal-welcome`.

- Prioridade do Código na Base por descritor institucional.
- Capa local única reutilizada no Dashboard.
- Boas-vindas e atalhos explicativos conforme perfil validado.
- Academy temporariamente fora do menu e Dashboard.
- Manual administrativo Markdown/PDF reconciliado com a versão candidata.

## Prioridade e capa

Commit `a6e6f29`, revisão independente de conformidade e qualidade aprovada,
sem achados. A ordenação usa CASE explícito para incluir documentos NULL no
grupo comum; busca/categoria preservam a ordenação antes da paginação.

Evidências:
- `node tests/database/check-knowledge-priority.mjs`: PASS em SQL/API real com
  PGlite; prioridade, NULL/PDF, filtros, contagens, paginação, edição e autenticação.
- Três suítes Knowledge: 10 testes PASS.
- `node tests/visual/check-knowledge-documents.mjs`: 12 cenários PASS;
  capa/teclado/320/390/1366 px, oito PDFs, zoom, descarte, retry e paridade
  dos 148 textos, 27 seções e três tabelas do Código oficial.
- Pasta externa: `Temp/opencode/portal-welcome-task1-visual-final`.

## Verificação integrada

- Testes focais Dashboard/Academy/lifecycle: **95 PASS**, sem falhas ou skips.
- Build público e conferência dos HTMLs gerados: PASS.
- `node tests/visual/check-portal-welcome.mjs`: **6 cenários PASS**, zero
  erros JavaScript, sem overflow em 320/390/1366 px. Axe WCAG A/AA no `main`
  do Dashboard: zero violações e zero incompletos nas três larguras.
- Browser cobre nome literal, permissões leitor/admin/parcial, quatro atalhos,
  capa proporcional, teclado/foco, leitura oficial, Back real, evento
  `pageshow` persistido, erro isolado/retry/ausência, navegação durante consulta
  e busca sem forçar o Código em resultados incompatíveis.
- Academy continua acessível por endereço direto e aba administrativa;
  não há links ou requisições Academy originados pelo Dashboard.
- `node tests/visual/check-conecta-interactions.mjs`: PASS, **42 capturas**
  em 1920/402/360 px, sem erros JavaScript. Cenário antigo de cursos no Dashboard
  atualizado para erro/retry do Código.
- Evidência integrada: `Temp/opencode/portal-welcome-visual-20261118-r2`
  (`results.json`, `axe-*.json`, capturas Dashboard, estado indisponível).

A primeira execução integrada detectou uma fixture de permissões incompleta:
ela fornecia os flags finais, mas o middleware real os recalcula a partir do
cargo. A fixture foi corrigida para `job_title_active` e `job_title_access`;
a implementação da autorização não foi alterada. A segunda execução passou.

- `npm run verify`: **1.239 testes, 1.235 PASS, 4 SKIP, 0 FAIL**.
  Sintaxe, segurança e configuração: `verify: ok`. Log na pasta integrada.
  Reexecução sobre a entrega com manual final: mesmo resultado, registrado
  em `verify-final.log`.
- Revisão independente do Dashboard/menu: conformidade e qualidade aprovadas,
  sem achados. Implementação integrada registrada em `1a1dcee`.
- Revisão final do conjunto `31de9142..1a1dcee`: runtime aprovado, sem
  achados P0/P1/P2; revisão incluiu diff, testes, logs e capturas de 320 px e
  Dashboard administrativo em 1366 px. A conferência documental final é separada.

## Manual administrativo

- `docs/operations/manual-operadores.md` e PDF final de **20 páginas A4**,
  com 19 capítulos, sumário clicável e 38 links internos (entradas e retornos).
- Fonte reconciliada com a release candidata, incluindo boas-vindas, leitura
  recorrente do Código distinta do aceite, manuais WebP e Academy oculta.
- Instruções de edição da Academy e entrega de e-mails corrigidas conforme o
  comportamento atual, sem incorporar funcionalidades de branches não publicadas.
- `scripts/build-operator-manual.py`: geração local com PyMuPDF/fonttools;
  rejeita overflow e diretório de evidência existente, verifica texto e navegação.
- Geração final aprovada, texto integral e ordenado dos capítulos, destinos dos
  links/outline e limites de texto conferidos. Sem caracteres de substituição.
- Implementador inspecionou as 20 páginas; controlador conferiu as três folhas
  de contato e, em tamanho legível, capa/sumário, leitura do Código e consulta rápida.
- Originais do checkout `Consent-wall` preservados e conferidos por SHA-256.

Evidência: `Temp/opencode/portal-welcome-manual-20261118/final`
(`inspection.json`, `extra-checks.json`, texto extraído e PNGs).

PDF: 197.163 bytes; SHA-256
`4636715ab89e67c73fc83809a0123cfab7f2892601ecdbe688da328f8b09e796`.
Fonte Markdown: SHA-256
`d47527a591223173aeafe46dc437b38faf44a4f208f52b43d5e448dba9ea5110`.

Revisão documental suplementar independente **aprovada**, sem achados P0/P1/P2.
O revisor confirmou diretamente tamanho, hashes, páginas, outline e links do PDF,
comparou as instruções com o código e inspecionou as folhas de contato e páginas
7, 9, 10 e 20. Conformidade, qualidade e prontidão para integração do conjunto
final aprovadas.

## Limites

Execução local em Node 24; alterações JavaScript compatíveis com Node 18,
sem execução alegada em binário Node 18. Browser Chrome com viewports emulados.
Knowledge SQL/API em PGlite e autenticação Firebase sintética. Notificações e
dados Academy do cenário integrado são fixtures explícitas.
O retorno BFCache usa evento persistido simulado, além do Back real entre rotas.
A resposta tardia após navegação tem cobertura determinística nos testes
unitários/lifecycle; o cenário de navegador não espera explicitamente o término
da requisição retida.

A release produtiva permanece a publicada na entrega anterior. Esta atualização
tem autorização de implementação; publicação depende de decisão própria.
