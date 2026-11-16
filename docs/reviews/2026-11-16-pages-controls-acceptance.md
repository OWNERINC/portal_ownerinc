# Pages — regressão dos controles, 16/11/2026

## Estado e limites do aceite

Base das tarefas 1–8: `1436f69237c091abf3196553e14465b582278c6d`.
Plano aprovado: `BASE1436f69`. Este registro separa regressão automatizada,
comparação com referências e aceite humano. **Não é autorização de integração,
deploy ou publicação. A18 foi adiado pelo usuário no gate da tarefa 9.**
Não foram implementados novos nomes de arquivo ou UX de legendas.

Evidências desta rodada ficam em diretórios novos sob
`C:/Users/Criação/AppData/Local/Temp/opencode/`. As seis referências em
`editor-v2-reference`, o manifesto e as capturas históricas foram preservados.
Fixtures são apenas sintéticas, persistidas no harness antes da abertura; nenhum
documento de usuário aberto é substituído para demonstrar comportamento.

## Inventário A01–A18

Cada item abaixo é verificável pelo runner indicado. O resultado final da execução
e as limitações são registrados nas seções seguintes; não equivale a 18/18.
**A01–A17: correções exercitadas com PASS funcional automatizado no harness**;
aceite humano e contraste inconclusivo de nós adicionais continuam gates separados.

- **A01 — menu de texto:** `controls-menus`, quatro larguras; ações textuais reais,
  alvo 44 px, lista numerada/lista/remoção/undo, Escape e identidade PM.
- **A02 — estrutura compacta:** `controls-structure`; posição/ordem por UUID,
  limites, foco, Alt+setas, arraste, Escape, save SQL e undo.
- **A03 — publicação explicável:** `controls-review`, `review`, `preflight`;
  pendências estruturadas e correção segura, revisão exata, checks opcionais.
- **A04 — Salvar/status fixos:** `controls-save`; quatro larguras com painel aberto,
  busy/erro/ACK perdido após COMMIT, payload/key idênticos no retry, edição durante
  save, CAS e permissões. Sem autosave ou duplicação de requisição.
- **A05 — modal centralizado:** `controls-overlays`; margens seguras, scrim,
  cabeçalho/rodapé, foco inicial/restaurado, bloqueio busy/IME, erro/retry/cancel.
- **A06 — checkbox de cargo:** `controls-overlays` e `controls-acceptance`;
  indicador 18–20 px separado de linha clicável 44 px, inclusive muitos cargos.
- **A07 — toolbar tablet:** `controls-responsive`, `workspace`; matriz de
  breakpoints/zoom/alturas, colisão/hit-testing local, folga medida do texto,
  identidade EditorView, sem ocultar controles para passar.
- **A08 — menus coordenados:** `controls-menus`, `controls-acceptance` e testes
  unitários de menus; um disclosure por vez, Escape, foco externo, teclado,
  remoção efetiva de keydown/pointerdown/click/toggle no descarte.
- **A09 — controles fora do workspace:** `controls-overlays`; controles textuais
  44 px e fonte compacta 16 px também em menus/painéis/dialogs reparentados.
- **A10 — fonte de vídeo contextual:** `controls-text-video`, `media`; MP4 privado
  não mostra URL YouTube; erro local associado; cancel mantém UUID e source ID
  originais, verificados no documento salvo em SQL. Sem iframe/thumbnail externo.
- **A11 — formato da seleção:** `controls-text-video`, `history`, `style`;
  PM/FAQ reais, H2/H3/parágrafo/misto/lista, seleção/link/cor, undo e view retida.
- **A12 — galeria por item:** `controls-inspector`, `media`; três uploads reais,
  identidade, metadados, miniatura privada já disponível sem GET adicional,
  ordem/remoção separadas, foco, substituição e save/undo/redo SQL.
- **A13 — título laranja:** `controls-responsive`, `renderer`, `mobile`;
  métricas canônicas e strong, cor persistida intacta, axe completo nos títulos,
  linhas contidas no bloco e diferentes fontes. Sem excluir título da auditoria.
- **A14 — rodapé Estilo:** `controls-overlays`, `style`; alvo real 44 px,
  rodapé acessível em laptop, corpo rola sem recortar campo/foco, Apply explícito.
- **A15 — aviso de exemplo:** `controls-responsive` e teste unitário workspace;
  aviso depende somente de Edição/Prévia, não da origem template do conteúdo.
