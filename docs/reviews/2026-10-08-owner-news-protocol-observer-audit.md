# Auditoria observacional do protocolo Owner News — Gate 4

## Resultado e limite

**PASS delimitado:** a trilha de auditoria instalada com `cms_observer` foi
executada em fixture isolado PostgreSQL 16.10, com o estado observado coerente e
os probes de negação aprovados. Esta evidência fecha somente a fatia read-only
da auditoria do protocolo Owner News.

O estado observado foi `coverage_version=0`, sequência `0`, barrier `open` e
`ready=false`. Ativação de admissão, certificação de release, certificação de
cobertura e verificação de drain permaneceram falsas. Este resultado **não** é
prontidão, cutover, certificação, prova de CRUD nativo, aceite da integração
Task15 ou autorização para produção. A revisão independente das evidências
retornou **ship** em 08/10/2026. Após conferir o relatório e seu checksum, a
sessão principal aceitou somente a fatia read-only descrita neste registro.

## Execução e evidência

- Run: `1e852687-435d-4d09-b56d-7a6b2f375569`.
- Projeto/fixture: `ownerinc-payload-observer-audit-1e852687435d`, database
  `ownerinc_cms`, imagem `postgres:16.10-bookworm` (major version 16).
- Evidência primária sanitizada: [`report.json`](evidence/2026-10-08-observer-audit/report.json).
- SHA-256 verificado para o arquivo acima:
  `c4cc51bc3dbc396b39a7bedb1cade5c74cebd10c599fb001f52d49843622e1dd`.
- O relatório registra o identificador físico do cluster verificado pelo
  harness, seis migrations nativas, instalação one-shot do protocolo com
  `coverage_version=0` e `ready=false`, e criação da role de observação pelo
  builder revisado. O observer leu `pg_shdepend` em transação read-only e não
  possuía objetos (`observerOwnedObjects=0`).

## O que passou

1. O CLI `audit:news-protocol` terminou com `status=PASS`, observando coverage
   `0`, sequência `0` e barrier `open`. O relatório manteve falsas as flags de
   prontidão, admissão, release, cobertura e drain.
2. Os snapshots de migrations, catálogo público selecionado (51 entradas de
   metadados) e head foram iguais antes/depois da auditoria. Após os probes de
   negação, esses mesmos snapshots permaneceram iguais.
3. O observer recebeu negação SQLSTATE `42501`, seguida de rollback, ao tentar
   `SELECT ... LIMIT 0` em `news_articles`, `news_media`, `news_schedules`,
   `payload_jobs` e `owner_news_mutation_events`.
4. `EXECUTE` em `owner_news_seal_run` foi negado; a função não foi invocada.

O baseline de catálogo capturado antes do provisionamento da role tem o mesmo
total de entradas, mas hash diferente do snapshot feito depois do provisionamento
e antes da auditoria. Isso é anterior ao intervalo da auditoria e compatível com
as mudanças de ACL do provisionamento. Portanto, a evidência sustenta igualdade
dos snapshots **durante a auditoria e os probes**, não imutabilidade desde antes
do provisionamento. O hash cobre o snapshot definido pelo harness; não é dump
completo do banco nem prova sobre todo conteúdo ou estado do database.

O full verify de repositório informado para o HEAD `2b9b0a8` terminou com
**1730 pass, 0 fail e 6 skip**: 1349 testes Portal e 381 CMS, com três skips em
cada grupo. Esse resultado é distinto do JSON da execução PG16, que registra o
harness e os probes, não o log do full verify.

## Falhas anteriores preservadas

Execuções anteriores não foram reutilizadas para este PASS nem tiveram seus
fixtures removidos nesta etapa. As causas conhecidas, em resumo, foram:

- validação de caminho/lease no ambiente Docker Desktop e do estado imutável da
  lease, corrigidas antes da execução bem-sucedida;
- o ACL inicial PG16 de `pg_catalog.pg_settings`, cujo `UPDATE` efetivo equivale
  a configuração de sessão e motivou a exceção estreita, sem revogar ACL de
  `PUBLIC`;
- a comparação do verificador de execução de funções com `NULL` quando a
  assinatura opcional `public.gen_random_uuid()` não existe, corrigida em
  `2b9b0a8` sem conceder privilégios extras ao observer.

Relatórios e fixtures falhos foram preservados conforme os registros disponíveis.
Não se afirma que continuem presentes, íntegros, disponíveis ou dentro de algum
prazo de retenção; não houve limpeza nem inspeção de expiração nesta conclusão.

## Próximos limites

O importador durável e a aplicação por adapter ainda precisam de integração
própria. Coverage, drain, trabalhos nativos, CRUD efetivo, reconciliação de
destino, Tasks 10–12 e qualquer validação de produção continuam pendentes nos
seus escopos. Esta auditoria não injeta conteúdo nem prova essas propriedades.
