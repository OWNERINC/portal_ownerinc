# Páginas do Conecta

## Escopo e fronteiras

Domínio novo e independente para páginas internas compostas por modelos e blocos.
Não reutiliza tabelas, uploads, endpoints, renderer, grants ou jobs do CMS histórico.
Knowledge, Academy, AutoCard e Cards Pós conservam seus contratos próprios.

A primeira entrega compreendeu comunicado, texto rico e imagem estática,
prévia desktop/mobile, rascunho persistente, publicação, leitura e arquivamento.
A expansão autorizada acrescenta composição em uma/duas colunas, arraste e comandos
por teclado, presets de bloco, destaque, botão, separador, GIF, MP3 e MP4 privados,
e um modelo Owner News sintético com cinco seções. Os resultados observados da
expansão são registrados separadamente ao final, sem estender a evidência do primeiro lote.
O exemplo de vestimenta é ilustrativo, não uma política oficial.

## Base e compatibilidade

O desenvolvimento parte de `2cecbe8`, incluindo o aceite obrigatório do Código de
Ética. Nenhuma rota Pages fica isenta desse gate. A autenticação continua sendo
Firebase Bearer, validada pelo middleware existente com o perfil atual no banco.

O código novo evita recursos exclusivos de Node 24. Os manifests, imagens e checks
existentes continuam em Node 24; isso não demonstra que toda a aplicação e suas
dependências são executáveis em Node 18. A divergência preexistente de AGENTS.md
fica registrada, sem downgrade de infraestrutura ou reescrita incidental das regras.

## Contrato de documento

Snapshots originais usam `schema_version: 1`; a expansão usa versão 2. Ambos têm modelo identificado e versionado, metadados,
presets de apresentação e IDs UUID estáveis em seções, linhas, colunas e blocos.
A ordem dos arrays é canônica. O formato não aceita HTML, CSS ou JavaScript livre,
base64, URLs de arquivos como substituto de mídia privada ou plugins arbitrários.

O título, resumo, tags, audiência e corpo pertencem à mesma revisão. Tags organizam
a página; não se confundem com etiquetas visuais dentro do conteúdo.

Texto rico usa uma árvore validada: documento, parágrafo, títulos H2/H3, listas
ordenadas/não ordenadas, itens, texto e quebra. As marcas permitidas são negrito,
itálico, sublinhado e links seguros. O título principal produz um único H1 na
leitura. Links externos exigem HTTPS, sem credenciais; links internos são caminhos
root-relative, sem `//`, barras invertidas ou caracteres de controle.

Limites de referência: requisição JSON de 1 MiB, 100 blocos, 100 linhas, 100 mil
caracteres de texto agregado e dois níveis de listas. A validação do backend é a
autoridade, incluindo propriedades desconhecidas, IDs duplicados e referências.
Um rascunho pode estar incompleto; a publicação tem validação adicional.

## Identidade, revisões e concorrência

`pages` contém identidade, autoria, versão de concorrência e ponteiros de rascunho
e publicação. `page_revisions` contém snapshots; `page_revision_job_titles` e
`page_revision_media` contêm suas referências, inseridas na mesma transação.

Conteúdo, audiência e referências de uma revisão são append-only. A anonimização
de autoria por `ON DELETE SET NULL` é uma exceção explícita, sem modificar conteúdo.
Apagar um usuário não apaga páginas ou imagens publicadas. Autor nulo não concede
edição a administradores, publicadores ou superadministradores.

Salvar cria uma revisão e move somente o rascunho. Publicar exige a versão atual
e a revisão salva explicitamente revisada; nunca substitui a seleção por outro
rascunho mais novo. O ponteiro publicado, sua audiência e a auditoria mudam de
forma atômica. Falha de auditoria reverte a operação inteira.

As mutações recebem `expected_version` e `client_mutation_id`. Conflito retorna
409 e preserva alterações locais. O identificador é vinculado ao ator e ao hash
canônico de operação, destino e payload. Retry confirmado revalida acesso, mas não
reaplica o CAS já consumido nem gera uma segunda revisão/auditoria. Reutilizar a
mesma chave com outro conteúdo é conflito. Recibos não contêm tokens ou snapshots.

