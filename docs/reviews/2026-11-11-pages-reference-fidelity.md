# Pages — garantias da correção de referência

## Atualização: aceite da prévia em 16/11/2026

O usuário aprovou no formulário comparativo das seis telas: **“Prévia aprovada
com diferenças descritas; sem autorização de deploy”**, sem observações adicionais.
O aceite abrange as diferenças visuais explicitadas na apresentação (marca,
ícones/controles nativos, tipografia e cores), não igualdade de pixels.

A implementação passou por revisão independente das tarefas e revisão ampla;
a correção final da pré-validação v3 passou por nova revisão. Último verify:
1.167 testes, 1.165 aprovados, zero falhas, dois skips de plataforma. Evidência
funcional final: `.superpowers/sdd/2026-11-11-pages-editor-reference-fidelity/final-fix-report.md`.

As capturas e resultados originais são preservados: `NOT_ACCEPTED` nos resultados
automatizados continua indicando divergência estrita de pixels, não ausência do
aceite humano agora registrado. Menções abaixo a aceite pendente descrevem o
estado das respectivas rodadas, anterior a esta decisão.

**Não houve autorização de integração ou publicação.** Gates nativos de PostgreSQL
16, concorrência/restore, Linux/Nginx e validações físicas continuam pendentes;
esta aprovação não os converte em PASS. Alterações permanecem locais, sem deploy.

Consolidação Task 17, executada em 12/11/2026 sobre o checkout não commitado das
Tasks 1–16. Este documento não modifica o histórico de deploy e não aceita as seis
pranchas (Task 18). Nenhum dado/conta/banco de produção foi usado.

## Leitura dos estados

- **PASS:** comportamento observado no ambiente/comando declarado.
- **PENDING:** gate ainda não executado ou que depende de ambiente/aceite autorizado.
- **BLOCKED:** requisito completo impedido por limitação identificada, não convertido
  em PASS por mock, fixture ou inspeção de código.

## Task 18 — medidas corrigidas; pixels e aceite ainda em revisão

**WITH_CONCERNS / NOT_ACCEPTED.** A comparação das seis fontes foi implementada e
executada; não é mais um check apenas de screenshots. Na continuação autorizada,
CSS/UI de produção corrigem todas as32 falhas regionais,10 gaps e6 capitalizações
da primeira rodada. Não houve aceite do usuário. Revisão fresca de toda a Task18
e apresentação ficam com a sessão principal. A rodada inicial e suas falhas estão
preservadas no relatório e nas cópias pré-correção.

Fontes: `<temp>/opencode/editor-v2-reference/reference-{1..6}.png`, com os seis
SHA256 originais preservados no manifesto. Evidência final:
`<temp>/opencode/pages-reference-task18-fix-2-final-v2/`. `results.json` contém
paths/SHA completos de fonte e captura, retângulos esperados/DOM, deltas, gaps,
texto por região e diferenças de pixels. `artifacts.json` indexa os hashes de todos
os artefatos gerados. Seis capturas, seis overlays 50%, seis mapas absolutos e
108 pares de recortes regionais; estados adicionais de botões em `buttons-*.png`.
Logs e pacote incremental ficam em `.superpowers/sdd/2026-11-11-pages-editor-reference-fidelity/task-18-*`.

### O que a evidência comprova

- O runner exige fontes, saída nova externa, PNGJS externo, Playwright/PGlite e
  versão exata do Chrome. Os seis hashes/dimensões são conferidos antes da captura.
  Arquivo ausente, SHA diferente, tamanho errado ou saída existente são erro.
- Cada estado editor nasce de documento/contexto/namespace SQL novo, com viewport
  da fonte, DPR=1, fontes carregadas e seleção/scroll/foco registrados. Cada estado
  de botões usa nova página/contexto. Somente identidades sintéticas e loopback próprio.
- Botões são componentes reais de `public/pages/button.js` com CSS de produção,
  sem redefinir skin/largura para a captura. Salvo vem de ACK de save; upload tem
  ACK; loading retém resposta HTTP real de download e não permite clique duplicado;
  disabled bloqueia ações/requisições; foco por Tab tem outline2/offset2. A ação
  primária foca sua seção real na prévia. O vídeo
  foca consentimento do renderer, sem iframe ou claim de reprodução.
