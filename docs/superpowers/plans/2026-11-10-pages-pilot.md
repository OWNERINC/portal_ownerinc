# Editor Conecta até piloto — Implementation Plan

## Steps
- [x] Composição versionada, blocos e personalização controlada.
- [x] Mídia privada GIF/MP3/MP4 com validação e reprodução reais.
- [x] Modelo sintético Owner News com navegação por seções.
- [x] Verificação independente, revisão e documentação de evidências.

**Goal:** concluir os lotes já autorizados de composição, mídias e piloto do editor.

**Architecture:** HTML/CSS/JavaScript e Express/CommonJS/PostgreSQL existentes.
Um documento e renderer genéricos; modelos são receitas de blocos. Revisões,
autoria, audiência, auditoria e acesso privado conservam seus contratos.

**Tech Stack:** ProseMirror local, SortableJS local fixado, Sharp e FFmpeg local.

## Global constraints

- Preservar todo o primeiro lote não commitado em `feat/conecta-pages-editor`.
- Não editar `040_pages.sql`, CMS histórico, AutoCard/Cards Pós, cron, deploy ou dados reais.
- Não iniciar Docker, aplicar migrations remotas, conceder permissões, publicar conteúdo real, commitar, fazer merge ou deploy.
- Código novo compatível com Node 18; não alterar runtime Node 24 existente.
- Fontes locais com OFL: Manrope, Source Serif 4 e Oswald. Nenhum asset remoto sem proveniência.
- Rascunho/publicação separados, editor somente da própria autoria inclusive superadmin;
  publicador revisa/publica outras autorias, sem editar. Ética e cargo ativo continuam obrigatórios.
- UUIDs estáveis, CAS, retry idempotente, snapshot append-only, auditoria atômica e
  preservação de arquivo após COMMIT ambíguo não podem regredir.

## Task 1 — Composição e compatibilidade

Files: `api/pages/{validation,templates,store}.js`, `public/pages/{model,editor,editor-source,renderer}.js`,
novo adaptador `public/pages/composition.js`, `public/css/pages.css`, bundle/lock/licenças,
`tests/unit/pages-*.test.mjs`.

- Manter schema v1/comunicado1 válido, sem mutar snapshots ou marcar dirty ao abrir.
- Usar schema v2/comunicado2 e v2/owner-news1 para expansão; migrar cópia de trabalho
  somente em ação v2, preservando UUIDs e persistindo apenas após salvar.
- Validar até 20 seções, 100 linhas, 100 blocos, 100 mil caracteres agregados, JSON 1 MiB.
- `single` tem uma coluna; `two_equal` duas. Ordem canônica: seções, linhas, coluna
  esquerda inteira, coluna direita inteira. Duas→uma concatena sem perder blocos.
- Inserção/movimento resolvem IDs estáveis, nunca array órfão. Undo guarda coluna/posição.
- Drag vertical e lateral com handle e alvos vazios; teclado usa os mesmos comandos,
  com destino explícito, foco e anúncio. Não arrastar texto selecionado/inputs.
- Preservar instâncias ProseMirror por ID em movimentos para manter undo e seleção.
- Blocos novos: callout com PM/tom/ícone, botão com label/preset/destino, separador.
- Destino é URL HTTPS/root-relative segura ou UUID de seção existente, não HTML/fragment livre.
- Estilo de bloco por tokens finitos: alinhamento início/centro/fim, escala pequena/padrão/grande,
  paleta Conecta contrastada e fontes locais. Sem CSS/HTML/inline marks arbitrários.
- Testar old snapshot equality, limites, IDs duplicados, transformações sem perda,
  equivalência teclado/drag e ordem modelo/DOM/mobile; preservar regressões hash/upload/save incerto.

## Task 2 — Mídia privada

Files: `api/pages/{media,router,store,validation}.js`, novo runner de mídia se necessário,
`api/db/migrations/041_pages_media.sql`, `api/db/{schema,verify-migrations}.js/sql`,
fixtures/readiness/build tests, `api/Dockerfile`, somente location Pages em `nginx/nginx.conf`,
`public/pages/{api,renderer,editor,dom,model}.js` e testes unitários.

