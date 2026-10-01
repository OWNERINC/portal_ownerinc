# Portal Ownerinc Brief

## Produto

O Portal Ownerinc é uma aplicação interna para concentrar informações e
serviços usados pelos colaboradores. Ele não faz parte do Ownerinc Brain e não
é um produto público para clientes.

## Usuários

- Colaboradores que consultam informações, cursos e benefícios.
- Usuários que mantêm o próprio perfil e recebem lembretes.
- Administradores que gerenciam usuários, permissões e conteúdo interno.

## Capacidades atuais

- Autenticação pelo Firebase Auth.
- Perfis e permissões persistidos no PostgreSQL.
- Base de conhecimento interna.
- Academy dentro do Portal: formação inicial para todos, formação por cargo,
  currículo de módulos/aulas, player YouTube ou arquivo HTTPS, materiais CMS,
  conclusão manual e retomada individual. O catálogo de benefícios permanece
  preservado para uma etapa futura e fora da experiência inicial.
- Lembretes mensais enviados por email.
- Upload de foto de perfil.

## Restrições

- Aplicação destinada à VPS e executada com Docker Compose.
- PostgreSQL e credenciais de serviços não podem ser expostos publicamente.
- O frontend acessa somente a API publicada pelo Nginx.
- Dados pessoais devem respeitar LGPD, acesso mínimo e rastreabilidade.
- Firebase, Resend SMTP e futuros canais de mensagem dependem de serviços externos.

### Limite de aceite da entrega Academy

Os fluxos de domínio e frontend têm testes locais e verificações estáticas. A
aceitação final deste lote separa evidência PASS de validações PENDENTES: por
decisão do usuário, não foram iniciados Docker, PostgreSQL, Firebase, Nginx ou
serviços full-stack, não foi usado banco remoto e não se afirma autenticação
real, reprodução YouTube/MP4 real, headers efetivos ou persistência entre contas.
Consulte a [matriz de aceite](../reviews/2026-09-30-academy-acceptance.md).
