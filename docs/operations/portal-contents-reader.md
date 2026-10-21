# Operação do leitor Conteúdos

## Comportamento para leitores

- **Navegação:** o link Conteúdos aparece depois de uma identidade Portal ativa e
  de uma resposta válida de `GET /api/contents/availability`. `available:false`
  significa que ainda não há publicação; erro/503 mantém o link oculto e pode ser
  reconsultado ao voltar à página, recuperar foco ou ficar online. Esse probe não
  autoriza nem bloqueia `/contents.html` ou um slug direto.
- **Catálogo:** `/contents.html`, `/contents.html?category=<slug>` e
  `/contents.html?page=<n>`; filtro e página podem ser combinados. Há 12 itens por
  página, categorias e paginação preservam o histórico do router. Categoria zera
  a página. Um slug direto usa `/contents.html?slug=<slug>` e permanece carregável
  sem ter visitado o catálogo; a ação Voltar usa o catálogo conhecido desta visita
  ou o início do catálogo. Parâmetros reconhecidos duplicados, fora de formato ou
  fora dos limites falham de modo fechado.
- **Limites publicados:** até 100 blocos, 10.000 nós rich-text, 5 MiB de conteúdo
  serializado, 6 MiB por detalhe e 16 MiB por coleção; 12 itens por página,
  offset máximo de 1.000.000, total máximo de 100.000, 20 categorias e 20 imagens
  por galeria. Layouts válidos são `content`, `wide`, `full`, `left` e `right`,
  com layout omitido tratado como `content`.
- **Vazio e falha:** zero resultados publicados, categoria sem itens, conteúdo
  despublicado e falha temporária do CMS são estados distintos. Erros de rede/503
  oferecem retry; erro de categorias pode ser repetido sem descartar cards já
  carregados. Não substitua erro do CMS por catálogo vazio e não contorne 404 de
  conteúdo despublicado.
- **Conteúdo:** o browser valida o DTO público inteiro antes de renderizar. São
  aceitos até 100 blocos, 10.000 nós, 5 MiB de blocos, 6 MiB por detalhe, 16 MiB
  por coleção, 20 categorias por página, 20 imagens por galeria, 12 itens por
  página, offset até 1.000.000 e total até 100.000. Rich text usa estrutura
  permitida, não HTML arbitrário. Cada bloco admite `content`, `wide`, `full`,
  `left` ou `right`; todos permanecem dentro dos gutters do conteúdo principal.

## Mídia e acessibilidade editorial

- A URL de asset é vinculada à revisão publicada e só é ativada após POST sem
  body a `/api/contents/media-session` retornar 204 para identidade ativa. A
  sessão de mídia dura cinco minutos, renova proativamente em quatro minutos
  quando visível ou durante reprodução e tem retry transitório limitado a
  5/15/30 segundos (429 respeita `Retry-After`). Logout/troca de conta invalida
  fontes imediatamente e tenta limpar a cookie; nenhuma aba deve tratar bytes já
  entregues como revogados.
- Cookie de produção: `__Secure-ownerinc-content-media`, `Secure`, `HttpOnly`,
  `SameSite=Strict`, escopo `/api/contents/assets`. Somente desenvolvimento HTTP
  em loopback usa `ownerinc-content-media-dev`. Emissão e remoção exigem Origin
  igual à origem configurada. Nunca copie cookies, tokens ou `storage state` para
  o checkout ou para um relatório.
- Imagens são nativas. Vídeo e PDF usam streaming privado e aceitam Range único;
  não baixe nem armazene o corpo inteiro via JavaScript. O limite de asset é
  500 MiB; as regras editoriais limitam imagens a 15 MiB, vídeos a 500 MiB e PDFs
  a 100 MiB. Vídeo usa controles nativos sem autoplay; uma renovação normal não
  substitui `src` nem reinicia `currentTime`. Recuperação de falha persistente
  recarrega a revisão inteira, nunca combina blocos de revisões diferentes.
- PDF usa link nativo em nova aba/download. A aba PDF independente não renova a
  cookie: ela pode deixar de carregar novos ranges depois de cinco minutos. O
  leitor instrui voltar ao Portal e abrir de novo; não se promete renovação
  indefinida fora do Portal nem popup assíncrono.
- A galeria é um diálogo com foco contido, Escape, setas, wrap, retorno de foco,
  retry e restauração do estado de `inert`/rolagem. Teste com teclado e leitor de
  tela real. O conteúdo editorial ainda deve fornecer alt/caption adequados,
  PDFs marcados e ordem de leitura, além de legendas/transcrição/alternativa para
  vídeo quando necessárias. Iframe carregado não prova reprodução; controles
  nativos não corrigem mídia inacessível.
