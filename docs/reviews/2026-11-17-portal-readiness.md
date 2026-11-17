# Correções de prontidão — registro de aceite

## Estado

**Pacote de código/documentação aceito pela sessão principal**, após verificação
local e revisão independente com veredito **`ship`**, na branch
`fix/portal-readiness`. A homologação de capacidade e a implantação continuam
pendentes.

Base: `dfe991db1a8aa89921262345ce72acee1279dd0e`.
Especificação: commit `cee81d0`.
Implementação: `dc2f979a9874bd3950f11e9121c688411367407e`.
Documentação e HEAD revisado: `e3c529b5bca78332f1e3f6d9cd837e5554151801`.
Especificação aprovada:
[`2026-11-17-portal-readiness-design.md`](../superpowers/specs/2026-11-17-portal-readiness-design.md).
Plano:
[`2026-11-17-portal-readiness.md`](../superpowers/plans/2026-11-17-portal-readiness.md).

## Evidência de partida

A reverificação de 17/11 reproduziu:

- colisão de 100 UIDs no limite global de 300/IP/15 minutos;
- dez convites retendo dez conexões enquanto aguardavam outra aquisição,
  utilizando `pg-pool` real com transporte SQL falso;
- retenção de microssegundos impedindo progresso além do primeiro lote de cem;
- remoção de bytes após COMMIT persistido/ACK perdido em foto, AutoCard e Pós;
- UID preservado em recibos Pages e dados em linhas de importação após
  apagamento do usuário, em desacordo com a promessa documental genérica.

Baseline na branch: `npm run verify`, 1220 PASS, 4 SKIP, 0 FAIL.
Não houve reclassificação desses resultados como benchmark.

## Mudanças verificadas

- Orçamento de 300/UID validado/15 minutos, agregado de 30.000/IP/15 minutos
  e `Retry-After`, preservando os gates de conta/Ética e os limites específicos.
- Nginx API 20r/s, burst 500; uploads 60r/m, burst 20; mídia 60r/s, burst 500.
  A diff altera apenas os números aprovados, mantendo LF e `nodelay`.
- Convite administrativo libera a conexão antes de habilitação/compensação.
  Reconciliação e cleanup liberam a conexão de seleção antes de novos helpers.
- Aprovação propaga `discardClient` e `afterRelease`; a rota descarta a conexão
  fornecida antes de restaurar o marcador pendente. Ambos são não enumeráveis.
- Retenção usa a chave temporal textual da releitura sob lock e trata DELETE
  inesperado de zero linhas como falha.
- Foto, AutoCard e Pós preservam bytes após COMMIT confirmado/incerto ou rollback
  incerto, inclusive falha de resposta posterior ao COMMIT confirmado.
- Privacidade descreve os recibos Pages e as linhas de importação retidos.
  Recibos e prazos existentes não foram alterados.

## Verificação primária em 17/11/2026

Executada no worktree da branch em `dc2f979`, após inspeção da diff runtime/config
e dos testes novos/alterados. Node `v24.15.0`, exigido pelo verificador atual;
Git Bash `5.3.15` precedeu o WSL indisponível no PATH. A sintaxe adicionada é
compatível com Node 18, mas não se executou a suíte em Node 18.

| Verificação | Resultado |
| --- | --- |
| `npm run verify` | 1264 PASS, 4 SKIP, 0 FAIL; exit 0 |
| Sintaxe Node e shell, scan de segredos, nomenclatura | PASS pelo verificador |
| `docker compose --env-file .env.example config --quiet` | PASS pelo verificador; validação estática, sem iniciar serviços |
| Suíte direcionada (comando abaixo) | 112 PASS, 0 SKIP, 0 FAIL; exit 0 |
| Retenção SQL/PGlite | PASS: precisão, proteções, retry e 101º registro |
| `node --test tests/unit/pages-schema-v3.test.mjs` com PGlite | 3 PASS, 0 SKIP, 0 FAIL |
| `node tests/database/check-ethics.mjs` com PGlite | PASS |
| `npm run check:pages-build` | PASS, bundle/notices atuais, sem escrita |
| `git diff --check` | PASS |
| Nginx nativo | PENDENTE: executável não disponível; somente testes estáticos |

Os quatro skips da suíte geral são: dois dependentes de semântica Linux
(`flock` e symlinks), PNGs externos sem `PAGES_REFERENCE_DIR` e SQL Pages sem
`PGLITE_MODULE_PATH`. O último foi executado separadamente e passou; os outros
três não foram substituídos por evidência local equivalente.

Suíte direcionada:

