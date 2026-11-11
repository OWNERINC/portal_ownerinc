# Editor V2 — reprodução visual e funcional das referências

## Estado e decisão já recebida

**Proposta para revisão; nenhuma implementação desta correção foi iniciada.**

Em 11/11/2026, o usuário contestou a fidelidade do frontend e das funções
publicadas. Após comparação com os originais, confirmou **Reproduzir visual e
funcionalidades dos SVGs**. Essa escolha não será perguntada novamente.

Esta proposta substitui as exclusões de reprodução da especificação de 10/11,
que adaptava os desenhos às funções então existentes. Não é outro polimento
estético. Também não autoriza novo deploy: a prévia corrigida será apresentada
e validada com o usuário antes de qualquer publicação.

## Fontes e diagnóstico

Referências obrigatórias, sem alterar os arquivos originais:

1. `EDITOR V2 · Desktop · Edição contextual.svg` — 1600×1160.
2. `EDITOR V2 · Desktop · Estilo e cores.svg` — 1600×1160.
3. `EDITOR V2 · Desktop · Inserir bloco.svg` — 1600×1160.
4. `EDITOR V2 · Desktop · Revisar publicação.svg` — 1600×1160.
5. `EDITOR V2 · Mobile · Painel inferior.svg` — 390×820.
6. `EDITOR V2 · Assets · Botões editáveis.svg` — 1600×480.

Os originais estão no Desktop; as rasterizações foram encontradas em
`opencode/editor-v2-reference/index.json`. Não é necessário reenviá-los.

As auditorias independentes visualizaram as seis referências, cinco capturas
da implementação e os módulos reais. A estrutura geral e algumas dimensões
estão próximas; a hierarquia e vários contratos são diferentes. O teste visual
anterior gera capturas, mas não compara a imagem entregue com a referência.

Fatos confirmados: painéis e controles diferentes; galeria/FAQ/embed ausentes;
estilo em lote não equivale a tema da página; histórico textual não equivale
necessariamente às setas de histórico no cabeçalho. Não há evidência de cache.

O conteúdo Owner News das capturas é diferente do guia ilustrativo dos SVGs.
Essa diferença, isoladamente, não prova defeito de layout. O mobile capturado
em Estilo também não prova ausência de comandos existentes em Conteúdo.

## Alternativas consideradas e direção

- **Reprodução ponta a ponta no módulo existente — recomendada:** manter o stack
  e os contratos seguros, completar modelo/validação/renderização e reproduzir
  a apresentação dos SVGs. Evita controles falsos e reescrita de produto.
- **Somente aparência:** inadequada ao escopo confirmado; deixaria funções ausentes.
- **Editor paralelo/rewrite:** aumenta duplicação e risco de divergência de dados,
  sem necessidade demonstrada. Não adotado.

## 1. Contrato visual

- Reproduzir marca compacta, tipografia, cores, hierarquia, densidade, ícones,
  ordem e posição dos controles das pranchas; não trocar fontes/frameworks.
- Desktop: cabeçalho e segunda barra com a organização original; trilhos próximos
  de 220/280 px; modelo como controle real, seletor de dispositivo e zoom.
- Canvas: remover as linhas técnicas de seleção sempre visíveis. Seleção,
  arraste e alternativas por teclado/toque permanecem alcançáveis, sem impor
  aquela linha extra a cada bloco.
- Inspetor: título contextual e sequência Tipografia, Tamanho, Alinhamento,
  Largura, Fundo/amostras, Tags, Ícone e Opções avançadas. Propriedades não
  aplicáveis não podem fingir efeito no bloco selecionado.
- Estilo: abas Tema/Tipografia/Cores, exemplos e paletas Conecta/Editorial/Neutro
  correspondentes às referências, campo de cor e estados selecionados reais.
- Inserção: âncora, largura, densidade, ícones, busca e agrupamentos da referência.
- Revisão: hierarquia, campos, fechar e Voltar à edição/Publicar página da prancha.
- Mobile: agrupamento de Blocos/Prévia/Publicar, painel inferior e abas iguais
  ao estado de referência. Fechar/Concluir edição sempre alcançáveis, inclusive
  com teclado e safe-area; não basta esconder conteúdo em uma folha extensa.
  Conteúdo mantém a apresentação compacta de formatação, tipografia e fundo;
  ajustes adicionais ficam nas abas próprias, não alongam essa tela inicial.
- Botões: reproduzir os espécimes e estados, inclusive ícone, foco, carregamento,
  desabilitado e confirmação. Alvos acessíveis podem ampliar a área clicável
  sem ampliar arbitrariamente o desenho visível.

As frases de protótipo não serão copiadas como afirmações falsas de produção.
Conteúdo de exemplo fica identificado como ilustrativo; status de salvamento
e publicação refletem operações reais.

## 2. Edição, histórico, modelos e inserção

