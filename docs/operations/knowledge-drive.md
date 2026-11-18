# Documentos do Drive na Base de Conhecimento

## Edição e leitura

O artigo continua sendo texto simples. Cole a URL de leitura do arquivo em uma
linha própria, sem espaços antes/depois:

```text
Descrição do documento.

https://drive.google.com/file/d/ID_DO_ARQUIVO/view
```

O leitor apresenta **Abrir documento no Drive ↗**. O link abre uma nova aba com
`noopener noreferrer`; o nome acessível inclui o título do artigo, o número do
documento e o aviso de nova aba. Aceita também `?usp=sharing` e `?usp=drive_link`.
Links de pastas, outros parâmetros, fragmentos, domínios e protocolos, ou URLs
dentro de frases permanecem texto literal. HTML também permanece texto literal.

O editor conserva a URL no campo `content`. A API e a busca continuam trabalhando
com esse texto. Colar um link não copia nem pré-carrega o PDF.
O acesso externo segue as permissões do Google Drive.

## Lote Uniformes

O arquivo [knowledge-uniformes.json](knowledge-uniformes.json) contém oito entradas
preparadas a partir da pasta indicada pelo usuário em 18/11/2026. Cada entrada tem
metadados `source` para conferência e um objeto `article` com `title`, `category`
e `content`, usado como entrada do conversor.

As descrições identificam os documentos pelos nomes fornecidos. Não transcrevem
regras nem afirmam revisão integral dos PDFs.

O manifesto não é importado pelo frontend nem cria registros ao iniciar serviços.
O lote foi convertido em 207 páginas WebP e oito capas. O pacote externo
`import.json` acrescenta IDs estáveis e descritores privados, além do nono post
institucional do Código de Ética e Conduta.

## Publicação do lote convertido

Siga [knowledge-documents.md](knowledge-documents.md) para publicar os pacotes
privados e executar o importador com dry-run, backup e auditoria.
Não cadastre também as entradas antigas como posts somente de links: isso
duplicaria os oito documentos. O link ao original já faz parte do leitor.

A limpeza demonstrativa de 18/11/2026 foi uma operação anterior concluída;
não integra o processo de conversão ou importação.

## Verificação local

```sh
node --test tests/unit/knowledge-drive-links.test.mjs tests/unit/task-7-shell-mobile.test.mjs
npm run verify
git diff --check
```