```text
node --test tests/unit/readiness-rate-limit.test.mjs tests/unit/readiness-pool.test.mjs tests/unit/readiness-upload.test.mjs tests/unit/pending-registration.test.mjs tests/unit/user-invitation-delivery.test.mjs tests/unit/academy-progress.test.mjs tests/unit/pos-cards-api-invariants.test.mjs tests/unit/nginx-config.test.mjs
```

SQL de retenção:

```text
node tests/database/check-registration-retention.mjs
```

O módulo externo usado em `PGLITE_MODULE_PATH` foi
`C:/Users/Criação/AppData/Local/Temp/opencode/consent-db-tools/node_modules/@electric-sql/pglite/dist/index.js`.
Não foi adicionado ao projeto. O ensaio misto excluiu seis linhas e reportou
uma falha intencional por referência; retry passou de `{deleted:0,failed:1}`
para `{deleted:1,failed:0}`; o lote passou de `{deleted:100,failed:0}` para
`{deleted:1,failed:0}`.

Os testes do pool usam `pg-pool` instalado com transporte falso: pools de 2 e
10 concluem convites concorrentes e `SELECT 1` sem aumento de capacidade.
Testes de um slot cobrem liberação/compensação, COMMIT e rollback incertos,
aprovação e restauração do marcador após descarte pelo proprietário.
Uploads têm seis cenários em cada um dos três módulos, mais o caso de resultado
vazio de `withAudit`. Firebase, SMTP e filesystem de uploads são doubles.

Logs primários preservados em `C:/Users/Criação/AppData/Local/Temp/opencode/`:

- `portal-readiness-primary-verify.log`;
- `portal-readiness-primary-targeted.log`;
- `portal-readiness-primary-retention.log`;
- `portal-readiness-primary-pages-sql.log`;
- `portal-readiness-primary-ethics-sql.log`.

O implementador registrou falhas pré-correção e resultados verdes em
`task-1-report.md`, arquivado com o ledger, brief, pacote da diff e parecer em
`C:/Users/Criação/AppData/Local/Temp/opencode/portal-readiness-evidence-20261117-e3c529b/`.
Seu verify
ignorou Compose por restrição do worker; a execução primária acima efetivamente
validou Compose. PGlite, doubles e limite de tempo dos testes não são benchmark.

## Revisão independente

Revisor fresco `sol-advisor-reviewer`, sessão
`ses_e15e013d8ffea8kyZraxybfCNe`, examinou o pacote completo
`dfe991db..e3c529b`, com requisitos, código real, callers e testes.

**Veredito: `ship`.** Conformidade da task, qualidade e revisão ampla da branch
aprovadas; nenhum defeito introduzido, lacuna obrigatória ou novo minor
identificado. Não foi necessária rodada de correção.

O parecer confirmou o UID validado, continuação assíncrona, gates, propriedade
das conexões e cadeia `afterRelease`, chave temporal sob lock, preservação dos
uploads e fidelidade da documentação de apagamento. Também confirmou a
limitação preexistente de aquisições aninhadas fora dos caminhos corrigidos.

O revisor não reexecutou suítes. Suas permissões negaram shell e logs externos;
portanto, não alegou validação independente dos logs brutos, do HEAD ou da
limpeza da árvore Git. As execuções e a conferência Git pertencem à sessão
principal. A primary confirmou HEAD `e3c529b`, árvore limpa e os dois worktrees
preservados ao receber o parecer.

Aceite primário: o pacote satisfaz a especificação aprovada dentro das evidências
locais descritas. Alterações posteriores ao HEAD revisado registram apenas este
aceite e o encerramento do plano. Não houve alteração runtime após a revisão.

## Fronteiras de aceite

O pacote verifica os mecanismos corrigidos, suas regressões e a documentação.
Capacidade para cem usuários, configuração produtiva efetiva, provedores reais,
dispositivos físicos, PostgreSQL nativo e restore são gates separados.

Documento de Ética, arte/PDF dos Cards Pós, capturas e dados históricos
permanecem fora das alterações deste pacote. A documentação de apagamento
registra as retenções existentes sem instituir nova base legal ou prazo.

A correção de pool é localizada. Não comprova ausência global de aquisição
aninhada: bulk mantém conexões de job/linha e rejeição/retenção têm ramos
históricos adicionais. Upload incerto pode deixar órfãos; não há expurgo geral
de fotos órfãs. Essas limitações constam no
[contrato operacional](../operations/readiness-capacity.md).

Continuam pendentes: formulário anterior de uso/rede/ambiente/VPS, ensaio
20→50→100 e sustentação, p95/p99/CPU/RSS/pool/locks/banda, PostgreSQL 16 nativo,
Nginx efetivo, jornadas Firebase/SMTP reais, dispositivos físicos e restore
integral/off-host. Nenhuma carga ou alteração produtiva foi executada neste
pacote. Contraste dos Cards Pós, A18 e permissões de backup são itens separados.
