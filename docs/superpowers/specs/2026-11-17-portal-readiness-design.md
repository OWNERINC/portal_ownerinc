# Correções de prontidão do Portal

## Objetivo e autorização

Em 17/11/2026, após auditoria e reverificação, o usuário pediu “faça a
recomendção entao”. O objetivo aceito é corrigir os dois P1 de disponibilidade,
os defeitos de retenção e de recuperação de uploads e a divergência documental
de apagamento. A capacidade de 100 usuários ativos será um aceite posterior,
dependente de ambiente, carga e medições.

Base: `main` em `dfe991db1a8aa89921262345ce72acee1279dd0e`, árvore
`ac2afbb7fe96807a29f80136ba5692c4558aa9d6`. Branch de trabalho:
`fix/portal-readiness`, no worktree existente `Consent-wall`. O checkout
anterior era detached em `c06cb850435af1f1ff117c3d1d82004b1f7fca02`, com a mesma
árvore. Os dois diretórios de worktree e suas capturas são preservados.

## Alternativas consideradas

1. **Correção localizada dos mecanismos — recomendada.** Orçamento autenticado
   por UID, liberação correta de conexões, identidade temporal exata e
   compensação conservadora de arquivos. Menor superfície de alteração e
   regressões ligadas aos defeitos reproduzidos.
2. **Aumentar limites e tamanho do pool.** Não resolve a aquisição circular nem
   integridade; apenas muda o ponto em que os problemas aparecem.
3. **Introduzir Redis, filas e reestruturar persistência/mídia.** Pode ser útil
   após medição, mas amplia operação, dependências e migração sem necessidade
   demonstrada neste pacote.

## Desenho recomendado

### 1. Proteção de tráfego compatível com rede compartilhada

- Substituir o orçamento global atual de 300 chamadas/IP/15 minutos por uma
  proteção agregada de **30.000 chamadas/IP/15 minutos**.
- Aplicar **300 chamadas/UID/15 minutos** após a validação Firebase com
  revogação. O identificador vem exclusivamente do token validado; presença de
  header, token decodificado sem verificação, UID informado pelo cliente e
  `X-Forwarded-For` arbitrário não concedem orçamento individual.
- Manter os limites específicos: escritas 60/UID/15 minutos, progresso Academy
  120/UID/15 minutos, foto 10/UID/15 minutos, cadastro e recuperação 5/IP/hora.
- Preservar todos os gates de conta, cargo, autorização e Ética. Aceitar a
  identidade para contabilizar tráfego não concede acesso ao produto.
- Respostas de limitação devem incluir `Retry-After` coerente com a janela e
  conservar o contrato JSON de erro/request ID.
- No Nginx, manter o ritmo agregado de API em **20 req/s/IP**, ampliando o
  burst para **500** nas rotas de API geral, Pages e bulk. Manter `nodelay`.
  Isso acomoda o envelope inicial de cem pessoas com até cinco chamadas
  próximas, sem tornar ilimitado o tráfego sustentado.
- A zona de uploads passa a **60/minuto/IP**, burst **20**, compartilhada entre
  os módulos; mídia mantém **60 req/s/IP**, burst **500**. Limites de bytes,
  normalização, capacidades e admissão exclusiva do processador Pages continuam.
- Esses números são orçamentos técnicos iniciais, não resultados de benchmark.
  Cem uploads simultâneos não fazem parte do critério de liberação deste
  pacote. O ensaio posterior medirá sustentação e ajustará orçamento e SLO.
- Os buckets continuam em memória por processo, coerentes com a implantação
  atual. Distribuição entre réplicas não integra esta correção.

### 2. Ciclo de vida das conexões de convites

- O handler de convite administrativo deve liberar sua conexão após COMMIT
  confirmado e antes de chamar helper que adquire outra conexão.
- Em erro anterior ao COMMIT, tentar rollback e liberar/descartar a conexão
  antes de iniciar compensação que utiliza o pool.
- COMMIT ou rollback de resultado incerto exige descarte da conexão.
- Cada client tem um único proprietário e uma única liberação.
- Revisar os caminhos usados por `enableActiveUser` para evitar que uma
  conexão própria continue retida enquanto o mesmo helper aguarda outra para
  persistir o marcador de reconciliação.
- Conexões recebidas de chamadores continuam pertencendo ao chamador; sinais
  de descarte precisam ser propagados. Os callers afetados devem ser lidos
  antes de qualquer ajuste.
- Preservar criação desabilitada, habilitação pós-COMMIT, marcador pendente,
  locks de identidade e compensação de Firebase. Não aumentar o pool como
  substituto dessa correção.

### 3. Retenção com identidade temporal exata

- As releituras sob lock retornam `created_at::text AS created_at_key`.
- O DELETE compara o timestamp com essa chave da linha efetivamente bloqueada,
  mantendo UID, ID, estado e condição de cleanup.
- Não converter a chave em JavaScript Date nem usar fallback truncado.
- Uma exclusão inesperada de zero linhas não é contabilizada como sucesso:
  deve seguir o caminho de falha/rollback e ser observável no resultado.
