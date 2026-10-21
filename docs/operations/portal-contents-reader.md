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
4. Monte todas as 60 fixtures da matriz vinculante do [caso layout-mobile](#case-layout-mobile):
   cada um dos dez tipos `heading`, `rich_text`, `image`, `gallery`, `video`, `pdf`,
   `embed`, `callout`, `link`, `divider` com `content`, `wide`, `full`, `left`,
   `right`, e outro exemplar por tipo omitindo a propriedade `layout`. Nenhuma
   página pode ser publicada sem validação editorial de campos e referências.
5. Abra um browser real e anote produto/versão, versão do sistema, viewport/DPR e
   zoom. Grave `startedAt` antes da primeira ação e `finishedAt` depois da última.
   Use DevTools/Network para status, headers, revisões, transferência incremental,
   cancelamento e chamadas de sessão; não exporte HAR bruto.
6. Para cada caso abaixo siga a ordem **precondições → passos → PASS**. Um subpasso
   que não pôde ser executado não é PASS. Registre o caso inteiro como
   `NOT_EXECUTED` (ou `FAIL` se foi executado e falhou); não infira resultado de
   harness/offline.

#### Casos de serviço, browser e revisão

<a id="case-live-auth-gate"></a>
1. **`live-auth-gate` — identity, zero-publication navigation gate and route authorization.**
   - **Precondições:** viewer A ativo, conta inativa, sessão sem login, CMS/API
     funcionais e fixture recém criada com **zero publicações**. Abra três abas
     autenticadas de A antes de publicar; mantenha cache desabilitada em DevTools
     na aba de deep-link.
   - **Passos:**
     1. Com zero publicações, carregue o shell e aguarde um probe real
        `GET /api/contents/availability` com `cache: no-store`; registre status,
        `{available:false}` e `.contents-link` hidden. Não avalie o gate antes da
        identidade estar validada.
     2. Enquanto o link segue oculto, navegue diretamente para
        `/contents.html?category=<slug-sintetico>` em uma aba autenticada recém
        aberta, com **Disable cache** ativo. Confirme que a rota monta independente
        do link/gate, e que o list request usa a origem atual e resposta
        `private, no-store`; com zero resultados, a UI mostra estado vazio, não
        redirect/403 por causa do gate. Repita sem query em `/contents.html`;
        confirme que o direct URL não depende de link anterior ou cache.
     3. Sem acionar probes nas três abas preparadas, publique a primeira página.
        Use uma aba por trigger, sem outro evento entre publicação e leitura:
        (a) navegue a outra rota do shell e volte (fresh navigation/
        `portal:navigated`); (b) em outra aba vá para background e retorne
        (`visibilitychange`); (c) em outra aba use DevTools offline e depois online
        (`online`). Confirme no Network que cada trigger provoca um novo probe e
        que a sidebar só revela o link após `{available:true}`. Se não for possível
        isolar um trigger, registre só esse subpasso `NOT_EXECUTED`.
     4. Repita `GET /api/users/me`, availability, list, categories e detail sem
        autenticação, como A e como conta inativa; anote apenas status/forma, nunca
        tokens/corpos privados. Como A publique `r1`, salve/publique `r2`, confira
        `revision.id`, e então despublique somente o slug sintético e consulte-o.
     5. Se houver falha CMS segura no stack descartável, desabilite somente essa
        dependência pelo procedimento autorizado; confirme indisponibilidade/503,
        não `available:false`, e restaure antes de encerrar. Não invente rota/SQL.
   - **PASS:** zero publicação oculta o link, mas não bloqueia deep-link autenticado;
     publicação revela o link após cada probe independente de navigation, visibility
     e online. Cache desligada/no-store não muda autorização da rota. Sem sessão ou
     conta inativa não há DTO privado (401/403); A vê só DTO publicado, `r2`
     substitui `r1`, draft nunca é exposto, e despublicação retorna 404. Falha CMS
     segura resulta indisponibilidade/503. Cada trigger não executado fica explícito.

<a id="case-catalog-routing"></a>
2. **`catalog-routing` — independent category retry, native links and query canonicalization.**
   - **Precondições:** browser autenticado como A, 13+ páginas em duas categorias,
     e DevTools Network aberto com captura sanitizada.
   - **Passos:**
     1. Faça request blocking somente de `/api/contents/categories`. Confirme que
        a lista/cards carregam, enquanto a navegação de categorias apresenta erro
        e botão de retry. Clique **Tentar novamente**; confirme um request
        categories-only, sem novo list/detail, reset de conteúdo, foco ou scroll.
        Retire o bloqueio, repita o retry e selecione categoria; repita também na
        página 2, registrando request counts antes/depois.
     2. Abra um card por clique simples e confirme navegação interna sem reload do
        shell. Repita com `Ctrl+click` (Windows/Linux), `Meta+click` (macOS), botão
        do meio e `Shift+Enter`: os gestos modificados mantêm a navegação nativa
        nova aba/janela em vez de navegar na aba atual. Abra um bloco Link sintético
        com `new_tab=true` e confira `_blank`/`noopener noreferrer`; link sem essa
        opção preserva navegação normal do shell.
     3. Carregue `?category=<slug>&page=2` nas duas ordens; verifique URL canônica
        `category` antes de `page`, com `page=1` omitida. Adicione parâmetro
        inocente `utm_source=fixture` e confira que ele não permanece na URL de
        aplicação após canonicalização.
     4. Teste individualmente duplicatas reconhecidas
        (`category=a&category=b`, `slug=a&slug=b`, `page=2&page=3`) e valores
        hostis/não canônicos (`category=__proto__`, `slug=%2F..%2Fadmin`, `page=01`,
        `page=0`, page/offset acima do limite, `redirect=https://example.invalid`).
        Confira URL final, request type/status e DOM; nenhum valor recusado pode se
        tornar slug/categoria/offset ou HTML. Query bruta não vai para artifacts.
     5. Teste refresh, Back/Forward, paginação, categoria+página, detalhe direto,
        retorno ao catálogo e slug sintético despublicado.
   - **PASS:** lista usa 12 por página; category retry refaz somente categories;
     modified/new-tab gestures mantêm comportamento nativo. Parâmetros aceitos são
     canonizados; duplicatas/valores hostis não viram dados nem markup. Back/Forward/
     refresh preservam shell/foco e não mostram resposta antiga; slug despublicado
     retorna 404 seguro.

<a id="case-native-image"></a>
3. **`native-image` — media session, native GET and private original-path denial.**
   - **Precondições:** página A publicada com imagem/revisão conhecida. O registro
     privado da fixture pode conter a referência original `cms-private`; nunca
     copie `storage_key`/caminho para evidência.
   - **Passos:** no Network confirme `POST /api/contents/media-session` sem body,
     mesmo Origin e identidade válida; carregue imagem nativa em
     `/api/contents/assets/<pageId>/<revisionId>/<assetId>`. Repita emissão com
     Origin inválido só no ambiente descartável. Com e sem autenticação, tente
     uma vez `/uploads/cms-private/<referencia-sintetica>` para esse asset; não
     enumere diretórios nem tente mídias de outros produtos. Guarde só status e
     tamanho retornado, sem guardar a referência.
   - **PASS:** emissão válida retorna 204 sem body e cookie `Secure; HttpOnly;
     SameSite=Strict; Path=/api/contents/assets` (nome de produção) ou nome dev
     exclusivo de loopback; asset responde 200 com MIME/headers privados esperados.
     Origin inválido é negado; token/cookie não aparece em URL/DOM/log. O caminho
     original retorna 404 (ou negação explícita configurada), sem bytes/redirect;
     somente a URL opaca autorizada do Portal entrega a mídia.

<a id="case-native-range"></a>
4. **`native-range` — prefix, open-ended, suffix, unsatisfiable and streaming.**
   - **Precondições:** vídeo/PDF válidos com tamanho/hash conhecidos e sessão
     válida; use arquivo de tamanho `N > 2048`, anotando só `N`, não bytes.
   - **Passos:** solicite asset sem Range; em requisições separadas envie
     `Range: bytes=0-1023` (prefix), `Range: bytes=1024-` (open-ended satisfatível),
     `Range: bytes=-1024` (suffix), `Range: bytes=N-` (offset exatamente no fim,
     insatisfatível) e `Range: bytes=0-1,3-4` (multi-range não suportado). No
     DevTools observe headers/primeiro bloco antes do fim do arquivo; provoque
     seek no vídeo e feche/pare o recurso depois do primeiro bloco para cancelar.
   - **PASS:** GET integral é 200; faixas satisfatíveis são 206 com
     `Accept-Ranges`, `Content-Range` e `Content-Length` exatos. `bytes=1024-`
     responde `Content-Range: bytes 1024-(N-1)/N` e `Content-Length: N-1024`.
     `bytes=N-` e multi-range retornam 416, `Content-Range: bytes */N`, corpo
     vazio. O browser recebe blocos incrementais, não corpo inteiro via JS;
     cancelamento termina transferência e libera recursos sem sucesso falso.

<a id="case-long-video-renewal"></a>
5. **`long-video-renewal` — hidden-tab playing renewal and authorized seek after minute five.**
   - **Precondições:** vídeo seekable sintético >8 min, conta A ativa, relógio
     real e DevTools Network aberto; não manipule relógio do cliente.
   - **Passos:**
     1. Inicie playback por gesto do usuário e confirme estado playing/lease ativo.
        Coloque a aba em background/minimize sem pausar o vídeo; mantenha-a hidden
        ao cruzar o renew alvo de 4 min. Ao retornar confira request de renewal
        feito enquanto hidden ou no `visibilitychange`/focus, e que playback
        avançou sem reset de source/time.
     2. Em ciclo separado registre `performance.now()`, `currentTime` e source na
        emissão. Depois de **mais de cinco minutos** desde a emissão, acione seek
        pelo player para marcador sintético 6:00. Observe session renewal e confirme
        seek/playback autorizado no marcador; não reutilize URLs/cookies antigos.
     3. Como controle negativo, faça expirar/negue a sessão no ambiente autorizado;
        confirme que ação negada não entrega nova mídia nem é registrada como PASS.
   - **PASS:** o POST de renewal ocorre por volta de 4 min com vídeo ainda playing
     em aba hidden ou no primeiro recheck após retorno; source/time não resetam e
     o vídeo não pausa. Seek do usuário após minuto cinco renova/revalida e chega
     ao marcador sem trocar identidade/revisão. Registre tempo monotônico real;
     ausência do trigger/evento fica FAIL ou `NOT_EXECUTED`, nunca inferida.

<a id="case-media-failure-recovery"></a>
6. **`media-failure-recovery` — suspend past expiry, PDF href removal and measured bounded retries.**
   - **Precondições:** página `r1` com vídeo e PDF, `r2` com conteúdo diferente,
     duas sessões sintéticas; controle local aprovado para falhar somente a
     renovação POST de mídia. Para medir backoff use 503 sem `Retry-After` e mantenha
     a aba foreground, visível e sem throttling. Faça cada subcaso em lease nova.
   - **Passos:**
     1. Prepare vídeo e PDF, pause o vídeo e confirme pause state (não `playing`).
        Deixe a página sem uso até ultrapassar TTL de 5 min (suspenda/background
        somente se o browser realmente suspender a aba). Na expiração verifique
        vídeo paused e ambos os anchors PDF sem `href`, `aria-disabled=true`; não
        tente abrir link antigo salvo.
     2. Retorne foreground e acione o retry visível do Portal. Confirme nova emissão
        autorizada e, só depois de success, reativação do vídeo/PDF. Em outra lease
        deixe a tentativa retomar e falhar; nos controles negativos 401/403 não
        deve ocorrer repetição automática nem entrega de bytes.
     3. Para backoff, deixe a primeira renovação falhar em `t0`. Marque no relógio
        monotônico timestamp da resposta de cada tentativa e do próximo POST:
        retry automático #1 em `t0 + 5 s`; após sua falha, #2 em `+15 s`; após a
        falha #2, #3 em `+30 s`. Não injete 429 nesse subcaso, pois Retry-After
        pode aumentar o intervalo. Capture as medições e status, sem body/headers
        com credenciais.
     4. Depois da falha do retry #3, deixe a aba visível, sem focus/online/user
        action por pelo menos 60 s; conte os requests. Em seguida clique uma vez
        no retry de UI e confirme que recovery manual pode iniciar um novo ciclo.
     5. Em ciclo separado simule offline → online; injete 429 com Retry-After e
        confira que o tempo indicado não é ignorado. Publique `r2`, retente o detail
        completo e compare revisão/blocos sintéticos de ponta a ponta.
   - **PASS:** após expiry vídeo está pausado e PDF open/download anchors não têm
     `href` até renewal válida; retry autorizado volta a preparar os recursos. Sem
     429, medições não mostram retries antecipados e seguem nominalmente 5/15/30 s;
     depois do terceiro retry falho não há quarto automático durante a janela de
     60 s, mas a ação manual pode recuperar. 429 respeita no mínimo Retry-After,
     online não deixa erro permanente, expiração nega bytes e `r2` substitui
     integralmente `r1`. Se timer/background/network não puderem ser medidos, use
     `NOT_EXECUTED`, não arredonde a sequência para PASS.

<a id="case-large-pdf"></a>
7. **`large-pdf` — standalone expiry after Portal lease release and viewer/download fallback.**
   - **Precondições:** PDF sintético ≥20 MiB, revisão publicada, sessão nova,
     downloads direcionados a diretório descartável e browser/profile/version
     anotados. Confirme hash sintético antes do teste sem anexar arquivo.
   - **Passos:**
     1. No Portal abra o PDF nativo em nova aba e confirme GET/Range. Enquanto a
        lease do Portal está ativa, teste **Abrir PDF** e **Baixar PDF** como ações
        distintas: registre se o browser abre viewer, prompt ou download; quando
        houver arquivo baixado, compare tamanho/hash com fixture sem guardar bytes.
     2. Feche a aba original do Portal ou navegue-a para fora do reader para
         disparar lease release; mantenha só a aba independente do PDF. Após
         **5+ min**, peça uma nova faixa (fresh navigation/reload nativo, não bytes já
        em cache) e registre status/bytes. Volte a abrir o PDF pelo Portal em uma
        nova sessão válida e repita a faixa.
     3. Em browser/profile de teste sem viewer PDF embutido (quando suportado),
        clique **Abrir PDF** e registre o fallback fornecido pelo próprio browser
        (open-with/download prompt/arquivo). Confirme separadamente que **Baixar
        PDF** continua uma ação disponível enquanto lease válida; não prometa
        viewer customizado do Portal.
   - **PASS:** PDF não passa por fetch/blob JS; a aba standalone perde autorização
     para nova requisição depois de expirar cookie/lease do Portal (`401/403`, zero
     novos bytes), mesmo que bytes previamente entregues continuem visíveis. Release
     do Portal não deve renovar a aba autônoma. Reabrir via Portal reemite lease e
     volta a responder. Os resultados open/download e o fallback sem viewer são
     observados por browser/version; comportamento nativo documentado não é
     confundido com falha da aplicação.

<a id="case-auth-exit-cross-tab"></a>
8. **`auth-exit-cross-tab` — failed clear retry, editorial revoke and cross-tab invalidation.**
   - **Precondições:** viewer A com conteúdo/mídia em duas abas, usuário/editor
     sintético com `manageKnowledge`, uma aba para logout e capacidade de observar
     `ownerinc-contents-invalidation` BroadcastChannel e storage key. Use falhas
     controladas apenas no stack descartável.
   - **Passos:**
     1. Force o DELETE de clear media session a falhar uma vez (503) enquanto
        `revokeEditorialSession` está disponível. Inicie logout. Confirme conteúdo
        ocultado imediatamente, Portal ainda não confirma sign-out, alerta de falha
        e retry único habilitado. Restaure DELETE, clique retry e confirme que
        revogação editorial + media clear terminam antes do sign-out; cheque que
        nenhum segundo sign-out ocorre após UID mudar.
     2. Em ciclo isolado, com `manageKnowledge`, abra página editorial e confirme
        sessão editorial revogável. Use o logout existente do Portal; registre a
        chamada de revoke editorial e confirme que cookie/sessão antiga não abre
        endpoint protegido nem preview. Não imprima cookie ou response body.
     3. Com BroadcastChannel nativo, faça logout e depois troca A→B na aba emissora;
        confirme na outra que media sources/lease são invalidados e identidade
        revalidada via `/users/me`. Repita em profile fresco com BroadcastChannel
        desabilitado **antes de abrir as duas abas**. Observe o `storage` event
        efetivamente produzido pelo logout (set/remove da chave); não escreva nem
        simule manualmente payload na chave. Repita logout e troca de conta.
     4. Atrase uma resposta de `POST /api/contents/media-session`, mude/logout da
        conta antes de liberar a resposta e depois conclua-a. Faça GET nativo com
        cookie revogado nas duas abas.
   - **PASS:** falha no clear mantém conteúdo oculto e impede sign-out até retry
     confirmar clear/revoke; a sessão editorial antiga é recusada após revoke.
     Logout/troca invalida duas abas por BroadcastChannel e, separadamente, pelo
     storage fallback real. Nova identidade requer `/users/me`; emissão tardia não
     instala lease/URL para A; request revogado nega bytes. Registre status, ordem,
     elapsed time e contagens, nunca payload do canal/storage, IDs sensíveis,
     token, cookie, header ou body.

<a id="case-gallery-keyboard"></a>
9. **`gallery-keyboard` — persistent failed-next, reload, focus fallback, Back and backdrop isolation.**
   - **Precondições:** galeria com ≥3 imagens, reader com heading focusable,
     conteúdo ao fundo com foco/scroll e vídeo ativo; profile de teste com DevTools
     Network blocking apenas para a segunda imagem sintética.
   - **Passos:**
     1. Abra pelo trigger, avance para a segunda imagem bloqueada. Confirme status
        persistente e retry; clique retry com o bloqueio ainda ativo e confirme
        erro terminal e ação **Recarregar conteúdo**. Clique nela depois de remover
        o bloqueio; confira detail/list request esperado, lightbox encerrado ou
        reconstruído sem imagem velha e retry não duplicado.
     2. Reabra a galeria, remova pelo DevTools **somente no DOM desta aba de teste**
        o botão opener enquanto dialog está aberto e feche Escape. Confirme que
        foco cai no heading seguro do reader, não no body nem elemento removido.
     3. Reabra, então use browser Back real (sem `history.pushState` artificial).
        Confirme URL/reader/catalog correspondente, dialog fechado, listeners e
        scroll lock limpos; Forward retorna à rota sem reabrir dialog.
     4. Teste pointer pairs com mesmo pointerId: down no backdrop/up no painel e
        down no painel/up no backdrop **não** fecham; apenas down+up no backdrop
        fecham. `pointercancel` também não fecha.
     5. Em viewport mobile abra o sidebar drawer e confirme seu foco/expanded state;
        feche o drawer, abra lightbox e confirme que drawer fica fechado/inert,
        toggle não entra no Tab loop e backdrop do dialog não aciona o drawer.
        Feche e confira estado de sidebar/scroll anterior restaurado.
   - **PASS:** falha na imagem seguinte oferece recovery até persistir, então uma
     única ação de reload recupera sem imagem velha. Opener removido usa o heading fallback;
     router Back fecha overlay e limpa; gesto de arrasto entre dialog e
     backdrop não fecha; mobile drawer não concorre com foco/overlay. Tab/Shift+Tab,
     setas/wrap, Escape, foco/inert/scroll e pausa do vídeo também permanecem corretos.

<a id="case-screen-reader-gallery"></a>
10. **`screen-reader-gallery` — árvore e anúncio real.**
    - **Precondições:** browser e leitor de tela reais; registre versões e
      configuração/modo de navegação, sem capturar áudio/pessoal.
    - **Passos:** abra a galeria; percorra título, imagem/alt/caption, posição e
      controles; avance/volte, feche por Escape e backdrop; repita com foco vindo
      do acionador e com conteúdo de fundo inert.
    - **PASS:** leitor anuncia diálogo/modal, título, alt/caption útil, índice e
      rótulos dos controles; foco não escapa para o fundo e é restaurado; mudanças
      são anunciadas sem duplicação. Snapshot de DOM/harness não substitui este caso.

<a id="case-embeds-effective-csp"></a>
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

<a id="case-layout-mobile"></a>
12. **`layout-mobile` — explicit 10 × 5 layouts + omitted default, sidebar states and ≥44px controls.**
    - **Precondições:** uma página sintética válida com ao menos um de cada bloco
      listado na matriz abaixo; browser real/emulado em 320, 375, 768 e 1440 CSS px,
      DPR anotado, zoom 100%/200%, toque e `prefers-reduced-motion`. Para 320/375
      use o breakpoint mobile que o browser realmente aplicar.
    - **Matriz vinculante:** crie uma fixture por célula; cada uma é exercitada nas
      quatro larguras e nos dois zooms. A coluna `default omitido` deve omitir a
      propriedade JSON `layout` de propósito (não escrever `"layout":"content"`).

      | Bloco | `content` | `wide` | `full` | `left` | `right` | `default omitido` |
      | --- | --- | --- | --- | --- | --- | --- |
      | `heading` | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot |
      | `rich_text` | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot |
      | `image` | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot |
      | `gallery` | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot |
      | `video` | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot |
      | `pdf` | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot |
      | `embed` | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot |
      | `callout` | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot |
      | `link` | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot |
      | `divider` | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot | Executar + screenshot |

      Matriz = 60 variantes: dez blocos × cinco valores explícitos + dez omissões.
      Não substitua células por uma captura de uma variante de cada bloco.
    - **Passos:**
      1. Em cada viewport percorra todas as células e registe a variante/layout,
         overflow horizontal, ordem de leitura, gutters, crop, foco, embeds e
         comportamento de mídia; repita com 200% zoom e reduced motion.
      2. Em 320 e 375 px repita com sidebar mobile **expanded** e **collapsed**.
         Em ambas confira shell, conteúdo, foco/inert, drawer, scroll e retorno ao
         estado inicial; confirme que o reader continua diretamente navegável.
      3. Meça com `getBoundingClientRect()` largura e altura em CSS px de cada
         controle touch usado: toggle/sidebar, categorias, paginação, botões da
         galeria, retry, PDF open/download e ações equivalentes. Registre o menor
         par observado (W×H) por largura/estado. Teste toque real ou emulação touch.
      4. Use somente screenshots sanitizadas, sem URL query, identidade, UUID,
         storage/cookie ou conteúdo pessoal.
    - **PASS:** as 60 células renderizam sem overflow, clipping, foco invisível,
      crop indevido, scroll preso ou iframe fora do gutter; omissão equivale a
      `content`. Sidebar expanded/collapsed é operável. Cada controle touch medido
      tem **W ≥44 CSS px e H ≥44 CSS px** em cada viewport/estado; zoom 200%, toque
      e reduced motion continuam utilizáveis. Registre todas as 60 células, quatro
      larguras, ambos zooms e sidebar states; uma célula sem observação invalida PASS.

<a id="case-bfcache-cleanup"></a>
13. **`bfcache-cleanup` — real `pageshow.persisted` restoration over ten cycles.**
    - **Precondições:** browser real com suporte BFCache, usuário A ativo e reader
      com vídeo/galeria; DevTools/console de teste aberto para observar apenas
      boolean `PageTransitionEvent.persisted`, listeners/counts e timings.
    - **Passos:**
      1. Faça dez ciclos completos: entrar em Conteúdos → abrir vídeo/galeria →
         navegar para outra rota same-origin → usar botão Back real. Em cada retorno
         registre o `pageshow.persisted` daquele evento; não force `persisted` nem
         construa evento sintético.
      2. Para ao menos um ciclo obtenha **`pageshow.persisted === true`** comprovado
         no evento de retorno da página Conteúdos. Nesse ciclo compare listener/
         overlay/dialog, áudio/video paused, scroll lock, foco e identity before/
         after. Verifique `/api/users/me`/identidade validada antes de novo media
         session POST e reativação de mídia.
      3. Se o browser decidir `persisted=false`, registre esse ciclo mas continue
         tentando somente por navegações seguras; não invente restore via reload.
    - **PASS:** dez ciclos foram contados e pelo menos um retorno real reportou
      `persisted=true`; handlers/dialogs/locks não duplicam, mídia pausada/limpa e
      conteúdo só volta após revalidação atual e lease nova autorizada. `persisted`
      em falso em todos os dez = `NOT_EXECUTED` para esta aceitação (não PASS por
      limpeza convencional); falha na restauração verdadeira = FAIL.

<a id="case-owner-news-regression"></a>
14. **`owner-news-regression` — editorial logout and Owner News unchanged.**
    - **Precondições:** notícia sintética já publicada, Academy item sintético,
      editor acessível a `manageKnowledge` e browser Portal autenticado; anote
      estado Owner News anterior por rota/status/count de fixture, sem título/body
      ou dado pessoal.
    - **Passos:**
      1. Navegue Owner News lista→detalhe→retorno, Academy→aula e editor→lista/
         visualização; percorra links nativos, refresh e Back/Forward e retorne a
         Conteúdos sem editar/publicar/substituir dados preexistentes.
      2. Em sessão sintética `manageKnowledge`, confirme acesso editorial; execute
         logout/revoke editorial existente. Confirme sessão editorial revogada e
         que o Portal auth permanece no estado esperado; tente uma ação/leitura
         protegida do editor e registre negação/redirect sem cookie.
      3. Abra novamente Owner News via fluxo normal e compare endpoints/status,
         número de fixtures e acesso pré/pós editorial logout. Não rode migration,
         não altere dados, não reuse session cookie. Se for necessário testar Portal
         logout completo, faça-o em ciclo separado e depois autentique A novamente.
   - **PASS:** logout/revoke editorial bloqueia sessão editorial antiga, sem
     quebrar sessão Portal ou alterar publicação/rota/permissão de Owner News;
     Owner News, Academy e editor seguem seus fluxos normais e nenhum dado muda.
     Se logout editorial não puder ser isolado do logout Portal no stack usado,
     registre essa separação `NOT_EXECUTED`, não conclua Owner News unchanged por
     uma simples renderização offline.

<a id="case-editorial-accessibility"></a>
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

#### Registro JSON sanitizado e observações seguras

O fragmento abaixo é **somente um registro de forma** com estado atual
`NOT_EXECUTED`; não é prova de execução e um array de uma linha sempre retorna
código 2 por omissão dos outros casos. Duplique-o uma vez por nome exato em
`REQUIRED_CASES`. Para PASS/FAIL substitua os timestamps nulos e todos os valores
`NOT_EXECUTED` por observações reais: timestamp UTC, browser/version, dimensão da
viewport, passos e resultado verificado. Nunca acrescente credenciais/cookies.
Mantenha exatamente o schema aceito pelo agregador: `scenario` identifica a
condição + trigger sob teste (ex.: `publish; trigger=visibilitychange;
direct_route=loaded`) e `notes` recebe pares sanitizados `key=value`, separados
por `;` (ex.: `availability_status=200; elapsed_ms=5012; link_hidden_before=true;
link_visible_after=true; retry_delay_ms=5012; range_status=206;
range_start=1024; layout=left; viewport_css=375x844; sidebar=expanded;
bfcache_persisted=true; focus=contents-title`). Para medições múltiplas use
contagens/tempos/status/booleanos, não IDs nem valores brutos. Use `artifact` só
para screenshot/log já redigido dentro do evidence directory privado; caso a
imagem revele URL, conteúdo, identidade, email, cookies ou query, não a guarde.
Nunca registre URLs completas/queries, page/revision/asset UUIDs, nome/storage key,
corpo/bytes do PDF, cookie/token, Authorization, valores de localStorage/
BroadcastChannel, resposta JSON privada, HAR ou informação pessoal. Os screenshots
do grid podem ser particionados por layout/viewport, desde que a referência
sanitizada permita conferir cada célula da matriz.

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
    "scenario": "NOT_EXECUTED: live-auth-gate; trigger=not-run",
    "status": "NOT_EXECUTED",
    "artifact": null,
    "notes": "NOT_EXECUTED: state only; observations=none; no secrets or personal data"
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
sem publicação, catálogo de ao menos 13 páginas em duas categorias, **todas as
60 combinações** da matriz `layout-mobile` (dez blocos × cinco layouts + um
layout omitido por bloco), galerias/imagens, vídeo seekable >8 min para as ações
pós-minuto cinco, PDF de pelo menos 20 MiB dentro do limite de ingress e exemplos
canônicos de YouTube/Vimeo. Inclua textos longos e assets com tamanhos/hash
conhecidos. Registre referências sintéticas fora do repositório; não copie UUIDs,
revision IDs nem storage keys para evidência.

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
