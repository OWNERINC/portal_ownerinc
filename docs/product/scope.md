# Escopo

## Incluído

- Login, recuperação de senha e sessão via Firebase Auth.
- Administração de usuários e permissões.
- Perfil do colaborador e foto.
- Base de conhecimento.
- Academia interna.
- Lembretes e notificações por email.

## Fora do escopo atual

- Ownerinc Brain e suas operações de conteúdo.
- `ownerinc-novo-agente` e integrações com Discord ou IA.
- Atendimento ao cliente e campanhas externas.
- Aplicativo móvel nativo.
- WhatsApp enquanto a integração não estiver configurada e validada.
- Catálogo de Benefícios na experiência inicial; a rota e o CRUD administrativo
  permanecem preservados para uma etapa futura, fora da navegação inicial.
- Sólides na experiência global enquanto o estágio de liberação permanecer `off`.

## Status atual

- O Gate 0 de exposição insegura está concluído no código, conforme o roadmap.
- Homologações com Firebase, SMTP, VPS, restauração real e dispositivos de
  acessibilidade continuam como validações operacionais externas.

## Próxima etapa

Antes de ampliar funcionalidades, concluir as homologações externas do Gate 0 e
validar as rotas sensíveis conforme o
[`roadmap.md`](roadmap.md), sem trazer Benefícios ou Sólides para a experiência
inicial sem decisão de produto.
