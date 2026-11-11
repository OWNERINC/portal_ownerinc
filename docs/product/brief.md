# Portal Ownerinc Brief

## Produto

O Portal Ownerinc é uma aplicação interna para concentrar informações e
serviços usados pelos colaboradores. Ele não faz parte do Ownerinc Brain e não
é um produto público para clientes.

## Usuários

- Colaboradores que consultam informações, cursos e benefícios.
- Usuários que mantêm o próprio perfil e recebem notificações.
- Administradores que gerenciam usuários, permissões e conteúdo interno.

## Capacidades atuais

- Autenticação pelo Firebase Auth.
- Perfis e permissões persistidos no PostgreSQL.
- Base de conhecimento interna.
- Academy dentro do Portal: formação inicial para todos, formação por cargo,
  currículo de módulos/aulas, mídia própria YouTube ou arquivo HTTPS, ativação e
  desativação de conteúdo próprio, conclusão manual e retomada individual. A
  Academy não usa materiais CMS nem apresentação editorial no runtime. O catálogo
  de benefícios permanece preservado para uma etapa futura e fora da experiência
  inicial.
- Notificações mensais enviadas por email (rotas e contratos técnicos reminders).
- Upload de foto de perfil.
- Páginas internas do Conecta por modelos/blocos: comunicado, composição em uma ou
  duas colunas, texto rico, presets e mídia privada; rascunho e publicação por cargo
  separados. O piloto Owner News é uma receita sintética, não uma edição oficial.

## Restrições

- Aplicação destinada à VPS e executada com Docker Compose.
- PostgreSQL e credenciais de serviços não podem ser expostos publicamente.
- O frontend acessa somente a API publicada pelo Nginx.
- Dados pessoais devem respeitar LGPD, acesso mínimo e rastreabilidade.
- Firebase, Resend SMTP e futuros canais de mensagem dependem de serviços externos.

## Limite editorial do produto atual

O Portal mantém Knowledge, Academy, Benefits e Reminders com contratos próprios de
texto, mídia, rotas e tabelas. CMS, Payload CMS, Owner News histórico, editor editorial legado,
enquetes, importadores e a URL `/announcements.html` não fazem parte do runtime
ativo. Migrations, tabelas, uploads e documentação desses fluxos antigos são
preservados para compatibilidade, auditoria e eventual decisão futura; preservação
histórica não significa capacidade disponível. O novo módulo Pages é independente;
seu modelo sintético Owner News não acessa acervo, importadores ou tabelas históricas.

### Limite de aceite da entrega Academy

Os fluxos de domínio e frontend têm testes locais e verificações estáticas. A
aceitação final deste lote separa evidência PASS de validações PENDENTES: por
decisão do usuário, não foram iniciados Docker, PostgreSQL, Firebase, Nginx ou
serviços full-stack, não foi usado banco remoto e não se afirma autenticação
real, reprodução YouTube/MP4 real, headers efetivos ou persistência entre contas.
Consulte a [matriz de aceite](../reviews/2026-09-30-academy-acceptance.md).
