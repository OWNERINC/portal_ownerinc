# Payload CMS — plano do go-live acelerado sem migração inicial

> **Execução:** implementar em três PRs sequenciais. Cada PR recebe CI verde,
> revisão fresca e aceite antes da próxima. Não executar duas fatias mutáveis em
> paralelo e não fazer mudanças produtivas durante os PRs 1 e 2. O PR 3 prepara o
> caminho protegido; o cutover real continua sendo uma operação manual aprovada.

**Goal:** ativar o Payload como única autoridade de escrita para novas Owner News,
sem importar o acervo existente, mantendo o legado somente leitura no mesmo feed e
preservando autenticação, autorização, isolamento, backup/restore, HTTPS,
observabilidade e recuperação fail-closed.

**Architecture:** separar autoridade de escrita de composição de leitura. A máquina
durável existente (`legacy | frozen | payload | payload_frozen`) continua decidindo
quem pode escrever. A leitura passa a consultar legado e Payload por origem,
normalizar ambos para o mesmo DTO e fazer merge determinístico por cursor. O Payload
inicia com o domínio Owner News vazio, sem worker nem endpoints de agendamento. Um
preflight privado prova readiness, modo manual e ausência de mutações antes da
ativação; depois da primeira mutação aceita, o ledger torna o floor Payload
irreversível. A instalação usa um contrato manual próprio, sem relaxar o receiver
`payload-v1` do programa de migração completa.

**Tech stack:** API Express/CommonJS, frontend JavaScript estático, Payload/Next.js/
TypeScript, PostgreSQL 16, Docker Compose, Nginx, GitHub Actions, Bash/Python
operacional e testes Node sem dependências externas.

**Design aprovado:**
[`docs/superpowers/specs/2026-10-26-payload-cms-accelerated-go-live-design.md`](../specs/2026-10-26-payload-cms-accelerated-go-live-design.md)

---

## 1. Baseline que a implementação deve preservar

- A autoridade persistida já usa `legacy`, `frozen`, `payload` e
  `payload_frozen` em `api/owner-news/authority.js`.
- Somente `legacy` e `payload` permitem escrita; os dois estados congelados e todo
  estado ilegível recusam escrita.
- O bridge privado Portal → Payload já existe em
  `api/owner-news/payload-client.js` e `cms/src/endpoints/portal-news.ts`.
- Login do admin, identidade do Portal e autorização no servidor já existem. Esta
  entrega deve testá-los e completar o wiring, não criar uma autenticação paralela.
- O overlay `docker-compose.payload.yml` já separa banco, usuários, volume e imagem
  do CMS. `cms-worker` ainda entra no conjunto padrão e precisa ser retirado dele.
- Nginx já bloqueia externamente `/editorial/api/portal-news/*` e publica o admin
  sob `/editorial`; esses limites não podem ser alargados.
- O receiver `production:payload-v1` permanece fechado por
  `release_not_preflighted`. Ele pertence ao protocolo de migração completa e não
  será enfraquecido para esta entrega.
- O formato coordenado de backup Payload já contém banco e uploads dos dois
  runtimes. Reutilizar sua validação e restore; não criar um formato incompatível.
- O frontend atual usa UUID sem origem e paginação por offset. Ambos precisam mudar
  de modo compatível para impedir colisões e deslocamento entre páginas.

## 2. Contratos transversais a congelar no PR 1

### 2.1 Autoridade e leitura

| Modo durável | Writer legado | Writer Payload | Leitura legado | Leitura Payload |
|---|---:|---:|---:|---:|
| `legacy` | sim | não | sim | sim, se saudável |
| `frozen` | não | não | sim | sim, se saudável |
| `payload` | não | sim | sim | sim |
| `payload_frozen` | não | não | sim | sim |
| ausente/desconhecido | não | não | erro controlado | erro controlado |

Autoridade nunca seleciona uma única fonte de leitura. Ela seleciona exclusivamente
o writer. Falha de leitura não muda autoridade e nunca reabre escrita legada.

### 2.2 Identidade pública source-aware

Toda notícia publicada entregue pelo backend público terá:

```js
{
  source: 'legacy' | 'payload',
  id: '<uuid>',
  // campos editoriais existentes
}
```

A identidade é o par `(source, id)`. Não concatenar os campos em um UUID falso e
não substituir IDs existentes. Cards, links, detalhe e navegação carregam os dois
campos:

```text
/announcements.html?id=<uuid>&source=legacy
/announcements.html?id=<uuid>&source=payload
```

Compatibilidade: links antigos sem `source` resolvem **somente** como `legacy`.
Nunca procurar nas duas fontes para “adivinhar” a origem.

Mídia continua usando scopes separados:

```text
legacy  -> /api/cms/assets/:id
payload -> /api/announcements/assets/:id
preview -> /api/announcements/preview/assets/:id
```

O validador deve exigir consistência entre `source` e `asset_scope`; um DTO Payload
com scope legado, ou o inverso, falha fechado.

### 2.3 Ordenação e cursor

Usar uma comparação única, documentada e testada:

1. `published_at` decrescente;
2. `source` crescente, com ordem fixa `legacy`, `payload`;
3. `id` crescente em lowercase.

O cursor público é uma string base64url versionada, limitada em tamanho, que codifica
somente `{ v: 1, published_at, source, id }`. O servidor decodifica e valida todos os
campos; campos extras, base64 inválido, datas inválidas e versões desconhecidas
retornam `400 invalid_request`.

Cada fonte recebe o limite global e a fronteira decodificada, retorna no máximo
`limit + 1`, e o agregador escolhe os primeiros `limit` pela comparação canônica. O
próximo cursor corresponde ao último item emitido. Assim, uma publicação mais nova
inserida após a primeira página não desloca nem duplica as páginas seguintes.