- Comparador puro separa geometria de pixels, exige cada região/âncora e mede gaps.
  Usa 2 px em frames e 4 px em controles. Qualquer pixel diferente fica para revisão;
  nenhum percentual global aprova o resultado. **Exit 1 com os seis resultados é
  reprovação de fidelidade, não erro a ser ignorado nem PASS parcial.**

### Correções mensuráveis da continuação

- Seleção de coluna inteira: o contorno real ocupa997px, com extensão lateral1.5px
  no gutter. As bordas dos drop targets permanecem; cards e fluxo vertical conservam
  suas medidas. O comparador continua medindo o DOM, sem inflar resultados.
- Inspetor desktop: campos37px, linha de rótulo17px, gaps16px e intervalo das
  amostras calibrado. Passo86px entre campos; Fundo→Tags89px. A deriva acumulada
  anterior de até24.1875px foi removida. Campos avançados conservam44px.
- Estilo: ritmo da paleta corrigido; Aplicar tem desenho **129×36px**, com extensão
  transparente de4px acima/abaixo, total44px. Hit-test e clique real no prolongamento
  são verificados; não se usa altura44 visível como exceção ao desenho36.
- Inserir: linhas64px, ícones16px, seis gaps48px; origens-fonte274/338/402/466/530/
  594/658 são verificadas com a tolerância4 existente. Texto, Imagem ou GIF, Vídeo,
  Áudio, Galeria e Duas colunas agora têm maiúscula inicial na UI de produção.
- As ações adicionais permanecem no diálogo rolável: FAQ, separador, escolha de
  destaque/botão e posição antes/depois. Tab/Enter e foco visível verificam acesso
  real aos extras. Não se comprime a lista principal para acomodá-los.

Asserções finais: **108/108 regiões,14/14 âncoras,34/34 gaps PASS**; texto:
**54/54 verificações visíveis e10/10 de DOM subjacente coberto PASS**, distinguidas no JSON;
zero falha geométrica/gap/capitalização. Os seis hashes das fontes e o hash do
manifesto são iguais aos da rodada anterior. As108 regiões ainda têm diferenças
de pixels; esse PASS de medidas **não** aceita nenhuma prancha.

A revisão tooling fixround1 invalidou a antiga interpretação de64 checks como
prova de texto visível: LABEL incluía opções não selecionadas e o inventário não
tratava clipping/closed details/oclusão. O runner corrigido extrai text nodes próprios,
confere valores em controles específicos e separa `text` visível de `underlyingDOM`.
A divisão40/24 da fixround1 foi invalidada na fixround2: modalidade bloqueia
interação, mas não pinta sobre todo o viewport. Nos painéis Estilo/Inserir, o backdrop
é transparente. Cabeçalho, inspetor, Em encontros, FAQ e áudio permanecem visíveis;
somente título da capa, título da introdução e No dia a dia têm glifos cobertos.
Na revisão, cabeçalho, inspetor, No dia a dia e FAQ permanecem visíveis através do
scrim40% da fonte; capa, introdução, Em encontros e áudio cruzam o painel opaco.
Cada requisito tem classificação/razão independente em `sourceTextVisibility`.
Os10 checks subjacentes exigem evidência de cobertura real pelo painel indicado,
nunca apenas bloqueio de interação. O coletor usa limites pintados do diálogo e
alpha do backdrop; refina interseções de envelopes de texto por ink de glifos.
Negativos escondem um requisito exposto e exigem FAIL mesmo sob diálogo modal.
O comparador possui contrato independente e exige todos os
pares `(region,text)` uma única vez, recalculando resultados sem confiar no `pass`
da captura. Negativos cobrem seleção errada, texto fechado/cortado/oculto, omissões,
duplicatas, região errada e sucesso forjado. A asserção de evidência exige34 gaps e
64 pares completos, além de recomputação idêntica. Nenhum novo erro de display foi
confirmado nesta rodada; fontes, geometria e aparência persistida permanecem iguais.

### Inspeção e divergências visuais sem dispensa automática