- YouTube e Vimeo aceitam somente os endereços canônicos validados. Vimeo está
  permitido em `frame-src` da CSP Portal; não amplie wildcard, sandbox, `object-src`
  ou CSP editorial. A validação efetiva deve observar headers e playback pelo
  Nginx, não apenas existência do iframe.

## Aceite local, guardas e evidência

O aceite de serviços é manual e separado de `npm run verify`. Não inicie Docker,
Nginx, API, CMS, migrations ou browser sem autorização explícita para o projeto
descartável **nomeado** e seus recursos. Use somente URLs loopback e dados
sintéticos; não use `.env`, URL de runtime, Firebase de produção, host externo ou
banco remoto como fallback. O runner não inicia serviços e não prepara fixtures.
Se o daemon/serviço/browser não estiver disponível, registre `NOT_EXECUTED` e a
causa — nunca promova check de configuração ou mock a PASS.

Defina explicitamente, apenas no processo de teste:

```sh
NODE_ENV=test
PORTAL_CONTENTS_TEST_DISPOSABLE=true
PORTAL_CONTENTS_TEST_BASE_URL=http://127.0.0.1:8080
PORTAL_CONTENTS_TEST_RUN_ID=<UUIDv4 exclusivo>
PORTAL_CONTENTS_TEST_EVIDENCE_DIR=<diretório absoluto fora do checkout>
```

O diretório de evidências deve existir, ser diretório real (não symlink) e estar
fora do checkout. Ele contém `portal-contents-acceptance.json`; `artifact` é um
caminho relativo interno ou `null`. Não registre cookies, tokens, storage state,
HAR bruto, dados pessoais ou corpos de resposta. Registre somente resumos
sanitizados e referências a artefatos privados. `--check-config` valida as
guardas, não conecta, não grava manifest e sempre imprime `NOT_EXECUTED` com
código 2. Depois de registrar execuções reais, `--aggregate` devolve 0 somente
para todos os 15 casos válidos PASS; falha/inconsistência retorna 1 e omissões ou
`NOT_EXECUTED` retornam 2.

```sh
node scripts/test-portal-contents-acceptance.mjs --check-config
node scripts/test-portal-contents-acceptance.mjs --aggregate
```

Cada registro tem exatamente `case`, `commit`, `runId`, `environment`, `startedAt`,
`finishedAt`, `browser`, `viewport`, `scenario`, `status`, `artifact` e `notes`.
`commit` é o SHA sob teste; run ID e commit devem ser iguais em todo o manifest.
Para PASS/FAIL, timestamps são UTC ISO canônicos (`YYYY-MM-DDTHH:mm:ss.sssZ`) e
`finishedAt` não antecede `startedAt`; para um caso `NOT_EXECUTED` sem tentativa,
ambos são `null` (uma tentativa parcial registrada pode usar timestamps reais e
ordenados, mas não muda o status para PASS).
Browser inclui produto e versão completa; viewport inclui dimensões CSS observadas.
PASS/FAIL rejeita campos vazios e valores placeholder (incluindo variações de
maiúsculas, espaços, hífens e underscores) em ambiente/browser/viewport/cenário/
notas. Um PASS exige ambiente descartável local, browser/version, viewport com
dimensões e cenário/notas que descrevam observações reais. Se `artifact` for
fornecido, o caminho também não pode ser placeholder. Registros
`NOT_EXECUTED` podem usar esses literais, mas nunca satisfazem um PASS. A tabela
completa, cenário, status e bloqueadores da execução são registrados na
[matriz de aceite](../reviews/2026-10-20-portal-contents-reader-acceptance.md).

### Matriz operacional reproduzível — 15 casos

#### Pré-requisitos compartilhados

1. Obtenha autorização para o projeto Compose **descartável e nomeado** e anote o
   identificador aprovado. Confirme que serviços, banco, uploads, volumes e portas
   não são compartilhados com runtime. O runner não inicia nem encerra serviços.
2. Use somente `127.0.0.1`/`localhost`, dados sintéticos e o Auth Emulator quando
   autorizado. Não use credenciais Firebase reais, URLs externas, dados pessoais,
   produção/VPS, `docker compose down -v` ou uma migration ad hoc.