- **A16 — Publicar disabled:** `controls-save`, `review`; motivo visível associado,
  aparência disabled inclusive hover e permissões de não autor/publicador.
- **A17 — inspector:** `controls-inspector`; Conteúdo/Estilo/Posição e presets
  legados em Estilo; hex/tags com erros independentes e describedby/invalid,
  sem migração ao abrir. Teste unitário prova correção independente dos erros.
- **A18 — autoria de mídia:** **PENDENTE/ADIADO pelo usuário**. Gate visual da
  tarefa 9 recusado por adiamento. Controles/serialização anteriores preservados;
  não afirmar entrega de legendas facilitadas ou novos nomes humanos.

## Correções localizadas da regressão

`editor-panels.js`: callback nomeado de `focusin` removido ao fechar/desmontar o
painel, inclusive quando a estrutura é reutilizada. Teste RED mostrou callback
remanescente após fechar; GREEN testa três reaberturas e cleanup da visita.

`editor-style.js`: tags não reutilizam mais o alerta hexadecimal. Cada campo tem
seu próprio `aria-describedby`, estado invalid e mensagem; corrigir um não limpa o
erro do outro. RED mostrou tags sem estado invalid; GREEN testa os dois erros e
suas correções. Nenhum payload, callback público, transação ou schema alterado.

`pages-editor-v2.css`: nomes de cargos muito longos revelaram que o grid podia
comprimir as linhas a 44 px e deixar texto invadir a linha seguinte. O grid da
audiência do editor agora dimensiona cada linha por `max-content`, mantendo o
scroll e o mínimo de 44 px. **RED real** em `pages-task10-cargo-red-a` falhou na
contenção das linhas; **GREEN** em `pages-task10-cargo-green-a` prova todos os 62
labels (inclusive fora da janela rolada) contidos em suas próprias caixas nas
três larguras. Nenhum texto/controle foi ocultado para passar.

Testes de menus agora contam remoção de todos os tipos de listener; cancelamento
de troca de vídeo verifica UUID e source ID após save SQL, não apenas quantidade.

## Resultados reproduzíveis desta rodada

Os controles são executados serialmente, com saída exclusiva por caso.
`npm run verify` não substitui este gate de browser.

- `pages-task10-final-a/controls-{menus,structure,save,review,overlays,responsive,text-video,inspector}`:
  **8/8 casos PASS**, com seus JSON e capturas. Erros de página vazios.
- No mesmo diretório, `workspace`, `style`, `review`, `media`, `destinations`,
  `history`, `preflight`, `pilot`, `polish`, `renderer`: PASS no primeiro passe.
- Primeiro passe de `insertion`, `feature`/`v2`, `friendly-route` e `mobile` revelou
  expectativas de testes desatualizadas. Saídas de falha preservadas: scroller agora
  é o corpo de Inserir; ação contextual é Inserir vídeo; contrato servidor atual
  permite usuário não verificado com Ética aceita/cargo autorizado; tipografia e
  fundo ficam em Estilo. Nenhuma política de autenticação foi alterada para passar.
  O modo estrito mobile conserva asserções históricas separadas do funcional.
- Testes focados dos minors: **15/15 PASS**, sem skips. Primeiro verify completo:
  **1218 testes, 1216 PASS, 0 falhas, 2 skips existentes**, `verify: ok`.
- `pages-task10-supplement-a/acceptance`: executou 1366/768/390 com 30 parágrafos,
  62 cargos, teclado/foco externo e três reaberturas de estrutura compacta. Seus
  **27 estados axe tiveram 0 violações e 13 resultados incompletos**; isso NÃO é
  alegação de WCAG completo. Incompletos incluem texto fora da janela do scroller,
  símbolos sem texto e um aviso de vídeo tablet com fundo indeterminado pelo axe.
  Inspeção das capturas encontrou sobreposição real dos nomes longos de cargo,
  apesar de zero violações; teste de linhas por label foi acrescentado para RED/GREEN.
  A correção posterior passou no teste de todos os labels; os incompletos originais
  e posteriores continuam registrados (2/6/5 por largura), não chamados de PASS.
  Aviso de vídeo tablet foi inspecionado visualmente: texto inteiro e ações visíveis
  em `768-video-error.png`, mas o contraste automático desse nó segue inconclusivo.