As seis sobreposições foram inspecionadas. Após as correções acima, permanecem:
wordmark local de glifos diferentes (Task14); métrica/contorno de texto e ícones
locais diferentes dos SVGs; chevrons nativos; tipografia/legendas com alinhamentos
e cores diferentes; amostra de fonte branca versus superfície cinza da fonte;
paleta do inspector com seis amostras versus cinco; layout de Opções avançadas.
No estado de edição, o foco real pode revelar o handle contextual ausente do SVG.
Não se atribui toda diferença a antialiasing.

Mobile mantém foreground canônico roxo versus cinza da fonte (Task16), e a capa
usa “no nosso dia a dia” versus “no dia a dia”. Revisão mostra UUID/revisão e
pendência reais no lugar da frase de protótipo, com Publicar disabled para o áudio
placeholder. A prancha de botões tem rodapé de proveniência verdadeiro no lugar do
rodapé do kit. Foco e hit-areas acessíveis podem exceder o desenho; isso é declarado,
não apagado dos pixels. Nenhuma dessas diferenças foi aceita em nome do usuário.

### Gates e próximos responsáveis

Os testes negativos do comparador e `npm run verify` passaram localmente; a
comparação visual termina **NOT_ACCEPTED** pelos pixels remanescentes. Consultar
o relatório Task18 para comandos, tentativas e hashes. Nesta continuação foram
reexecutados workspace15, estilo7, inserção/scroll/teclado/drag/persistência,
mobile8, revisão6, V2 em sete larguras e roundtrip integrado9. O pacote traz
diffs exatos de produção/testes/documentação contra snapshots pré-correção e
todo o escopo Task18 para revisão fresca. PG16/concorrência/dump/restore,
Nginx/Linux/Bash, Firebase real e aparelho/IME/toque/zoom físico seguem PENDING.
Writer default-off, leitor-primeiro, backup/restore e rollback compatível abaixo
continuam condições de um futuro rollout autorizado; não houve integração/deploy.

Base HEAD: `e78ca15c3ccaad4c7740e50185b2ee5a06919b7c`, com Tasks 1–16 e Task 17
não commitadas. Os hashes e diffs incrementais da Task 17 constam do review package.

Ambiente local: Windows, Node 24.15.0, Chrome headless **157.0.8103.51**, Express/SQL/arquivos
privados reais em PGlite descartável com conexões serializadas. Somente verificação
de token Firebase é substituída por identidades sintéticas; middleware de conta,
Ética, autoria, capacidades e cargo continua real. Nenhuma instalação ou serviço
existente é necessária. Os testes possuem e encerram seus listeners loopback.

Os comandos abaixo são relativos à raiz. Logs desta rodada ficam em
`.superpowers/sdd/2026-11-11-pages-editor-reference-fidelity/task-17-*.log`.
Artefatos em `<temp>/opencode/` usam os diretórios declarados abaixo, sem substituir
capturas anteriores. No ambiente da execução, `<temp>` é o temporário local do
usuário Windows. Pacotes externos são indicados por `PGLITE_MODULE_PATH`,
`PLAYWRIGHT_MODULE_PATH`, `AXE_MODULE_PATH`; originais por `PAGES_REFERENCE_DIR`;
FFmpeg/ffprobe por `FFMPEG_PATH`/`FFPROBE_PATH`. Nenhum segredo é exigido.

## Complemento autorizado — autoria de download/vídeo

**PASS local — lacuna de autoria fechada.** O mesmo inspector de botão agora
oferece download de mídia privada registrada e vídeo da página junto a URL/seção.
O módulo `editor-destinations.js` resolve alvos atuais, deriva kind do registro,
valida nome/extensão e aplica somente candidato válido, com opt-in/histórico v3
atômico. O writer permanece default off. A lista mínima do workspace contém apenas
IDs/kinds da própria página para seu autor autorizado; revisão alheia recebe `[]`.
Não há endpoint novo, alteração de storage ou ampliação de permissão.

Evidência nova, posterior à rodada inicial abaixo:

- `task-17-gap-focused-final.log`: **64/64 testes**, destinos, ciclo de vida real
  do editor, transações e rotas. Inclui quatro tipos, nomes inválidos, kind/alvo
  ausente/estrangeiro, v1/v2, gate, undo/redo, perda de capacidade, controls
  descartados, ACK sem colocação e exclusão de vídeo referenciado.
