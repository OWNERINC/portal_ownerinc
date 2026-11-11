# Pages receiver recovery

## Objetivo e autorização

O usuário autorizou a etapa operacional no formulário: verificar e, se necessário,
corrigir/testar/instalar o receptor do Portal com cópia de segurança. Não executar
restore, DROP, migrations ou restart no ambiente real para testar a instalação.
O deploy posterior continua pelo pipeline oficial, somente após os gates.

## Evidências de partida

- Feature `7c2c97b`, CI `43016622141`: 938 testes Linux PASS, sem skips, PG16,
  migrations, Academy, build, scans, audit e SBOM aprovados.
- Receiver instalado `/usr/local/libexec/ownerinc-portal-deploy`: root:root 0755,
  SHA-256 `c976d36abb8ed70561eaf38dedf0b5b9bd72735d41a05b81bc196e4272bf500e`,
  idêntico ao versionado. O novo cleanup ainda não existe nesse receptor.
- Chave de deploy usa `/usr/local/sbin/portal-ownerinc-deploy-from-ci`, cujo
  conteúdo corresponde ao wrapper de produção versionado. Preservar esse alias,
  authorized_keys, identidades e configuração SSH.
- Release real `2cecbe847db7e7b88bbb33c7463aa0260d265cfc`; consulta somente leitura:
  Pages ausente, ledger até039. API/cron/Postgres saudáveis, Nginx rodando.
- Duas análises independentes e rodada cruzada delimitam correção somente no
  receptor, ensaio, testes e documentação. Não alterar o restore manual por tabela.

## Arquivos e ownership

Um implementador único: `ops/deploy-from-ci.sh`,
`scripts/test-pages-recovery.mjs`, `tests/unit/pages-recovery.test.mjs`, novo
`tests/unit/pages-receiver-recovery.test.mjs` e, se necessário, ajuste mínimo de
`tests/unit/operations-invariants.test.mjs` para o controle de fluxo corrigido.
Primária: documentação, verificação, revisão, commits/CI e instalação/deploy.

Preservar migrations 040/041, regras Pages, API/frontend/cron, main local divergente,
outras worktrees, screenshots e todos os serviços/configurações do Brain.

## Contrato do receptor

### Síntese da análise

- **Decisão:** correção restrita com inventário do dump validado como prova
  obrigatória; não adicionar metadata de catálogo ao fluxo produtivo.
- **Fatos:** falha do legado reproduzida em PG16, receptor real idêntico ao repo,
  Pages ausente em produção. O wrapper existente é válido e será preservado.
- **Hipóteses pendentes:** implementação candidata, seus guards e instalação ainda
  não estão aceitos. Não se provocará rollback no ambiente real como demonstração.
- **Divergência resolvida:** ambos revisores aceitam TOC-only bem validado;
  observação ao vivo do catálogo é corroborativa, não substituto do dump.
- **Riscos residuais:** cleanup e restore são transações separadas; falha de
  restore mantém serviços parados. Clientes externos podem existir, exigindo
  bloqueios. Estado inesperado deve falhar fechado, não ser reparado genericamente.
- **Verificação:** funções Bash reais em harness isolado + SQL embutida exata em
  PG16; verify, revisão fresca, CI; instalação pelo mesmo lock com backup e hashes.
- **Condição de implementação:** autorização específica recebida; ownership
  delimitado acima. Nenhuma alteração de dados/serviços durante a instalação.

- Permanecer um arquivo autossuficiente; sem switch produtivo de teste/expurgo.
- Classificação inicial desconhecida; somente inventário de dump obtido com
  `pg_restore --list` bem-sucedido e manifesto válido pode provar ausência.
- Reconhecer entradas TABLE qualificadas em public, nunca TABLE DATA/ACL/comentário.
  As seis relações Pages devem estar todas ausentes ou todas presentes; estado
  parcial/erro/inventário não reconhecido falha fechado. Validar tabelas âncora do
  Portal no inventário para não classificar texto vazio/malformado como ausência.
- Antes de migrations, classificar backup válido; no rollback pré-tráfego,
  revalidar checksums e classificação. Backup com Pages nunca autoriza cleanup.
- Cleanup apenas dentro do gate existente: migration iniciada, backup completo,
  tráfego público ainda fechado e serviços parados. Falhas impedem restore/restart.
- SQL literal, com marcador único, reutilizado byte a byte no ensaio PG16.
- Transação, schema/allowlist fixos, tipos de relação ordinários, ACCESS EXCLUSIVE
  antes de conferir dados, row_security=off e timeout. Nenhuma tabela => no-op;
  conjunto parcial/tipo inesperado/qualquer linha/permissão/RLS/dependência externa
  => abortar sem alteração parcial. Remover somente as seis tabelas vazias e suas
  duas constraints circulares, sem CASCADE. Preparo histórico só após esse sucesso.
- Rollback desativa errexit: tratar explicitamente cada retorno, não confiar em
  set -e dentro de funções chamadas em condicionais.

## Steps

- [x] Implementar contrato restrito e testes RED/GREEN, sem operação real.
- [ ] Ensaiar SQL produtivo exato: nenhuma Pages, 040 apenas, 040/041 vazias,
      estado parcial, conteúdo, dependência externa, permissões/RLS e backup com Pages.
- [x] Testar funções reais de rollback em Bash isolado com doubles de comandos,
      sem executar o receiver completo com paths produtivos.
- [ ] Verify, revisão fresca e CI completo na feature com PostgreSQL16.
- [ ] Instalar apenas o receptor comum: lock existente, conferir hash anterior,
      backup verificável, candidato root:root0755, bash -n, troca atômica e hash final.
- [ ] Confirmar gates, promover remotamente e acompanhar CI/deploy normal e aceite.

## Casos funcionais mínimos

Ordem stop → checksum/inventário → SQL (somente dump pré-Pages) → restore →
retomada anterior. Sem cleanup/restore após tráfego, sem migrations ou backup;
backup com Pages sem cleanup; recusar TOC falho/parcial/malformado, checksum ruim,
SQL recusado, restore falho e parada falha. Falha de recuperação não reinicia
serviços. Capturar argumentos/stdin reais; a SQL capturada deve ser a do ensaio.

## Limites de aceite

CI nativo + mocks não simulam autenticação oficial nem provocam falha produtiva.
A instalação não executa o receiver. `scripts/restore.sh` permanece inadequado
como fallback genérico pré-Pages e exige procedimento específico aprovado.

## Evidência local da integração candidata

- Primária inspecionou o diff e repetiu `verify`: 957 testes,955 PASS,zero falhas,
  dois skips Linux; testes funcionais sem skips no Windows/Git Bash.
- Sintaxe Bash/Node e diff aprovados. Migration040 preservada byte a byte.
- SQL e classificador produtivos agora extraídos no ensaio nativo; seus novos
  casos ainda aguardam execução no CI da feature.
- Hash local do receptor candidato:
  `614311d154042c61d362a6b26cfe2ff4cd984de1d12ad116df5850389bd7d658`.
- Nenhuma instalação ou operação destrutiva foi executada na VPS nesta etapa.
- Revisão fresca Astra high: `ship` para fonte/CI da feature; aceite nativo e
  instalação continuam condicionados ao resultado do próximo CI e aos hashes.