- Rerun `pages-task10-rerun-a`: **save com capturas busy, insertion, friendly-route,
  feature e v2 PASS**; mobile expôs uma asserção nova indevida de caixa pintada 44 px
  para o X isolado, que conserva alvo efetivo 44 px com pseudoalvo já existente.
  Corrigida para medir extensão e hit-test das duas bordas; sem alteração runtime do X.
  A matriz responsive continua a conferir sobreposição de alvos reais/efetivos.
- Rodada final após a correção de nomes longos, `pages-task10-final-b`:
  **9/9 controles PASS serialmente**, incluindo o novo acceptance, e broad review
  PASS (revisão exata, archive/restore, permissões e retry). `npm run verify`:
  **1218 testes, 1216 PASS, 0 falhas, 2 skips existentes**, mais gates de sintaxe,
  segurança, Compose e build; `git diff --check` PASS. Browser continua gate separado.
  Responsive reteve as **648 combinações únicas/12096 bordas ativas** e os títulos
  laranja têm contraste axe completo; nenhum nó do título foi excluído.
  Mobile estrito falha honestamente em `header.height:156 vs64 ±2`, por ações/status
  fixos. Mobile funcional foi reexecutado separadamente para medir cleanup no primeiro
  frame de rendering após resize (ACK do protocolo sozinho não entrega matchMedia).
- **15/15 runners amplos funcionais concluídos com PASS**: os dez do primeiro
  passe acima, mais insertion/friendly-route/feature/v2 no rerun e mobile em
  `pages-task10-mobile-final-d` (**8 grupos**). Mobile preserva simulação de teclado,
  rotação, todas as views/documento, save SQL/reload e remoção de hooks no descarte.
  No reflow curto 683×450 usa o botão real Concluir antes de retornar ao canvas
  coberto pelo painel; nenhum force-click, CSS de ocultação ou descarte de asserção.
  Tentativa `mobile-final-c` não iniciou o browser: faltavam FFmpeg/ffprobe no
  ambiente do comando isolado. Corrigido o ambiente, sem mudar o produto.

## Referências e divergências intencionais

As comparações históricas estritas não são convertidas em igualdade falsa.
Salvar/status fixos, targets reais 44 px, toolbar que reserva linhas no tablet,
menus legíveis, diálogos centralizados e rodapés retidos mudam a geometria das
pranchas antigas. Inspector plano e grupos de mídia também diferem por decisão
do plano. O contrato histórico de toolbar **412 px versus 329 px** e o Apply
**44 px versus 36 px + pseudoalvo** permanecem divergências, não PASS estrito.
Purple/gray e wordmark legados também não recebem alegação de equivalência pixel.

Comparação nova `pages-task10-supplement-a/six-reference/results.json`:
**NOT_ACCEPTED, seis pranchas**, com originais validados por hash e novos
`*-overlay.png`/`*-diff.png` por prancha. Editable-buttons conserva geometria e
âncoras, mas tem diferenças de pixels em cinco regiões. As demais têm diferenças
de geometria no toolbar/inspector; Estilo/Inserir/Revisão também nos painéis. Revisão
tem cinco falhas de texto amostrado por região histórica e mobile quatro (incluindo
tipografia/fundo agora em Estilo). Esses resultados NÃO são removidos nem reclassificados
como igualdade; vários textos continuam visíveis fora da região histórica, como
mostra `desktop-review.png`. A aprovação humana dessas diferenças ainda está pendente.
`style-strict.log` e `workspace-strict.log` registram exit1 por 44 vs36 e 412 vs329.
Repetição sobre o runtime/CSS final em `pages-task10-tail-a/six-reference/` mantém
**NOT_ACCEPTED** com seis capturas/overlays/diffs novos e hashes originais intactos.

## Índice de preview para a revisão humana

Todos os caminhos abaixo são relativos ao diretório externo de evidências citado
acima. São capturas novas, não montagens nem referências alteradas.

- **Desktop 1366:** `pages-task10-final-b/controls-overlays/1366-style.png`,
  `controls-save/1366-busy.png`, `controls-save/1366-lost-ack.png` e
  `controls-review/1366-issues.png` dentro da mesma rodada final.
- **Tablet 768:** mesma rodada, `controls-overlays/768-link.png`,
  `controls-save/768-busy.png`, `controls-save/768-lost-ack.png` e
  `controls-review/768-issues.png`.
