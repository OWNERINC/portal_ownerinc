# Documentos em WebP na Base de Conhecimento

Data: 18 de novembro de 2026.

Estado: desenho e especificação aprovados; execução nesta sessão autorizada.

## Objetivo

Disponibilizar os oito PDFs da pasta **UNIFORMES PARA O PORTAL** como oito
posts individuais na Base de Conhecimento. Cada post terá capa e todas as páginas
do respectivo PDF em WebP, exibidas em sequência dentro do Portal.

Acrescentar um nono post, **Código de Ética e Conduta**, usando o documento oficial
integral já recebido e incorporado ao produto.

Fonte dos PDFs:
<https://drive.google.com/drive/folders/10520HN-PzHQUizY_IYO16C5Fxn6kT-T1>.

## Decisão aprovada

O usuário escolheu **páginas em sequência**: rolagem contínua, carregamento das
imagens conforme a leitura e ampliação para detalhes. A alternativa de uma página
por vez foi apresentada, mas não escolhida.

A Base manterá seus blocos de artigos, categorias, busca e links diretos. Ao
abrir um documento, o usuário continuará no Portal. O público seguirá a regra
atual da Base: contas autenticadas, ativas e com o aceite vigente.

## Conteúdo do lote

Categoria **Uniformes**:

- Uniformes — Apresentação geral.
- Uniformes — Garçom.
- Uniformes — Motoristas.
- Uniformes — Pós-venda.
- Uniformes — Promotores (feminino).
- Uniformes — Promotores (masculino).
- Uniformes — Recepção.
- Uniformes — Recreação.

Os nomes originais e IDs dos oito arquivos foram conferidos na listagem pública
do Drive e constam de `docs/operations/knowledge-uniformes.json`. Os títulos acima
identificam os documentos; a conversão não reescreve suas orientações.

Categoria **Institucional**:

- Código de Ética e Conduta.

O Código usará a fonte oficial `api/ethics/term.json`, atualmente versão 1.0,
com parágrafos, listas e tabelas. A origem está documentada em
`tests/fixtures/ethics-official-provenance.json`: o arquivo enviado foi
`Código de ética.docx`. O post será uma consulta ao documento vigente, usando a
mesma fonte e o mesmo renderer da tela de Ética, sem duplicação textual.

## Preparação dos PDFs

A preparação será executada localmente, fora do runtime da API:

1. Baixar os oito arquivos originais, conferir assinatura PDF, tamanho e SHA-256.
2. Inspecionar quantidade de páginas, orientação e disponibilidade de texto.
3. Renderizar todas as páginas, na ordem original, com fundo branco e proporção
   preservada. O lado maior terá até 2400 pixels; nenhuma página será cortada.
4. Codificar WebP com qualidade inicial 88. Conferir texto pequeno em amostras de
   cada documento e ajustar a codificação antes da publicação se necessário.
5. Gerar capa reduzida da primeira página, com lado maior de até 720 pixels.
6. Extrair o texto disponível por página, sem gerar instruções ou resumos novos.
7. Produzir manifesto com origem, hash do PDF, páginas numeradas, dimensões,
   tamanho e SHA-256 de cada imagem, capa e texto extraído.

Arquivos binários ficarão em um pacote externo ao Git. Os originais serão
preservados junto das evidências locais. A API não executará conversores PDF nem
buscará arquivos no Drive durante a leitura.

Quando uma página não fornecer texto extraível, a interface informará essa
limitação na opção de texto. A imagem completa e a ampliação continuarão
disponíveis; a entrega não afirmará acessibilidade textual integral dessas páginas.

## Modelo de conteúdo e armazenamento

Acrescentar a `knowledge_base` um campo nullable `document` do tipo JSONB,
restrito a dois descritores:

- Documento convertido: `kind` igual a `pdf` e `key` igual ao SHA-256 do PDF.
- Documento institucional: somente `kind` igual a `ethics`.

O valor nulo identifica os artigos comuns. A migration e o schema de instalação
nova devem concordar. O descritor terá validação estrita de chaves, tipos e
comprimentos; não conterá bytes, HTML, caminhos absolutos ou URLs arbitrárias.
Não é necessário índice JSONB para esse lote, consultado pelo ID do artigo.

Cada PDF terá um diretório imutável em
`UPLOAD_DIR/knowledge-private/<sha256>/`, com manifesto, capa e páginas WebP
numeradas. Reutilizar o volume de uploads permite incluir os documentos no
backup existente. O nome derivado do hash separa versões sem sobrescrever bytes.

Os arquivos serão acessíveis exclusivamente pelas rotas autenticadas da Base.
A montagem pública `/uploads` continuará restrita às fotos de perfil permitidas;
os arquivos de `knowledge-private` não serão publicados por caminho estático.

O manifesto de importação atribuirá IDs estáveis aos nove artigos. Reexecuções
consultarão esses IDs e as fontes antes de escrever. Divergências inesperadas
interromperão a importação, evitando duplicatas e sobrescrita de edições humanas.

## API e edição

Manter as rotas e os campos atuais de artigos e acrescentar respostas de leitura
para os documentos:

- A listagem informa tipo, quantidade de páginas e endereço autenticado da capa,
  sem carregar as páginas nem todo o texto extraído.