3. Prepare pela UI editorial: viewer ativo A e B, conta inativa, editor com
   `manageKnowledge`, no mínimo 13 páginas publicadas em duas categorias, uma
   sequência publicada `r1`→`r2` e um slug que possa ser despublicado. Inclua
   imagem, galeria com pelo menos duas imagens, vídeo com mais de seis minutos,
   PDF de pelo menos 20 MiB (e abaixo dos limites editoriais) e embeds canônicos
   YouTube/Vimeo. Use UUIDs/hashes sintéticos e anote-os em registro privado.
4. Monte as 60 combinações de blocos: os dez tipos
   `heading`, `rich_text`, `image`, `gallery`, `video`, `pdf`, `embed`, `callout`,
   `link`, `divider`, cada um com `content`, `wide`, `full`, `left`, `right`, mais
   um exemplar de cada tipo sem `layout` (default `content`). Nenhuma página pode
   ser publicada sem que o editor valide seus campos e referências.
5. Abra um browser real e anote produto/versão, versão do sistema, viewport/DPR e
   zoom. Grave `startedAt` antes da primeira ação e `finishedAt` depois da última.
   Use DevTools/Network para status, headers, revisões, transferência incremental,
   cancelamento e chamadas de sessão; não exporte HAR bruto.
6. Para cada caso abaixo siga a ordem **precondições → passos → PASS**. Um subpasso
   que não pôde ser executado não é PASS. Registre o caso inteiro como
   `NOT_EXECUTED` (ou `FAIL` se foi executado e falhou); não infira resultado de
   harness/offline.

#### Casos de serviço, browser e revisão

1. **`live-auth-gate` — identidade, listagem, detalhe e publicação.**
   - **Precondições:** viewer A ativo, conta inativa, sessão sem login, CMS
     funcional e, se houver meio seguro de injetar indisponibilidade no stack
     local, uma falha CMS controlada.
   - **Passos:** sem login, peça `GET /api/users/me`,
     `GET /api/contents/availability`, `GET /api/contents/` e
     `GET /api/contents/<slug>`; repita após login de A e de conta inativa. Como A,
     confirme disponibilidade, listagem e detalhe de uma publicação. Pelo editor,
     publique `r1`, salve/publique `r2`, consulte o detalhe e compare o `revision.id`
     e os blocos; despublique somente o slug sintético e consulte o mesmo detalhe.
   - **PASS:** não autenticado/inativo é negado (401/403) sem conteúdo; A obtém
     `/users/me` e DTO publicado coerentes; `r2` passa a ser a revisão visível,
     draft nunca é exposto; após despublicação o slug retorna 404. Falha CMS segura
     aparece como indisponibilidade/503, nunca como lista vazia. Se não houver
     injeção de falha segura, registre esse subpasso como não executado.

2. **`catalog-routing` — categoria, paginação, detalhe e histórico.**
   - **Precondições:** browser autenticado como A e as 13 páginas em duas categorias.
   - **Passos:** abra `/contents.html`; percorra primeira/segunda página, cada
     categoria e a combinação categoria+página; abra um slug diretamente; teste
     refresh, Voltar/Avançar e retorno ao catálogo. Faça a mudança de categoria
     estando na página 2 e observe foco/título/loader em cada transição. Despublique
     o slug de fixture e carregue seu URL direto.
   - **PASS:** lista usa 12 itens por página e página 2 contém o remanescente;
     filtro reseta página; Back/Forward/refresh preservam a URL canônica e o shell;
     links internos atualizam foco/título e não exibem resposta antiga; slug
     despublicado retorna estado 404 seguro.

3. **`native-image` — emissão da sessão e GET nativo.**
   - **Precondições:** página A publicada com imagem e versão/revisão conhecida.
   - **Passos:** no Network, confirme `POST /api/contents/media-session` sem body,
     mesmo Origin e identidade válida; em seguida carregue a imagem nativa em
     `/api/contents/assets/<pageId>/<revisionId>/<assetId>`. Repita a emissão sem
     Origin válido apenas no ambiente descartável.
   - **PASS:** emissão válida retorna 204 sem body e cookie `Secure; HttpOnly;
     SameSite=Strict; Path=/api/contents/assets` (nome de produção) ou o nome dev
     exclusivo de loopback; asset retorna 200 com MIME/headers privados esperados;
     Origin inválido é negado e nenhum token/cookie aparece em URL, DOM ou log.