Na primeira entrega, a UI troca números de página por “Anterior” e “Próxima”. O
histórico guarda a pilha de cursores em `history.state`; a URL pode carregar o cursor
atual, mas nunca dados privados. Categoria e tipo integram a chave da pilha. Trocar
filtro invalida os cursores anteriores.

### 2.4 Degradação

- `list`, `categories`, `navigation` e `home` podem compor resposta parcial.
- `detail`, `asset` e `preview` são direcionados por origem e nunca fazem fallback.
- Uma fonte saudável + uma fonte indisponível retorna sucesso com
  `X-Owner-News-Read-State: degraded`.
- Uma resposta degradada não emite próximo cursor: ela pode mostrar os itens
  saudáveis da página inicial, mas não pode afirmar uma travessia completa que
  pularia itens quando a outra fonte se recuperar.
- Duas fontes saudáveis retornam `X-Owner-News-Read-State: complete`.
- As duas fontes indisponíveis retornam `503 news_unavailable`.
- A resposta pública não informa stack, URL, credencial ou razão interna. O log
  estruturado registra `requestId`, ação e fonte indisponível, sem conteúdo.
- `404` de um detalhe conhecido por origem continua `404`; não deve ser convertido
  em degradação nem provocar consulta à outra fonte.

Para `home`, usar a abertura publicada do Payload quando presente; caso contrário,
usar a abertura legada. Indisponibilidade de uma fonte segue a regra de degradação.
Para categorias, unir por nome e somar contagens. Para navegação, aplicar a mesma
ordem global do feed; se só uma fonte responder, marcar a resposta como degradada.

### 2.5 Ponto de não retorno

O baseline de ativação contém o `sequence` e o hash do
`owner_news_mutation_head`. Qualquer incremento confirmado depois da ativação —
inclusive draft, upload, alteração da home ou publicação — torna rollback para
`legacy` proibido. Excluir depois o objeto não apaga esse fato.

Uma tentativa recusada ou uma transação abortada não é mutação aceita. Resultado
desconhecido fecha a autoridade em `payload_frozen` até reconciliação; nunca autoriza
rollback por ausência presumida.

---

## 3. Comandos comuns

Em toda tarefa, executar primeiro o teste focado. No fechamento de cada PR:

```sh
npm run verify
npm run security
git diff --check
```

Quando imagem, dependência ou runtime CMS mudar:

```sh
npm run sbom
CMS_BUILD_ONLY=true npm --prefix cms run build
npm run typecheck:cms
```

Checks Docker/PostgreSQL/Linux que não puderem rodar no checkout Windows devem ser
executados no job isolado correspondente. Registrar `PASS`, `FAIL` e `SKIP`
separadamente. Double offline não substitui restore, HTTPS ou smoke real.

---

# PR 1 — convivência de leitura e autoridade

**Resultado:** Portal entende identidade source-aware, combina as duas fontes com
cursor estável e degrada parcialmente. Todos os writers continuam governados pela
autoridade existente. Payload permanece privado e sem autoridade de escrita.

### Task 1: Congelar o contrato source-aware e o cursor

**Files:**

- Create: `api/owner-news/feed.js`
- Modify: `api/owner-news/payload-dto.js`
- Modify: `cms/src/contracts/news.ts`
- Modify: `cms/src/auth/service-access.ts`
- Modify: `cms/src/news/queries.ts`
- Modify: `cms/src/news/to-dto.ts`
- Modify: `tests/unit/owner-news-payload-api.test.mjs`
- Create: `tests/unit/owner-news-unified-feed.test.mjs`
- Modify: `cms/tests/unit/news-queries.test.ts`
- Modify: `docs/operations/owner-news-payload-read-bridge.md`

**Step 1: escrever testes RED do DTO**

Adicionar casos que exigem `source: 'payload'` em todo DTO retornado pelo bridge,
inclusive vizinhos. Rejeitar origem ausente/desconhecida, campos extras, UUID
inválido e combinações inválidas de `source`/`asset_scope`. Preservar o contrato
especial de preview (`preview_revision.source`) sem confundi-lo com a origem pública
do documento.

**Step 2: escrever testes RED do cursor e do comparator**

Em `owner-news-unified-feed.test.mjs`, cobrir:

- data decrescente e desempate exato por origem/ID;
- mesmo UUID em legado e Payload como dois itens;
- encode/decode round-trip;
- versão, tamanho, shape, data, source e UUID inválidos;
- cursor selecionando somente itens posteriores;
- nova notícia inserida antes do cursor sem duplicar/deslocar a página seguinte;
- `limit + 1` definindo corretamente `nextCursor`.

Exportar de `feed.js` somente helpers puros e o agregador necessários aos testes;
não exportar detalhes internos sem uso.

**Step 3: implementar o contrato privado Payload**

Adicionar `source: 'payload'` em `NewsDTO` e em referências de navegação. Estender o
input privado de `list` com fronteira opcional já decodificada e estritamente
validada. Em `queryPublishedNews`, filtrar antes de limitar e usar ordenação
determinística por `publishedAt` e `id`.

Não mandar o cursor público opaco ao CMS: o Portal valida/decodifica e envia apenas
a fronteira tipada. O CMS ainda valida novamente o input privado.

**Step 4: implementar helpers puros**

`feed.js` deve fornecer:

```js
compareNews(a, b)
encodeNewsCursor(item)
decodeNewsCursor(value)
mergeNewsPages({ legacy, payload, limit })
```

O merge não deduplica por título, data ou UUID isolado. Duplicata dentro da mesma
origem é erro de contrato, não item silenciosamente removido.

**Step 5: verificar e commitar**

