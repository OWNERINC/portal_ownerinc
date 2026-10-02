# Owner News — aceite integrado local A3

## Resultado e alcance

**DONE_WITH_CONCERNS — software validado localmente; acervo real e publicação
pendentes.** Execução em 30/09/2026 sobre `7bb0e0dc5d9edcd250b226c5b451a9790dc89594`.
Esta rodada acrescenta documentação de aceite, sem alterações de produto.

O aceite parcial autorizado usa exclusivamente fixtures sintéticas. As **cinco
candidatas reais continuam `needs_review`**. O PDF da edição foi adiado pelo
usuário, assim como a decisão sobre registros incompletos/de teste. Não houve
aprovação, importação, publicação ou retirada de conteúdo real nesta rodada.
A contagem final de matérias canônicas das duas fontes permanece **indeterminada**;
30 artigos de teste não representam essa contagem. A importação histórica descrita
no inventário não equivale ao aceite do novo pacote editorial.

## Ambiente e verificações repetíveis

- Somente a stack isolada `ownerinc-news-editorial`, Portal `localhost:8081`,
  Auth Emulator `127.0.0.1:9199`, PostgreSQL local na porta `55439`.
- Host Node **24.15.0**; API baseada em Node **24.12.0**, PostgreSQL 16.
  Compatibilidade integral das dependências com Node 18 não foi verificada.
- Edge/Chromium via Playwright, autenticação real, CSP normal, três contextos
  independentes: editor local existente e dois colaboradores `viewer` temporários.
- A API foi reconstruída pelo wrapper local com `up -d --no-deps --build api`.
  O emulator não foi recriado. Reinícios apenas da API zeraram o rate limiter
  entre rodadas; os limites e configurações do produto foram preservados.
- Inspeção de montagem confirmou
  `ownerinc-news-editorial_uploads_data` → **`/app/uploads`**. O CLI do importador
  executou dentro dessa API, como usuário `node`, usando seu banco e volume reais.

| Check executado | Resultado |
| --- | --- |
| Oito arquivos unitários enumerados no brief A3 | **104 PASS**, zero falhas |
| `scripts/test-migrations.mjs`, via wrapper privado local | **PASS**, runner repetido e integração de migrations |
| `scripts/test-owner-news-integration.mjs`, via wrapper privado local | **PASS**, PostgreSQL real, papéis, importação, publicação, home, enquetes e concorrência; fixtures limpas |
| `npm run verify` | **900 PASS**, zero falhas; demais verificadores concluídos |
| `git diff --check` | **PASS** |
| Jornada browser/HTTP integrada A3 | **PASS**, 14 grupos de asserções |
| Suplemento browser com PDF/título longo/resposta tardia/saída de área | **PASS**, 3 grupos |
| Consulta final de limpeza no banco e Auth Emulator | **PASS**, zero fixtures A3 restantes |

Comandos dos checks de repositório:

```sh
node --test tests/unit/owner-news-editorial.test.mjs tests/unit/owner-news-home.test.mjs tests/unit/owner-news-api.test.mjs tests/unit/owner-news-frontend.test.mjs tests/unit/owner-news-reader.test.mjs tests/unit/owner-news-polls.test.mjs tests/unit/owner-news-polls-frontend.test.mjs tests/unit/owner-news-bundle.test.mjs
npm run test:migrations
node scripts/test-owner-news-integration.mjs
npm run verify
git diff --check
```

Migrations e integração requerem a configuração privada de banco descartável e
autorização local descritas em [Desenvolvimento local](../operations/local-development.md).
Nesta execução, o wrapper forneceu esse ambiente e invocou o script correspondente
a `npm run test:migrations`. Nenhuma credencial pertence ao relatório.

## Importador e assets através da API real

Pacote sintético preparado com 30 artigos nativos, uma PNG compartilhada e decisões
sintéticas aprovadas. O conteúdo inclui capa opcional, introdução, dupla left/right,
imagem wide com legenda/crédito, perfil e citação. O CLI real executou:

1. Dry-run: `prepared=30`, `draftsCreated=0`, sem conflitos.
2. Apply-draft: `draftsCreated=30`, `assetsCreated=1`, `published=0`.
3. Inspeção HTTP autenticada dos drafts e de sua mídia.
4. Publish: `published=30`, `verifiedPublications=30`, `verifiedAssets=1`.
5. Novo dry-run: 30 publicações verificadas.

Hashes do manifesto sintético da execução aprovada:

```text
bundle_sha256  74edb1dc3af6366ad76252506dd6865d2408a10fd6378ecf07cbb2d579039d57
content_sha256 040ff239b83c850a07c9d0044d3d3ce982b2e86fc69fd72fa1cee867736e61ac
```

| Fase/identidade | Rota real | Resultado |
| --- | --- | --- |
| Draft/editor | `/api/cms/assets/:id` | 200, `image/png`, 9.193 bytes, SHA-256 idêntico à fixture |
| Draft/colaborador | mesma rota | **403**, sem bytes da imagem |
| Draft/colaborador | `/api/announcements/:id` e `/api/cms/documents/:id` | **404**, conteúdo privado indisponível |
| Publicado/editor e dois colaboradores | `/api/cms/assets/:id` | **200** nas três sessões, mesmo MIME/tamanho/hash |
| PDF sintético complementar/editor, no suplemento | mesma rota de assets | **200**, `application/pdf`, 414 bytes, hash idêntico |

```text
PNG SHA-256 028ec887815d9b11ba07c4ad421edb44ff3b2624c439e2ee231800c7d2a0ad87
PDF SHA-256 c7b6f3dd95c14017019ded89dbd4c08fd239c28ce22e5633cf646a981dad7bff
```

Assim, **2 assets sintéticos únicos** tiveram leitura HTTP com verificação de bytes;
a PNG importada também foi conferida com ambos os colaboradores. O PDF foi upload
CMS sintético, não importação/leitura do PDF real da edição. `verifiedAssets` isolado
não foi usado como substituto desse teste HTTP.

## Cenários funcionais

| Cenário | Status e evidência |
| --- | --- |
| Card com editoria e página 2 selecionadas | **PASS**: 30 publicações reais no banco de teste, página 24–29 com seis cards; abre overlay/URL interna |
| Anterior além da primeira página | **PASS**: vizinho comparado com API ordenada da mesma categoria; troca substitui entrada do histórico |
| Voltar/Escape e Back/Forward | **PASS**: card/foco/scroll restaurados (diferença inferior a 2 px); Forward reabre última matéria |
| URL direta, refresh e Dashboard | **PASS**: reader individual real; retorno funcional ao catálogo |
| Resposta antiga após troca rápida | **PASS**: resposta HTTP real deliberadamente retida; troca para vizinho; resposta liberada não substitui título atual |
| Trocar área com reader aberto | **PASS**: router real, overlay removido, blob PDF revogado, shell sem inert residual e Escape antigo inativo |
| Logout com reader aberto | **PASS**: retorno ao login e remoção do reader/inert |
| Dois colaboradores votando | **PASS**: sessões independentes, escolhas distintas e total 2 persistem após refresh; resultados 50%/50% |
| Requests simultâneos da mesma escolha | **PASS**: duas respostas idempotentes, total permanece 2; corrida de primeiro voto também coberta pela integração PostgreSQL |
| Encerrar enquanto chega primeiro voto de outro usuário | **PASS**: chamadas HTTP concorrentes; encerramento 200 e voto 409 `poll_closed` na execução final; estado fechado e total 2 |
| Falha somente da enquete | **PASS**: 503 injetado exclusivamente nessa rota; artigos continuam vindo da API real e cards permanecem disponíveis |
| CMS preview/autosave/publish/schedule | **PASS**: edição pela UI, autosave real e resumo na prévia; publicação/agendamento usam a revisão retornada pelo save imediatamente anterior à ação |
| Isolamento de revisão agendada | **PASS**: resumo futuro agendado não substitui resumo publicado; promoção/cancelamento cobertos na integração PostgreSQL |
| Retirada durante leitura | **PASS**: unpublish real; novo acesso 404 com mensagem de indisponibilidade e Voltar funcional |
| PDF complementar | **PASS sintético**: iframe com blob autorizado expande inline, corpo nativo anterior/posterior continua presente |