4. **`native-range` — respostas Range, streaming e cancelamento.**
   - **Precondições:** vídeo e PDF válidos com tamanhos/hash conhecidos e sessão
     válida; anote tamanho total `N` sem registrar bytes do corpo.
   - **Passos:** solicite asset sem Range; envie `Range: bytes=0-1023`,
     `Range: bytes=-1024`, `Range: bytes=N-` e multi-range
     `Range: bytes=0-1,3-4`. No DevTools observe chegada de headers/primeiro bloco
     antes do final do arquivo; inicie busca no vídeo e feche/pare o recurso após
     receber o primeiro bloco para provocar cancelamento.
   - **PASS:** GET integral autorizado é 200; os ranges satisfatíveis são 206 com
     `Accept-Ranges: bytes`, `Content-Range`/`Content-Length` exatos; o intervalo
     fora do tamanho e multi-range não suportado retornam 416 com
     `Content-Range: bytes */N` e zero bytes. O browser recebe blocos incrementais,
     não o corpo inteiro via JavaScript; cancelar termina a transferência e libera
     recursos sem buffer acumulado nem sucesso falso.

5. **`long-video-renewal` — reprodução e renovação em background.**
   - **Precondições:** vídeo real com duração >360 s, relógio/sessão controlados
     apenas no stack descartável; DevTools Network aberto.
   - **Passos:** reproduza por pelo menos 6 minutos mantendo o Portal visível;
     registre `currentTime`/`src`, observe o POST de renovação próximo de 4 min e
     continue além da renovação e de 6 min.
   - **PASS:** renovação autorizada não muda `src`, não volta `currentTime` nem pausa
     a reprodução; falha de renovação mantém estado seguro, sem nova origem privada
     utilizável e sem loop ilimitado.

6. **`media-failure-recovery` — offline, 429, expiração e revisão substituída.**
   - **Precondições:** página de revisão `r1` com vídeo/imagem, `r2` com conteúdo
     diferente, controles de rede do browser e duas sessões sintéticas.
   - **Passos:** durante uma solicitação de mídia simule offline e volte online;
     devolva 429 com `Retry-After`, depois uma falha transitória e, em outra
     tentativa, 401/403 expirado. Publique `r2`, retente o detalhe inteiro e
     compare todos os blocos/IDs antes e depois.
   - **PASS:** retry é limitado, 429 respeita Retry-After, estado online não deixa
     erro permanente, expiração pede revalidação sem exibir bytes negados e uma
     troca para `r2` substitui a página integralmente; nenhum bloco/asset de `r1`
     é misturado com `r2`.

7. **`large-pdf` — visualizador nativo e expiração da aba independente.**
   - **Precondições:** PDF sintético ≥20 MiB, revisão publicada e sessão recém emitida.
   - **Passos:** abra o link nativo em nova aba; observe GET e requests Range do
     visualizador. Mantenha a aba PDF independente por mais de cinco minutos e
     tente carregar outra página/range; volte ao Portal e abra o PDF novamente.
   - **PASS:** PDF não é baixado inteiro por JS; requests nativos iniciais autorizam
     bytes da revisão; depois da expiração independente, nova faixa é negada sem
     prometer renovação fora do Portal; reabrir pelo Portal emite nova sessão e
     funciona. Não trate bytes previamente entregues como revogáveis.

8. **`auth-exit-cross-tab` — logout, BroadcastChannel, storage fallback e emissão tardia.**
   - **Precondições:** duas abas com A, mídia aberta, tab separada para logout e
     capacidade de observar o canal `ownerinc-contents-invalidation` e a chave
     `ownerinc-contents-invalidation`.
   - **Passos:** primeiro deixe BroadcastChannel ativo; faça logout/troca A→B na
     outra aba e confirme invalidação. Repita com `BroadcastChannel` desabilitado
     antes de carregar as abas, usando o evento `storage` real do logout (não
     escreva valores artificiais na chave). Em uma terceira tentativa atrase a
     resposta de `POST /api/contents/media-session`, faça logout/troca de conta
     antes de liberá-la e então complete a resposta. Faça novo GET com cookie
     revogado.
   - **PASS:** ambas as abas limpam fontes/lease e suspendem mídia por
     BroadcastChannel e pelo fallback storage; identidade nova exige `/users/me`;
     a emissão tardia não ativa URL/cookie para identidade antiga e é limpa; GET
     subsequente com sessão revogada é negado sem bytes. Registro contém somente
     status/IDs sintéticos, nunca payload do canal ou cookie.