```sh
node --test tests/unit/owner-news-unified-feed.test.mjs tests/unit/owner-news-payload-api.test.mjs
cd cms
node --import tsx --test tests/unit/news-queries.test.ts
cd ..
git diff --check
git commit -m "feat(news): define source-aware feed contract"
```

---

### Task 2: Implementar adapters e composição dual no backend

**Files:**

- Modify: `api/cms/reader.js`
- Modify: `api/owner-news/backend.js`
- Modify: `api/owner-news/payload-client.js`
- Modify: `api/owner-news/payload-dto.js`
- Modify: `api/routes/announcements.js`
- Modify: `tests/unit/owner-news-reader.test.mjs`
- Modify: `tests/unit/owner-news-payload-api.test.mjs`
- Modify: `tests/unit/owner-news-unified-feed.test.mjs`

**Step 1: substituir o teste de exclusividade por testes de convivência**

Remover deliberadamente a expectativa “Payload outage never falls back to legacy
content” somente para operações compostas. Substituí-la por:

- modo `payload` continua lendo legado e Payload;
- modo `legacy` pode ler Payload publicado sem conceder escrita;
- falha Payload entrega legado degradado;
- falha legado entrega Payload degradado;
- resposta degradada não emite `nextCursor`;
- falha dupla retorna 503;
- detalhe/asset source-directed nunca consultam a outra origem;
- estado de autoridade ilegível retorna 503 e não consulta fontes.

Manter e reforçar a invariante de que degradação de leitura não chama transição de
autoridade nem libera writer.

**Step 2: adicionar adapter legado**

Normalizar saída de `api/cms/reader.js` com `source: 'legacy'` e
`asset_scope: 'legacy'`. Adicionar consulta keyset com a fronteira global. Não mudar
o storage nem copiar conteúdo. As consultas devem continuar excluindo revisão
inválida/não publicada.

**Step 3: decompor o backend por tipo de operação**

Em `backend.js`, substituir o branch exclusivo por três caminhos explícitos:

1. `runCompositeRead` para list/categories/navigation/home;
2. `runDirectedRead` para detail/asset;
3. `runPreview` para editor autorizado.

Cada chamada captura sucesso/falha por fonte sem engolir `404`/`403`. O backend
retorna `{ value, readState }` internamente; a rota converte `readState` em header.
Não expor objetos `Error`, URLs privadas ou resposta bruta do CMS.

**Step 4: implementar list, categorias, home e navegação**

- List: buscar até `limit + 1` de cada fonte, fazer merge e emitir cursor.
- List degradada: entregar a primeira fatia saudável sem cursor de continuação;
  depois da recuperação, o cliente reinicia a travessia completa.
- Categorias: unir nomes normalizados exatamente como os contratos atuais e somar
  contagens; uma fonte inválida é indisponível, não “zero”.
- Home: preferência Payload apenas quando há conteúdo publicado válido; ausência
  legítima usa legado, falha entra no estado degradado.
- Navegação: confirmar que o item corrente existe na origem solicitada e calcular
  vizinhos na ordem global. Colisão de UUID entre fontes deve navegar corretamente.

**Step 5: adaptar a rota pública**

Aceitar `cursor` na lista e `source` em detalhe/navegação. Ausência de `source` em
detalhe/navegação vira `legacy`. Emitir:

```text
X-Owner-News-Read-State: complete|degraded
X-Owner-News-Next-Cursor: <cursor>   # somente quando houver próxima página
```

Manter `Cache-Control: private,no-store`. Validar CR/LF e tamanho antes de colocar
qualquer valor em header. O total pode permanecer informativo, mas não governa a
navegação por cursor.

**Step 6: logar degradação de forma sanitizada**

Usar o logger/request ID já adotado pela API. Emitir um evento por request composto,
não um por item. Campos permitidos: código fixo, ação, fonte e `requestId`.

**Step 7: verificar e commitar**

```sh
node --test \
  tests/unit/owner-news-unified-feed.test.mjs \
  tests/unit/owner-news-payload-api.test.mjs \
  tests/unit/owner-news-reader.test.mjs
git diff --check
git commit -m "feat(news): compose legacy and payload reads"
```

---

### Task 3: Tornar URLs, assets e navegação do frontend source-aware

**Files:**

- Modify: `public/js/auth.js`
- Modify: `public/js/announcements.js`
- Modify: `public/js/dashboard.js`
- Modify: `public/js/owner-news/asset-path.mjs`
- Modify: `public/js/owner-news/catalog.js`
- Modify: `public/js/owner-news/navigation.js`
- Modify: `public/js/owner-news/reader-view.js`
- Modify: `public/js/pagination.js`
- Modify: `tests/unit/owner-news-frontend.test.mjs`
- Modify: `tests/unit/owner-news-reader.test.mjs`

**Step 1: escrever regressões RED de identidade**

Cobrir dois cards com o mesmo UUID e origens diferentes. Exigir IDs DOM distintos,
links distintos, abertura do detalhe correto, vizinhos com origem e retorno ao card
correto. Cobrir bookmark antigo sem `source` como legado.

**Step 2: transportar metadados de paginação**

Estender `requestAPI` sem quebrar consumidores existentes para retornar também o
cursor e o estado de leitura obtidos dos headers. Não entregar o objeto `Headers`
bruto aos componentes.

Trocar o uso de `offset` em Owner News por um controle anterior/próxima específico
ou modo cursor de `pagination.js`. Não alterar paginação das outras áreas.

**Step 3: atualizar roteamento do reader**

`createNewsNavigation` passa a operar com `{ source, id }`. Validar `source` antes de
alterar URL/history. `returnState.cardId` inclui ambos. Eventos de card, clique
interceptado, deep link, previous/next, back/forward e foco restaurado preservam a
origem.

**Step 4: aplicar origem aos assets**