O teste de troca de área usa clique programático no link do shell para forçar a
saída enquanto o diálogo mantém o restante da página inert. O overlay de menu
lateral fechado conserva seu próprio inert intencional; isso não é vazamento do
reader. A navegação natural por Voltar/Escape é verificada separadamente.

## Inspeção visual

Capturas privadas da abertura/categorias/mosaico, enquete aberta/resultados e
reader (topo, imagem larga/perfil e final), com medidas reais:

| Viewport CSS medido | Largura do main | Catálogo | Dupla editorial |
| --- | ---: | --- | --- |
| 1440 × 900 | 1204 px | Sem overflow horizontal | Mesma linha |
| 1024 × 768 | 788 px | Sem overflow horizontal | Mesma linha |
| 390 × 844 | 390 px | Duas colunas, sem overflow horizontal | Empilhada |

Conferidos: título sobre capa, marca sem capa, tipografia serif no corpo, metadados
monoespaçados, imagem wide/legenda/crédito, perfil, citação e título longo contido
no hero. Enquete escura com texto branco e escolha/percentuais legíveis. Escala
**CSS zoom 200%** passou sem overflow do reader; isso **não comprova o zoom nativo
do navegador nem uma auditoria completa com tecnologia assistiva**.

A comparação estrutural usa o CSS privado da referência já coletado: papel quente,
Manrope/DM Mono, masonry com proporções variadas, enquete escura e título sobre
hero. As capturas sintéticas verificam essa construção no espaço do Portal;
não são aprovação pixel a pixel, curadoria da fotografia/copy real ou confirmação
de paridade com mudanças posteriores da referência. Ver
[registro de design e fontes](../design/2026-09-30-owner-news-acceptance.md).

## Limites, intercorrências e limpeza

- **BLOCKED/deferred**: revisão das cinco candidatas, reconciliação editorial das
  duas fontes, PDF real, contagem canônica final e aprovação de conteúdo/mídia real.
- **BLOCKED/não autorizado**: snapshot/manifesto específico do destino publicado,
  equivalência de content hash nesse destino, importação/publicação e smoke em
  produção. Estado final: **validado localmente; publicação pendente**.
- `/favicon.ico` 404 e avisos preexistentes de módulo Cards Pós permanecem no
  histórico da homologação; não se declara console global inteiramente limpo.
  Nas jornadas A3 aprovadas não houve exceções `pageerror`. HTTPs 403/404/409 e
  o 503 induzido pertencem aos cenários negativos registrados.
- Uma tentativa longa atingiu o limite existente de 300 requests/15 minutos por
  IP (429). Foram reduzidas requisições redundantes de capas e reiniciada apenas
  a API local entre rodadas; o limite não foi relaxado. Não é teste de carga.
- Ajustes do harness: verificar email dos usuários sintéticos no emulator;
  esperar 403 para asset draft e 404 para documento privado; comparar publicação
  com o save da ação, não com autosave anterior; reconhecer inert intencional do
  menu fechado. Não exigiram correção de produto.
- A cópia temporária de código no container precisou de cleanup como root porque
  Compose cp preservou propriedade de diretórios. Remoção limitada a
  `/tmp/a3-code` e `/tmp/a3-data`; uploads removidos pela API após apagar somente
  documentos sintéticos rastreados. Nenhum diretório de uploads foi limpo em lote.
- Consulta final: **0 documentos, 0 assets, 0 usuários, 0 enquetes A3** no banco;
  **0 usuários A3** no Auth Emulator. Auditoria sintética normal permanece.
  Serviços locais permanecem disponíveis. Manifestos/snapshots/screenshots e
  relatórios JSON de teste ficam na área privada; nenhuma fonte real foi copiada
  para Git/public.

Os runners locais e o relatório completo de tarefa estão na área ignorada de
coordenação (`task-A3-report.md`). Evidências privadas: `privateDir/A3-synthetic/`,
incluindo `result.json`, `supplement-result.json`, `cleanup-result.json`, manifesto
sintético, capturas e extração estrutural do CSS de referência. `privateDir` é
resolvido exclusivamente pela configuração local privada; não há credenciais
ou conteúdo editorial real neste documento.