**Comportamentos propostos para os pontos não definidos pelos SVGs:**

- Salvar permanece explícito; estado salvo depende do reconhecimento do servidor.
  A área de status oferece Salvar rascunho quando houver alterações; o comando
  também fica no menu e em atalho. Concluir edição fecha o painel, não salva.
- Desfazer/refazer no cabeçalho cobre o rascunho local: texto, metadados, estilo,
  composição e movimentação. Histórico coordenado com o texto rico, sem duas
  pilhas concorrentes. Após salvar, desfazer deixa o rascunho alterado de novo.
- Histórico não reverte publicação, permissões, revisões no servidor nem remove
  arquivos enviados. Upload em andamento ou confirmação ambígua não será
  convertido em uma falsa operação desfeita.
- Dispositivo e zoom são estado de visualização da sessão. Desktop e mobile 390 px;
  zoom em 50/75/100/125/150%, sem mudar o documento ou a audiência. O dispositivo
  altera a largura da superfície; zoom escala essa superfície sem reescrever
  fonte, tamanhos ou colunas do documento. Não anunciar emulação de aparelho físico.
- O menu Modelo inclui Guia interno e os modelos existentes. Escolher um modelo
  para outro conteúdo cria novo rascunho; não substitui o documento aberto.
  A proteção de alterações não salvas continua obrigatória.
- Adicionar bloco insere no ponto escolhido, não obrigatoriamente no final.
  Duas colunas cria um grupo novo nesse ponto; converter uma linha existente
  continua disponível em organização avançada, sem misturar as duas operações.
- Imagem/GIF, áudio e vídeo abrem seletores do tipo correspondente. Validação
  de servidor permanece obrigatória, mesmo com filtro do seletor.
  Cartões de mídia oferecem selecionar/substituir arquivo no próprio contexto;
  um espaço ainda sem arquivo nunca anuncia upload pronto ou publicação válida.
- Estrutura permite navegar e ordenar seções com arraste e comandos acessíveis.
  Opções avançadas reúne mover, duplicar, excluir e destino, sem inventar funções.

## 3. Estilo persistido e compatibilidade

- Estilo da página define padrões persistidos para a página e novos blocos.
  Blocos podem ter substituições explícitas. Reabrir o painel mostra o estado real.
- Aplicar altera o rascunho local; cancelar não modifica dados. Nada é publicado
  por mudar tema, fonte ou cor.
- As paletas antigas conservam seu significado: o `brand` verde existente não
  será redefinido como a paleta índigo/laranja. Documentos e revisões anteriores
  não serão recoloridos nem reescritos automaticamente.
- Fonte, tamanho, alinhamento, preenchimento, cor, ícone e tags do inspetor são
  propriedades reais do bloco; tags locais são distintas das tags da página.
- Largura usa composição de linha inteira/meia linha, com consequências claras
  para os vizinhos. Não cria canvas livre ou valores percentuais arbitrários.
- Proposta para os ícones contextuais ambíguos: marca-texto modifica realce de
  fundo do texto selecionado; paleta modifica sua cor de texto.
- Cores personalizadas aceitam apenas hexadecimal sólido normalizado. Nunca
  CSS livre, URL ou HTML. A UI informa se está alterando texto, fundo ou destaque.
- Proposta de contraste: indicar o problema durante a edição e impedir nova
  publicação com contraste abaixo de AA nos pares de cores controlados pelo editor.
  Não aplicar uma mudança retroativa aos documentos históricos publicados.

Proposta técnica: formato documental adicional v3 para as novas capacidades,
mantendo leitura e validação v1/v2 e sem acrescentar silenciosamente chaves novas
às versões antigas. Essa é uma escolha técnica proposta, não um requisito extraído
dos desenhos. As migrations aditivas e o rollout serão detalhados no plano.
Não prometer frontend-only ou ausência de migration: os validadores atuais são
estritos. IDs, referências de mídia e aparência anterior são condições obrigatórias.

## 4. Galeria, FAQ e vídeo por link

- **Galeria:** grade responsiva ordenada de imagens/GIFs privados, com texto
  alternativo, legenda/crédito por item e ordenação acessível. Sem carrossel,
  lightbox ou autoplay inferidos do desenho. Limites/quota atuais continuam
  válidos para todos os itens e referências históricas.
- **FAQ:** perguntas em texto e respostas no texto rico permitido; itens podem
  abrir independentemente, com teclado e semântica acessível. Estado aberto é
  local à leitura, não uma revisão de conteúdo ou workflow de aprovação.
- **Vídeo externo — proposta para aprovação:** YouTube como provedor inicial,
  coerente com a integração já usada no Portal. URL normalizada para identidade
  de provedor/vídeo; não aceitar iframe/HTML arbitrário ou buscar URLs no servidor.
