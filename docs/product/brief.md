# Portal Ownerinc Brief

## Produto

O Portal Ownerinc é uma aplicação interna para concentrar informações e
serviços usados pelos colaboradores. Ele não faz parte do Ownerinc Brain e não
é um produto público para clientes.

## Usuários

- Colaboradores que consultam informações, cursos e benefícios.
- Usuários que mantêm o próprio perfil e recebem lembretes.
- Administradores que gerenciam usuários, permissões e conteúdo interno.
- Responsáveis autorizados que consultam mensagens da ouvidoria.

## Capacidades atuais

- Autenticação pelo Firebase Auth.
- Perfis e permissões persistidos no PostgreSQL.
- Base de conhecimento interna.
- Catálogo da academia e de benefícios.
- Lembretes mensais enviados por email.
- Ouvidoria com acesso restrito às mensagens recebidas.
- Upload de foto de perfil.

## Restrições

- Aplicação destinada à VPS e executada com Docker Compose.
- PostgreSQL e credenciais de serviços não podem ser expostos publicamente.
- O frontend acessa somente a API publicada pelo Nginx.
- Dados pessoais devem respeitar LGPD, acesso mínimo e rastreabilidade.
- Firebase, SendGrid e futuros canais de mensagem dependem de serviços externos.