`asset-path.mjs` recebe DTO/scope consistente e nunca escolhe endpoint apenas porque
o modo global é Payload. Conteúdo legado continua em `/api/cms/assets`; conteúdo
Payload usa `/api/announcements/assets`. Preview permanece separado.

**Step 5: adaptar dashboard e highlight**

Links do destaque e cards do dashboard incluem `source`. A consulta de highlight usa
a primeira página do cursor, sem `offset=0`. Falha parcial não apaga conteúdo válido.

**Step 6: verificar e commitar**

```sh
node --test \
  tests/unit/owner-news-frontend.test.mjs \
  tests/unit/owner-news-reader.test.mjs
npm run verify
git diff --check
git commit -m "feat(news): preserve source in reader navigation"
```

---

### Task 4: Fechar a documentação e o gate do PR 1

**Files:**

- Modify: `docs/architecture/data-flow.md`
- Modify: `docs/operations/owner-news-payload-read-bridge.md`
- Modify: `docs/operations/payload-owner-news.md`
- Modify: `tests/unit/owner-news-payload-api.test.mjs`
- Modify: `tests/unit/operations-invariants.test.mjs`

**Step 1: documentar a separação read/write**

Registrar a matriz de autoridade, identidade `(source,id)`, cursor, headers de
degradação e compatibilidade de bookmarks. Remover qualquer texto que diga que o
modo Payload elimina leitura legada.

**Step 2: adicionar invariantes estáticas**

Provar que endpoints privados continuam bloqueados no Nginx, respostas mantêm
`private,no-store`, nenhuma credencial entra no DTO e nenhum fallback de leitura
invoca writer/transição.

**Step 3: gate do PR 1**

```sh
npm run verify
npm run security
git diff --check
git commit -m "docs(news): document dual-source read behavior"
```

**Aceite PR 1:** feed dual testado, identidade sem colisão, cursor estável,
degradação observável e writers inalterados. Não há deploy nem mudança produtiva.

---

# PR 2 — runtime mínimo e publicação somente manual

**Resultado:** runtime Payload instalável em ambiente isolado, admin autenticado,
Owner News vazio, criação/draft/upload/publicação manual funcionais, schedules e
worker indisponíveis, backup/restore e reinício comprovados. Ainda sem cutover.

### Task 5: Introduzir o perfil manual-only e retirar agendamentos

**Files:**

- Modify: `cms/src/config/environment.ts`
- Modify: `cms/src/payload.config.ts`
- Modify: `cms/src/collections/NewsArticles.ts`
- Modify: `cms/src/collections/NewsSchedules.ts`
- Modify: `cms/src/endpoints/news-schedule.ts`
- Modify: `cms/src/admin/ScheduleRevision.tsx`
- Modify: `docker-compose.payload.yml`
- Modify: `ops/compose.payload.production.yaml`
- Modify: `.env.example`
- Modify: `cms/tests/unit/environment.test.ts`
- Create: `cms/tests/unit/manual-publication-mode.test.ts`
- Modify: `cms/tests/unit/news-schedule-worker.test.ts`
- Modify: `tests/unit/payload-infrastructure.test.mjs`

**Step 1: escrever testes RED do modo manual**

Exigir `CMS_PUBLICATION_MODE=manual` no runtime desta entrega. Valor ausente,
desconhecido ou com whitespace falha no startup. No modo manual:

- componente `ScheduleRevision` não aparece;
- endpoints de schedule não são registrados (404 externo, não 403 cosmético);
- coleção de schedules não aparece no admin;
- jobs de publicação não são registrados;
- criar draft, atualizar e publicar manualmente continuam disponíveis;
- `cms-worker` não inicia no perfil padrão.

**Step 2: implementar configuração única**

Adicionar `publicationMode: 'manual'` ao parser de ambiente e usar esse valor para
montar config/admin. Não espalhar flags independentes para UI, endpoint e worker.
Manter código adiado compilável, porém não alcançável nesse perfil.

**Step 3: perfilar o worker**

Adicionar profile explícito, por exemplo `scheduled-publication`, em
`docker-compose.payload.yml` e no override de produção. Nenhum comando do go-live
usa esse profile. Adicionar teste que inspeciona a configuração resolvida e recusa
réplica de worker no conjunto manual.

**Step 4: verificar e commitar**

```sh
cd cms
node --import tsx --test tests/unit/manual-publication-mode.test.ts tests/unit/environment.test.ts
cd ..
npm run typecheck:cms
node --test tests/unit/payload-infrastructure.test.mjs
git diff --check
git commit -m "feat(payload): enforce manual publication profile"
```

---

### Task 6: Criar preflight privado de ativação vazia e mutação zero

**Files:**

- Modify: `cms/src/auth/service-access.ts`
- Modify: `cms/src/endpoints/portal-news.ts`
- Create: `cms/src/publication/go-live-preflight.ts`
- Modify: `cms/src/publication/mutation-ledger.ts`
- Modify: `cms/src/publication/mutation-triggers.ts`
- Modify: `api/owner-news/payload-client.js`
- Modify: `api/owner-news/payload-dto.js`
- Create: `cms/tests/unit/go-live-preflight.test.ts`
- Modify: `cms/tests/unit/news-mutation-ledger.test.ts`
- Modify: `cms/tests/unit/news-mutation-sql.test.ts`
- Modify: `tests/unit/owner-news-payload-api.test.mjs`

**Step 1: definir o resultado estrito**

Adicionar ação privada `preflight`, acessível somente pelo secret Portal → Payload,
com resposta limitada:

```ts
type GoLivePreflight = {
  ready: true
  publicationMode: 'manual'
  authority: { mode: 'frozen' | 'payload_frozen'; epoch: number }
  newsEmpty: boolean
  mutation: { sequence: string; chainSha256: string; writeBarrier: string }
  counts: { articles: number; media: number; homePublished: number; schedules: number }
}
```