- `task-17-gap-db-v3.log`: **119 alias/categoria + 257 checks v3**. Acrescenta
  inventário same-page de uploads ainda não referenciados, DTO mínimo, exclusão de
  mídia de outra página e ausência do inventário para publicadores de outra autoria.
- `task-17-gap-db.log`: **75 checks HTTP v1 PASS**, reexecutados com o DTO atual.
- `task-17-gap-v2.log`: **10 cenários em sete larguras + 9 grupos integrados**.
  `pages-v2-task17-gap/feature-roundtrip/` contém payloads/SQL verificados, imagens
  e hashes legado. O teste cria os dois botões pela UI; download usa o ACK de um
  upload real feito na mesma visita. Depois de salvar/recarregar, verifica ações
  exatas e exerce download concluído e foco do consentimento na prévia e no leitor.
  Não prepara as novas ações pela API nem carrega iframe para simular reprodução.
- `task-17-gap-feature-final.log`: **9 grupos PASS** no estado final, após os
  refinamentos de refresh/aviso. `pages-feature-task17-gap-final/` conserva capturas
  de download/vídeo no inspector, prévia/leitor, payloads e hashes/computed legado.
- `task-17-gap-mobile.log`: **8 grupos**; `pages-mobile-task17-gap/`.
- `task-17-gap-media.log`: **5 grupos**, mídia/FAQ, fila/retry/replace, histórico,
  persistência e descarte de conta; `pages-media-task17-gap/`.
- `task-17-gap-build-pages.log` e `task-17-gap-check-pages-build.log`: build/check PASS.
- `task-17-gap-verify.log`: **1140 testes, 1138 pass, zero fail, 2 skips Linux
  existentes**, segurança/Compose e `verify: ok`. Posteriormente houve apenas
  indentação e duas capturas adicionais no teste integrado.
- `git diff --check`: **PASS**, registrado em `task-17-diff-check.log` na geração
  do pacote final.

O primeiro complemento integrado (`task-17-gap-feature.log`) falhou na asserção
de foco: o locator encontrava editor oculto e prévia. Foi restrito a `.pages-document`;
o V2 completo passou depois. Logs/capturas anteriores permanecem preservados.
`task-17-gap-before/` guarda cópias pré-edição, inclusive o relatório/pacote iniciais.
O pacote atualizado inclui os deltas exatos de ambas as rodadas e arquivos completos.

## Evidência da rodada inicial

- **PASS — API/banco v1:** `node tests/database/check-pages.mjs`, log
  `task-17-db-final.log`, **75 checks HTTP**. Middleware/SQL, revisão imutável, CAS/idempotência, autoria,
  cargos, auditoria e mídia privada. Não comprova Firebase produtivo.
- **PASS — API/banco v3:** `node tests/database/check-pages-v3.mjs`, log
  `task-17-db-v3.log`: **119 checks HTTP de alias/categoria + 252 checks v3**.
  `featureDocument` com imagem/galeria/GIF/MP3/MP4/download, projeção deduplicada,
  referências de outra página/kind negadas, writer default off, downgrade negado,
  400/403/404/409/413, rollback de auditoria/índice único, COMMIT real sem ACK,
  storage ausente, quotas históricas, publicação por cargo e rascunho posterior.
  413 JSON vem do parser real. `/uploads` retorna 404 neste harness sem mount;
  não é evidência de Nginx. Catálogo mostra somente título publicado, não o head
  de draft, e não lista draft alheio. Corrida UNIQUE é injetada, não concorrência.
