# Conecta — imagens e vídeos nos conteúdos

## Objetivo e direção aprovada

Tornar os conteúdos existentes mais visuais sem mudar a identidade Conecta nem
reativar CMS, Owner News ou o antigo editor editorial. O usuário aprovou uma
mistura de materiais próprios e banco de imagens e, nesta sessão, a amostra de
artigo com fotografia e trilhas com capas e apresentação de vídeo sob demanda.

Preservar Manrope, fundo `#F7F6F2`, superfície `#FFFEFB`, índigo `#2A275E`,
laranja `#E84F1C` e as bordas discretas do Portal. A mudança é no conteúdo e na
hierarquia das mídias, não outro redesign do shell.

## Abordagem recomendada e alternativas

1. **Campos de mídia nos domínios existentes, por URL validada:** recomendada.
   Atende capas, resumos e vídeos sem reintroduzir dependências editoriais, com
   alterações aditivas e compatibilidade com conteúdo antigo.
2. **Upload e biblioteca de mídia próprios:** permitiria selecionar arquivos no
   Portal, mas acrescenta armazenamento privado, auditoria, exclusão/retenção e
   proteção de uploads. Não é necessário para a primeira entrega por URL.
3. **Editor editorial completo:** daria liberdade de blocos e galerias, mas
   ampliaria o produto e contrariaria o recorte aprovado sem CMS. Não adotar.

## Recorte da primeira entrega

- Base de Conhecimento: capa, resumo curto e um vídeo opcional por artigo. A capa
  aparece no card e na abertura do artigo. O corpo continua sendo texto simples,
  preservando parágrafos; não há HTML livre, editor de blocos ou galeria embutida.
- Academy: capa fotográfica opcional em catálogo, detalhe, retomada e dashboard.
  Ausência ou falha da fotografia conserva o fallback vetorial oficial. As aulas
  mantêm YouTube/arquivo HTTPS e recebem apresentação de mídia coerente com a
  capa, sem iniciar reprodução automaticamente.
- Lembretes: imagem opcional na apresentação web e no detalhe; quando aparecerem
  no dashboard, a miniatura não deve deslocar a data ou esconder o título. A
  tabela administrativa mantém ações, status e rolagem acessível. Não incluir
  mídia no email nem mudar cron, destinatários ou política de envio.
- Gestão: campos de resumo/capa/vídeo nos formulários dos respectivos domínios,
  com prévia, texto alternativo e crédito. Não criar editor editorial separado.

Os dados antigos, sem mídia, continuam funcionando e não recebem fotografias
automaticamente só por terem uma categoria ou determinado título.

## Modelo e contratos

Adicionar metadados opcionais às tabelas próprias dos três domínios, com migration
aditiva e atualização equivalente do bootstrap; não tocar nas tabelas editoriais
históricas. A implementação definirá os tipos e CHECKs com as regras PostgreSQL
do projeto antes de escrever a migration.

- Knowledge: `summary` (até 400 caracteres), `cover_image` e `video` opcionais.
- Academy: `cover_image` opcional, sem alterar IDs, audiência ou progresso.
- Reminders: `cover_image` opcional, sem alterar `active` ou canais de entrega.
- Imagem: objeto com `url`, `alt` obrigatório e `credit` opcional. Campos textuais
  limitados e renderizados como texto seguro. Remoção explícita usa `null`;
  atualização que omite o campo conserva o valor atual.
- Vídeo Knowledge: entrada `{ type, url }`, normalizada pelos mesmos critérios
  de mídia próprios da Academy; saída sem HTML de embed arbitrário. Remoção
  explícita usa `null` e omissão na atualização preserva a mídia existente.

Validators e helpers pequenos de mídia podem ser compartilhados sem transformar
os domínios em consumidores de CMS. Projeções públicas, administrativas e do
dashboard devem transportar somente os campos autorizados em cada domínio.

## Origem de imagens e vídeos

Primeira versão por URL, sem criar um novo serviço de upload ou biblioteca de
assets. Aceitar imagens locais sob `/assets/content/` e HTTPS com hostname exato
`images.pexels.com`; esta é a allowlist inicial para links externos. Rejeitar
outras origens, credenciais em URL,
traversal, protocolos executáveis e payloads arbitrários. O backend não faz fetch
de URLs enviadas em formulários. Material próprio exige autorização para uso;
fotos internas sensíveis não devem ser publicadas como assets estáticos.

As imagens demonstrativas selecionadas devem ser otimizadas e servidas localmente
em WebP, com origem, autoria e licença registradas em `public/assets/content/README.md`.
Referências verificadas para a amostra:

