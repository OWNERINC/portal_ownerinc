# Redesign Conecta Ownerinc — V3.5 laranja

## Objetivo e decisão de escopo

Aplicar a referência V3.5 laranja ao Portal atual, em desktop e mobile,
com integração aos fluxos existentes, revisão do PR e verificação do deploy.
O usuário aprovou a direção visual no material de referência e escolheu
“Redesign completo do Portal atual” nesta sessão em 08/11/2026.

Esta especificação está em revisão antes do planejamento de implementação.

## Fonte visual e rastreabilidade

- Handoff: “Conecta Ownerinc — referência para desenvolvimento”, de 08/11/2026.
- PDF informado: `Conecta-Ownerinc-Laranja-PREVIA-2026-11-08.pdf`, no Drive
  `https://drive.google.com/file/d/1i1CnvHDIY__Y5yN6zoFGrFrnbKPss6XQ/view`.
  O caminho informado no PC Usuario não existe neste ambiente; o PDF não foi lido.
- Fonte efetivamente consultada: canvas aberto no Pencil via MCP, no documento
  `Conecta-Ownerinc-V2.pen`. Os tokens `v35-*` correspondem ao handoff.
  O nome antigo do arquivo não determina a versão das pranchas no canvas.
- Dashboard conferido visualmente: `MbSMe` (D01, 1920 × 1080) e
  `l37OU` (M01, 402 px de largura). Variantes: `Hkud8` (menu recolhido)
  e `X8IGx` (expandido). A navegação mobile aberta é `kyhN7`.
- A leitura de textos do dashboard e da sidebar confirmou Manrope.
  O dashboard mobile usa título 28/800, seções 21/800 e corpo 14–16.
- Componentes: `KTGKN`; identidade: `W5PyN9`; marca e feedback: `lw7cj`.
- Logo original e símbolo: componentes `Jll9h` e `tCupM`.
  Extrair os assets originais, conservando geometria e proporções.
- As 147 pranchas informadas são variantes e documentação, não uma contagem de
  funcionalidades. Os 82 alertas de recorte do handoff precisam de inspeção por
  contexto; não são tratados como defeitos confirmados.

## Abordagem

Usar a arquitetura HTML/CSS/JavaScript existente. Evoluir os tokens e componentes
compartilhados primeiro; depois adaptar cada área aos seus contratos atuais.
Isso permite coerência entre telas e conserva o shell persistente.

Foi considerada uma entrega inicial limitada a login, navegação e dashboard;
o usuário escolheu a cobertura completa. A reintrodução de Notícias e CMS foi
apresentada como ampliação funcional e não foi escolhida.

## Sistema visual

Tokens semânticos de referência:

| Papel | Valor |
| --- | --- |
| Fundo | `#F7F6F2` |
| Superfície | `#FFFEFB` |
| Texto principal e ação primária | `#2A275E` |
| Texto secundário | `#6C706D` |
| Borda | `#E1E2DD` |
| Destaque e ícones | `#E84F1C` |
| Texto destacado | `#C4461A` |
| Seleção | `#E8E6EB` |
| Sucesso / fundo | `#345F50` / `#E9F1EB` |
| Erro / fundo | `#B13F38` / `#FBEDEB` |
| Informação / fundo | `#2A5970` / `#EAF1F4` |
| Aviso / fundo | `#805D18` / `#F6EDDA` |
| Desabilitado / texto | `#ECEBE8` / `#858783` |
| Scrim | `#201E4D66` |

Manrope será servida localmente com sua licença. A escala por componente será
extraída das pranchas correspondentes; a tipografia própria das artes exportadas
por AutoCard e Cards Pós permanece vinculada aos respectivos modelos.

Separar tokens de ação primária (índigo) e destaque (laranja), pois trocar apenas
o valor do atual `--primary` propagaria a semântica errada. Usar composição limpa,
bordas discretas, seleção lavanda e estados com texto/ícone além de cor.
O contraste será medido nas combinações efetivamente utilizadas.

## Navegação e responsividade

- Sidebar clara, com grupos Portal, Ferramentas e Gestão; conta e saída ao final.
- Referência desktop: 256 px expandida e 88 px recolhida, com preferência
  persistida e nomes acessíveis também no estado recolhido.
- Cabeçalho mobile compacto, símbolo oficial e menu acionável por teclado/toque.
- Alvos de toque de pelo menos 44 × 44 px; controles principais de 48 px quando
  compatíveis com a prancha. Ícones menores não diminuem a área acionável.
- Menu sobreposto com foco controlado, Escape, retorno ao acionador e fechamento
  ao navegar. Conteúdo e ações continuam utilizáveis com teclado virtual.
- Layout fluido: referência desktop 1920 × 1080 e mobile 402 px, com validação
  adicional em 360, 768 e 1366 px. A altura da tela não limita conteúdo real.
- Evitar overflow horizontal da página. Tabelas podem ter rolagem própria
  identificada; formulários e prévias se reorganizam conforme o espaço disponível.
- Navegação preserva URLs `.html`, histórico, deep links, montagem/descarte e
  proteção de alterações pendentes do router atual.