- Player externo só carrega após ação explícita, sem autoplay. Informar que
  reprodução faz conexão com terceiro e que autenticação do Portal não torna
  aquele vídeo externo privado. Upload MP4 privado continua disponível.
- Outros provedores, como Vimeo, dependem de decisão explícita antes de entrar
  na allowlist; não haverá campo que aceite uma URL e silenciosamente não funcione.

## 5. Botões e ações reais

- Botões de conteúdo têm rótulo, aparência/ícone e destino real. Navegação, ação
  de mídia e download não são a mesma operação com ícones diferentes.
- Ver guia completo navega para seção/URL segura; Assistir ao vídeo pode apontar
  para um bloco de vídeo da mesma página, com foco/ativação explícitos.
- Baixar material entrega um arquivo associado à página por endpoint autenticado,
  com autorização da revisão e disposição de download. A primeira proposta usa
  os tipos de mídia já suportados; não presume biblioteca genérica de documentos.
- Enviar arquivo corresponde ao upload autorizado do autor. O espécime não
  autoriza formulários de envio por leitores ou novas permissões de escrita.
- Salvo representa confirmação real da operação, nunca um botão de conteúdo
  editável que declare persistência sem ter salvo.
- A prancha de botões será validada como vocabulário de componentes; não será
  usada para inventar cinco processos de negócio novos.

## 6. Categoria, URL, visibilidade e revisão

- Título e categoria são metadados editáveis e revisionados. Categoria usa campo
  com sugestões de valores existentes e possibilidade de novo valor; não cria
  um módulo de taxonomia nem reativa CMS histórico.
- URL amigável mostrada deve funcionar. Proposta: alias interno autenticado,
  gerado a partir do título ao salvar para revisão; UUID permanece a identidade.
  Colisões recebem sufixo estável confirmado pelo servidor antes da revisão.
- Alterar título posteriormente não troca a URL já atribuída. Não se presume
  edição manual de slug ou redirecionamentos públicos a partir da prancha.
- Somente colaboradores continua restrição interna **pelos cargos ativos
  selecionados**. Alias e aparência de dropdown não ampliam público nem autoria.
- Título/categoria/público alterados durante a revisão invalidam o snapshot
  conferido. É necessário salvar e conferir a nova revisão antes de publicar;
  o botão não publica silenciosamente um documento diferente do exibido.
- Checklist é auxílio de sessão. Não é aprovação persistida nem requisito de
  segunda pessoa. Validações reais permanecem independentes dele.
- Publicar usa a revisão salva exata, CAS, chave idempotente e autorização real.
  Arquivar/restaurar e leitura de revisões existentes continuam preservados.

## 7. Verificação e aceite antes de deploy

1. Criar fixture sintética isolada equivalente ao guia da referência: textos,
   seções, seleção, estilo, estado salvo e posição de rolagem comparáveis. Nunca
   substituir documento de usuário para fabricar uma captura parecida.
2. Comparar quatro estados desktop 1600×1160, Conteúdo mobile 390×820 e espécimes
   de botões 1600×480. Carregar fontes, fixar escala/estado/foco e capturar cada
   estado de forma independente, sem herdar alterações de outro cenário.
3. Usar sobreposição/diferença por região e inspeção de cada controle. Proposta
   de tolerância geométrica: 2 px em âncoras fixas e 4 px em controles; diferenças de
   antialiasing avaliadas separadamente. Um percentual global não pode aprovar
   um painel errado ou controle ausente. Exceções acessíveis serão documentadas.
4. Exercitar cada ação: seleção, texto, estrutura, histórico, modelo, inserção,
   estilos, galeria, FAQ, embed, botões, categoria/alias, revisão e mobile.
5. Para cada propriedade persistida: editar → salvar → recarregar → conferir
   prévia/leitor. Cobrir erro, conflito, retry ambíguo e preservação de edições.
6. Preservar regressões de autoria, cargos, CAS/idempotência, revisão conferida,
   mídia privada, limites, cancelamento, foco, teclado e lifecycle.
7. Manter verify, bundle/licenças, shell, Nginx real e CI, sem confundi-los com
   aceite visual. Executar revisão fresca e apresentar as comparações ao usuário.
8. Não fazer novo deploy antes da validação da prévia e autorização de publicação.

## Proteções e limites

Manter HTML/CSS/JavaScript, Express/CommonJS e PostgreSQL. Não introduzir outro
framework/editor paralelo, substituir conteúdo real, ampliar capacidades ou
expor mídia. Nenhum SQL de produção, backfill, reset, descarte de screenshots,
alteração de outra worktree ou deploy faz parte desta etapa de especificação.

O rollout e a recuperação devem suportar os novos documentos antes de habilitar
novos escritores; não assumir que uma release antiga conseguirá ler um formato
novo. A estratégia será detalhada no plano após aprovação deste contrato.