Não há exclusão definitiva exposta. Arquivar suspende leitura e mídia publicada.
Restaurar preserva o rascunho e não republica automaticamente. Revisões antigas e
arquivos referenciados permanecem preservados; esta entrega não introduz expurgo.

## Capacidades e audiência

`editPages` e `publishPages` são novas capacidades normalizadas, falsas por padrão,
não novos roles. Mantêm o requisito atual de `role=admin` e a herança de capacidade
do superadministrador. A concessão continua no fluxo administrativo existente,
sem backfill ou alteração de permissões reais durante o desenvolvimento.

- Editor cria e altera somente páginas de sua própria autoria, inclusive quando
  é superadministrador. Envia mídia apenas para essas páginas.
- Publicador pode listar/revisar rascunhos e publicar/arquivar/restaurar páginas.
  Essa capacidade não permite alterar o conteúdo de outra autoria.
- Um publicador pode publicar sua própria página; não existe aprovação obrigatória
  por segunda pessoa ou estado adicional de workflow.
- Leitura normal, inclusive para administradores, exige audiência da publicação.
  Prévia administrativa é uma operação explícita diferente.

A audiência inicial é restrita por cargo. Seleções pertencem à revisão e não
mudam com o rascunho seguinte. A publicação exige seleção válida com cargo ativo;
leitura exige o cargo atual ativo do usuário na seleção publicada. Cargo ausente
ou inativo não vira audiência geral. Renomear cargos não altera seus IDs e excluir
um cargo referenciado é restrito. Prévia de rascunho é exclusiva do autor autorizado
ou publicador. Um catálogo mínimo de cargos pertence ao próprio módulo, sem abrir
o endpoint administrativo de usuários.

## Mídia privada

Imagens pertencem a uma página, em subdiretório privado próprio `pages-private`.
Não são armazenadas como fotos públicas na raiz de `/uploads`. O backend não
busca URLs arbitrárias nem aceita SVG/iframe/script como conteúdo incorporado.

JPEG, PNG e WebP devem ser decodificados, limitados a 5 MiB/20 megapixels/quadro
único, sem upscale, com dimensão máxima de saída de 2400 px e normalização WebP
sem metadados. Multipart tem margem de transporte acima do limite exato do arquivo.
Os limites de imagem não alteram o normalizador compartilhado de foto de perfil.

Leitores recebem bytes somente quando a mídia integra a publicação autorizada.
Uma referência histórica não concede acesso de leitura normal. Prévia de revisão
requer autor/publicador autorizado; mídia ainda não referenciada só pode ser vista
no contexto explícito de edição da própria página. O uploader isoladamente não é
uma permissão de acesso global. Respostas são `private, no-store` e `nosniff`.

O frontend faz fetch autenticado e usa object URLs com descarte. Não inclui tokens
em URLs. A imagem anterior permanece após falha de substituição. Quotas e limite
de quantidade consideram também a mídia histórica registrada. Não há remoção de
arquivo referenciado por qualquer revisão preservada.

Filesystem e banco não são uma transação única: uma falha antes de commit pode
ter compensação, mas erro ambíguo de COMMIT nunca autoriza apagar o arquivo, pois
a linha pode ter sido persistida. Órfãos de crash exigem inspeção/retensão própria
futura, sem alcançar outros módulos ou bytes históricos.

No primeiro lote, GIF, áudio e vídeo não estavam habilitados. A expansão implementa
validação própria de frames/codecs/duração, acessibilidade, quotas e reprodução.
Download completo autenticado por blob não é streaming; não se promete HLS ou
provider externo privado. MP3/MP4 são preservados após validação, sem promessa de
remoção de metadados; imagem estática e GIF são normalizados.

## Frontend e ciclo de vida

`pages.html` serve catálogo/leitura/gestão; `page-editor.html` serve edição. Ambos
entram no router e no shell gerado. O renderer de conteúdo é compartilhado pela
prévia e leitura, sem renderer por modelo. A largura do container da prévia mobile
controla o reflow; não se simula celular apenas reduzindo visualmente um desktop.

