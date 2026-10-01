# Escopo

## Incluído

- Login, recuperação de senha e sessão via Firebase Auth.
- Administração de usuários e permissões.
- Perfil do colaborador e foto.
- Base de conhecimento.
- Academia interna com catálogo elegível, formação inicial e por cargo, currículo,
  player de mídia, materiais editoriais, conclusão manual e retomada individual.
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
- Para a Academy, a matriz final também mantém pendentes a execução contra
  PostgreSQL/Firebase real, o navegador autenticado servido pelo Nginx e a
  reprodução/erro real de YouTube e MP4. Nenhuma dessas pendências deve ser
  descrita como aprovada por checks locais ou fixtures.

## Próxima etapa

Antes de ampliar funcionalidades, concluir as homologações externas do Gate 0 e
validar as rotas sensíveis conforme o
[`roadmap.md`](roadmap.md), sem trazer Benefícios ou Sólides para a experiência
inicial sem decisão de produto.

Para a Academy, usar a [matriz de aceite](../reviews/2026-09-30-academy-acceptance.md)
e o [manual editorial](../operations/academy-content.md) como checklist de
homologação e operação.