## Cobertura das áreas

1. **Login e recuperação:** identidade oficial, hierarquia de campos e ações,
   mensagens de autenticação e recuperação ligadas ao Firebase existente.
   Estados do desenho só aparecem quando suportados pelo fluxo real.
2. **Dashboard:** saudação, atalhos, continuação da Academy e próximos lembretes,
   com dados reais e estados independentes de carregamento, vazio e erro.
   A composição se adapta ao conteúdo atual sem a seção de Notícias.
3. **Conhecimento:** busca, filtros, listagem, leitura e edição autorizada;
   preservar o contrato de texto simples e a ausência de PDF/CMS ativos.
4. **Lembretes:** lista, criação/edição, detalhes e entregas/filtros existentes;
   validação inline, mensagens de retorno e operações disponíveis por permissão.
5. **Academy:** catálogo, continuação, curso e aula; preservar currículo, audiência,
   mídia própria, progresso e comportamento do player. Imagens ilustrativas do
   canvas não substituem dados ou capas que a API não oferece.
6. **Perfil:** campos, foto, feedback de upload e ações existentes.
7. **Administração:** usuários, filtros, convites, permissões, atividade e demais
   abas existentes, com tabelas/formulários responsivos e confirmação de ações.
8. **AutoCard:** criação, edição, histórico e exportação com novo entorno visual,
   mantendo os contratos de imagem, crop e geração da arte.
9. **Cards Pós:** proprietário/convidado, seções, prévia, salvar, histórico,
   duplicação, exclusão e PDF. Adaptar F01–F35 aos estados reais; a escolha de
   seção no mobile e as ações persistentes não podem esconder campos da arte.
10. **Rotas auxiliares existentes:** Benefícios e Sólides recebem coerência dos
    componentes compartilhados, mantendo sua disponibilidade atual.

Notícias, CMS e enquetes permanecem fora do runtime conforme a decisão de escopo.
O redesign não inclui uma migração de framework ou de banco de dados.

## Fronteiras técnicas e dados

- `public/css/tokens.css`: fonte semântica de cores, tipografia, ritmo e dimensões.
- `public/css/components.css` e `layout.css`: controles, feedback e shell.
- `scripts/generate-public-shell.mjs`: fonte do markup gerado da navegação;
  gerar e conferir as páginas consumidoras para evitar divergências.
- `public/js/sidebar.js`, `sidebar-state.js`, `auth-shell.js` e router:
  evolução localizada de interação e acessibilidade.
- CSS e módulos de cada área: adaptar composição conservando IDs, eventos e
  contratos consumidos pelos loaders, APIs e testes.
- `public/assets/`: assets oficiais e fontes locais, com proveniência/licença.
- `api/`, `cron/` e `nginx/`: fronteiras existentes mantidas. Uma divergência
  funcional encontrada será registrada, sem inventar endpoints para o desenho.

Ocultar uma ação no frontend não substitui autorização. Dados e permissões
continuam vindo das integrações existentes. Falhas de uma seção não interrompem
as demais; referências DOM opcionais são verificadas antes de manipulação.
Conteúdo de usuário continua sendo renderizado com segurança.

## Verificação e critérios de aceite

- Executar `npm run verify` na base e após a implementação, mais
  `git diff --check` antes de commit.
- Manter os testes de contratos existentes; adicionar regressões relevantes para
  mudanças de navegação, foco, estados e comportamento responsivo.
- Conferir visualmente todas as áreas cobertas em desktop/mobile, incluindo
  menu expandido/recolhido, modais, filtros e conteúdo longo.
- Verificar Tab/Shift+Tab, foco visível, Escape, nomes acessíveis, erros associados
  aos campos, estados anunciados e preferência de movimento reduzido.
- Separar evidência visual com fixtures da validação autenticada e persistência
  real. Fixtures não são conteúdo de produção nem prova de integração.
- Registrar resultados, capturas e limitações reais de acesso/ambiente.

## PR e deploy

Trabalhar na branch `feat/conecta-orange-redesign`, em worktree própria, com
commits revisáveis. O checkout original contém uma alteração não commitada em
`public/css/dashboard-home.css` (duas colunas acima de 1020 px), que foi lida e
permanece no checkout original. A implementação terá sua própria composição
desktop baseada na referência aprovada.

Abrir PR com resumo por área e evidências. Fazer revisão fresca do diff completo,
corrigir achados e acompanhar os checks do CI antes da integração. A revisão
deve cobrir regressões de permissões, router, upload/exportação e fidelidade visual.

O deploy existente é GitHub Actions → GHCR → VPS, disparado em `main` após
validação. Revisar o workflow, o SHA publicado e os logs da release; conferir
health/readiness, recursos estáticos e smoke pelo domínio público documentado
`https://portal.ownerinc.com.br`. Validar navegação autenticada quando houver
sessão disponível. Sucesso de health isolado não comprova o deploy completo.

A solicitação inclui review de PR/deploy; merge e acionamento de produção serão
confirmados com o usuário antes de executá-los. Docker que afete serviços em
execução exige aprovação explícita conforme `AGENTS.md`.
