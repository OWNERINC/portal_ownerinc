# Knowledge Documents Implementation Plan

> Escolha do usuário: executar nesta sessão. Execução inline com checkpoints;
> revisão independente somente ao concluir a implementação.

**Goal:** Publicar oito posts de Uniformes com páginas WebP e um post do Código
de Ética e Conduta integral na Base de Conhecimento.

**Architecture:** Conversão local produz pacotes privados imutáveis por hash.
Knowledge recebe um descritor nullable, rotas autenticadas para manifesto/imagens
e um leitor isolado com carregamento gradual. O Código reutiliza sua API e
renderer oficiais. Importação operacional vincula os nove artigos de forma
idempotente e auditada.

**Tech Stack:** Express/PostgreSQL, JavaScript sem framework, PyMuPDF/Pillow na
preparação local, node:test e navegador Chromium.

## Global Constraints

- Especificação: `docs/superpowers/specs/2026-11-18-knowledge-documents-design.md`.
- Um post por PDF; páginas em sequência com ampliação.
- Lado maior de até 2400 pixels; capa com lado maior de até 720 pixels.
- WebP com qualidade inicial 88; conferir legibilidade antes de publicar.
- Fonte oficial: `api/ethics/term.json`, sem alterar hash/versão/aceites.
- Documentos privados em `UPLOAD_DIR/knowledge-private/<sha256>/`.
- Preservar os limites `api/`, `public/`, `cron/`, `nginx/`.
- Node 18 compatível, LF em SQL/shell, sem credenciais no código.
- Preservar alterações anteriores; commits e publicação delimitados.
- `npm run verify` e `git diff --check` antes de compartilhar o código.

---

## Estrutura dos arquivos

- `scripts/prepare-knowledge-documents.py`: download, conversão e manifesto.
- `api/knowledge/documents.js`: validação e leitura privada dos pacotes.
- `api/routes/knowledge.js`: DTOs e rotas de documento; CRUD preservado.
- `api/db/migrations/043_knowledge_documents.sql`, `api/db/schema.sql`:
  descritor persistente; atualizar verificações de schema existentes.
- `scripts/import-knowledge-documents.cjs`: validação do pacote e importação
  transacional com parâmetros explícitos.
- `public/js/knowledge-documents.js`: fila de imagens, leitor e ampliação.
- `public/js/knowledge.js`, `public/css/knowledge.css`, `public/knowledge.html`:
  integração ao catálogo e ao ciclo de vida existente.
- `tests/unit/knowledge-documents.test.mjs`: arquivos/descritores/rotas.
- `tests/unit/knowledge-document-reader.test.mjs`: concorrência e descarte.
- `tests/visual/check-knowledge-documents.mjs`: navegação com documentos reais.
- `docs/operations/knowledge-documents.md`: uso, pacote, importação e recuperação.

## Task 1: Pacote real dos documentos

**Interfaces**

Entrada: `knowledge-uniformes.json`, pasta de saída externa.
Saída: `sources/<drive-id>.pdf`, `knowledge-private/<sha256>/manifest.json`,
`cover.webp`, `0001.webp` e demais páginas; `import.json` com nove artigos.
O manifesto tem `version:1`, `source:{id,filename,sha256,url}`, `cover` e `pages`.
Cada imagem tem `number` (somente página), `width`, `height`, `bytes`, `sha256`;
cada página também tem `text`. Nomes são derivados, não aceitos do manifesto.

- [x] Conferir dependências locais e preservar o manifesto anterior.
- [x] Implementar download limitado a IDs da lista aprovada, com validação PDF,
  suporte à confirmação de download do Drive e arquivos parciais substituídos
  atomicamente somente após conferência.
- [x] Converter cada página:

```python
scale = 2400 / max(page.rect.width, page.rect.height)
pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
image.save(destination, "WEBP", quality=88, method=6)
```

- [x] Criar IDs estáveis com UUIDv5 do identificador Drive e um identificador
  institucional fixo; gerar pacote JSON que não contenha caminhos absolutos.
- [x] Executar o conversor em pasta externa e conferir estes invariantes:

```python
assert len(import_manifest["articles"]) == 9
assert len(manifest["pages"]) == len(pdf)
assert [p["number"] for p in manifest["pages"]] == list(range(1, len(pdf) + 1))
assert all(p["width"] > 0 and p["height"] > 0 for p in manifest["pages"])
```

- [x] Inspecionar visualmente capa e páginas com texto de cada PDF, registrar
  contagem, tamanho e hashes; corrigir legibilidade antes do vínculo.
- [ ] Commit delimitado do conversor e metadados textuais; binários ficam externos.

## Task 2: Persistência e leitura autenticada

**Interfaces**

`validateDescriptor(value)` retorna boolean.
`loadDocument(uploadDir, descriptor)` retorna manifesto validado.
`documentSummary(article, uploadDir)` retorna descritor público, sem caminhos.
`documentImage(uploadDir, descriptor, numberOrCover)` retorna Buffer validado.
Erros têm `status` 400 para entrada inválida e 404 para recurso indisponível.

- [x] Criar testes para descritores estritos e arquivos inválidos:

```js
assert.equal(validateDescriptor(null), true);
assert.equal(validateDescriptor({ kind: 'ethics' }), true);
assert.equal(validateDescriptor({ kind: 'pdf', key: 'a'.repeat(64) }), true);
assert.equal(validateDescriptor({ kind: 'pdf', key: '../secret' }), false);
assert.equal(validateDescriptor({ kind: 'ethics', key: 'x' }), false);
```

- [x] Executar `node --test tests/unit/knowledge-documents.test.mjs` e confirmar
  falha pela implementação ausente.
