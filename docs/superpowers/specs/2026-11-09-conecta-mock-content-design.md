# Conteúdo demonstrativo do Conecta

## Objetivo e alcance aprovados

Preencher a prévia local do Portal com conteúdo fictício coerente entre páginas,
sem alterar dados reais, autenticação de produção ou serviços externos. A opção
aprovada é ampliar `tests/visual/serve-conecta.mjs` e suas fixtures, não adicionar
um modo público de demonstração nem cadastrar registros no banco.

## Conteúdo

- Dashboard: próximos lembretes e retomada de aprendizagem derivados das mesmas
  fixtures usadas nas páginas de destino.
- Lembretes: seis exemplos com descrições úteis, dias de disparo variados,
  destinatários e canais demonstrativos. Datas futuras são calculadas a partir
  da data da prévia, evitando uma agenda permanentemente vencida.
- Academy: exatamente duas trilhas internas, “Primeiros passos na Ownerinc”
  (formação inicial) e “Atendimento e relacionamento com o cliente” (formação por
  cargo). Cada trilha contém dois módulos com três aulas cada, descrições
  próprias e progresso coerente. Uma trilha fica iniciada; a outra, não iniciada.
  Catálogo, detalhe, aula e retomada compartilham IDs e contagens.
- Base de Conhecimento: oito artigos completos em português, distribuídos entre
  integração, pessoas, tecnologia e atendimento. Exemplos incluem primeiros
  passos, solicitação de apoio, segurança de acesso e boas práticas de atendimento.
  Os textos são demonstrativos, não políticas oficiais da empresa.
- Perfil e administração: usuários, cargos e listas administrativas fictícias
  suficientes para exercitar as seções existentes, sem dados pessoais reais.
- Benefícios: exemplos de benefícios e instruções demonstrativas na rota já
  existente, sem adicioná-la à navegação inicial.
- AutoCard e Cards Pós: exemplos de históricos compatíveis com os contratos
  atuais; galerias e renderizadores das artes não são modificados.
- Sólides: dados demonstrativos somente nas superfícies que já suportam
  apresentação local. Funcionalidades não disponíveis continuam explicitamente
  indisponíveis; não simular integração real bem-sucedida.
- Login e entrada mantêm sua apresentação e limitações de autenticação simulada.

“Postagens” serão representadas pelos artigos da Base de Conhecimento. Não será
criado feed, rota de notícias, CMS ou outro domínio editorial removido.

## Arquitetura e fluxo de dados

As fixtures permanecem fora de `public/`, `api/` e `cron/`. Conteúdo e projeções
compartilhadas ficam em módulos de `tests/visual/`, divididos por responsabilidade
se o volume exigir. O servidor continua escutando exclusivamente em loopback,
sem proxy para produção e recusando métodos de escrita.

Listas respeitam os filtros e a paginação já consumidos pelo frontend. O total
representa a lista filtrada antes de limit/offset. Detalhes desconhecidos retornam
404, em vez de reutilizar um registro de outro curso ou usuário. Categorias,
currículos, vizinhos e progresso são derivados dos registros correspondentes.

Antes de preencher históricos e listas secundárias, conferir seus contratos nos
consumidores atuais. Não inventar suporte de frontend para aumentar o escopo.

## Interações e limites

Navegação, busca, filtros, paginação, abertura de detalhes e modais usam o frontend
existente. Criação, edição, exclusão, conclusão de aulas, exportações autenticadas
e envio de lembretes não ganham persistência simulada nesta entrega.

A prévia mantém um aviso visível de dados fictícios e escritas indisponíveis.
As aulas têm conteúdo textual próprio e estado explícito de mídia demonstrativa;
não serão usados vídeos aleatórios, URLs fictícias reproduzíveis ou integração
externa para alegar reprodução real.

## Verificação e documentação

- Testes automatizados das fixtures cobrem exatamente duas trilhas, consistência
  entre catálogo/currículo/aulas/retomada, filtros, paginação, datas e IDs ausentes.
- Testes do servidor confirmam loopback, rejeição de escritas e respostas de
  listas/detalhes compatíveis com o consumo existente.
- Inspeção local desktop/mobile das páginas preenchidas, incluindo filtros,
  detalhes de artigo, lembrete e navegação das duas trilhas.
- Atualizar `tests/visual/README.md` com o inventário e limites dos exemplos.
- Executar `npm run verify` e `git diff --check` antes da entrega.

Não iniciar Docker, não acessar banco remoto, não alterar deploy e não publicar
em produção. Evidências da prévia não comprovam autenticação, envio de email,
reprodução de vídeo ou persistência reais.