9. **`gallery-keyboard` — lightbox, backdrop, inert e mídia.**
   - **Precondições:** galeria com pelo menos três itens, conteúdo ao fundo com
     foco/scroll e vídeo nativo ativo.
   - **Passos:** abra pelo botão, use Tab/Shift+Tab, ArrowLeft/ArrowRight (incluindo
     wrap), Escape; reabra e clique apenas no backdrop, depois no diálogo; inspecione
     `inert`, foco inicial/contido/restaurado, rolagem e estado prévio de estilos.
   - **PASS:** diálogo tem nome/posição atual, foco permanece dentro e volta ao
     acionador, setas fazem wrap, Escape/backdrop fecham sem clique interno acidental,
     fundo fica inert enquanto aberto e o estado anterior de inert/scroll é
     restaurado; vídeo pausa ao fechar/ocultar.

10. **`screen-reader-gallery` — árvore e anúncio real.**
    - **Precondições:** browser e leitor de tela reais; registre versões e
      configuração/modo de navegação, sem capturar áudio/pessoal.
    - **Passos:** abra a galeria; percorra título, imagem/alt/caption, posição e
      controles; avance/volte, feche por Escape e backdrop; repita com foco vindo
      do acionador e com conteúdo de fundo inert.
    - **PASS:** leitor anuncia diálogo/modal, título, alt/caption útil, índice e
      rótulos dos controles; foco não escapa para o fundo e é restaurado; mudanças
      são anunciadas sem duplicação. Snapshot de DOM/harness não substitui este caso.

11. **`embeds-effective-csp` — CSP entregue e playback provider.**
    - **Precondições:** páginas publicadas com URLs canônicas YouTube e Vimeo;
      resposta via Nginx do stack descartável.
    - **Passos:** leia o header CSP efetivo em resposta 200; abra cada embed e
      observe console, request/frame e início de playback; tente URLs adulteradas
      somente na UI de fixture, sem ampliar allowlist.
    - **PASS:** `frame-src` efetivo inclui somente origens canônicas necessárias,
      sem wildcard ampliado; YouTube/Vimeo canônicos carregam e reproduzem; entradas
      inválidas não emitem frame. CSP estática no arquivo, sem resposta Nginx, é
      insuficiente.

12. **`layout-mobile` — 60 variantes de bloco e quatro larguras.**
    - **Precondições:** fixtures das 60 combinações acima; browser com emulação
      320, 375, 768 e 1440 CSS px, zoom 100% e 200%, toque e `prefers-reduced-motion`.
    - **Passos:** em cada largura percorra os cinco layouts e o default omitido para
      os dez tipos, incluindo galeria/lightbox, vídeo, PDF, embed e texto longo;
      repita a 200% e com reduced motion, role dispositivos touch e use screenshots
      sanitizadas dos pontos de quebra.
    - **PASS:** 60 variantes são renderizadas sem transbordamento horizontal,
      conteúdo encoberto, foco invisível, crop indevido de mídia, scroll preso ou
      iframe fora do gutter; layout omitido equivale a `content`; controles touch,
      zoom e reduced motion permanecem utilizáveis. Registre cada largura/DPR, não
      uma única screenshot representativa.

13. **`bfcache-cleanup` — pageshow.persisted e dez ciclos.**
    - **Precondições:** browser real que suporte BFCache, listener/Network/Memory
      observável e fixture autenticada com mídia/galeria.
    - **Passos:** execute pelo menos dez ciclos entrar→abrir mídia/galeria→navegar
      para outra área→Voltar; em cada retorno capture o booleano de
      `pageshow.persisted`, listener count, diálogos, áudio e scroll lock. Faça ao
      menos um retorno BFCache verdadeiro.
    - **PASS:** ao congelar/retomar há limpeza idempotente, sem listeners,
      diálogos/áudio/locks duplicados; sessão/identidade são revalidadas e a mídia
      só volta após `/users/me`/renovação válidos. Se `persisted` nunca for true,
      este caso é `NOT_EXECUTED`, não PASS simulado.

14. **`owner-news-regression` — News, Academy e editor.**
    - **Precondições:** páginas sintéticas publicadas, editor acessível e browser
      autenticado; estado inicial capturado por URL/título, sem conteúdo pessoal.
    - **Passos:** navegue News→detalhe/retorno, Academy→aula, editor→lista/visualização
      e volte a Conteúdos; teste links nativos, shell persistente, refresh e Back/
      Forward sem salvar nem publicar dados preexistentes.
    - **PASS:** News/Academy/editor continuam navegáveis e autenticados, shell e
      permissões não mudam, nenhuma rota/dado editorial é alterado e voltar a
      Conteúdos mantém loaders/foco corretos. Testes offline não satisfazem o smoke
      browser.