- [x] Adicionar `document JSONB` nullable, com CHECK que aceita exclusivamente
  nulo ou os dois formatos aprovados. Usar `IS TRUE` na expressão de objetos
  para impedir que campos ausentes escapem pela semântica SQL NULL.
- [x] Atualizar schema fresh e verificadores de schema/ledger para migration043.
- [x] Implementar leitura com limite de tamanho de manifesto, máximo de 500
  páginas, hashes SHA-256 e dimensões até2400; negar links simbólicos e escapes
  do diretório privado. Não confiar em nomes fornecidos pelo manifesto.
- [x] Adicionar endpoints antes de `/:id`; autenticar antes de validar; conferir
  artigo existente e tipoPDF. Capa e páginas retornam `image/webp` e
  `Cache-Control: private, no-store`.
- [x] Rejeitar `document` em POST/PUT comuns e preservar o vínculo na edição.
  Converter descritores em DTOs, sem expor a chave de armazenamento.
- [x] Testar ausência de autenticação, aceite pendente, recurso ausente,
  descritor inválido, página fora da faixa e `/uploads/knowledge-private`.
- [x] Executar os testes focais e migration em banco descartável local disponível;
  registrar separadamente evidência que dependa de PostgreSQL nativo.
- [ ] Commit delimitado de backend/migration/testes.

## Task 3: Leitor contínuo e catálogo

**Interfaces**

`createDocumentImages({ fetchAsset, document })` fornece
`observe(image, url)`, `dispose()`; controla fila e blobs.
`mountKnowledgeDocument({ host, article, fetchAPI, fetchAsset })` devolve
função de descarte; tipoPDF carrega manifesto, tipoethics usa `/api/ethics`.
Knowledge chama descarte ao iniciar outra leitura e ao desmontar a página.

- [x] Criar testes com promises controladas: resposta antiga não pode montar
  imagem depois de dispose; fila tem no máximo duas solicitações simultâneas;
  falha permite retry; URLs retornadas após cancelamento são revogadas.
- [x] Implementar fila com `AbortController`, `IntersectionObserver` e dimensões
  reservadas; remover blobs distantes e readmitir quando visíveis.
- [x] Implementar páginas com legenda, texto extraído em Details e ampliação em
  diálogo nativo. Fechar/Escape restauram foco; tamanho real pode rolar.
- [x] Integrar o leitor ao detalhe após título/descrição; reutilizar
  `renderEthicsDocument` para o Código. Obter descrição da API, nunca executarHTML.
- [x] Integrar capas e contagem aos blocos existentes; carregar capas somente
  quando próximas da tela. Manter categorias, paginação e busca.
- [x] Adicionar CSS usando tokens existentes; preservar imagem integral e
  reflow320px. Ampliar sem depender de hover, animação ou pop-up externo.
- [x] Rodar testes de leitor, Knowledge, navegação persistente e Ética; verificar
  troca de artigo e volta à lista durante carregamento.
- [ ] Commit delimitado de leitor, integração e testes.

## Task 4: Importação auditada e repetível

**Interfaces**

`importDocuments({ pool, uploadDir, articles, batch, apply })` valida tudo antes
de gravar; `apply:false` relata plano sem mutação. Artigos incluem ID estável,
título, categoria, descrição e descritor. Retorna created/unchanged e IDs.

- [x] Testar duas execuções do mesmo lote: a segunda não cria artigos nem
  auditoria duplicados. Um artigo divergente aborta o lote inteiro.
- [x] Validar arquivos e hashes antes da transação; consultar IDs e possíveis
  duplicatas por título/origem. Recusar conflito, nunca adotar silenciosamente.
- [x] Gravar com parâmetros, `lock_timeout=5s`, `statement_timeout=30s` e auditoria
  `knowledge.documents_import`. Após COMMIT incerto, consultar IDs e auditoria
  por nova conexão antes de concluir ou repetir.
- [x] Documentar comandos, formato, fallback para original e limite do texto
  extraído em `docs/operations/knowledge-documents.md`.
- [x] Atualizar documentação atual da Base e manifesto antigo para refletir o
  novo formato, preservando rastreabilidade das fontes.
- [ ] Commit delimitado do importador, testes e documentação.

## Task 5: Aceite local e revisão

- [x] Abrir prévia real autenticada pelo harness local com os oito pacotes e o
  Código, usando servidor loopback e sem contas produtivas sintéticas.
- [x] Conferir320/390/1366px, capas, ordem e quantidade, zoom, teclado, texto,
  falha/retry, navegação e Código integral.
- [x] Executar `npm run verify` e `git diff --check`; registrar saídas.
- [x] Revisar diff completo e contratos de caminhos/autenticação/importação;
  usar requesting-code-review para a revisão exigida, respeitando execução
  nesta sessão e as regras de delegação aplicáveis.
- [x] Consolidar relatório com resultados reais e quaisquer limites observados.

## Task 6: Publicação do lote aprovado

- [ ] Conferir release produtiva e Git remoto atuais; construir candidato que
  contenha somente a feature e suas dependências, preservando WIP anterior.
- [ ] Executar os checks do candidato exato e publicar pelo fluxo existente;
  acompanhar conclusão pelo mecanismo de notificação, sem polling.
- [ ] Conferir migration043 e API do candidato antes de inserir conteúdo.
- [ ] Criar backup completo anterior à importação; enviar arquivos privados e
  conferir hashes do pacote no destino.
- [ ] Executar dry-run, aplicar o lote validado e conferir IDs por nova conexão.
- [ ] Validar nove posts, imagens e Código; conferir health/ready e registrar
  release, auditoria e backup.
- [ ] Atualizar relatório e pendência do projeto com resultado e evidências.