ProseMirror é responsável pelo DOM do texto editável, com schema restrito. Não é
o mecanismo de layout da página. Dependências do editor são locais, fixadas por
lockfile, com bundle gerado reproduzível e avisos de licença; sem CDN ou migração
de framework. SortableJS entra no lote de composição, fixado e incluído no mesmo bundle local.

Salvamento inicial é explícito. A baseline só avança após confirmação do servidor
e somente para a fotografia enviada. Digitação posterior continua dirty. Falha,
conflito e operação com resposta incerta não anunciam publicação ou salvamento.
Não há promessa de recuperação offline ou armazenamento editorial em localStorage.

Guardas protegem alterações, gravação e upload, incluindo Back/Forward e logout.
Descarte cancela recursos, listeners, popovers, observers, editores e blobs. Respostas
tardias não podem atualizar outra visita ou identidade. Prévia não perde o rascunho.
Controles têm foco visível, alvo mínimo de 44 px, Escape/retorno de foco e respeito
a movimento reduzido. Ações não dependem de hover; opções ficam contextuais.

## Validação reproduzível e limites de evidência

Executar `npm run build:public`, o check read-only do bundle, os testes focados,
`npm run verify`, o check do shell gerado e `git diff --check`.

`tests/database/check-pages.mjs` usa PostgreSQL WASM efêmero, Express, rotas, arquivos
privados e middleware reais. Substitui apenas a identidade Firebase por contas
sintéticas. Requer `PGLITE_MODULE_PATH` instalado fora do projeto. Não acessa banco
remoto, não inicia Docker e não usa credenciais. Não prova paralelismo de processos,
PostgreSQL 16 nativo, Firebase real ou Nginx efetivo.

`tests/visual/check-pages.mjs` exercita o frontend real no Chrome contra esse backend
descartável. Requer também `PLAYWRIGHT_MODULE_PATH` e `AXE_MODULE_PATH` externos.
Confere o fluxo de edição/publicação, revisão isolada, navegação, teclado e reflow
em 360, 402, 768, 1366 e 1920 px. Evidências são locais e explicitamente sintéticas.
Não equivalem a aceite em aparelho físico ou produção.

Migrations fresh/upgrade/bootstrap, grants reais e readiness continuam com o harness
PostgreSQL descartável do repositório. Aplicação de migrations em ambiente existente,
concessão de permissões, publicação, merge e deploy não são efeitos do desenvolvimento.

O protótipo privado, as pranchas Pencil e o kit de assets não foram confirmados na
inspeção inicial. Nenhum arquivo sem licença/proveniência verificada deve ser
incorporado como substituto. A marca e Manrope existentes continuam sendo a fonte
visual. Fotografia de banco, se aprovada depois, deve permanecer ilustrativa.

### Evidência local do primeiro lote

- Verificador de banco: 75 verificações HTTP aprovadas, executando migration,
  consultas/transações, normalização e entrega de imagem privada reais em PGlite.
  Inclui repetição sem duplicar auditoria, CAS, rollback por falha da auditoria,
  restrição por cargo, referências históricas, arquivamento/restauração, grants e
  aceite de Ética. As identidades Firebase são sintéticas e as conexões de teste
  são serializadas; isso não comprova concorrência nativa entre processos.
- Verificador Chrome ampliado: 12 cenários aprovados, incluindo seleção/formatação
  de texto por teclado, upload e prévia real de imagem privada, prévia mobile,
  salvar sem alterar publicação, confirmação de publicação, duplo clique, edição
  durante save, falha/retry, duas sessões e navegação nativa por fragmento durante
  edição/upload e perda da resposta de um save realmente confirmado pelo servidor,
  com reconciliação idempotente antes de habilitar publicação. Editor e leitor
  passaram no axe WCAG A/AA e reflow em 360, 402,
  768, 1366 e 1920 px; nenhum erro JavaScript registrado.
- Os dois problemas encontrados pela revisão independente — remontagem por hash
  e confirmação indevida de save com resultado incerto — recebem regressões
  específicas. O resultado de teste é local, não autorização de publicação.
