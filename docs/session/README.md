# Handoff da Sessão

Atualize este arquivo antes de encerrar uma sessão relevante.

## Objetivo Atual

Continuar o Portal Ownerinc com harness próprio, sem misturá-lo ao Ownerinc
Brain e sem reestruturar o código funcional existente.

## Estado

- Frontend estático, API, PostgreSQL, cron e Nginx já existem.
- O Portal agora possui documentação e verificações reproduzíveis.
- `ownerinc-novo-agente` permanece fora do escopo.

## Próximos Passos

1. Executar revisão de segurança antes do primeiro deploy.
2. Adicionar testes de autorização para as rotas críticas.
3. Definir a próxima funcionalidade do Portal.

## Decisões Pendentes

- Origem permitida pelo CORS em cada ambiente.
- Política de criação e promoção do primeiro administrador.
- Retenção de mensagens da ouvidoria e logs de notificações.
