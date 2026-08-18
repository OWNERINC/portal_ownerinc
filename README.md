# Portal Ownerinc

Portal interno da Ownerinc para perfis, base de conhecimento, academia,
benefícios e lembretes.

## Arquitetura

- `public/`: aplicação web estática e integração com Firebase Auth.
- `public/autocard.html`: página canônica do AutoCard dentro do shell do Portal;
  `/autocard/` permanece como redirect compatível para bookmarks antigos.
- `api/`: API Express, autorização e persistência PostgreSQL.
- `cron/`: processamento diário de lembretes e notificações.
- `firebase-emulator/`: imagem do Auth Emulator usada apenas no perfil local.
- `nginx/`: publicação do frontend e proxy de `/api` e `/uploads`.
- `docs/`: decisões de produto, arquitetura e operação.
- `scripts/`: verificações locais reproduzíveis.
- `tests/`: checks automatizados sem serviços externos.

O Portal e o Ownerinc Brain são produtos e repositórios separados.
`ownerinc-novo-agente/` também não faz parte deste projeto.

## Desenvolvimento local

1. Copie os valores necessários de `.env.example` para `.env`.
2. Execute `docker compose --profile local up -d --build`.
3. Crie o primeiro administrador conforme o guia de desenvolvimento local.
4. Acesse `http://localhost:8080`.
5. Encerre com `docker compose --profile local down`.

Consulte [`docs/operations/local-development.md`](docs/operations/local-development.md)
para executar serviços individualmente.

## Verificação

Execute:

```sh
npm run verify
```

O comando valida sintaxe JavaScript, testes, scripts shell, configuração do
Compose quando Docker estiver disponível e possíveis segredos versionados.

## Contratos de UI e prevenção de quebras

Os scripts das páginas podem atender seções com estruturas diferentes. Um
helper compartilhado não deve assumir que todo container opcional existe no
HTML.

- Antes de chamar `clear`, `replaceChildren`, `focus`, `hidden` ou alterar
  atributos de um elemento encontrado por ID, valide se o elemento existe.
- Se uma tabela não possui paginação, o loader deve limpar o container de
  paginação somente quando ele estiver presente; não crie IDs derivados sem
  adicionar o elemento correspondente à página.
- Estados de carregamento, vazio e erro devem funcionar mesmo quando uma
  seção opcional foi omitida. A ausência de uma seção não pode interromper a
  montagem das demais abas ou cards.
- Toda correção desse tipo deve incluir uma invariante ou teste de regressão
  que cubra a página sem o elemento opcional.
- Antes de commit, execute `npm run verify` e confirme também `git diff --check`.

## Documentação

- [Brief do produto](docs/product/brief.md)
- [Escopo](docs/product/scope.md)
- [Inventário da implementação funcional](docs/product/feature-inventory.md)
- [Deck executivo da implementação](docs/decks/portal-ownerinc-implementacao.html)
- [Roadmap](docs/product/roadmap.md)
- [Roadmap da integração Sólides](docs/product/solides-roadmap.md)
- [Privacidade e retenção](docs/product/privacy-retention.md)
- [Arquitetura](docs/architecture/overview.md)
- [Auditoria da plataforma](docs/reviews/2026-07-20-platform-audit.md)
- [Auditoria de UI/UX](docs/design/2026-07-20-ui-ux-audit.md)
- [Relatório de implementação](docs/reports/2026-07-20-roadmap-implementation.md)
- [Fluxo de dados](docs/architecture/data-flow.md)
- [Deploy](docs/operations/deployment.md)
- [Checklist de release V1](docs/operations/v1-release-checklist.md)
- [Status final da V1](docs/operations/2026-08-12-v1-final-status.md)
- [Handoff](docs/session/README.md)