- O bundle local e os avisos de licença passam no check reproduzível read-only.
  Shell gerado e `git diff --check` também foram conferidos.
- Verificação integrada final: `npm run verify` com 880 aprovados, zero falhas e
  dois skips específicos de Linux no Windows. A auditoria de dependências de
  produção de API/cron retornou zero vulnerabilidades no escopo configurado.
- Revisão independente após as correções: `ship`, sem achados pendentes. Nenhum
  commit, merge, deploy ou concessão de permissões reais foi realizado.

Para repetir os verificadores, defina `PGLITE_MODULE_PATH` com o arquivo de entrada
da instalação externa de `@electric-sql/pglite`. Execute
`node tests/database/check-pages.mjs`. Para o navegador, defina também
`PLAYWRIGHT_MODULE_PATH` e `AXE_MODULE_PATH` com as entradas externas de Playwright
e `@axe-core/playwright`, e execute `node tests/visual/check-pages.mjs`. Os scripts
criam e encerram seu próprio backend loopback e banco em memória, limpando somente
o diretório temporário exclusivo criado por eles. `VISUAL_OUTPUT` escolhe o local
das capturas e do `results.json`; o padrão fica na pasta temporária `opencode/pages-editor`.

## Expansão até piloto — decisões de implementação

Em 10/11/2026, o usuário autorizou desenvolver composição, mídias e piloto.
O plano executável está em
`docs/superpowers/plans/2026-11-10-pages-pilot.md`. Esta seção registra decisões;
não converte recursos planejados em evidência de conclusão.

### Síntese da análise independente

- **Decisão:** expansão delimitada em schema v2, preservando o contrato v1 e a
  fundação de autorização, transação e revisões do primeiro lote.
- **Fatos inspecionados:** a hierarquia já possui IDs e arrays canônicos, mas o
  validador limita composição e tipos; editor/renderer achatam colunas; mídia é
  apenas WebP; o leitor refaz render em todo `popstate`.
- **Divergência resolvida:** manter v1 extensível era possível, porém ambos os
  analistas aceitaram v2 como fronteira explícita das novas semânticas. Conversão
  ocorre somente após ação v2 bem-sucedida; abrir, cancelar ou falhar não converte.
- **Hipóteses não confirmadas:** custo em VPS, suporte efetivo do pacote Alpine,
  reprodução em dispositivos físicos e integração Firebase/PostgreSQL/Nginx reais.
- **Riscos residuais:** subprocessos não são sandbox de memória/filesystem; blobs
  já baixados não podem ser revogados do dispositivo; teste automatizado não
  atesta qualidade editorial de transcrição/legendas ou uso de leitor de tela físico.
- **Verificação:** preservar regressões v1, testar upgrade populado 040→041,
  composição por teclado/ponteiro, probe/decode/reprodução de arquivos sintéticos,
  acesso tipado privado, histórico, retries, deep links e descarte; revisão fresca.
- **Condição:** implementar apenas arquivos definidos no plano, sem operações de
  produção, concessão de acesso real, reativação do CMS ou alteração da migration 040.

### Proveniência das fontes

As três fontes locais e seus textos SIL OFL 1.1 foram inspecionados. Em 10/11/2026,
os SHA-256 dos binários existentes corresponderam byte a byte aos arquivos de
Google Fonts indicados abaixo; nenhum binário foi alterado ou acrescentado.

| Fonte local | Fonte conferida | SHA-256 |
| --- | --- | --- |
| `Manrope-Variable.ttf` | `https://raw.githubusercontent.com/google/fonts/main/ofl/manrope/Manrope%5Bwght%5D.ttf` | `3ae11c49db0455a3cc33e37d380f20fdb8c7f8b41dc07625c177e3d87a9d6ae6` |
| `SourceSerif4-Variable.ttf` | `https://raw.githubusercontent.com/google/fonts/main/ofl/sourceserif4/SourceSerif4%5Bopsz,wght%5D.ttf` | `97b2d4da6e3cb494b5a1e66ae176914d852ccabef49e0c02c0df25f3e39aca0b` |
| `Oswald-Variable.ttf` | `https://raw.githubusercontent.com/google/fonts/main/ofl/oswald/Oswald%5Bwght%5D.ttf` | `5b38c246e255a12f5712d640d56bcced0472466fc68983d2d0410ec0457c2817` |

