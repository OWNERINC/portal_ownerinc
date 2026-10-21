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

Cada registro tem exatamente `case`, `commit`, `runId`, `environment`, `browser`,
`viewport`, `scenario`, `status`, `artifact` e `notes`. `commit` é o SHA sob teste;
run ID e commit devem ser iguais em todo o manifest. Inclua browser/version e
viewport reais em PASS. A tabela completa, cenário, status e bloqueadores da
execução são registrados na [matriz de aceite](../reviews/2026-10-20-portal-contents-reader-acceptance.md).

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