- **PASS — fluxo integrado browser:** `node tests/visual/check-pages-v2.mjs`, log
  `task-17-v2.log`, **10 cenários V2 + 9 grupos integrados**, erros JS `[]`.
  Inclui `check-pages-feature-roundtrip.mjs`, Chrome 1600×900, legado 1600×2400
  para capturar o documento inteiro sem recorte, e sete larguras V2.
  Artefatos `pages-v2-task17/feature-roundtrip/`: resultados, payloads, capturas de
  prévia/leitor e comparações legado. A sequência integrada edita o mesmo grafo,
  verifica os seis marks no texto selecionado, aparência/estrutura, projeções SQL,
  estilos computados e marks no leitor/prévia, publicação conferida e cargo negado.
  As seis falhas de save isoladas retêm texto dirty e head SQL exato.
  Repetição isolada final: `node tests/visual/check-pages-feature-roundtrip.mjs`,
  `task-17-feature-final.log`, **9 grupos**; `pages-feature-task17-final/results.json`
  acrescenta versão Chrome e hashes/computed dos três estados legado. A captura
  do leitor normaliza scroll após testar a âncora. Essa pequena melhoria de
  evidência posterior ao V2 completo não altera runtime ou asserções funcionais.
- **PASS — mobile completo local:** `node tests/visual/check-pages-mobile-reference.mjs`,
  log `task-17-mobile.log`, **8 grupos**, erros JS `[]`;
  `pages-mobile-task17/results.json`, `feature-reader-390.png` e
  `mobile-content-390.png`. O foreground usa agora todas as seções da fixture
  funcional, com mídia realmente registrada. Estado visual usa a fixture de referência.
- **PASS — build/check:** `npm run build:pages`, `npm run check:pages-build`, logs
  `task-17-build-pages.log` e `task-17-check-pages-build.log`.
- **PASS — verificação final:** `npm run verify`, `task-17-verify.log`, **1135 testes,
  1133 pass, zero fail, 2 skips Linux existentes**, segurança/Compose e `verify: ok`.
  Skips: flock concorrente e symlinks com semântica Linux. Verificar Compose não
  inicia serviços. `git diff --check`, `task-17-diff-check.log`, exit 0 sem diagnóstico.
  Verify precede somente o acréscimo de metadados de evidência e normalização de
  scroll do teste integrado, que foi reexecutado isoladamente com PASS.

## Cobertura reutilizada com proveniência

Os relatórios/logs abaixo foram inspecionados e continuam evidência de suas rodadas;
não são anunciados como reexecuções Task 17. Seus testes permanecem disponíveis.
A rodada inicial não alterou runtime; o complemento autorizado acima acrescentou
o módulo de destinos e o inventário mínimo do workspace.

- **PASS local — inserção/estrutura:** `node tests/visual/check-pages-insertion.mjs`,
  `task-14-resumed-insertion-final2.log`; pontos antes/depois/coluna vazia, merge
  cancelado, aside, falha/alvo inválido, undo, drag/teclado a 50/100/150%. Check
  workspace posterior `task-16-fix-1-workspace.log`, **15 cenários**, mede o controle
  real de dispositivo/zoom em 1366/1600 e não só transforms artificiais.
- **PASS local — todas as propriedades e marcas:**
  `node tests/visual/check-pages-style.mjs`, `task-16-style.log`, **7 grupos**;
  defaults, herança/override/reset explícito sem recolorir pins legados, fonte,
  escala, alinhamento, fundo/hex, ícone, tags locais, largura, seleção rich/FAQ,
  cores/realce, IME CDP, guardas e AA real na publicação. Testes adicionais de
  estado/composição/limites fazem parte do verify; não somar seus totais duas vezes.
- **PASS local — mídia/FAQ/embed:** `node tests/visual/check-pages-editor-media.mjs`,
  `task-14-resumed-check-pages-editor-media.log`; fila parcial/retry com mesma chave,
  COMMIT confirmado sem resposta, replace preservando ID/metadados, reorder,
  pergunta/resposta keyed, save/reload/prévia/leitor, paste restrito, troca de conta
  durante upload e descarte sem referências tardias. Áudio/vídeo/GIF usam bytes
  sintéticos reais. A tarefa integrada acrescenta o grafo `featureDocument` inteiro.
- **PASS local — revisão/CAS/checklist:** `node tests/visual/check-pages-review.mjs`,
  `task-15-fix-1-browser-final.log`, **6 grupos**; revisão exata, título/categoria/
  cargo, publicação incerta retida, retry após cargo inativo/consulta falha,
  payload idêntico, uma auditoria, invalidar checks mesmo com modal fechado,
  publicador de outra autoria somente leitura e estado disabled real. Geometria
  1600×1160 é evidência localizada, não aceite conjunto das seis pranchas.