Licenças permanecem ao lado dos arquivos como `OFL-Manrope.txt`,
`OFL-SourceSerif4.txt` e `OFL-Oswald.txt`. Manrope continua sendo o padrão.
O piloto não substitui o PDF/kit Owner News original, indisponível nesta sessão.

### Contratos da expansão implementada

- Combinações aceitas: `schema_version: 1` / `comunicado@1`, versão 2 /
  `comunicado@2` e versão 2 / `owner-news@1`. Abrir uma revisão antiga não a migra.
  A primeira ação v2 bem-sucedida substitui a cópia de trabalho; o save pendente
  mantém seu payload/chave originais. A migration 041 amplia o schema sem atualizar
  snapshots ou privilégios. SHA-256 preservado de 040:
  `be822d6384830b775b397010929d87560e145f126c3d5fb953c09a32e59929bc`.
- Até 20 seções; `single` contém uma coluna e `two_equal` duas. A ordem de leitura é
  seção→linha→coluna esquerda inteira→coluna direita inteira, igual à ordem DOM e
  ao empilhamento mobile. Duas→uma concatena sem perder IDs/conteúdo. Destinos e
  undo usam IDs, e instâncias ProseMirror sobrevivem a movimentos e presets.
- Destaque usa texto rico restrito, tom e ícone fixos. Botão tem `label`,
  `preset: primary|secondary|text` e `destination: {type: url|section, value}`;
  `value` é HTTPS/root-relative seguro ou UUID de seção existente. Separador é um
  bloco sem HTML. Botões/separadores isolados não satisfazem conteúdo para publicação.
- O estilo opcional de bloco usa `align: start|center|end`,
  `scale: small|standard|large`, `palette: neutral|brand|warm` e
  `font: manrope|source-serif-4|oswald`, mapeados a CSS local. Não há CSS livre ou
  novas marcas inline de tipografia no texto rico.
- Multipart legado continua `image` + `client_mutation_id`. Novas mídias usam
  `file` + `kind: gif|audio|video` + `client_mutation_id`. O ACK preserva IDs e
  dimensões e acrescenta `kind`, `mime_type`, `duration_ms`; áudio tem dimensões nulas.
- GIF: 8 MiB, até 100 frames/20 milhões de pixels totais/30 segundos por ciclo,
  normalizado sem achatar animação. MP3: 10 MiB/600 segundos, uma trilha MP3 mono ou
  estéreo até 48 kHz. MP4: 25 MiB/120 segundos, H.264 yuv420p até 1920×1080/30 fps,
  AAC-LC opcional mono/estéreo até 48 kHz; VFR é conservadoramente rejeitado.
- MIME, propriedades, referências de mídia tipadas e duração são validados pelo
  servidor. Probe e decode completo usam executáveis absolutos locais, sem shell,
  demuxers fixos, protocolo file, referências externas desabilitadas, tempo/saída
  limitados e uma admissão por processo antes do buffer. Isso não é uma sandbox de
  memória. Ausência das ferramentas retorna indisponibilidade, sem aceitar por MIME.
- Linux usa o pacote FFmpeg do Alpine declarado no Dockerfile (não construído nesta
  tarefa). Windows exige `FFMPEG_PATH` e `FFPROBE_PATH` absolutos. O limite de
  transporte Pages é 26 MiB; JSON continua 1 MiB e quota histórica 50 arquivos/100 MiB.
- Áudio/vídeo só baixam após `Carregar`, sem autoplay; o usuário aciona os controles
  nativos. GIF usa `Iniciar animação` / `Parar animação`, não pausa/retomada. Áudio
  exige transcrição e vídeo também exige cues sincronizados para publicar. Cues
  são `{start_ms,end_ms,text}`, ordenados, sem sobreposição, até 500 itens e limitados
  à duração da mídia. VTT é criado como blob local, não buscado externamente.