- Preservar revalidação de elegibilidade, estados aprovados, contas referenciadas,
  cadastro recente e comportamento conservador de cleanup externo.
- Não requer mudança de schema ou prazo de retenção.

### 4. Uploads e resultado incerto da transação

- Em foto, AutoCard e Cards Pós, distinguir falha antes de COMMIT, COMMIT
  confirmado e COMMIT de resultado incerto.
- O helper `withAudit` propaga informação de resultado incerto e descarta o
  client correspondente. Falha de rollback também impede compensação destrutiva
  baseada em certeza que não existe.
- Se houver certeza de rollback anterior ao COMMIT, remover o arquivo novo.
- Depois de COMMIT confirmado ou de resultado incerto, preservar os bytes.
  Também preservar se o erro ocorrer apenas ao construir/enviar a resposta
  depois da persistência.
- Na foto, manter o arquivo anterior até confirmação do novo COMMIT.
- Não transformar COMMIT incerto em resposta de sucesso nem repetir mutação
  automaticamente.
- A escolha conservadora pode deixar arquivo órfão. Documentar esse resultado:
  a retenção existente de cards pode tratá-lo quando aplicável; não prometer
  expurgo automático de fotos sem um processo implementado.
- Preservar os contratos HTTP e o comportamento dos demais callers de
  `withAudit`, com testes de rollback, liberação e auditoria.

### 5. Documentação fiel do apagamento

- Corrigir a promessa genérica de que todo histórico perde UID estável.
- Descrever precisamente as referências removidas/anuladas, recibos Pages que
  mantêm UID para idempotência e linhas de importação que podem manter UID,
  nome, email e demais campos até sua retenção de 30 dias.
- Explicitar que não há expurgo de recibos Pages implementado neste pacote e
  que prazo/base legal definitivos dependem do responsável pela política.
- Não alterar dados, recibos, chaves de retry ou prazos para fazer a
  implementação parecer compatível com uma promessa documental imprecisa.

## Fronteiras e propriedade

Arquivos de implementação previstos:

- `api/index.js`, `api/middleware/security.js`, `api/middleware/auth.js`;
- `api/routes/users.js`, `api/services/user-invitation.js`;
- `api/services/pending-registration.js`;
- `api/routes/upload.js`, `api/routes/autocard.js`, `api/routes/pos-cards.js`,
  `api/route-utils.js`;
- `nginx/nginx.conf`;
- testes correspondentes em `tests/unit/`, helpers limitados em `tests/helpers/`
  e regressão SQL descartável em `tests/database/`.

Se a inspeção mostrar que um caller adicional precisa mudar para manter o
contrato de propriedade de conexão, registrar o motivo e limitar o ajuste ao
mesmo fluxo. Não introduzir refatoração geral.

Documentação: esta especificação, plano de implementação, registro de aceite,
`docs/product/privacy-retention.md` e documentação técnica de tráfego/recuperação
necessária ao contrato.

Protegidos: documento oficial de Ética, arte/PDF dos Cards Pós, capturas,
worktree Pages, frontend, migrations históricas, dados reais, credenciais,
scripts de deploy, permissões de backups, A18, Brain e `ownerinc-novo-agente/`.
Manter LF nos arquivos Linux e compatibilidade da sintaxe com Node 18.

## Critérios de aceite do código

1. Cem UIDs validados compartilham um IP sem disputar o orçamento individual;
   um UID abusivo continua limitado. Tokens inválidos não produzem UID confiável.
2. Limites agregados e específicos continuam exercitados, inclusive expiração
   de janela, `Retry-After` e gates de Ética/revogação.
3. Convites concorrentes iguais à capacidade do pool concluem com `pg-pool`
   instalado e transporte falso, sem intervenção que aumente o pool; leitura
   adicional progride. Falhas liberam/descartam exatamente uma vez.
4. Retenção com microssegundos exclui os elegíveis e alcança o 101º registro
   em rodadas seguintes; recentes e referenciados permanecem.
5. Nenhum cenário de COMMIT confirmado/ACK perdido apaga bytes potencialmente
   referenciados nos três módulos. Rollback confirmado permite limpeza.
6. Testes SQL descartáveis e testes de aplicação registram seus limites;
   PGlite/doubles não são apresentados como PostgreSQL nativo ou integração real.
7. `npm run verify`, `npm run check:pages-build`, `git diff --check` e testes
   direcionados aprovados; configuração Nginx verificada na ferramenta disponível.
8. Revisão independente fresca da diff resulta em `ship`; a sessão principal
   inspeciona a diff e confirma os resultados antes de aceitar.

## Gates posteriores à implementação

O formulário já aberto de perfil de uso/rede/ambiente/VPS continua pendente.
Carga 20→50→100, SLOs, PostgreSQL 16 nativo, jornadas Firebase/SMTP reais,
dispositivos físicos e restore são evidências separadas. O pacote de código
não concede automaticamente aceite de capacidade, merge ou deploy.
