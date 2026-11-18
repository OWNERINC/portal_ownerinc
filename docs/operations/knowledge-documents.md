# Documentos internos da Base de Conhecimento

## Leitura e edição

O catálogo exibe um post por documento. PDFs preparados têm capa, quantidade de
páginas e leitura contínua em WebP. **Ampliar** abre a página com ajuste à tela ou
tamanho real; **Escape** ou **Fechar** retorna à leitura. O texto extraído fica
em **Ler texto da página N**. A busca do catálogo usa título e descrição.

As imagens são carregadas conforme a proximidade da tela, com até duas
requisições simultâneas por leitor. Imagens distantes liberam memória e podem
ser carregadas novamente. Uma falha oferece **Tentar novamente**.

O **PDF original** abre o arquivo no Google Drive em outra aba, sujeito às
permissões do Drive. A leitura em WebP é interna, exige uma conta admitida e
aceite vigente. `/uploads/knowledge-private` não é uma URL pública.

O Código de Ética e Conduta usa a fonte vigente de `/api/ethics` e o mesmo
renderer da tela de aceite. Sua consulta não registra outro aceite.

Administradores podem editar título, categoria e descrição. Essas edições
preservam o documento. A API de edição comum rejeita o campo `document`;
vincular arquivos exige o importador operacional. Excluir um post não remove
automaticamente os pacotes privados.

## Preparação local

Dependências externas de preparação: Python, PyMuPDF, Pillow e requests.
Não são instaladas na API. A pasta de saída deve ficar fora do Git.

```sh
python scripts/prepare-knowledge-documents.py \
  --manifest docs/operations/knowledge-uniformes.json \
  --output /caminho/privado/knowledge-package
```

O conversor confere o tamanho aprovado e a assinatura dos PDFs, calcula SHA-256,
renderiza as páginas com lado maior até 2400 px e qualidade WebP 88 e cria capas
até 720 px. Cada pacote é identificado pelo SHA-256 do PDF:

```text
knowledge-package/
  sources/<drive-id>.pdf
  import.json
  knowledge-private/<sha256>/
    manifest.json
    cover.webp
    0001.webp
    ...
```

O manifesto guarda metadados da origem, dimensões, tamanhos, hashes e texto por
página. Os nomes de arquivo são derivados pelo servidor; o JSON não escolhe
caminhos. O importador valida todos os arquivos antes de abrir uma transação.
O limite é 500 páginas por documento, 8 MiB por imagem e 4 MiB por manifesto.

Preserve os PDFs originais como evidência local. Para publicação basta transferir
`knowledge-private/` e `import.json` para o volume `UPLOAD_DIR`. Não sobrescreva
um diretório de hash existente: confira os arquivos e reutilize somente bytes
iguais. Pacotes fazem parte do backup de uploads.

Avisos MuPDF sobre `No common ancestor in structure tree` apareceram nos
originais do lote Uniformes. A conversão terminou com sucesso; os avisos de
marcação estrutural foram avaliados junto da contagem, hashes, decodificação das
imagens, texto extraído e amostras visuais. Texto extraído não equivale a uma
transcrição revisada: mantenha a imagem e o original como referência.

## Importação

Pré-condições: release com migration `043_knowledge_documents` aplicada, backup
verificado e arquivos privados presentes no volume. O schema novo possui
`knowledge_base.document` nullable, limitado a `{kind:"pdf",key:"<sha256>"}` ou
`{kind:"ethics"}`.

Execute a partir do checkout, com `DATABASE_URL` já configurada no ambiente
protegido. Nunca escreva a credencial na linha de comando ou no relatório.

```sh
node scripts/import-knowledge-documents.cjs /caminho/privado/knowledge-package uniformes-20261118
node scripts/import-knowledge-documents.cjs /caminho/privado/knowledge-package uniformes-20261118 --apply
```

Sem `--apply`, o comando só valida e relata `wouldCreate`. Com a opção, cria
somente IDs ausentes em transação curta, serializa alterações na tabela e
registra `knowledge.documents_import` em `audit_log`. IDs são UUIDv5 estáveis.
O campo `created_by` fica nulo porque se trata de publicação operacional.

No container da API o módulo fica em `/app/knowledge/import.js`. Quando o
checkout `scripts/` não estiver na imagem, um comando operacional pode chamar
`importDocuments` desse módulo com o pool `/app/db`, o `uploadDir` do volume,
o array `articles` de `import.json`, `batch` explícito e `apply` booleano.
Isso executa exatamente a mesma validação/transação do CLI.

Reexecução idêntica não duplica posts nem auditoria. IDs, títulos ou fontes que
colidam com registros divergentes interrompem todo o lote. Uma edição humana
não é substituída pelo manifesto antigo. Reutilização incompatível do nome do
lote também é recusada.

Uma resposta perdida ao COMMIT é reconciliada por outra conexão, consultando
artigos e auditoria. Se a confirmação não for possível, o comando falha sem
repetir gravações. Confira o lote no banco antes de nova tentativa.

## Conferência e recuperação

Após a importação, consulte os nove IDs em conexão nova, categorias e
`audit_log`; confira manifesto, capa e amostras autenticadas, Código integral,
health e ready. Registre release, backup, lote, hashes e resultados.

Arquivo ausente/corrompido retorna 404 genérico; o post permanece visível e
oferece retry. Restaure o pacote de mesmo hash a partir do backup conferido.
Não altere descritores diretamente para ocultar falhas.

Para desfazer uma importação, revise os IDs da auditoria e o estado atual dos
posts antes de qualquer remoção. Uma restauração completa do banco exige avaliar
gravações posteriores e seguir [rollback.md](rollback.md). A migration é aditiva;
não remova a coluna para retornar à release anterior.

## Verificação local reproduzível

- `npm run verify`: contratos e testes independentes de serviços.
- `node tests/database/check-knowledge-documents.mjs`: SQL real em PGlite,
  importação, rollback, COMMIT incerto, middleware/API e arquivos privados.
  Exige `PGLITE_MODULE_PATH` externo e `KNOWLEDGE_PACKAGE`.
- `node tests/visual/check-knowledge-documents.mjs`: navegador real com API e
  SQL locais, identidades Firebase sintéticas. Exige as variáveis anteriores,
  `PLAYWRIGHT_MODULE_PATH` e `KNOWLEDGE_VISUAL_OUTPUT` apontando para pasta nova.
  Verifica 320/390/1366 px, nove posts, oito PDFs, fidelidade do Código, zoom,
  teclado, retry e navegação durante carregamento.

Esses ensaios não equivalem a autenticação Firebase produtiva. O CI mantém o
gate de migrations/estrutura em PostgreSQL 16 nativo.