- O catálogo permite selecionar o modelo sintético Owner News. Capa, índice,
  matéria, entrevista e reconhecimentos usam somente os blocos genéricos; pessoas e
  iniciativas são fictícias. URLs usam `pages.html?id=UUID#section-UUID`. Hash do
  mesmo documento mantém players e recursos; troca de query descarta e carrega outro.

Os scripts adicionais de aceite são `tests/database/check-pages-pilot.mjs` e
`tests/visual/check-pages-pilot.mjs`, com as mesmas variáveis externas dos checks
originais e os dois caminhos absolutos de FFmpeg. Os fixtures são gerados de lavfi
por `tests/helpers/pages-media-fixtures.mjs`; não há uploads reais ou binários de
mídia no repositório. `PILOT_VISUAL_OUTPUT` escolhe os artefatos; o padrão é
`opencode/pages-pilot` no diretório temporário. Os testes encerram os recursos que criam.

### Evidência independente da expansão — 10/11/2026

- `node tests/database/check-pages.mjs`: **75 verificações HTTP aprovadas** após
  a expansão, preservando os contratos do primeiro lote.
- `node tests/database/check-pages-pilot.mjs`: **125 verificações HTTP aprovadas**.
  Executa rotas, SQL e arquivos privados reais com FFmpeg local; inclui v1 anterior
  à migration, aplicação idempotente de 041, comparação efetiva de colunas,
  constraints, índices e grants entre bootstrap+040+041 e upgrade populado 040→041,
  modelo v2, referências tipadas, quota histórica, retry, rollback, publicação e arquivo.
- A verificação adicional rejeitou arquivos reais com codec/trilhas extras,
  duração/fps/frames excessivos, truncamento, referência externa e criptografia
  CENC. Dois arquivos têm stream anunciado 160×90/yuv420p, mas frames posteriores
  2048×1152 ou yuv444p: ambos rejeitados. MP4 válido com `sinf schm pssh url ` em
  metadados comuns foi aceito, sem confundir palavras com boxes de proteção.
- `node tests/visual/check-pages.mjs`: **12 cenários Chrome aprovados**, repetindo
  as regressões do primeiro lote e as cinco larguras.
- `node tests/visual/check-pages-pilot.mjs`: **16 cenários Chrome aprovados**:
  seleção/criação do modelo pelo catálogo real; controles de duas colunas; destino
  por teclado; drag por mouse e eventos touch do Chrome; colapso sem perda; mesma
  instância e undo ProseMirror; presets/blocos; uploads GIF/MP3/MP4 pelo editor;
  legendas editadas após substituir a cópia de composição e carregadas no player
  reutilizado; prévia mobile e confirmação de revisão/cargo; áudio/vídeo com avanço
  real de reprodução e cues; GIF com pixels visivelmente diferentes entre frames;
  início/parada explícitos; deep link/índice/Back/Forward sem refetch; troca de query
  pausando/limpando players e revogando todos os blobs; botão existente reconhecendo
  nova seção sem reload. Leitor auditado em 360/402/768/1366/1920 px, com ordem DOM
  canônica e geometria real de colunas. Axe WCAG A/AA sem violações nas superfícies
  verificadas; nenhum erro JavaScript registrado.
- `npm run verify`: **908 aprovados, zero falhas e dois skips específicos de Linux**
  no Windows. Os **55 testes Pages** focados fazem parte desse total, não se somam a ele.
- Build público, bundle/licenças reproduzíveis, shell gerado e `git diff --check`
  conferidos. Auditoria de produção API/cron: zero vulnerabilidades no escopo configurado.
- A revisão Astra high encontrou três problemas e exigiu correção: propriedades
  de vídeo somente no cabeçalho, busca textual ingênua de proteção MP4 e estado
  obsoleto em controles/mídia reutilizados. As correções recebem os testes reais
  descritos acima. A revisão fresca final Astra high retornou **`ship`**, sem
  correções adicionais obrigatórias, confirmando o fechamento dos três achados.
  O revisor inspecionou código/testes, mas teve shell e artefatos externos negados;
  as execuções, o diff acumulado e as capturas foram conferidos pela sessão primária.