- O detalhe informa os metadados necessários ao leitor.
- `GET /api/knowledge/:id/document` fornece o manifesto público validado do PDF.
- `GET /api/knowledge/:id/document/cover` fornece a capa WebP.
- `GET /api/knowledge/:id/document/pages/:number` fornece uma página WebP.
- Para `kind: ethics`, o leitor consulta o contrato existente `GET /api/ethics`.

As novas rotas aplicarão a mesma autenticação, autorização de leitura e exigência
de aceite dos artigos. O acesso aos arquivos será resolvido pelo artigo e pelo
manifesto validado, nunca por um caminho recebido do navegador. Números de página
devem ser inteiros canônicos positivos presentes no manifesto.

Imagens terão `Content-Type: image/webp`, `X-Content-Type-Options: nosniff` e cache
privado sem armazenamento compartilhado. Erros não devolverão caminhos do servidor.

O formulário atual poderá editar título, categoria e descrição do post.
Atualizações comuns preservarão o descritor de documento. Os endpoints de edição
não aceitarão introduzir ou trocar o descritor; a vinculação será feita pelo
importador operacional deste lote, com auditoria.

Excluir um artigo removerá sua disponibilidade, mas não apagará imediatamente
arquivos compartilháveis por hash. Não haverá limpeza automática de arquivos
nesta entrega.

## Leitor e apresentação

Os oito blocos de Uniformes terão capa, título, categoria e quantidade de páginas.
O bloco institucional identificará o Código de Ética e Conduta e abrirá seu texto
integral. A busca existente continuará atuando sobre título e descrição dos posts;
pesquisa integral dentro dos PDFs não faz parte desta entrega.

O leitor de PDFs exibirá:

- título, categoria e descrição;
- todas as páginas na ordem, com indicação “Página N de M”;
- imagens fluidas, sem corte, adequadas à largura disponível;
- opção de ampliar cada página e consultar seu texto extraído;
- link secundário para o PDF original no Drive.

O carregamento de imagens usará o transporte autenticado existente. Uma fila
limitada carregará somente as capas e páginas próximas da área visível. O leitor
reservará a proporção das imagens para evitar saltos. Imagens distantes poderão
liberar seus blobs; ao voltar, serão carregadas novamente.

A ampliação abrirá diálogo com ajuste à tela e tamanho real, permitindo rolagem
quando necessário. Terá botão Fechar, Escape, foco contido e retorno ao controle
que a abriu. Ações serão utilizáveis por toque e teclado.

Ao trocar de artigo, sair da tela ou encerrar a sessão, cancelar solicitações,
ignorar respostas antigas e liberar object URLs e observadores. Falha de uma
página oferecerá nova tentativa sem esconder as páginas já disponíveis.

O Código reutilizará `renderEthicsDocument` para preservar a ordem do texto e a
semântica das tabelas. O post de consulta não apresentará um novo formulário de
aceite nem registrará aceites por leitura.

## Importação e publicação

O lote será publicado depois de o leitor e a migration estarem disponíveis:

1. Conferir o pacote local, a contagem de páginas e a legibilidade.
2. Executar as verificações de código e a prévia com os documentos reais.
3. Publicar somente os commits necessários ao leitor de documentos.
4. Criar backup pré-importação e enviar o pacote para o volume privado.
5. Conferir hashes e caminhos no destino antes de vincular artigos.
6. Criar ou reconciliar os nove artigos em transação curta, com IDs esperados e
   registro em `audit_log`; nenhuma conversão ou transferência ocorrerá dentro
   da transação.
7. Reconsultar os registros e conferir leitura, imagens, saúde e readiness.

O relatório registrará IDs, hashes, totais de páginas, backup, release e resultado
das verificações. A limpeza de mocks anterior já está concluída e não será
reexecutada como parte da importação.

As alterações locais anteriores de e-mail, manual e homologação serão preservadas.
A publicação deve partir de uma base produtiva conhecida e integrar somente o
conjunto necessário; publicar toda a branch de trabalho não é consequência deste
pedido. Os scripts produtivos de deploy não serão alterados.

## Verificação e aceite

A entrega exige:

- oito PDFs íntegros e oito conjuntos completos de páginas WebP, sem páginas
  ausentes, repetidas ou fora de ordem;
- nove posts únicos e categorias corretas, verificados após recarregar;
- leitura de imagens e Código de Conduta dentro do Portal;
- fidelidade do Código à fonte oficial e preservação de versão, hash e histórico
  dos aceites;
- bloqueio das rotas de documentos sem autenticação ou sem aceite vigente;
- rejeição de descritores, números de página e tentativas de caminho inválidos;
- importação repetível sem duplicatas e recusa de conflitos;
- edição comum preservando o documento vinculado;
- navegação e ampliação verificadas em 320, 390 e 1366 pixels;
- falha e retry por imagem, troca de artigo durante carregamento e descarte dos
  recursos verificados;
- `npm run verify` e `git diff --check` aprovados;
- `/api/health` e `/api/ready` normais após a publicação.

Os testes se concentrarão nos contratos novos, na preservação do comportamento
existente e nos riscos reais de autenticação, arquivos e concorrência da leitura.
Uma verificação estática não substituirá a conferência dos documentos renderizados.
