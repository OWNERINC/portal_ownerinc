# Preparação de pacotes editoriais privados — A1

`scripts/prepare-owner-news-bundle.mjs` valida e empacota um manifesto privado
revisado. Não abre conexão com banco, não aplica drafts e não publica. A aplicação
transacional é uma etapa posterior. O importador antigo e seus guards permanecem
independentes; este fluxo reutiliza suas identidades, sanitização e downloads.

## Execução

Use Node 24 para `npm run verify`, conforme o manifesto efetivo. Os módulos novos
usam APIs disponíveis no Node 18; isso não declara compatibilidade das dependências
instaladas com Node 18. São necessárias as dependências existentes de `api/`
(incluindo `sharp` para decodificação de imagens).

```sh
node scripts/prepare-owner-news-bundle.mjs --input /privado/revisado.json --check
node scripts/prepare-owner-news-bundle.mjs --input /privado/revisado.json --output /privado/pacote-novo
```

Entrada e saída precisam ser absolutas, fora de checkouts Git e sem ancestrais
symlink. A saída deve ser nova; reexecução não sobrescreve arquivos. Uma falha pode
deixar um diretório parcial, nunca um relatório de sucesso: use um novo destino
depois de investigar. `--check` somente lê; não aceita `--output`.

Para **relatório de preparação**, acrescente `--allow-pending`. Isso aceita
`needs_review`, incluindo conversões incompletas com `issues` explícitas, mas não
dispensa controles de assets, decisões ou procedência. Sem essa flag, pendências
dos itens bloqueiam a validação. Marcar um item `approved` com `issues` remanescentes
também bloqueia. Limites editoriais e regras de publicação dos itens aprovados
são conferidos pelo `validateNewsRevision` real, com `publishing: true`.

O JSON de saída no terminal informa somente contagens, hashes e estados. Erros da
CLI não imprimem corpos, URLs privadas ou erros arbitrários de bibliotecas.
Diagnósticos permitidos identificam `asset_budget_exceeded` (300 MiB),
`editorial_payload_exceeded` (5 MiB), `review_required` e `invalid_manifest`.
Mensagens desconhecidas usam `preparation_failed`, sem reproduzir a exceção original.
`report.json` separa preparação de `drafts_applied`, `publications` e
`destination_assets_verified`, que ficam em zero nesta etapa.

## Construção privada e procedência

As funções de `scripts/lib/owner-news-bundle.mjs` permitem montar o material
antes da CLI:

1. `captureReference()` baixa o GET autorizado, valida JSON/estrutura e devolve
   bytes, payload, hash, horário de observação e contagem, sem gravar ou imprimir.
   Um snapshot já capturado também pode ser utilizado após conferir seu hash.
2. `referenceMedia(payload)` enumera mídias de **todos** os registros, inclusive
   rascunhos. `captureReferenceMedia(payload, {root})` baixa e valida essas mídias
   em uma raiz privada existente, com escrita exclusiva. Cada redirect passa
   pelos guards do importador anterior. Falhas bloqueiam a captura, sem tratar
   arquivos parcialmente capturados como um conjunto completo.
3. `inventorySources({referencePayload, editionItems, decisions})` produz a matriz
   de título, editoria, origem/páginas, fingerprint, candidatos, decisão, chave
   canônica, responsável e motivo. Fingerprints de corpos iguais apenas sugerem
   duplicidade. Corpos vazios não sugerem fusão; similaridade sem igualdade precisa
   de inspeção editorial. A matriz não substitui os bytes originais preservados.
4. `prepareBundle({referencePayload, editionItems, decisions, assets,
   sourceSnapshot})` exige uma decisão por fonte e confere a contagem publicada.
   `assets` pode conter `url` para resolver a conversão; essa URL fica no inventário
   de mídias da fonte, não no registro de asset emitido no pacote. Somente assets
   referenciados pelos itens entram no pacote.
5. Grave snapshot, inventário, matriz e manifesto **somente no diretório privado**.
   Passe o manifesto à CLI. Fixtures versionadas devem ser sintéticas.

As decisões são `include`, `merge`, `exclude` e `retain_pdf`. Cada uma possui
`source_key`, `canonical_key` (null para exclude), `reason` e `reviewer` não vazios.
Uma fusão precisa apontar a um item canônico incluído. A preparação agrega sua
procedência e marca revisão obrigatória, sem concatenar ou deduplicar os textos.
Todo item convertido começa em `needs_review`; aprovação é uma ação editorial
explícita, após conferir corpo, resumo, mídia, colunas e procedência.

O contrato `OwnerNewsBundleV1` mantém `schema_version`, `source_snapshot`, `assets`,
`items` e `decisions`. Detalhes de preparação adicionados ao contrato:

- `source_snapshot.inventory_source_keys`: inventário completo de chaves que
  precisam de decisão, incluindo registros excluídos do pacote parcial.