Artefatos locais: `opencode/pages-editor/results.json` e
`opencode/pages-pilot/results.json`, com capturas correspondentes, no temporário.
Testes PGlite usam conexões serializadas e identidade Firebase sintética. Isto não
é homologação de PostgreSQL 16 nativo, autenticação Firebase oficial, Nginx efetivo,
build Linux do FFmpeg, capacidade VPS, aparelho físico ou leitor de tela físico.
Nenhum conteúdo real foi publicado e nenhum commit, merge ou deploy foi executado.

### Polimento visual do editor — 10/11/2026

Após inspeção local, o usuário aprovou o polimento completo descrito em
`docs/superpowers/specs/2026-11-10-pages-editor-polish-design.md`.
Mudanças de runtime localizadas em `public/css/pages.css` e `public/pages/editor.js`:

- Cabeçalho com status e grupos de ações; título/resumo em largura útil e
  metadados alinhados; barras de seção, linha e bloco com espaçamento explícito.
- Botões, selects, upload e campos seguem Manrope e tokens Conecta; handle deixa
  de ter aparência nativa. Ferramentas agrupadas por organização, apresentação e
  formatação. Rótulos visíveis dos tipos/presets ficam em português; valores JSON
  permanecem iguais e `data-block-type` identifica o tipo sem depender da tradução.
- Controles de interface não herdam Oswald/serif, alinhamento ou escala dos blocos.
  Contraste medido também sobre presets warm/brand; ações mantêm alvo de 44 px.
- Nenhum backend, schema, estado de save, mídia, renderer ou serviço foi alterado.
  O preview em uso não foi reiniciado e dados sintéticos/edições locais foram preservados.

Evidências primárias: `tests/visual/check-pages-polish.mjs` aprovado em 360, 402,
768, 1366 e 1920 px, com estados ocioso/selecionado/paleta brand/prévia; confere
geometria, fontes, gaps, isolamento dos presets, save real e axe/reflow. Os checks
Chrome originais/piloto passaram com 12+16 cenários após os ajustes de seletores
para `data-block-type`. `npm run verify`: 911 aprovados, zero falhas, dois skips de
Linux; 58 testes Pages focados fazem parte desse total. Capturas e relatório em
`opencode/pages-polish` no temporário. Revisão fresca Astra high: **`ship`**, sem
correções obrigatórias. O revisor inspecionou código e testes, mas não executou
checks ou acessou as capturas devido às permissões de suas ferramentas; execução
e inspeção visual são evidências da sessão primária. Bundle/licenças, shell gerado
e `git diff --check` aprovados. A versão atualizada foi aberta em nova aba do
preview local, sem recarregar a aba anterior nem reiniciar o servidor em uso.

### Editor V2 — reprodução de referência — 10/11/2026

O usuário enviou e autorizou a reprodução dos SVGs **EDITOR V2** de edição
contextual, estilo/cores, inserção, revisão, painel inferior mobile e botões.
Os seis arquivos foram rasterizados localmente e inspecionados. O arquivo `.ai`
anexado abriu como arte fotográfica de SPA, não como editor, e ficou fora do lote.
Especificação e plano em `docs/superpowers/specs/2026-11-10-pages-editor-v2-design.md`
e `docs/superpowers/plans/2026-11-10-pages-editor-v2.md`.

Implementação:

- `public/pages/editor-workspace.js`: header e barra dedicados, estrutura real de
  seções à esquerda, conteúdo central e propriedades à direita; aba Página para
  metadados/cargos. O shell continua montado, apenas apresentado em modo dedicado
  pela classe de rota, removida ao sair ou após falha de carregamento.
- `public/pages/editor-panels.js`: dialogs de inserção/estilo/estrutura, foco
  nativo e Escape. `public/css/pages-editor-v2.css`, carregado somente no editor,
  segue cores e proporções das referências; não altera tokens ou CSS do leitor.
- Formatação contextual no desktop e painel inferior não modal em tamanhos
  compactos, com Conteúdo/Estilo/Posição. Campos e controles textuais são movidos,
  não clonados; texto ProseMirror e mídia continuam com identidade estável.
