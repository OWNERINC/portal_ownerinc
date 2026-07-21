# Roadmap de Integração Sólides

Atualizado em 21 de julho de 2026.

## Princípios

- A Sólides é a fonte oficial de vínculo trabalhista, escala, ponto e saldo.
- O Portal é a fonte oficial de identidade, acesso, perfil e conteúdo Ownerinc.
- A integração nasce desligada e não aparece na navegação global.
- Cada liberação exige vínculo verificado e autorização server-side.
- O frontend nunca recebe token, CPF, PIS, PIN, biometria ou geolocalização.
- Operações de escrita permanecem bloqueadas até homologação e aprovação do RH.
- Leituras upstream têm orçamento por usuário; probes administrativos usam um
  limite separado e mais restritivo para proteger o token e o rate limit externo.

## Estágios de Liberação

O estágio é controlado por `SOLIDES_RELEASE_STAGE`.

| Estágio | Visibilidade | Público | Funcionalidades permitidas |
| --- | --- | --- | --- |
| `off` | Totalmente oculta | Ninguém | Nenhuma rota de produto é descobrível |
| `internal` | API administrativa sem tab pública | Super-admin ou `manageSolides` | Configuração, vínculos e testes internos |
| `pilot` | Card e página aparecem somente após descoberta autorizada | UIDs em `SOLIDES_PILOT_UIDS`, CLT e vínculo verificado | Leitura individual |
| `general` | Card e página para usuários elegíveis | Todos os CLTs com vínculo verificado | Leitura individual |
| `manager` | Reservado | Gestores sincronizados | Futuro: equipe e pendências agregadas |
| `write` | Reservado | RH/gestores autorizados | Futuro: solicitações e operações aprovadas |

`manager` e `write` não liberam hoje rotas adicionais; seus nomes reservam a
ordem de rollout sem habilitar funcionalidades incompletas.

## Estado da Implementação

| Gate | Entrega | Estado | Condição de liberação |
| --- | --- | --- | --- |
| 0 | Contrato técnico e homologação | Pendente externo | Confirmar sandbox, hosts, token, paginação, datas, rate limit e Report |
| 1 | Cliente HTTP seguro e feature gate | Implementado | Verificação local e configuração válida |
| 2 | Vínculo UID ↔ `employeeId` | Implementado com tab administrativa oculta por gate | Operação interna auditada |
| 3 | Resumo, histórico, escala e saldo read-only | Implementado atrás do gate | Homologar respostas reais com o token Ownerinc |
| 4 | Página Minha Jornada e descoberta no dashboard | Implementado atrás do gate | Piloto com UIDs explícitos e vínculos verificados |
| 5 | Folha de ponto em PDF | Pendente | Descobrir contrato atual do serviço Report |
| 6 | Sincronização incremental/cache | Pendente condicional | Implementar apenas se latência, rate limit ou disponibilidade exigirem |
| 7 | Piloto acompanhado | Pendente | Gate 0 aprovado e amostra conciliada com a Sólides |
| 8 | Visão de gestores | Pendente | Hierarquia Sólides homologada e nova política de equipe |
| 9 | Operações de escrita | Bloqueado | Idempotência, aprovação, auditoria e reconciliação definidas |

## Funcionalidades Read-Only Preparadas

- Resumo de entrada, saída e status do dia.
- Histórico de até 31 dias, paginado e sem campos sensíveis.
- Banco de horas retornado pela Sólides, sem cálculo local.
- Cargo, setor, admissão e escala atual.
- Jornada semanal normalizada para exibição.
- A consulta de escala revalida o vínculo e registra o último contato válido;
  divergência de ID, External ID ou desligamento falha fechada.
- Férias, afastamentos e ajustes do ano, sem justificativas ou texto livre.
- Estado de integração ausente, sem vínculo ou temporariamente indisponível.
- Resumo, saldo e escala degradam separadamente quando um endpoint falha.
- Link de contingência para a aplicação oficial.

## Administração Interna Preparada

- Consultar contagem de vínculos e conflitos.
- Carregar todos os CLTs elegíveis para vínculo por paginação server-side.
- Listar vínculos com paginação e filtro por estado.
- Criar ou atualizar vínculo manual/external ID.
- Novos vínculos começam pendentes e exigem uma segunda ação explícita para
  verificar o mesmo `employeeId`; a API consulta o colaborador na Sólides e,
  quando informado, também confere o `externalId`. Trocar o ID reinicia essa
  verificação. Colaboradores marcados como desligados não podem ser verificados.
- Remover vínculo.
- Auditar leitura, criação, alteração e remoção.
- Impedir que dois usuários compartilhem o mesmo colaborador no mesmo escopo.
- Executar probe read-only de conectividade e, com vínculo selecionado,
  colaborador, resumo, histórico, saldo e ajustes sem mostrar o conteúdo retornado.

A tab administrativa só é criada após uma consulta autenticada confirmar
`internal` ou estágio posterior e a permissão `manageSolides`. Em `off`, seu
conteúdo permanece no HTML estático, mas não é descoberto nem recebe dados; as
rotas correspondentes respondem 404.

## Gate 0 — Checklist Externo

1. Confirmar ambiente de homologação ou colaborador seguro na produção.
2. Validar `Authorization: Basic <token>` sem registrar o segredo.
3. Confirmar bases Employer, Punch e Report.
4. Confirmar os endpoints autorizados pelo token Ownerinc.
5. Homologar paginação e índice inicial.
6. Homologar formatos de data, timezone e limites inclusivos.
7. Confirmar unidade e semântica de `lastUpdate`.
8. Confirmar rate limits, `Retry-After` e SLA.
9. Conciliar resumo, histórico, escala e saldo com a interface oficial.
10. Descobrir o contrato atual de `/time-sheet`.

O probe read-only pode ser executado com as variáveis carregadas no ambiente:

```sh
npm run solides:probe
```

Sem `SOLIDES_TEST_EMPLOYEE_ID`, ele valida apenas conectividade/autenticação. Com
um ID seguro de homologação, também consulta colaborador, resumo, histórico,
saldo e ajustes.
O comando imprime somente status, duração e forma da resposta; token e conteúdo
pessoal não são exibidos.

Até o Gate 0 confirmar o contrato de ajustes, o Portal exige um `employeeId`
explícito em cada ocorrência e descarta registros sem identificação ou de outro
colaborador. Justificativas e demais textos livres nunca são enviados ao browser.

## Critérios do Piloto

- Nenhum usuário acessa dados de outro `employeeId`; resumo, histórico, saldo,
  escala e ajustes possuem cobertura de isolamento na fronteira HTTP da API.
- Totais de paginação upstream são omitidos se qualquer registro estrangeiro
  precisar ser descartado.
- Dados exibidos coincidem com a Sólides na amostra validada.
- Nenhum cálculo trabalhista é realizado pelo Portal.
- Token e respostas brutas não aparecem no navegador ou logs.
- Indisponibilidade externa não bloqueia o restante do dashboard.
- Página funciona em mobile, teclado e tecnologia assistiva.
- O link externo permanece disponível como contingência.

## Rollback

Definir `SOLIDES_RELEASE_STAGE=off` e reiniciar a API remove a descoberta e o
acesso à página sem apagar vínculos. O link oficial da Sólides continua no
dashboard. Em incidente de credencial, revogar o token e manter o estágio
`off` até concluir a investigação.