15. **`editorial-accessibility` — PDF, vídeo, embed e conteúdo manual.**
    - **Precondições:** exemplos publicados sintéticos dos dez tipos, PDF marcado,
      vídeo com legendas/transcrição e provider embed; ferramenta de inspeção PDF
      e tecnologia assistiva disponível.
    - **Passos:** percorra ordem de headings/links/alt/captions por teclado e leitor;
      inspecione estrutura/tags/ordem de leitura do PDF no visualizador/editor
      escolhido; verifique legendas/transcrição/alternativa para vídeo e nome/controles
      do embed.
    - **PASS:** sequência de leitura corresponde à ordem visual/lógica; headings,
      links, imagens, PDF e vídeo têm nomes/alternativas suficientes; PDF marcado
      e legível sem depender da apresentação visual; embed é identificável e
      operável. Registre ferramenta/versão e achados sem copiar o conteúdo do fixture.

#### Registro JSON sanitizado

O fragmento abaixo é **somente um registro de forma** com estado atual
`NOT_EXECUTED`; não é prova de execução e um array de uma linha sempre retorna
código 2 por omissão dos outros casos. Duplique-o uma vez por nome exato em
`REQUIRED_CASES`. Para PASS/FAIL substitua os timestamps nulos e todos os valores
`NOT_EXECUTED` por observações reais: timestamp UTC, browser/version, dimensão da
viewport, passos e resultado verificado. Nunca acrescente credenciais/cookies.

```json
[
  {
    "case": "live-auth-gate",
    "commit": "a554bcb4eac5759b68caa2638be22147f6698028",
    "runId": "a72e87b2-f750-4d51-88e3-ffe8d92a6a68",
    "environment": "disposable-local; NOT_EXECUTED; no stack started",
    "startedAt": null,
    "finishedAt": null,
    "browser": "NOT_EXECUTED",
    "viewport": "NOT_EXECUTED",
    "scenario": "NOT_EXECUTED: live-auth-gate prerequisites unavailable",
    "status": "NOT_EXECUTED",
    "artifact": null,
    "notes": "NOT_EXECUTED: state only; no secrets or personal data"
  }
]
```

PASS metadata is validated, not inferred from this template. `artifact` must be
`null` or a safe relative path inside the private evidence directory; sanitise
screenshots to remove user data and never persist HAR, headers, response bodies,
Firebase tokens, cookies, storage state or session identifiers.

### Preparação e limpeza de fixtures

Quando a execução real estiver autorizada, primeiro documente o identificador do
projeto Compose descartável, volumes e portas e confirme que ele não compartilha
banco/uploads com runtime. Use o Auth Emulator para identidades sintéticas; não
confunda isso com Firebase real. Pelo CMS/editorial UI e protocolos existentes,
prepare: viewer ativo A e B, editor com `manageKnowledge`, conta inativa, estado
sem publicação, catálogo de ao menos 13 páginas em duas categorias, amostras para
os cinco layouts e layout omitido, galerias/imagens, vídeo superior a seis
minutos, PDF de pelo menos 20 MiB dentro do limite de ingress e exemplos canônicos
de YouTube/Vimeo. Inclua textos longos e assets com tamanhos/hash conhecidos.
Registre UUIDs/revisões sintéticos fora do repositório.

Use controles existentes para publicar/despublicar e gerar revisões; não crie
rotas, SQL ou protocolo de publicação especial para o teste. Depois de concluir,
use a UI editorial para despublicar/remover somente os fixtures criados pela
execução e confirme a lista/estado. Preserve os dados preexistentes. Encerre
somente o stack descartável explicitamente autorizado pelo procedimento daquele
ambiente; não use `down -v` ou remova volumes sem autorização explícita. Se nenhum
serviço tiver sido iniciado, registre `cleanup: none; no local stack or fixtures
created`. Mantenha o manifest sanitizado externo para auditoria.

## Regressões automatizadas

`npm run verify` executa testes offline, incluindo os módulos Contents, shell,
auth, Academy e Owner News. Para revisar a geração do shell sem escrever:

```sh
node scripts/generate-public-shell.mjs --check
git diff --check
```

Esses checks cobrem contratos e integração com harnesses; não comprovam auth
HTTP real, tráfego Range/native streaming, playback de provider, CSP efetiva,
leitor de tela, Firebase real ou BFCache do browser.