- Barra curta no celular: Blocos/Prévia/Publicar. O menu Mais ações oferece
  Salvar rascunho, Inserir bloco, Estilo e Propriedades. **Salvar é explícito**;
  Concluir edição somente fecha o painel e não anuncia persistência.
- Inserção pesquisável dos tipos existentes, uploads privados e duas colunas.
  Estilo geral aplica somente presets suportados aos blocos existentes de forma
  atômica no rascunho; cancelar não altera o documento. Não cria herança global.
- Revisão com título, versão salva e cargos reais, mais checklist pessoal não
  persistente. Preserva CAS, snapshot revisado, idempotência e autorizações.
  Sem categoria/slug/audiência geral fictícios, galeria/FAQ/embed/cor livre ou
  substituição do conteúdo do usuário pelo exemplo desenhado.

Nenhum backend, migration, contrato JSON, estado de salvamento, renderer,
normalizador de mídia, ProseMirror ou Sortable foi modificado para este lote.
`dialog.js` recebeu apenas uma classe opcional compatível com os demais callers.
Os ícones locais usam geometria simples de linha; não foram importadas bibliotecas
ou fontes. Logos e fontes existentes foram preservados.

Evidências executadas pela sessão primária:

- `npm run verify`: **916 aprovados, zero falhas, dois skips Linux** no Windows.
- `tests/visual/check-pages-v2.mjs`: **10 cenários**, em **360, 390, 402, 768,
  1366, 1600 e 1920 px**. Inclui edição, busca/inserção, estilo aplicado e salvo
  na API/SQL, identidade PM, painel inferior e suas abas, retorno de foco após
  fechar/Escape/concluir, revisão, prévia, saída restaurando shell, publicador
  de outra autoria sem edição e resize com título/texto dirty e undo preservados.
- Comparação visual da sessão primária com as pranchas rasterizadas: capturas
  de edição/inserção/estilo/revisão a 1600×1160 e mobile 390×820. O conteúdo das
  capturas é sintético; diferenças de receita não representam conteúdo importado.
- Chrome original: **12 cenários**; piloto: **16**, com mídia e drag mouse/touch
  reais; polimento: **5 larguras**, fontes, gaps, contraste warm/brand e controles.
  Todos repetidos após as correções. Axe WCAG A/AA sem violações nas superfícies
  auditadas; sem overflow global ou erros JS registrados pelos verificadores.
- Bundle/licenças, shell gerado e `git diff --check` aprovados.
- Astra high: **`ship`** após corrigir estado pressed das marcas na toolbar
  movida, retorno do shell em falha de load e foco da folha Página no celular.
  Regressões específicas foram adicionadas. Revisão read-only de código/testes;
  shell/capturas externos foram negados ao revisor, portanto os PASS de execução
  e a comparação visual são evidências primárias, não reproduções independentes.

Artefatos no temporário: `opencode/editor-v2-reference` (referências rasterizadas)
e `opencode/pages-editor-v2` (capturas, `results.json`, `verify-final.log`).
As mesmas limitações de Firebase sintético, PGlite serializado, Windows/Chrome
e ausência de aparelho físico/homologação VPS continuam aplicáveis.

Ao abrir a prévia final, a porta 4186 já não tinha listener e o servidor anterior
estava encerrado. A demonstração descartável foi reiniciada com novo banco/ID,
sem parar serviços ativos ou recarregar abas anteriores. O banco em memória
antigo não foi recuperado. Nenhum dado real, permissão real, commit, merge ou
deploy foi alterado/executado.

Em 11/11/2026 o usuário autorizou o commit local da entrega completa. A checagem
pré-commit identificou CRLF no texto de licença original do Sortable: o gerador
agora normaliza os avisos para LF, preservando integralmente o texto e tornando
o resultado compatível com o blob Git e checkouts Linux. O teste reproduzível
também exige LF nos avisos. Capturas locais não integram o commit; autorização
para commit não inclui push, merge, deploy ou mudanças em serviços reais.