Não retornar nomes de arquivo, usuários, conteúdo, SQL, URLs ou credenciais. O
Portal valida chaves exatas, inteiros e hash.

**Step 2: testar preflight fail-closed**

Cobrir authority fora de estado congelado, modo não manual, documento/draft, mídia,
home publicada, schedule, ledger ausente/parcial, sequence inválida, barreira fechada
e erro DB. Qualquer condição retorna erro controlado; não converter falha em
`newsEmpty: true`.

**Step 3: garantir cobertura do ledger**

Provar em SQL/testes que mutações aceitas de artigo, mídia e home avançam a cadeia,
inclusive draft e upload antes da publicação. Schedule permanece zero e inacessível
no perfil manual. Uma transação abortada não avança a cabeça; create seguido de
delete deixa sequência maior que o baseline.

**Step 4: integrar o cliente privado**

Adicionar `preflight` à allowlist e aos validadores sem torná-lo rota pública do
Portal. Nginx continua retornando 404 para o endpoint CMS privado. Somente o script
de cutover do PR 3 consumirá esta ação.

**Step 5: verificar e commitar**

```sh
cd cms
node --import tsx --test tests/unit/go-live-preflight.test.ts tests/unit/news-mutation-ledger.test.ts tests/unit/news-mutation-sql.test.ts
cd ..
node --test tests/unit/owner-news-payload-api.test.mjs
npm run typecheck:cms
git diff --check
git commit -m "feat(payload): expose private empty-state preflight"
```

---

### Task 7: Provar runtime, persistência, backup e restore

**Files:**

- Modify: `docker-compose.payload.yml`
- Modify: `ops/compose.payload.production.yaml`
- Modify: `scripts/payload-operations.sh`
- Modify: `scripts/backup.sh`
- Modify: `scripts/restore.sh`
- Create: `scripts/integration/payload-manual-runtime.mjs`
- Create: `tests/unit/payload-manual-runtime.test.mjs`
- Modify: `tests/unit/payload-operations.test.mjs`
- Modify: `tests/unit/backup-s3.test.mjs`
- Modify: `docs/operations/payload-owner-news.md`
- Modify: `docs/operations/payload-runtime-recovery.md`

**Step 1: manter banco/volume/credenciais isolados**

Revisar o Compose resolvido e testar que CMS usa `cms-postgres`,
`cms_postgres_data`, `cms_uploads_data` e roles próprias; nenhum volume do legado é
montado no CMS e nenhuma credencial admin/control entra no processo web. Preservar
limites de CPU/memória, `no-new-privileges`, rede privada, healthcheck e logs
rotacionados.

**Step 2: escrever a fixture nativa manual-only**

Em PostgreSQL 16 descartável:

1. provisionar e migrar banco vazio;
2. iniciar API/CMS sem worker;
3. provar readiness privada;
4. autenticar editor autorizado e recusar usuário não autorizado;
5. criar artigo, enviar mídia, salvar draft e publicar manualmente;
6. confirmar ausência de endpoint/controle de schedule;
7. reiniciar CMS e PostgreSQL;
8. reler draft/publicação/mídia byte a byte;
9. executar backup coordenado;
10. restaurar em destino descartável independente;
11. repetir leitura e comparar IDs, status, hash e bytes.

Bloquear egress externo desnecessário na fixture. Não registrar token, cookie,
conteúdo ou arquivo enviado.

**Step 3: reutilizar o formato de backup existente**

O caminho enxuto deve chamar os mesmos validadores do backup `payload-v1` para
`postgres.dump`, `uploads.tar.gz`, `cms-postgres.dump`, `cms-uploads.tar.gz`, imagens
e manifestos. Se for necessário extrair helpers, fazê-lo sem mudar o formato.
Restore sempre cria backup de proteção e mantém serviços parados em falha.

**Step 4: separar readiness de health**

Health comprova processo vivo; readiness comprova DB, schema, storage e config
manual válidos. O admin não é publicado apenas porque o processo responde TCP.
Adicionar negativos para DB indisponível, diretório não gravável, schema incompleto
e modo de publicação inválido.

**Step 5: executar prova nativa**

```sh
node --test tests/unit/payload-manual-runtime.test.mjs tests/unit/payload-operations.test.mjs
PAYLOAD_MANUAL_RUNTIME_DISPOSABLE=1 node scripts/integration/payload-manual-runtime.mjs
```

O segundo comando pertence ao job Linux/Docker aprovado. Sem opt-in descartável ele
deve sair sem mutar nada e nunca alegar PASS.

**Step 6: verificar e commitar**

```sh
npm run verify
npm run security
npm run sbom
CMS_BUILD_ONLY=true npm --prefix cms run build
git diff --check
git commit -m "test(payload): prove manual runtime recovery"
```

**Aceite PR 2:** fixture nativa prova publicação manual, autorização, persistência e
restore; worker/schedules estão ausentes. Produção e autoridade continuam intactas.

---

# PR 3 — cutover protegido e dispatch manual

**Resultado:** existe um caminho manual, restrito e reentrante para instalar o
runtime vazio, congelar writers, ativar Payload, publicar o admin e executar aceite.
Rollback para legado só é possível com prova de mutation sequence inalterada.

### Task 8: Completar a máquina de cutover com preflight e floor

**Files:**

- Modify: `api/owner-news/authority.js`
- Create: `api/db/migrations/037_owner_news_payload_activation.sql`
- Modify: `scripts/test-migrations.mjs`
- Modify: `scripts/owner-news-payload/cutover.mjs`
- Create: `scripts/owner-news-payload/go-live-proof.mjs`
- Modify: `tests/unit/owner-news-cutover.test.mjs`
- Create: `tests/unit/owner-news-go-live-proof.test.mjs`
- Modify: `docs/operations/payload-owner-news.md`