- **PASS local — renderer/consentimento/lifecycle:**
  `node tests/visual/check-pages-renderer-v3.mjs`, `task-10-browser-final.log`,
  **8 cenários**; zero requests YouTube pré-clique, um stub local pós-clique,
  galeria keyed, FAQ independente, bytes/blobs abortados e revogados, widths
  180/390/1044, captions computadas e legado v1/v2. Não comprova player ao vivo.
- **PASS local — botões/identidade/rotas:** checks
  `check-pages-buttons.mjs` e `check-pages-friendly-route.mjs`, evidências das
  Tasks 8/10 e contratos em `docs/architecture/pages.md`; download autenticado,
  busy/duplo clique, resposta tardia após conta/dispose, link por seção, alias
  direto/refresh/SPA/Back/Forward/Ética. O shell estático simula somente a rota Nginx.
- **PASS local — mobile/reflow/cleanup:** `task-16-fix-1-browser-final.log`,
  **8 grupos**, `pages-mobile-task16-fix1/results.json`; 360/390/402/768/1366/1600/1920,
  axe A/AA, foco visível inclusive alvo fora da tela, visualViewport reduzido com
  offset/safe-area, diálogos aninhados, rotação, Back/conta e 200% equivalente por
  viewport 683×450. Chrome simulado não prova teclado/toque/zoom físico.

## Lacunas e limites explícitos

- **PASS local — autoria UI dos destinos download/vídeo:** bloqueio inicial
  resolvido pelo complemento autorizado, com autoria real, save/reload e ações na
  prévia/leitor descritos acima. Não substitui revisão independente ou aceite visual.
- **PENDING — PostgreSQL 16 nativo:** concorrência em duas conexões/processos,
  locks, readiness/migrations reais, pg_dump/pg_restore, restore pré-042 e pré-Pages.
  Usar os checks nativos existentes em ambiente descartável autorizado. PGlite não
  substitui esse gate; nenhum cluster existente foi usado.
- **PENDING — Nginx/Bash/Linux reais:** `nginx -t`, entrega/negação efetiva de
  `/uploads/pages-private`, shell por alias, headers e scripts de restore no alvo.
  404 de Express e análise estática de config não são equivalentes.
- **PENDING — autenticação Firebase e aparelho físico:** identidade real, teclado
  virtual/IME/toque, leitor de tela e gesto de zoom nativo. Não foram simulados como
  aprovação desses ambientes.
- **NOT_ACCEPTED — comparação Task 18; PENDING — aceite do usuário:** comparação
  executada acima; as falhas geométricas históricas foram corrigidas e as medidas
  atuais passam. Pixels e aceite continuam pendentes. O wordmark SVG local tem glifos diferentes da fonte
  (limite Task 14); não foi redesenhado. O texto mobile respeita foreground canônico
  roxo/override, em vez do cinza forçado da prancha (correção Task 16). Copy da capa
  “no nosso dia a dia” difere de “no dia a dia”. Diferenças de glyph/rasterização/
  controles nativos continuam visíveis; não há CSS condicional para mascará-las.

## Operação e contrato de rollback

Writer v3 permanece desligado por padrão. Migration 042 é aditiva; 040/041 e os
snapshots históricos não são reescritos. Antes de habilitar escrita, leitores,
validadores e armazenamento devem suportar v3. Desabilitar o writer conserva
leitura/publicação de revisões salvas e retries autorizados, não converte v3 para
v1/v2. Rollback após criar v3 precisa manter esse leitor e a migration; uma release
exclusivamente antiga não é fallback compatível. Gates nativos pendentes e aceite
de prévia precedem qualquer rollout autorizado.

Salvar continua explícito. Concluir edição não salva. Checklist é pessoal,
opcional e não persistido. Download não é biblioteca PDF/Office: somente tipos
privados já suportados. YouTube é externo, sem privacidade conferida pelo login,
sem autoplay/prefetch antes de consentimento. Autoria, cargo ativo e revisão
autorizada controlam bytes; alias não torna página/mídia pública. O harness também
recusa consultas às tabelas históricas CMS/Owner News; checks de fronteira no
verify complementam esse percurso real, sem reativar consumidores legados.