- `source_snapshot.pending_sources`: array opcional de `{source_key, reason}`.
  Registra fontes preservadas para trabalho futuro. `scope: "partial"` pode
  identificar explicitamente esse recorte. `edition_pdf_sha256: null` significa
  que o PDF não foi obtido/conferido; não é um hash fictício.
- Um `retain_pdf` sem item só é válido quando essa fonte está explicitamente
  pendente. Isso registra intenção de preservação, não comprova um PDF no destino.
- Fontes da referência preservam `external_id`, `updated_at`, `published_at` e
  `status`. Só `publishedAt` civil válido vira `editorial.source_date`; atualização
  nunca substitui publicação. Campos ausentes de autoria e rótulo ficam vazios.
- Fontes da edição usam `edition_key` e páginas inteiras positivas. Sua chave
  estável é a do item (`edition:4:slug-revisado`). Em uma fusão, `source_key`
  adicional preserva a chave da matéria de origem antes da reconciliação.
- `issues` nos itens identifica perdas/transformações que exigem revisão. Mídia
  desconhecida, data inválida, tipo não suportado, fonte tipográfica desconhecida,
  imagem inline em perfil/citação e colunas longas são sinalizados. Em citações,
  `quote_inline_media_requires_review` impede aprovação silenciosa após remoção da
  tag img pelo sanitizador; a curadoria deve resolver a mídia a partir da fonte
  preservada antes de aprovar.

`exclude` no recorte parcial **não equivale a retirada de publicação existente**.
`withdraw` exige decisão explícita de exclusão, identidade de origem importada
e fotografia completa `target`. A1 valida a forma dessa fotografia, não consulta
nem confirma seus ponteiros no banco. A etapa transacional deverá verificá-los.
`skip` somente registra a decisão. Não procurar destinos por similaridade de título.

## Conversão e integridade

HTML prioritário é convertido para texto. Capa é emitida uma vez (`usage: cover`),
resumo/autoria ficam no EditorialV1, sem parágrafos duplicados no corpo. Imagens
preservam caption/credit; quote e profile são blocos nativos planos. `image` tem
precedência sobre o campo auxiliar `url`. Imagens inline mantêm a ordem. Layouts
desconhecidos são rejeitados; font serif/sans vira typography apenas em texto.

Texto left/right até 5.000 caracteres permanece um único paragraph com quebras
internas. Acima disso, segmentos conservam ordem e atributos, mas recebem
`column_requires_relayout`; curadoria precisa resolver a diagramação antes de
aprovar. Textos semelhantes ou repetidos permanecem intactos por padrão.

Assets usam somente `asset_key`. Para validação, a biblioteca resolve um UUID
determinístico temporário e remove asset_key antes de chamar o CMS; nunca retorna
esses IDs como se fossem assets persistidos. Recusa asset inexistente, tipo/MIME
incompatível, caminhos absolutos/traversal, symlinks, arquivos não regulares,
hash/tamanho divergente, mais de 50 MiB por arquivo e mais de 300 MiB no conjunto
de assets do manifesto. Imagens são decodificadas por sharp; vídeo usa as mesmas
assinaturas de container do importador anterior, sem validação integral de codecs.
PDF requer `application/pdf` e assinatura `%PDF-`; isso não confirma páginas ou
fidelidade da extração. Não há OCR automático nem estimação de texto ausente.

A CLI preserva os caminhos relativos e copia apenas assets referenciados. Dois
itens usando a mesma chave compartilham um único asset. `bundle_sha256` cobre os
bytes exatos do manifesto gravado (ou lido por `--check`). `content_sha256` cobre
a serialização JSON indentada com dois espaços e LF final, removendo **somente**
`target` de cada item. Uma transferência que só altera target mantém o hash de
conteúdo; reformatações do arquivo podem alterar o hash do bundle.

## Recorte A1 de 30/09/2026

Snapshot revalidado: 19 publicadas e 1 rascunho. Das publicadas, 14 permanecem
pendentes fora dos itens (11 placeholders simples, 1 com dois parágrafos de
placeholder e imagem, 2 testes). Cinco candidatas têm corpo convertido, mantendo
ordem e repetições. Dezesseis publicadas não informam data de publicação.

Inventário privado: 21 fontes (20 registros + PDF adiado), 25 mídias da referência,
44.514.980 bytes. Pacote parcial de preparação: 5 itens `needs_review`, 10 mídias,
10.968.897 bytes. Há 16 fontes pendentes fora dos itens (14 publicadas, rascunho e
PDF). O PDF não foi obtido, extraído ou contado; o acervo unificado está incompleto.
Nenhum item foi aplicado ou publicado. A aprovação das cinco candidatas e a
conciliação com os destinos pertencem às etapas seguintes.

```sh
node --test tests/unit/owner-news-bundle.test.mjs tests/unit/owner-news-import.test.mjs
npm run verify
git diff --check
```