**Step 1: escrever matriz RED de transições**

Preservar as transições existentes e exigir provas específicas:

```text
legacy         -> frozen          freeze-legacy
frozen         -> legacy          unfreeze-legacy (antes de ativar)
frozen         -> payload         activate-payload + preflight vazio
payload        -> payload_frozen  freeze-payload
payload_frozen -> payload         resume-payload
payload_frozen -> legacy          rollback-before-edit + sequence inalterada
```

Rejeitar epoch antigo/futuro, prova de outro commit/runtime, prova expirada, estado
não congelado, CMS não ready, modo não manual, domínio não vazio, hash divergente,
sequence maior e resultado desconhecido.

**Step 2: definir o envelope de prova**

`go-live-proof.mjs` produz JSON sanitizado, com schema versionado, commit, digests
das imagens, authority epoch/mode, timestamp, expiration, publication mode, contagens
e mutation head. Não conter secret nem resposta bruta.

O script lê o preflight pela rede privada, grava arquivo novo com `0600`, fsync e
rename atômico. O comando de cutover reabre com no-follow, valida owner/mode/link e
vincula exatamente ao epoch observado.

**Step 3: persistir o baseline de ativação**

Criar uma tabela append-only/controlada para vincular `activation_epoch`, commit,
digests e mutation `sequence`/`chain_sha256`. A role comum da API não recebe UPDATE
ou DELETE arbitrário; somente a função/transação de autoridade pode inserir o
baseline durante a transição `frozen -> payload`.

Testar migration, constraints, grants, tentativa duplicada e vínculo obrigatório ao
epoch que se torna Payload. Receipt de workflow não substitui esse registro durável.

**Step 4: habilitar ativação por CAS**

Substituir `news_cutover_proof_required` por validação real apenas para
`activate-payload`. Dentro da transação, reler authority com lock e confirmar o
epoch da prova. A transição continua auditada e incrementa epoch uma vez.

Não consultar rede enquanto mantém lock PostgreSQL. Capturar prova antes, validar
identidade do arquivo e então executar CAS curto.

Na mesma transação do CAS, inserir o baseline; falha de qualquer uma das duas
operações faz rollback integral.

**Step 5: habilitar rollback antes da primeira mutação**

Fluxo obrigatório:

1. `payload -> payload_frozen` fecha writers;
2. obter novo preflight privado;
3. comparar sequence/hash com baseline de ativação durável;
4. confirmar CMS sem resultado desconhecido;
5. executar `payload_frozen -> legacy` por CAS e auditoria.

Se sequence/hash divergir, o único caminho é reparar e retornar a `payload`; nunca
aceitar override manual.

**Step 6: verificar e commitar**

```sh
node --test tests/unit/owner-news-cutover.test.mjs tests/unit/owner-news-go-live-proof.test.mjs
npm run verify
git diff --check
git commit -m "feat(payload): gate cutover on empty mutation proof"
```

---

### Task 9: Criar contrato de release enxuto sem abrir `payload-v1`

**Files:**

- Modify: `scripts/release-manifest.sh`
- Create: `scripts/payload-empty-release.sh`
- Create: `ops/payload-empty-receiver-admission.py`
- Create: `ops/payload-empty-receiver-root.sh`
- Modify: `ops/deploy-from-production-ci.sh`
- Modify: `ops/deploy-from-ci.sh`
- Modify: `ops/payload-operations-guard.sh`
- Create: `tests/unit/payload-empty-receiver-admission.test.mjs`
- Create: `tests/unit/payload-empty-release.test.mjs`
- Modify: `tests/unit/payload-receiver-root.test.mjs`
- Modify: `tests/unit/payload-operations.test.mjs`
- Modify: `tests/unit/cms-image-pipeline.test.mjs`
- Modify: `docs/operations/deployment.md`

**Step 1: congelar a gramática do novo selector**

Adicionar `production:payload-empty-v1` com número fixo de campos e os mesmos
formatos estritos de commit, run/attempt, artifact IDs e imagens por digest. Não
aceitar env assignments, flags livres, paths, shell, branch ou tag mutável.

`production:payload-v1` continua byte a byte com seu admission/preflight atual e
continua recusando `release_not_preflighted`. Testes devem provar que um selector não
é aceito pelo parser do outro.

**Step 2: definir o escopo permitido do receiver enxuto**

O novo receiver pode somente:

- validar candidato assinado/qualificado do mesmo commit;
- instalar release imutável;
- validar secrets/config sem imprimi-los;
- criar/provisionar o runtime CMS isolado;
- executar migrations aprovadas;
- iniciar `cms-postgres` e `cms`, nunca `cms-worker`;
- executar readiness/preflight privado;
- manter Nginx/admin fechado;
- gravar receipt sanitizado e parar.

Ele **não** pode mudar autoridade, publicar rota, importar acervo, iniciar worker,
executar schedule ou marcar deployment como aceito.

**Step 3: implementar instalação reentrante**

Usar lock global já existente, diretórios root-owned, no-follow, arquivo de intenção
antes de cada mutação e receipt depois do commit. Reentrada distingue exatamente:
`not_started`, `in_progress`, `installed_closed`, `unknown`, `incompatible`.

Em falha pre-floor, remover somente recursos comprovadamente pertencentes ao
attempt. Em falha pós-criação de dados, manter fechado e exigir reconciliação. Nunca
adotar volume/container sem receipt correspondente.

**Step 4: reutilizar primitives, não política do protocolo completo**