- Preservar imagem estática 5 MiB/20 MP/WebP normalizado e multipart `image` antigo.
- GIF: 8 MiB, 100 frames, 20 milhões de pixels decodificados totais, ciclo até 30s,
  decodificar e normalizar GIF preservando animação e limitando saída.
- MP3: 10 MiB/600s, uma trilha MP3, mono/estéreo, amostragem até 48kHz.
- MP4: 25 MiB/120s, H264 8-bit yuv420p até 1920x1080/30fps, AAC-LC opcional;
  rejeitar tracks extras, encriptação, referências externas, codecs não permitidos.
- Probe local 10s/256KiB stdout/64KiB stderr, decode completo até 45s com timeline
  medida consistente; timeout não é sucesso parcial. Sem shell, nomes gerados,
  executável absoluto, demuxer fixo, protocolo file, drefs e absolute paths desabilitados.
- Uma admissão por processo antes de buffer; fila não ilimitada. Abort e cleanup
  após encerramento do processo. Ausência da ferramenta falha fechada com 503.
- FFmpeg empacotado no Dockerfile Alpine (não executar Docker). Nginx Pages multipart
  26 MiB e JSON 1 MiB. MIME/kind inferidos no servidor, hash origem+kind no retry.
- Migration 041 permite versões 1/2 e metadados tipados com CHECK null-safe;
  preserva linhas antigas, privilégios append-only e negação ao cron. `insertRevision`
  usa versão validada real. Bootstrap e upgrade convergem pelo encadeamento 040+041.
- Validar referências `{id,kind}` na mesma página no save e publish, não apenas existência.
- Quota histórica permanece 50 arquivos/100 MiB. Bytes entregues integralmente sem ranges,
  somente após autorização por publicação/revisão; no-store/nosniff e MIME registrado.
- Áudio/vídeo baixam blob após ação explícita, controles nativos, sem autoplay/.play automático.
  GIF inicia/para explicitamente. Transcript e cues sincronizados limitados/validados.
- Dispose aborta, pausa, limpa fontes/track e revoga URLs; resposta tardia é ignorada.
- Testar formatos reais e abusivos, mismatch/foreign media, retry/rollback/COMMIT ambíguo,
  admissão/timeout/cancel/output flood, reprodução e descarte reais.

## Task 3 — Piloto e navegação

Files: `api/pages/templates.js`, `public/pages/{catalog,app,renderer}.js`, testes.

- Modelo selecionável `owner-news`, rotulado sintético/demonstração/não oficial.
- Cinco seções: capa, índice, matéria, entrevista e reconhecimentos; pessoas fictícias.
- Somente blocos genéricos, sem endpoint/tabela/renderer especial ou consulta histórica.
- Índice usa destino de seção e URL `pages.html?id=UUID#section-UUID`.
- Hash do mesmo documento não refaz fetch/render nem interrompe mídia. Deep link inicial
  é resolvido após render assíncrono; Back/Forward mantém foco/scroll adequados.
- Testar criar/salvar/reabrir/prévia/publicar/ler em banco descartável, com mídias
  sintéticas reais adicionadas pelo mesmo editor/API.

## Task 4 — Aceite primário independente

Primary owns `tests/database/check-pages.mjs`, `tests/visual/check-pages.mjs`, eventuais
verificadores independentes de expansão e documentação. Um único implementador
possui runtime/testes unitários; não há edição paralela nos mesmos arquivos.

Run: `npm run build:public`, `npm run check:pages-build`, `npm run verify`,
`node scripts/generate-public-shell.mjs --check`, `git diff --check`, verificadores
PGlite/Chrome com dependências externas e FFmpeg local. Não converter resultados
PGlite serializado/Firebase sintético em alegação de PostgreSQL/Firebase/Nginx real.

Revisão fresca read-only Astra high exige `ship`, `fix-first` ou `rethink`; corrigir
e repetir evidências antes de concluir. Atualizar `docs/architecture/pages.md`,
`README.md` e `docs/product/roadmap.md` com apenas resultados observados.