- Integração: fauxels, Pexels 3182801,
  <https://www.pexels.com/photo/photo-of-people-looking-on-laptop-3182801/>.
- Atendimento: MART PRODUCTION, Pexels 7709189,
  <https://www.pexels.com/photo/people-working-in-an-office-with-their-laptops-7709189/>.
- Licença consultada: <https://www.pexels.com/license/>. Não implicar endosso das
  pessoas fotografadas nem apresentá-las como funcionários da Ownerinc.

Vídeos serão incorporados somente de fontes publicadas com incorporação permitida
e coerentes com o tema da aula/artigo, ou arquivos autorizados. Clipes genéricos
de banco não serão apresentados como treinamento institucional. Não inventar
URLs, instrutores, duração, história da empresa ou conclusão de aulas.

## Apresentação e interação

- Cards de artigo: fotografia 16:9, título e resumo útil. A identificação de
  exemplo permanece clara, mas o aviso longo não ocupa o resumo de todos os cards.
  Sem `summary`, usar o fallback de resumo textual existente.
- Artigo: título, introdução, fotografia com crédito e corpo em largura de leitura.
  Vídeo opcional em seção própria, sem iframes dentro de cards clicáveis.
- Curso: fotografia temática com `object-fit: cover`, título e status real.
  Preservar retomada e progresso confirmados; não exibir percentuais fictícios em
  produção. O carregamento vetorial tardio não pode sobrescrever uma capa real.
- Vídeos: controles oficiais/nativos, sem autoplay ou carregamento de player
  externo antes da ação explícita quando houver capa de espera. Não criar
  controles fictícios; rótulos distinguem carregar mídia de iniciar reprodução.
- Imagens: dimensões reservadas para evitar saltos, lazy loading abaixo da dobra,
  alt adequado, `referrerpolicy=no-referrer` nas imagens externas e fallback que
  mantém título, texto e ações disponíveis. Não encaminhar token do Portal a
  hosts de mídia.
- Mobile: cards reorganizados sem títulos ilegíveis, crop destrutivo de pessoas
  ou overflow. Alvos interativos de pelo menos 44 px; foco visível e reduced motion.
- Troca de rota: descartar players/listeners e impedir respostas tardias de
  substituir o conteúdo da página seguinte. Preservar busca, filtros e histórico.

## Conteúdo demonstrativo e produção

Usar os oito artigos, seis lembretes e duas trilhas já aprovados como amostra,
com capas relacionadas aos respectivos temas e resumos individuais. Manter a
identificação de conteúdo fictício, mesmo ao melhorar os títulos e resumos.

Na implementação local, fixtures podem demonstrar cursos e progresso, sempre
rotulados. Em produção, os seis lembretes permanecem inativos e as duas trilhas
permanecem em rascunho. Aulas só podem ser cadastradas com mídia válida; roteiro
na descrição não equivale a aulas existentes. A ausência de vídeo autorizado
mantém o rascunho, sem falsificar conteúdo para completar o lote.

O aceite desta etapa é implementação e demonstração local. Um deploy e a
atualização dos registros produtivos são operações posteriores, com verificação
e autorização explícitas; o pedido anterior de cadastro não autoriza ativação
automática de cursos/lembretes nem substituição de conteúdo oficial.

## Verificação

- Testes de validação, omissão/null, payloads inválidos, protocolos/origens,
  autorização e manutenção dos campos antigos nas três APIs.
- Testes de migration fresh/upgrade/repetição e preservação de dados, em ambiente
  descartável autorizado; nunca executar migrations diretamente em produção como
  teste. Sem Docker/serviços locais sem aprovação.
- Testes de frontend: texto seguro, imagem com erro, fallback de marca, hidratação
  tardia, vídeo sem autoplay, descarte/abort e formulários protegidos.
- Prévia com mídias reais selecionadas, sem alegar reprodução real quando só
  houver fixture ou capa. Conferir carregamento e reprodução no navegador quando
  o provedor permitir; registrar limitações e créditos.
- Reflow em 360/402/768/1366/1920 px, teclado e auditoria automatizada das áreas
  alteradas. As artes AutoCard e Cards Pós permanecem intocadas.
- Executar `npm run verify` e `git diff --check`. Atualizar documentação de
  arquitetura, brief, operação Academy e a prévia local para o contrato ampliado.

## Fora do escopo

Upload de arquivos privados, biblioteca de mídia, CMS, feed de notícias, PDFs,
galerias de blocos, certificados, relatórios novos, mudança de autenticação,
instalação de infraestrutura e envio de emails demonstrativos.
