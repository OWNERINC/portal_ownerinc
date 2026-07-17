# Portal Ownerinc

Portal interno da Ownerinc para perfis, base de conhecimento, academia,
benefícios, lembretes e ouvidoria.

## Arquitetura

- `public/`: aplicação web estática e integração com Firebase Auth.
- `api/`: API Express, autorização e persistência PostgreSQL.
- `cron/`: processamento diário de lembretes e notificações.
- `nginx/`: publicação do frontend e proxy de `/api` e `/uploads`.
- `docs/`: decisões de produto, arquitetura e operação.
- `scripts/`: verificações locais reproduzíveis.
- `tests/`: checks automatizados sem serviços externos.

O Portal e o Ownerinc Brain são produtos e repositórios separados.
`ownerinc-novo-agente/` também não faz parte deste projeto.

## Desenvolvimento local

1. Copie os valores necessários de `.env.example` para `.env`.
2. Execute `docker compose up --build`.
3. Acesse `http://localhost`.
4. Encerre com `docker compose down`.

Consulte [`docs/operations/local-development.md`](docs/operations/local-development.md)
para executar serviços individualmente.

## Verificação

Execute:

```sh
npm run verify
```

O comando valida sintaxe JavaScript, testes, scripts shell, configuração do
Compose quando Docker estiver disponível e possíveis segredos versionados.

## Documentação

- [Brief do produto](docs/product/brief.md)
- [Escopo](docs/product/scope.md)
- [Arquitetura](docs/architecture/overview.md)
- [Fluxo de dados](docs/architecture/data-flow.md)
- [Deploy](docs/operations/deployment.md)
- [Handoff](docs/session/README.md)
