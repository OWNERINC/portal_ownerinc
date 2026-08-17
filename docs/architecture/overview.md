# Visão Geral da Arquitetura

## Princípio

Preservar a aplicação existente e suas fronteiras. O harness organiza trabalho,
documentação e validação, mas não exige mover código para uma pasta `src/`.

## Serviços

- `nginx`: serve `public/` e encaminha `/api/` e `/uploads/` para a API.
- `api`: aplicação Express responsável por autenticação, autorização e CRUD.
- `postgres`: banco PostgreSQL inicializado por `api/db/schema.sql`.
- `cron`: processo isolado que consulta lembretes e envia notificações.

## Dependências externas

- Firebase Auth autentica usuários e valida tokens na API.
- Resend SMTP entrega emails gerados pelo serviço de lembretes.
- Z-API está prevista, mas permanece desativada.

## Decisões

- Portal e Brain permanecem em repositórios diferentes.
- API e cron continuam como pacotes CommonJS independentes.
- O frontend continua estático enquanto essa solução atender ao produto.
- Serviços só devem ser separados ou reescritos quando existir pressão real.

## Evolução Aprovada

O alvo técnico mantém os mesmos serviços e adiciona admissão controlada,
política central de autorização, renderização segura, migrations SQL, ledger
idempotente de notificações, least privilege, readiness e deploy recuperável.
As fases e critérios estão em [`../product/roadmap.md`](../product/roadmap.md).
