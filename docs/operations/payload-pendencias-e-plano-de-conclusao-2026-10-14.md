# Payload — pendências e plano de conclusão

Snapshot de 14/10/2026 · Portal Ownerinc · PR [#61](https://github.com/OWNERINC/portal_ownerinc/pull/61).

## 1. Resumo executivo

**O Payload ainda não está entregue em produção.** Há implementação, revisão e
qualificações isoladas importantes concluídas; faltam integração operacional,
recuperação B0 de produção, instalação, migração, ativação e aceite editorial real.
Abrir o admin, obter readiness ou passar uma fixture nativa não conclui a entrega.

O objetivo é usar `https://portal.ownerinc.com.br/editorial/admin`, entrar pelo
login real do Portal, criar notícia do zero, enviar arquivo original, salvar
draft/autosave, consultar Versions, restaurar uma versão, publicar e ler o resultado
no Portal em sessão independente. O acervo existente deve continuar íntegro.

Este documento consolida o plano P1–P8 já aprovado; não cria uma nova autorização
operacional. Foi produzido apenas com leitura local e evidência fornecida pela
coordenação. Não houve nova consulta ao CI, browser público ou VPS nesta tarefa.
Nenhum código, serviço, CI, SSH, banco, Docker, commit ou deploy foi alterado.

### Legenda de estado e prioridade

- **CONFIRMADO:** evidência identificada para aquele commit/ambiente/escopo.
- **TEST-ONLY:** implementação ou execução isolada; não autoriza produção.
- **PENDENTE:** falta entrega ou evidência específica de aceite.
- **BLOQUEADO:** depende de gate anterior; não deve ser executado antecipadamente.
- **A:** bloqueia a próxima fronteira operacional; **B:** bloqueia a entrega final.
- “Fechado” abaixo vale só para o escopo indicado; histórico de falhas é preservado.
- IDs deste backlog são estáveis; dependências não representam prazo estimado.

## 2. Evidências disponíveis e limites

| Ref. | Evidência | Estado e alcance |
| --- | --- | --- |
| E01 | [Commit 3192127d4796c41bd0f2c72e073aaf1bbb2ee650](https://github.com/OWNERINC/portal_ownerinc/commit/3192127d4796c41bd0f2c72e073aaf1bbb2ee650), [CI 38600074126](https://github.com/OWNERINC/portal_ownerinc/actions/runs/38600074126) | CONFIRMADO: SUCCESS; native 25 PASS/0 skip; 14 checks, 11 negativos e 2 restores completos. Deploy SKIPPED. Qualifica o perfil TEST anterior. |
| E02 | [Report 11917696403](https://github.com/OWNERINC/portal_ownerinc/actions/runs/38600074126/artifacts/11917696403), [qualified 11917981281](https://github.com/OWNERINC/portal_ownerinc/actions/runs/38600074126/artifacts/11917981281) | Artefatos do run anterior preservados; não substituem qualificação dos bytes novos. |
| E03 | [Commit 242652c9b43f5d3a7c8a93cebc85634a6fe0bbd1](https://github.com/OWNERINC/portal_ownerinc/commit/242652c9b43f5d3a7c8a93cebc85634a6fe0bbd1), [job 116036041743](https://github.com/OWNERINC/portal_ownerinc/actions/runs/38617436909/job/116036041743) | Push confirmado pela coordenação; native SUCCESS: 29 PASS, 0 fail, 0 skip, 57,16 s. Fecha a pendência nativa daquele incremento TEST de uploads. |
| E04 | [CI 38617436909](https://github.com/OWNERINC/portal_ownerinc/actions/runs/38617436909) | **Último status conhecido: IN_PROGRESS, em validate; consultar novamente.** Não afirmar workflow completo, novos 14/11/2 ou deploy com base apenas em E03. |
| E05 | Verify local final informado pelo primary | Portal: 1.954 total / 1.935 PASS / 19 skip; CMS: 459 / 448 / 11; total: 2.413 / 2.383 / 30; zero falhas; `VERIFY_EXIT=0`. |
| E06 | [Comentário de entrega](https://github.com/OWNERINC/portal_ownerinc/pull/61#issuecomment-6175791374) | Referência de handoff mais recente fornecida; deve ser correlacionada ao SHA e run, não usada como autorização de produção. |
| E07 | [Review de conclusão](../reviews/2026-10-13-payload-production-completion.md), seção final | Revisão estática SHIP para o incremento TEST; não significa aprovação de B0 real ou implantação. |
| E08 | Observação read-only do host em 14/10, fornecida pelo primary | Inventário de planejamento, não baseline congelado/autenticado. Detalhes abaixo. |

Identificadores integrais para conferência:

- E02 raw SHA-256 informado: `ba55ab748058b3b69e64f453147d2fcd9795ae54369db546d1c12b532c76aeb1`.
- E05 log: `%LOCALAPPDATA%/Temp/opencode/payload-b0-tree-materialization-final-verify.log`.
- E05 hash do diff antes/depois: `2f7f1285c87a5899497a956ec116d8cc500095aa`; diff/status inalterados no aceite informado.
- Thread que acompanha E04: `ses_ec447dc31ffej718TaJFjlVQOO`.
- Review TEST: `ses_ec454ad83ffeUvvk4qKRxClnfc`.

A prova runtime informada registra `dataVerified=true`, interrupções reconciliadas,
evidência preservada e recursos próprios removidos, com admission fechada e readiness
pendente. Permanecem **false**: `applicationRollbackExecuted`,
`applicationCompatibilityQualified` e `productionAuthorized`.

As marcações antigas “native NOT RUN” dos runbooks/reviews continuam corretas como
histórico de suas entregas. E01 e E03 as superam apenas para seus bytes e fixtures
exatos. Não se reescreve o histórico nem se promove TEST a baseline de produção.

### Inventário observado para planejamento — E08

| Item | Observação fornecida |
| --- | --- |
| Source em produção | `ce324b1b3d36fafb98270c9dfd8e62fed87d67a3` |
| Checkout e ponteiro | `/opt/ownerinc/apps/portal-ownerinc-real`, `current-release` |
| API | `ghcr.io/ownerinc/ownerinc-portal-api@sha256:bf2b4f6ebd67addb38abae3f9bd9c53a8ee0b7279f23b6e4e82e8374d47705c0` |
| Cron | `ghcr.io/ownerinc/ownerinc-portal-cron@sha256:2549282327dcd3412524896250dcc12eb73ff92bc13c46dd335170e342b75469` |
| Image IDs em execução | Informados como correspondentes às imagens API/cron acima; isso não prova startup posterior ao restore. |
| PostgreSQL | `postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777` |
| Uploads | 2 arquivos + 2 diretórios, incluindo root; 6.754.593 bytes; maior arquivo 6.180.100 bytes; profundidade 2. |
| Metadados uploads | UID/GID 1000:1000; diretórios 0755, arquivos 0644; sem links, tipos especiais, ACLs, xattrs ou candidatos sparse observados. |

Essas observações manuais não são aprovações autenticadas, não congelam o source e
não comprovam exclusividade de consumidores. Nomes/conteúdo privados não entram nas
fixtures. O 502 público anteriormente observado é **histórico**, não verificação
atual de disponibilidade. Nada foi modificado no host por este trabalho.

## 3. Backlog completo P1–P8

Cada linha define próxima ação, entregável e aceite. As referências R01–R10 estão
na seção 9. Evidência futura deve ser anexada à thread visível correspondente e
identificada por commit, ambiente, resultado e caminho privado/sanitizado adequado.

### P1 — recuperação e identidades

| ID / prioridade / estado | Dependência | Próxima ação e entregável | Aceite exato / evidência |
| --- | --- | --- | --- |
| P1-01 · A · CONFIRMADO/TEST-ONLY | E01 | Manter a correção da ordem externa de mounts e ticket efêmero v2 já entregue. | Permutação conserva receipt; mudança real de campos/cardinalidade e healthcheck recusa; HMAC/FD9/ancestral/journal mantidos. R01/R02 + E01. |
| P1-02 · A · PENDENTE | E04 | Fechar evidência do candidato novo, sem repetir CI cegamente. | Run/attempt/SHA e jobs completos conferidos; 14 checks/11 negativos/2 restores e artefatos exatos; deploy distinguido. E04/E06. |
| P1-03 · A · CONFIRMADO/TEST-ONLY | P1-01 | Preservar versionamento separado de receipts persistentes v3 e históricos. | Nenhuma reinterpretação de hash antigo, conversão silenciosa ou adoção de recurso; integração produtiva fica em P3. R02. |

### P2 — confiança, admissão e preparação

| ID / prioridade / estado | Dependência | Próxima ação e entregável | Aceite exato / evidência |
| --- | --- | --- | --- |
| P2-01 · A · TEST-ONLY; host PENDENTE | P1-02 | Qualificar e instalar a cadeia aprovada: launcher privilegiado fixo, verifier, policy, records e incoming protegido. | Ancestrais root-owned, bytes autenticados, publicação ordenada e reentrada interrompida; comprovar identidade/autoridade do acesso CI SSH/sudo real. R03/R04. |
| P2-02 · A · PENDENTE | P2-01 | Vincular source/candidato exatos e preparação inativa sob lease. | Approval independente e closure exata; FD9 fresco herdado corretamente; pins obsoletos só substituídos por identidades autenticadas; legado/staging preservados. R03/R04. |
| P2-03 · A · BLOQUEADO | P2-02, B0-01–09 | Integrar admissão sem antecipar instalação. | Admissão não equivale a deploy; `release_not_preflighted` permanece até P3 qualificado; nenhum sudo amplo ou ownership compartilhado alterado. R02/R03. |

### P3 — instalação recuperável, B0, floor e B1

| ID / prioridade / estado | Dependência | Próxima ação e entregável | Aceite exato / evidência |
| --- | --- | --- | --- |
| P3-01 · A · BLOQUEADO | B0-01–09, P2-02 | Conectar executor de instalação ao binding produtivo, com receipts de criação. | B0 anterior às mutações; provisionamento receipted; API/cron/CMS candidatos parados; quatro containers/dois volumes CMS identificados; reentrada sem adoção. R02. |
| P3-02 · A · BLOQUEADO | P3-01 | Implementar/qualificar floor commit e B1 dedicado em estado fechado. | Floor durável confirmado; B1 de quatro stores coerente e recuperável; recovery pós-floor permanece no floor compatível Payload. B0 não substitui B1. R01/R02. |
| P3-03 · A · BLOQUEADO | P3-02, B0-08 | Qualificar readiness privada e publicação autenticada da release. | Aplicações reais, identidade/readiness/smoke completos; admission fechada até fronteira autorizada; dados verificados não implicam readiness concluída. R02/R03. |
| P3-04 · A · BLOQUEADO | P3-01–03 | Habilitar dispatch produtivo somente após revisão e aceite primário. | Falhas em cada fronteira recuperáveis; processo novo obtém lease/autoridade nova; produção v3 continua recusada até todos os gates. R02. |

### P4 — fases operacionais e recuperação com conteúdo

| ID / prioridade / estado | Dependência | Próxima ação e entregável | Aceite exato / evidência |
| --- | --- | --- | --- |
| P4-01 · A · PENDENTE | P3 | Estender estado/proofs para protocolo instalado, preparação frozen, ativação sealed, Payload active e Payload frozen. | Transições assinadas exatas; estados desconhecidos recusados; schema host, binding, fingerprint, protocolo V2 e extensão operacional versionados separadamente. R01/R02/R05. |
| P4-02 · A · BLOQUEADO | P4-01 | Qualificar backup/restore populated e active em Linux isolado. | Quatro stores, histórico, uploads, ledger e agendas preservados; worker held; não voltar a autoridade legacy depois de edições nativas. R01/R02/R05. |

### P5 — importação fiel e reconciliação real

| ID / prioridade / estado | Dependência | Próxima ação e entregável | Aceite exato / evidência |
| --- | --- | --- | --- |
| P5-01 · A · PENDENTE | P4-01 | Integrar caller controller: bootstrap RPC e COMMIT confirmado antes da transação Payload. | Identidade física target + source instance distintas; lock 7194030 sem bloqueio circular; grants reais; controller/runtime sem INSERT direto indevido. R05. |
| P5-02 · A · PENDENTE | P5-01 | Corrigir criação/atualização incompatível de `news-migration-runs`, incluindo `updatedAt`. | Fluxo real respeita ACLs, hooks e protocolo; não remover guards nem conceder acesso amplo para passar. `cms/src/migration/import-news.ts`, coleções e R05. |
| P5-03 · A · PENDENTE | P5-02 | Alinhar projeções/hashes de conteúdo, representação nativa e legado. | Hash esperado e observado usam a mesma projeção; hashes históricos/proveniência/snapshot nativo permanecem distintos e verificáveis. `plan.ts`, `destination.ts`, R05/R06. |
| P5-04 · B · PENDENTE | P5-03 | Fechar `publishedAt`, precisão temporal e comportamento para home ausente. | Datas originais preservadas, sem fabricar publicação; exceções explícitas para precisão; decidir ausência versus home vazio sem descarte silencioso. R05/R06. |
| P5-05 · B · PENDENTE | P5-03 | Completar paginação de versões, histórico e reconciliação do acervo. | Mais de uma página e acima do limite de uma consulta cobertos; nenhum item omitido; IDs, bytes, referências e contagens exatos. `destination.ts`, R05/R07. |
| P5-06 · A · BLOQUEADO | P5-01–05, P3/P4 | Exercitar importador existente com grants reais e staging privado durável. | Publicação/draft/história distintos; mídia original preservada; unidade documental auditada; rollback externo e COMMIT desconhecido reconciliados em request novo, sem retry cego. R05/R06. |

### P6 — agendas, cobertura, drenagem e selagem

| ID / prioridade / estado | Dependência | Próxima ação e entregável | Aceite exato / evidência |
| --- | --- | --- | --- |
| P6-01 · B · PENDENTE | P5 | Manter agendas importadas suspensas e registrar decisões explícitas/successors vinculados. | Instante/snapshot/proveniência preservados; ator desconhecido e vencimento tratados; nenhuma execução automática ou ator inventado. R05/R06. |
| P6-02 · A · PENDENTE | P4/P5 | Qualificar cobertura de todas as mutações e persistir baseline de reconciliação. | Ledger/head/barreira capturam caminhos reais, inclusive importação, manutenção e worker; `coverage_version` observado não é certificado. R05/R08. |
| P6-03 · A · BLOQUEADO | P6-02 | Demonstrar drain editorial privado com API viva e selar o run exato. | Writes em andamento drenados; nenhuma corrida entre reconciliação e seal; API responde à prova de drain. Isso é distinto da quiescência de todos os writers para backup dos quatro stores. R01/R05. |

### P7 — ativação e jornada editorial

| ID / prioridade / estado | Dependência | Próxima ação e entregável | Aceite exato / evidência |
| --- | --- | --- | --- |
| P7-01 · A · BLOQUEADO | P6-03 | CAS curto da autoridade Portal com auditoria transacional. | Epoch/manifest/run/seal exatos; confirmação durável fresca do COMMIT antes de reabrir barreira CMS; resultado desconhecido permanece fechado. R01/R05. |
| P7-02 · B · BLOQUEADO | P7-01, P4-02 | Executar browser nativo integrado em Linux isolado. | Login Portal real, notícia zero, upload original, draft/autosave, Versions/restore, publicação e leitor independente; evidência por ação, sem substituir dependências reais por doubles não declarados. R07/R08/R09. |
| P7-03 · B · BLOQUEADO | P6-01, P7-02 | Qualificar e liberar scheduling worker em gate próprio. | Successors/decisões respeitados, sem duplicação; edições posteriores preservadas; worker fica held até aceite específico. R01/R05. |

### P8 — candidato final, manutenção e produção HTTPS

| ID / prioridade / estado | Dependência | Próxima ação e entregável | Aceite exato / evidência |
| --- | --- | --- | --- |
| P8-01 · A · BLOQUEADO | P1–P7 | Qualificar bytes/imagens finais e revalidar inventory/grants reais. | CI, report, qualification, package, source e digests correspondem ao release final; aprovação antiga não cobre código novo. R03/R04. |
| P8-02 · A · BLOQUEADO | P8-01, B0 completo | Comunicar janela de manutenção medida e executar instalação/importação/ativação testadas, só no Portal. | Plano de interrupção/recuperação e evidência privada disponíveis; gates frescos; nenhum efeito em outros projetos ou proxy compartilhado. R01/R03. |
| P8-03 · B · BLOQUEADO | P8-02 | Repetir jornada pública HTTPS e leitor independente; registrar entrega e handoff. | TLS/rotas/login/permissões/assets/Versions/restore/publicação/leitura reais; IDs, história e agendas reconciliados; recuperação compatível preservada. R07/R09. |

## 4. B0 — o que ainda falta para produção

O B0 legado cobre Portal DB + uploads, antes dos novos grants/mutações. A verificação
streaming de integridade existe; o restore isolado passou em TEST. Falta fechar
todo o conjunto abaixo com fonte real autenticada e aplicações anteriores exatas.

| ID / prioridade / estado | Dependência | Próxima ação e entregável | Aceite exato / evidência |
| --- | --- | --- | --- |
| B0-01 · A · PENDENTE | P2-02 | Collector bounded autenticado do source, sob processo/lease FD9 frescos. | Closure, approval/policy/record, inventory, journal e identidades conferidos; observações manuais não viram aprovação por cópia. R02/R04. |
| B0-02 · A · PENDENTE | B0-01 | Perfil de segurança pré-grants: owners, ACLs/defaults, memberships, privilégios efetivos, consumidores de roles e credenciais. | Aprovação independente para source/API/cron exatos; autenticação privada real; exclusividade dentro e fora dos catálogos; nenhum reparo global de role/senha. R02. |
| B0-03 · A · PENDENTE | B0-01 | Fence efetivo de ingress Docker, host e não-Docker, com observer externo independente. | Topologia aprovada + probes de rotas exatas; timeout/DNS/TLS/502 genérico não provam fechamento; observar antes da captura e novamente antes de cada passo destrutivo sob FD9. R02. |
| B0-04 · A · BLOQUEADO | B0-02/03 | Capturar baseline coerente pré-grants e backup exato protegido. | Source vivo vinculado; dump/uploads/proof/manifest exatos; root/ancestrais protegidos, 0700/0600, single-link/no-follow, descritores estáveis e stream integral; sem baseline aprendido do alvo danificado. R02. |
| B0-05 · A · TEST-ONLY; real PENDENTE | E03, B0-04 | Verificar uploads privados reais contra dimensões e perfil aprovados. | TEST de árvore bounded/UID/GID passou; ainda conferir bytes/metadados efetivos, root/parents, ausência real de ACL/xattr/link/sparse e caps no source congelado. E03/E08/R02. |
| B0-06 · A · PENDENTE | B0-04 | Qualificar schema/dump legado real com solução fundamentada em fonte. | Comparação exata; sem normalizador SQL genérico, sem ampliar a exceção TEST de dois CHECKs ao schema real por analogia; qualquer delta extra recusa. R02. |
| B0-07 · A · PENDENTE | B0-02/06 | Decidir estratégia de owners/ACLs no restore produtivo. | Escolha explícita entre preservar archive owners/ACLs e `--no-owner --no-privileges` com reparo dirigido qualificado; preservar outros grantees/databases/credenciais; não misturar os contratos. R02. |
| B0-08 · A · BLOQUEADO | B0-04–07 | Provar rollback de aplicação anterior compatível, com contenção de operações/saída externa. | Disponibilidade das imagens exatas e image IDs não bastam: startup real, autenticação privada, readiness/smoke, DB/uploads e comportamento compatíveis; nenhum envio externo indevido. R01/R02. |
| B0-09 · A · BLOQUEADO | B0-08 | Integrar recuperação pre-floor interrompível, fechada e auditável. | Processo/lease novos por retomada; COMMIT desconhecido reconciliado; evidência CMS preservada; `data_verified_readiness_pending` não abre admission; nenhum downgrade após edições nativas. R02. |

### Checklist de gate B0 completo

- [ ] B0-01: source e collector autenticados, contexto/lease atuais.
- [ ] B0-02: perfil pré-grants aprovado, consumidores e credenciais qualificados.
- [ ] B0-03: fence externo independente + host/não-Docker, fresco em cada fronteira.
- [ ] B0-04: captura coerente e artefatos exatos protegidos/verificados integralmente.
- [ ] B0-05: uploads reais qualificados privadamente, além da fixture TEST já aprovada.
- [ ] B0-06/07: schema legado e estratégia owners/ACLs decididos e restaurados exatamente.
- [ ] B0-08: aplicações anteriores exatas executadas e compatíveis, saída externa contida.
- [ ] B0-09: interrupções/retomadas/readiness e estado fechado qualificados.

**B0 completo permite avaliar a próxima fronteira de P3; não entrega o CMS.**
Produção v3 permanece desabilitada até seus gates completos, revisão fresca e
aceite primário. O fechamento de B0 não dispensa B1, P4–P8 nem o browser final.

## 5. Execução em fases e threads visíveis

Toda nova implementação, revisão e execução de testes deve ocorrer em **novas
threads visíveis no OpenChamber**, com escopo limitado e link para PR #61. Manter
um único implementador por vez e aceitação pela sessão primária; revisão fresca
separada. Esta tarefa documental não criou agentes nem delegou trabalho.

| Fase / thread temática proposta | Escopo manejável | Saída para aceite primário |
| --- | --- | --- |
| F0 — evidência do candidato atual | P1-02, consultar E04 na thread de entrega existente | Status final confirmado ou blocker exato; artefatos/run/SHA preservados. |
| F1 — source, segurança e fence | P2 + B0-01–03; dividir collector, security e observer em entregas | Contratos autenticados e provas isoladas; aprovação real separada. |
| F2 — backup e restore realista | B0-04–07; separar uploads, schema e decisão ACL | Comparações exatas e decisão fundamentada; nenhuma expansão implícita do TEST. |
| F3 — aplicação anterior e recuperação | B0-08/09 + P3 | Rollback compatível, floor, B1 e readiness fechada demonstrados. |
| F4 — estados operacionais | P4 | Transições/restore populated qualificados com evidências assinadas. |
| F5 — importer | P5 em fatias: bootstrap/grants, projeções/datas, paginação/reconciliação | Integração real com fidelidade e recuperação de COMMIT ambíguo. |
| F6 — seal e ativação | P6 + P7-01 | Cobertura, drain, seal, CAS/auditoria e confirmação fresca. |
| F7 — aceite nativo | P7-02/03 | Jornada browser e worker qualificados separadamente. |
| F8 — release e operação | P8 | Candidato final e implantação Portal-only com aceite HTTPS. |

Cada fatia exige: implementação → review fresco → correções → testes adequados →
aceite primário. Relatar PASS/fail/skip, doubles, recursos e evidências preservadas;
não emitir conclusão de produção a partir de teste parcial. Nenhuma fase pressupõe
prazo garantido. O alvo temporal anterior era intenção, não compromisso validado.

### Próximas três ações imediatas

1. Obter o resultado final de E04 com a thread `ses_ec447dc31ffej718TaJFjlVQOO`;
   confirmar o conjunto completo antes de reutilizar qualquer pacote ou disparar CI.
2. Abrir a próxima thread visível para B0-01–03, delimitando collector autenticado,
   perfil pré-grants e cobertura externa independente; manter mutações bloqueadas.
3. Fechar a decisão B0-06/07 e o plano de prova B0-08 com review fresco: schema
   source-grounded, owners/ACLs e aplicações anteriores exatas, antes do executor.

## 6. Decisões abertas e riscos concretos

- **Segurança/autoridade:** acesso read-only root observado não prova autoridade do
  entrypoint CI SSH, aprovação independente, exclusividade de roles ou credenciais.
- **Fence:** fixture de container no mesmo host não é observer externo independente;
  proxies/túneis/processos host-native precisam de cobertura aprovada.
- **Schema:** a transformação TEST de dois CHECKs tem domínio exato; não é solução
  genérica para PostgreSQL nem autorização para alterar dumps de produção.
- **Restore ACL:** preservar owners/ACLs do archive e restaurar sem eles com reparo
  dirigido são estratégias diferentes; a escolha produtiva continua pendente.
- **Aplicação:** dados iguais e imagens disponíveis não demonstram rollback funcional;
  exige processos reais, autenticação, readiness e contenção de saídas externas.
- **Importer:** decidir home ausente, precisão de datas e projeção nativa sem inventar
  histórico; grants e `updatedAt` devem ser resolvidos respeitando o protocolo.
- **Agendas:** ator desconhecido/instante vencido exigem decisão explícita e successor
  rastreável; não liberar worker para “resolver” automaticamente o legado.
- **COMMIT desconhecido:** preservar arquivos/recibos e reconciliar em contexto novo;
  nunca apagar evidência ou repetir mutação por ausência de resposta.
- **Notificações:** contato de email foi fornecido privadamente, mas a capacidade de
  envio não está confirmada; não prometer email nem prazo. Não documentar o contato.

## 7. Requisitos que permanecem obrigatórios

- Preservar os documentos `3a3af1ab-f64f-4545-9371-24a2f8e78756` e
  `338c5db2-f620-413e-a5b3-8a7e622377ee`, seus IDs públicos, mídias, publicações,
  drafts, versões/história e agendamentos; provar reconciliação antes/depois.
- Manter Portal e Ownerinc Brain separados; `ownerinc-novo-agente/` fora do escopo.
- Operar somente serviços/recursos Portal autorizados; avisar antes de qualquer
  alteração em n8n; não alterar outros projetos nem o proxy compartilhado por atalho.
- Preservar artefatos de sucesso e falha, evidências privadas e arquivos untracked
  do usuário; nenhum cleanup amplo, retry cego ou reparo silencioso de journal/head.
- Conservar os 14 checks, 11 negativos e 2 restores completos. Não reduzir cobertura,
  aumentar timeouts ou relaxar comparações para obter verde neste plano.
- Não copiar segredos, dumps, nomes/conteúdo privados ou credenciais para docs/CI.
- Manter a distinção entre drain editorial com API viva e quiescência integral de
  writers dos quatro stores; readiness privada não satisfaz fence destrutivo.

## 8. Critério de conclusão global e handoff

A entrega só fecha quando P1–P8 tiverem aceite explícito para o candidato final,
B0/B1 e recuperação compatível estiverem demonstrados, e a jornada pública HTTPS
completa funcionar com login Portal real e leitura independente. IDs, bytes,
história e agendas devem estar reconciliados; worker tem gate próprio.

O handoff deve registrar: SHA/digests implantados, CI/artefatos exatos, estado e
epoch finais, evidências editor/reader, pendências residuais explícitas e localização
privada dos backups/receipts. A sessão primária decide o aceite com review fresco.
Não declarar conclusão com base apenas no admin aberto, em SHIP estático ou em E03.

Verificação desta edição documental: `git diff --check` sem diagnósticos; comparação
no-index do arquivo untracked também sem diagnósticos de whitespace (exit 1 por
arquivo adicionado). Referências locais conferidas, sem destinos ausentes.
**Full `npm run verify` não executado nesta tarefa exclusivamente documental**, conforme escopo pedido;
E05 é evidência anterior informada, não uma nova execução. Não houve mudança runtime.

## 9. Referências de trabalho

- R01 — [Plano aprovado P1–P8](../superpowers/plans/2026-10-13-payload-production-execution.md).
- R02 — [Runtime e recuperação](payload-runtime-recovery.md): B0, security, fence, binding e receipts.
- R03 — [Deploy e preparação](deployment.md).
- R04 — [Admissão do receiver](../superpowers/plans/2026-10-13-payload-receiver-admission.md).
- R05 — [Migração Payload](owner-news-payload-migration.md): bootstrap, grants, protocolo e reconciliação.
- R06 — [Importação/exportação Owner News](owner-news-import.md): bundle Payload distinto de A1/A2 e legado.
- R07 — [Ponte de leitura e prévia](owner-news-payload-read-bridge.md).
- R08 — [Checks e aceite Payload](payload-owner-news.md).
- R09 — [Matriz de aceite](../reviews/2026-10-02-payload-owner-news-acceptance.md) e [admin nativo](../reviews/2026-10-08-payload-native-admin-acceptance.md).
- R10 — [Review/histórico de conclusão](../reviews/2026-10-13-payload-production-completion.md).
- Contexto: [README](../../README.md), [brief do produto](../product/brief.md) e [AGENTS](../../AGENTS.md).
- Coordenação: [PR #61](https://github.com/OWNERINC/portal_ownerinc/pull/61) e E06; todas as futuras threads devem preservar a ligação entre item, commit, teste e aceite.