Extrair validações comuns de archive/digest/filesystem se necessário, mas não copiar
o bypass nem chamar internamente o receiver `payload-v1`. O release format passa a
aceitar `payload-empty-v1`; o backup coordenado permanece no formato de backup
`payload-v1`, explicitamente documentado como formato dos quatro stores, não como
autorização de migração.

**Step 5: provar negativos**

Cobrir archive truncado/grande, traversal, symlink/hardlink, digest/tag inválida,
commit divergente, artifact replay, diretório permissivo, receipt trocado, secrets
parciais, worker no Compose resolvido, runtime não vazio e interrupções antes/depois
de volume, migration e readiness.

**Step 6: verificar e commitar**

```sh
node --test \
  tests/unit/payload-empty-receiver-admission.test.mjs \
  tests/unit/payload-empty-release.test.mjs \
  tests/unit/payload-receiver-root.test.mjs \
  tests/unit/payload-operations.test.mjs \
  tests/unit/cms-image-pipeline.test.mjs
npm run verify
git diff --check
git commit -m "feat(payload): add protected empty-runtime receiver"
```

---

### Task 10: Adicionar workflow manual e aprovação de produção

**Files:**

- Create: `.github/workflows/payload-empty-go-live.yml`
- Modify: `.github/workflows/ci.yml`
- Create: `scripts/package-payload-empty-candidate.mjs`
- Create: `scripts/validate-payload-empty-candidate.mjs`
- Create: `tests/unit/payload-empty-workflow.test.mjs`
- Modify: `tests/unit/cms-image-pipeline.test.mjs`
- Modify: `docs/operations/deployment.md`

**Step 1: manter push normal separado**

O job normal `deploy-production` não instala nem ativa Payload. O novo workflow usa
somente `workflow_dispatch`, commit SHA completo, environment protegido e imagens
API/cron/CMS por digest produzidas pelo mesmo commit.

Nenhum input booleano em push normal pode selecionar o go-live.

**Step 2: separar fases no workflow**

Criar jobs com artefatos e approvals explícitos:

1. `qualify`: verifica commit, CI, SBOM e digests;
2. `install-closed`: envia candidato ao receiver enxuto;
3. `verify-private`: valida runtime vazio, manual-only, backup e readiness;
4. `approval-cutover`: environment manual;
5. `cutover`: executa freeze/preflight/CAS/publicação de rota;
6. `smoke`: editor e leitor independentes;
7. `finalize`: conclui deployment somente após smoke;
8. `failure-evidence`: preserva evidência sanitizada sem tentar rollback cego.

Não transportar secrets em artifacts. Usar GitHub secrets/environment e mascarar
output. Cada artefato inclui schema, commit, run ID/attempt, timestamps e hashes.

**Step 3: aplicar limite de 30 minutos**

O relógio inicia imediatamente antes de `freeze-legacy` e termina após smoke ou
estado seguro documentado. Definir timeout menor que 30 minutos para a fase mutável,
deixando margem operacional. Instalação, backup e restore-test ocorrem antes da
janela.

Timeout/Cancel durante a janela chama apenas uma rotina de observação e fechamento:
consulta estado durável, fecha rota/admin se necessário e deixa `frozen` ou
`payload_frozen`. Não presume que uma etapa não executou.

**Step 4: verificar e commitar**

```sh
node --test tests/unit/payload-empty-workflow.test.mjs tests/unit/cms-image-pipeline.test.mjs
npm run verify
git diff --check
git commit -m "ci(payload): add protected empty go-live dispatch"
```

---

### Task 11: Publicar admin somente após readiness e autoridade

**Files:**

- Modify: `nginx/nginx.conf`
- Modify: `docker-compose.yml`
- Modify: `ops/compose.production.yaml`
- Modify: `ops/payload-operations-guard.sh`
- Modify: `api/routes/editorial-session.js`
- Modify: `public/js/editorial-entry.js`
- Modify: `tests/unit/nginx-route-delivery.test.mjs`
- Modify: `tests/unit/editorial-entry.test.mjs`
- Modify: `tests/unit/editorial-session.test.mjs`
- Modify: `docs/operations/payload-owner-news.md`

**Step 1: escrever a matriz RED da rota**

Exigir admin indisponível quando runtime não ready, authority `legacy`/`frozen`,
config não manual ou cutover sem receipt. Em `payload_frozen`, manter login/read-only
somente se o runbook precisar diagnóstico; toda mutação continua recusada no
servidor. Documentar a decisão e testá-la.

**Step 2: manter o gate no servidor**

A UI pode explicar indisponibilidade, mas Nginx/API e hooks do Payload são os gates
reais. Não confiar em esconder botão.

Montar no Nginx um include mínimo, root-owned e somente leitura, gerado inicialmente
como `closed`. O guard operacional é o único escritor: depois de confirmar authority
`payload`, receipt do runtime e readiness, ele grava `open` por arquivo temporário +
fsync + rename, executa `nginx -t` e só então reload. Em falha ou recuperação, volta
a `closed` antes de qualquer ação destrutiva. Arquivo ausente, ilegível, permissivo
ou com valor desconhecido deve fazer Nginx recusar `/editorial*` e `/_next/*`, nunca
abrir por default.

A rota privada de serviço continua 404 no ingress público e `/_next/image` continua
bloqueada mesmo quando o admin abre.

**Step 3: testar HTTPS/headers no job real**

Validar redirect `/editorial -> /editorial/admin`, cookies `Secure`, origin/CSRF,
CSP/nonce, headers de proxy, limite de upload e recusa de usuário sem
`manageKnowledge`. Não reduzir rate limits existentes.

**Step 4: verificar e commitar**

```sh
node --test tests/unit/nginx-route-delivery.test.mjs tests/unit/editorial-entry.test.mjs tests/unit/editorial-session.test.mjs
npm run verify
git diff --check
git commit -m "feat(payload): gate editorial ingress on cutover readiness"
```