- **Mobile 390:** mesma rodada, `controls-menus/390-text-menu.png`,
  `controls-save/390-busy.png`, `controls-save/390-lost-ack.png` e
  `controls-inspector/390-independent-field-errors.png`. 320 px também exercitado.
- **Conteúdo longo/muitos cargos:** `pages-task10-cargo-green-a/{1366,768,390}-many-cargos.png`,
  `*-cargo-text.json` (todas as linhas, inclusive fora da janela) e
  `pages-task10-final-b/controls-overlays/*-long-task.png`.
- **Galeria/FAQ/fontes/legado:** rodada final `controls-inspector/*-gallery-private.png`,
  `*-gallery.png`, `*-legacy-style.png`; `controls-text-video/*-mixed-format.png` e
  `controls-review/*-correction-formatting.png`. Resultados amplos de mídia, history,
  style e renderer no primeiro passe preservam seus casos de fontes/persistência.
- **Comparação antiga estrita:** `pages-task10-supplement-a/six-reference/` contém
  seis capturas, seis overlays, seis diffs e os JSON com hashes/geometria/texto.

Abrir um screenshot não significa aceite. A revisão humana deve conferir os estados
e a leitura dentro dos scrollers, além da geometria automatizada.

## Reprodução local (PowerShell)

Instalações externas já existentes; sem instalar dependências ou iniciar Docker:

```powershell
$tempRoot = Join-Path $env:LOCALAPPDATA 'Temp/opencode'
$env:PGLITE_MODULE_PATH = "$tempRoot/consent-db-tools/node_modules/@electric-sql/pglite/dist/index.js"
$env:PLAYWRIGHT_MODULE_PATH = "$tempRoot/conecta-browser-tools/node_modules/playwright/index.mjs"
$env:AXE_MODULE_PATH = "$tempRoot/conecta-browser-tools/node_modules/@axe-core/playwright/dist/index.mjs"
$env:PAGES_REFERENCE_DIR = "$tempRoot/editor-v2-reference"
$env:FFMPEG_PATH = (Get-Command ffmpeg).Source
$env:FFPROBE_PATH = (Get-Command ffprobe).Source
# Use uma raiz inédita. Não reaproveite diretórios de evidência anteriores.
$fresh = "$tempRoot/pages-controls-rerun-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $fresh | Out-Null
foreach ($case in @('menus','structure','save','review','overlays','responsive','text-video','inspector','acceptance')) {
  $env:PAGES_CONTROLS_OUTPUT = "$fresh/$case"
  node tests/visual/check-pages-controls.mjs $case
  if ($LASTEXITCODE -ne 0) { throw "Falha em $case; preservar saída" }
}
npm run verify
git diff --check
```

Os runners amplos são `check-pages-{workspace,style,review,editor-media,buttons,history,insertion,friendly-route,publication-preflight,feature-roundtrip,v2,pilot,polish,renderer-v3,mobile-reference}.mjs`
em `tests/visual/`; cada um usa sua variável `*_VISUAL_OUTPUT` documentada no README
visual. Comparação estrita usa `check-pages-reference.mjs`, diretório novo em
`PAGES_REFERENCE_OUTPUT`, `PNGJS_MODULE_PATH` apontando ao decoder externo
`playwright-core/lib/utilsBundle.js` e browser fixado por
`PAGES_REFERENCE_BROWSER_VERSION=157.0.8103.51`. Exit1 por divergência estrita deve
ser registrado, não convertido em sucesso. Style/workspace/mobile também conservam
`--strict-reference-geometry` separado do modo funcional.

## Gates restantes

- Aceite humano visual: **pendente**, a ser apresentado pelo controlador após
  revisão independente de toda a branch. Este executor não solicitou aceite.
- A18/tarefa 9: **adiado pelo usuário**.
- Touch físico, teclado virtual/IME físico, Safari/iOS: **não verificados**.
  Eventos sintéticos/CDP Chrome não substituem essa validação.
- Harness usa Express real, SQL PGlite descartável e identidades Firebase
  sintéticas; não comprova autenticação real, PostgreSQL nativo concorrente,
  restore de backup, headers Nginx, produção ou playback externo real.
- Sem Docker, serviços de produção, backend/migrations/grants/cron/Nginx/deploy,
  dependências ou conteúdo real alterados. Node 18 compatível nos módulos tocados;
  o ambiente/repositório existente executa Node 24.
