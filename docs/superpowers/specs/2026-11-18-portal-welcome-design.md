# Destaques institucionais e boas-vindas do Portal

## Objetivo e decisões aprovadas

Dar mais orientação a quem entra no Conecta, destacar permanentemente o Código
de Ética e Conduta e retirar a Academy da navegação principal por enquanto.
Atualizar o manual de administradores e operadores com a experiência resultante.

O usuário confirmou:

- O Código precisa de uma capa visual, usada na Base e no Dashboard.
- A Academy será ocultada **somente no menu e no Dashboard**. A gestão no Admin
  e os links diretos continuam disponíveis.
- As boas-vindas serão uma **seção fixa do Dashboard**, mantida com a interface,
  em vez de um novo artigo administrável.

Base de publicação: `31de9142b9ad5c8feef0d1754768f6b1ab3e938b`, PR #103.
Os nove posts e 207 páginas WebP já existem em produção.

## Experiência

### 1. Boas-vindas no Dashboard

A abertura apresenta saudação conforme o horário de São Paulo e o primeiro
nome do perfil validado. Sem nome utilizável, usa uma saudação neutra.
Nomes e demais dados entram como texto, sem interpretação de HTML.

Direção visual: composição editorial com fundo claro, índigo e laranja do
Conecta, tipografia existente, título confortável, espaços bem definidos e
elementos gráficos discretos da marca. Evitar uma coleção de cartões aninhados
ou um banner que ocupe toda a primeira tela.

O texto explica, em linguagem direta, como o Portal ajuda no dia a dia:

- **Base de Conhecimento:** documentos, manuais de uniformes e orientações.
- **Notificações:** avisos e lembretes destinados à pessoa.
- **Pages:** comunicados e conteúdos internos liberados para seu cargo.
- **Meu Perfil:** atualização de dados pessoais e foto.
- **AutoCard:** criação de peças e artes de vagas, somente para contas com
  acesso real à ferramenta.
- **Cards Pós:** criação e edição dos convites Guest e Owner, somente para
  contas com acesso real.
- **Admin:** acesso à gestão apenas quando permitido pela regra atual.

Os links têm rótulos que explicam seu destino. Ferramentas indisponíveis para
a conta não são anunciadas como liberadas. A seção é permanente e responsiva,
sem pop-up, carrossel, etapa obrigatória ou estado de dispensa.

### 2. Código de Ética na Base

O post com descritor `document.kind === 'ethics'` recebe prioridade na ordenação
da API, antes de `updated_at` e do desempate por ID. Assim, a primeira página
do catálogo mostra o Código antes dos materiais de Uniformes.

A prioridade respeita busca e categoria: o Código só aparece quando atende ao
filtro aplicado. Não é duplicado em outras páginas nem forçado sobre resultados
que não correspondem à pesquisa.

Seu bloco recebe capa institucional, identificação discreta de destaque e
continua abrindo o leitor oficial já existente.

### 3. Código de Ética no Dashboard

Um destaque permanente aparece logo após as boas-vindas e antes dos conteúdos
variáveis, com a mesma capa, título, descrição curta e ação **Ler Código de Ética**.

O Dashboard consulta o primeiro artigo da Base pela API autenticada, verifica
que é o descritor institucional e monta o link com o ID retornado. Não depende
do título editável ou de um UUID codificado na interface.

Se a consulta falhar, o destaque mantém seu contexto e oferece nova tentativa.
Se o post não existir, informa a indisponibilidade sem apontar para um documento
diferente. As boas-vindas e notificações continuam funcionando.

### 4. Capa institucional

Criar um único recurso visual local, reutilizável, com a marca Ownerinc/Conecta e
o título **Código de Ética e Conduta**. A capa pode ser vetorial, para manter
nitidez em celular e desktop, sem fonte externa ou conteúdo remoto.

O título também permanece em HTML para leitura assistiva; a capa é decorativa
quando repetir esse texto. Não inventar selo, assinatura, versão nova ou
aprovação institucional. A arte não modifica o documento oficial.

### 5. Ocultação temporária da Academy

Retirar a entrada da lista principal do gerador do shell e regenerar as páginas
mantidas. Retirar atalhos, destaque de curso e texto de aprendizado da página
inicial. O Dashboard deixa de fazer consultas à API Academy, inclusive após
retornar pelo histórico/BFCache.

Conservar a página Academy, sua rota, permissões, API, gestão administrativa,
dados e progresso. Isso permite acesso direto e reativação futura sem migração.
O manual explicará essa disponibilidade temporária.

### 6. Manual do administrador

Reaproveitar a fonte e o gerador do manual que permanecem no checkout anterior:
`docs/operations/manual-operadores.md` e `scripts/build-operator-manual.py`.
Conferir suas instruções contra o código efetivamente publicado e esta mudança;
a referência anterior era uma branch com correções ainda não publicadas.

Atualizar:

- Dashboard, boas-vindas e navegação;
- acesso recorrente ao Código, distinto do fluxo obrigatório de aceite;
- leitura WebP, ampliação, texto extraído, original e edição dos artigos;
- prioridade do Código e efeito dos filtros;
- disponibilidade administrativa/direta da Academy;
- edição e versão do manual.

Entregar Markdown editável e PDF regenerado, com sumário e conferência de todas
as páginas para texto ausente, cortes, overflow e legibilidade. Manter o gerador
reproduzível e o link documental no README.

## Arquitetura e limites

- `public/`: apresentação, capa e ciclo de vida do Dashboard/Base.
- `scripts/generate-public-shell.mjs`: fonte da navegação gerada.
- `api/routes/knowledge.js`: prioridade institucional na listagem existente.
- `docs/` e gerador documental: manual e evidências.
- Nenhuma nova tabela, migration, importação de posts ou flag operacional.
- Preservar `api/ethics/term.json`, versão, hash e registros de aceite.
- Preservar o leitor privado, os pacotes WebP e suas rotas autenticadas.
- Usar o ciclo de vida e helpers existentes para abortar requisições e ignorar
  respostas antigas. Sem novas dependências de runtime.
- Manter Node 18 e o fluxo de publicação existente.

## Critérios de aceite

1. Código é o primeiro artigo elegível em consultas sem filtro e filtros
   compatíveis; busca/categoria/paginação e artigos comuns permanecem corretos.
2. Capa única aparece na Base e no destaque do Dashboard, com texto legível,
   proporção preservada e ação que abre o Código real.
3. Dashboard apresenta boas-vindas e explicações úteis, adaptadas às permissões,
   sem renderizar conteúdo de perfil como HTML.
4. Não há Academy no menu ou Dashboard, nem requisições Academy originadas
   pelo Dashboard. Gestão e acesso direto continuam funcionais.
5. Falha/ausência do Código não interrompe boas-vindas ou notificações.
   Navegação durante carregamento não altera uma página já desmontada.
6. Desktop e viewports de 320/390 px sem overflow horizontal, links acessíveis
   por teclado e foco visível.
7. Manual Markdown/PDF coerente com a interface final; todas as páginas do PDF
   verificadas e sem cortes.
8. Testes focais, navegador e `npm run verify` passam; `git diff --check` limpo.
   Revisão independente ao concluir, conforme instruções do repositório/skill.

## Publicação e aprovação

A especificação cobre implementação e validação desta atualização. A aprovação
de deploy anterior pertence à entrega dos documentos já concluída. Publicar
esta nova mudança exige autorização própria após a prévia e os checks.

Estado: desenho escolhido pelo usuário; especificação escrita para revisão
antes do plano técnico e da implementação.