---

### Task 12: Fechar runbook, smoke e handoff

**Files:**

- Modify: `docs/operations/payload-owner-news.md`
- Modify: `docs/operations/payload-runtime-recovery.md`
- Modify: `docs/operations/deployment.md`
- Create: `docs/operations/payload-accelerated-go-live-checklist.md`
- Create: `tests/unit/payload-accelerated-runbook.test.mjs`
- Modify: `tests/unit/operations-invariants.test.mjs`

**Step 1: escrever checklist pré-janela**

Exigir antes do freeze:

- commit e três imagens por digest;
- CI, security, SBOM e revisão frescos;
- receiver/guard instalados e autenticados;
- backup legado identificado;
- dois restores descartáveis com resultado e duração;
- backup CMS vazio identificado;
- runtime privado ready, manual-only e mutation sequence baseline;
- disco, memória, logs e reinícios observados;
- editor autorizado e leitor independente preparados;
- conta sem permissão preparada;
- responsável e go/no-go explícitos.

**Step 2: escrever checklist da janela**

Sequência exata:

1. registrar início;
2. `freeze-legacy` e confirmar writers recusados;
3. obter preflight privado novo;
4. ativar Payload por CAS;
5. abrir ingress editorial;
6. login real via HTTPS;
7. criar notícia de aceite do zero;
8. enviar mídia original;
9. salvar draft — neste ponto o ledger já deve marcar floor;
10. publicar manualmente;
11. em sessão leitora independente, conferir notícia nova e item legado;
12. testar conta sem permissão;
13. testar tentativa de escrita legada recusada;
14. registrar fim e duração;
15. finalizar deployment e handoff.

**Step 3: escrever árvore de recuperação**

- Antes de ativar: `frozen -> legacy` após falha, sem tocar CMS.
- Ativado, sequence igual ao baseline: `payload -> payload_frozen`, provar vazio,
  fechar ingress e permitir rollback registrado.
- Sequence maior: manter floor Payload; congelar, restaurar/reparar CMS e retomar.
- Resultado desconhecido: observar authority, ledger, ingress, containers e receipts;
  não repetir comando.
- Feed parcialmente degradado: manter writer correto, recuperar apenas reader
  afetado.
- Duas fontes indisponíveis: 503 controlado; não fabricar feed vazio.

**Step 4: definir evidência sanitizada**

Registrar apenas commit, digests, IDs de run/artifact/deployment, horários,
duração, contagens, hashes, status e códigos fixos. Nunca anexar dump, mídia,
cookies, token, email, título/texto da notícia ou secret.

**Step 5: verificar e commitar**

```sh
node --test tests/unit/payload-accelerated-runbook.test.mjs tests/unit/operations-invariants.test.mjs
npm run verify
npm run security
npm run sbom
git diff --check
git commit -m "docs(payload): publish accelerated go-live runbook"
```

**Aceite PR 3:** caminho manual fechado e testado, receiver completo continua
intacto, admin permanece fechado antes do gate, rollback depende de prova de zero
mutação e runbook cobre operação/recuperação.

---

## 4. Operação de go-live (fora do merge do PR 3)

O merge não autoriza automaticamente produção. A operação exige approval novo,
vinculado ao commit e às imagens qualificadas.

### Fase A — preparação sem freeze

1. Executar workflow manual até `install-closed`.
2. Confirmar que o Portal normal continua saudável.
3. Executar e validar backup/restore legado.
4. Executar backup CMS vazio.
5. Confirmar `cms-worker` ausente.
6. Confirmar preflight vazio/manual e readiness privada.
7. Revisar evidências e dar go/no-go.

### Fase B — janela editorial de até 30 minutos

Executar somente a sequência da Task 12. Se qualquer etapa não tiver resultado
confirmado, parar em estado congelado e reconciliar. Não repetir CAS, upload ou
publicação por timeout sem observar o estado durável.

### Fase C — observação

Após sucesso:

- acompanhar 5xx, latência, degradação por fonte, reinícios, disco e erro de upload;
- confirmar backup Payload pós-conteúdo;
- manter legado read-only;
- não habilitar worker/agendamento;
- registrar pendências adiadas em entrega separada.

---

## 5. Itens explicitamente fora deste plano

- importar publicação, draft, versão, mídia, autor ou agenda legada;
- executar delta, seal, reconciliação integral ou finalizer do plano completo;
- habilitar worker ou publicação agendada;
- habilitar Versions/restore ou autosave como critério do go-live;
- apagar tabelas, uploads ou editor legado;
- alterar Ownerinc Brain, n8n ou `ownerinc-novo-agente/`;
- tornar Payload parte automática de todo deploy de `main`;
- relaxar `release_not_preflighted` do receiver `payload-v1`.

## 6. Definition of done

- Payload é o único writer para Owner News novas.
- Todos os writers legados recusam no servidor.
- Legado e Payload aparecem no mesmo feed sem colisão.
- Paginação não duplica/desloca itens quando uma notícia nova entra entre páginas.
- Falha de uma fonte produz leitura parcial observável; falha dupla produz 503.
- Links, detalhes, vizinhos, dashboard e assets preservam origem.
- Admin real autentica via HTTPS; usuário sem permissão é recusado.
- Editor cria, envia mídia, salva draft e publica manualmente.
- Worker e agendamentos não existem na superfície ativa.
- Reinício e restore preservam banco e mídia.
- Primeira mutação avança ledger e proíbe rollback ao legado.
- Cutover mede no máximo 30 minutos de bloqueio editorial.
- Portal fora das escritas editoriais permanece disponível.
- `npm run verify`, security, SBOM, build CMS e checks focados estão verdes.
- Handoff identifica commit, imagens, backups e resultado sem dados privados.
