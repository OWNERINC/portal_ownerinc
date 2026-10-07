# Matriz de aceite — Payload Owner News

Atualização: 07/10/2026, consolidação para revisão por PR. Base de partida `ba5acb6`.
Esta matriz não declara piloto aceito. Task9 tem bloqueio histórico de navegação;
correção e revisão ainda precisam ser integradas. A preparação e a suíte portátil
real Task15 estão **incompletas**, não apenas aguardando execução.

## Consolidação para o PR — 07/10/2026

- **PASS offline:** `npm run verify` concluído com 1.271 testes Portal e 314 CMS
  aprovados, zero falhas e cinco skips; typecheck, scanner de segredos e Compose
  passaram. Os 26 guards do harness de finalização passaram separadamente.
- **PASS nativo delimitado e revisado:** no run local isolado
  `b2ee7900-0f6d-42a9-aa53-6b2a28a3ad5b`, seis migrations, bootstrap e verificação
  dos papéis passaram. A fixture rejeitou exatamente
  `public_function_execute_outside_allowlist`, observou DDL antes do rollback e
  confirmou ausência posterior dos objetos do protocolo e igualdade dos hashes
  nativos de schema, dados, ledger e sequências. Instalação e reexecução do
  finalizador concluíram com exit 0; o harness conferiu igualdade do estado na
  reexecução. Relatório sanitizado SHA-256:
  `8d40bc0c47fc9b68bbdb46b7f4830a18051c6dea9c9b189d6ba6c23f3796667d`.
- O protocolo permaneceu com **coverageVersion 0, ready false e admissionActivated
  false**. Esse aceite não cobre CRUD/jobs/drain do Payload ou ativação.
- **PASS UI delimitado:** R9 comprovou feedback de data inválida, preservação do
  draft válido, correção, Save explícito e reload. R16 comprovou abertura do menu
  nativo e retorno por clique ao CMS real. Firebase/sessão e hosting eram doubles
  locais; isso não comprova identidade ou CSP de produção.
- **FAIL leitor R16:** o clique chegou a `/announcements.html` com HTTP 200, mas o
  heading esperado não ficou visível no prazo. Diagnóstico adicional do bootstrap
  segue pendente; o retorno ao CMS aprovado não é um aceite completo do leitor.
- **Pendências de release:** importação operacional (`--apply` bloqueado), adapter
  operacional e recibos protegidos, cobertura nativa CRUD/jobs/drain, Back/Forward,
  legado `editorial=null`, build/imagem Linux finais, Monaco/CSP, recuperação e
  cutover. As evidências abaixo são históricas quando anteriores a esta seção.

O PR reúne a implementação e as evidências para revisão; **não declara ativação do
Payload pronta para produção**. Merge em `main` pode acionar o deploy automático
do repositório. Implantação na VPS e cutover exigem decisão separada após avaliar
as pendências; abrir o PR não executa essas etapas.

## Leitura dos estados

- **PASS**: cenário delimitado realmente observado, com evidência e código de saída.
- **FAIL**: falha observada, mantida até correção e nova prova revisadas.
- **NÃO EXECUTADO**: nenhuma execução válida desta rodada; declarar separadamente
  se o teste está implementado ou se falta implementação/contrato/runtime.
- Resultado histórico é identificado como tal. Não somar jornadas sobrepostas.

## Evidências existentes e limites

| Evidência | Estado | Limite |
|---|---|---|
| Baseline root anterior ao wiring Task14 | PASS histórico informado pela coordenação: 1185 pass/0 fail/2 skips | Não executado por esta thread; não cobre wiring novo |
| Guard portátil e utilitários offline | PASS: 8 testes, exit0, 06/10/2026 | `node --test tests/unit/payload-integration-guard.test.mjs tests/unit/payload-verification.test.mjs`; sem serviços |
| Next/Express/Postgres Task7 | PASS histórico parcial | Firebase substituído, Next dev; não prova Nginx/CSP/produção |
| Prévia/browser Task8 | PASS histórico parcial | Fixture browser textual, identidade e transporte parcialmente substituídos |
| Histórico Task9 | FAIL histórico: 8/8 RED, exit1 | Toolbar/API × Back/Forward × dirty/pending; não reexecutado nesta thread |
| Navegação nativa Payload Task9 — R13 | FAIL antes do servidor/browser, exit1; autorização consumida, sem retry | Snapshot de ambiente carregou `LOCALAPPDATA` antigo enquanto a pasta privada era nova; o guard estrito rejeitou o pai divergente. Nenhum precompile, navegação ou clique; aceite CMS/leitor continua pendente |
| Audit CMS histórico de 05/10 | Snapshot: 17 pacotes, 5 high/10 moderate/2 low | Não é audit atual nem prova de exploit; remediação aguarda lease |
| Wiring consolidado verify/build/security/SBOM/CI | NÃO EXECUTADO | Implementado parcialmente; execução exclusiva final pendente |
| Runner portátil real Task15 | NÃO EXECUTADO | Helper de fixtures do Firebase Emulator é parcial; suíte HTTP/sessão/browser e preparação/integração continuam incompletas; default exit2, nunca PASS por suíte vazia |
| Suporte a fixtures Firebase Auth Emulator | PASS somente offline: 4 testes unitários, exit0, 06/10/2026 (execução anterior) | Guard estrito `demo-*` + loopback com porta explícita; criação/limpeza por run exercitadas com fetch injetado; aquela execução não contactou emulator/serviço/auth/sessão |
| Fixtures reais no Firebase Auth Emulator | PASS delimitado: 4 identidades, 06/10/2026, exit0 | Demo `demo-ownerinc-payload-local`, loopback9299; ID tokens conferidos por aud/iss e `verifyIdToken` do Admin SDK, emailVerified conferido no registro real, unverified=false e cleanup apenas dos UIDs desse run; não cobre Portal/API/cookie/browser |

## Camadas obrigatoriamente separadas

| Camada | Estado desta entrega | Oráculo/gate necessário |
|---|---|---|
| Offline | Parcial conforme tabela acima | Unit Portal/CMS, typecheck, sintaxe MJS, scanner, build, diff |
| PostgreSQL real | PASS delimitado de migrations/bootstrap/finalizador/rollback/reexecução; integração completa pendente | CRUD, locks de escritores, workers, drain e COMMIT ambíguo ainda requerem aceite próprio |
| Next + Express reais | NÃO EXECUTADO integrado | Build/start produção, REST/Server Actions, 503 sem fallback |
| Nginx/CSP real | NÃO EXECUTADO | Nonce no HTML/scripts, CSP única, limites, paths privados bloqueados |
| Firebase Emulator real | NÃO EXECUTADO final | Emissão/verificação cookie, revogação, expiração; sem provider/SDK doubles |
| Browser integrado | NÃO EXECUTADO final; Task9 FAIL histórico | Abas reais, UID, logout, navegação/foco, 1440×900/390/320 |
| Produção | NÃO EXECUTADO | Autorização nova, release/backup compatíveis e recuperação ensaiada |

## Jornadas editor e reader — todas pendentes de aceite integrado

| ID | Cenário | Oráculo |
|---|---|---|
| NEWS-01 | Editor entrar → salvar/autosave → prévia → publicar → ler → voltar → sair | Sessão real; salvar não publica; prévia usa ID da revisão salva; destinos distintos |
| NEWS-02 | Draft A → publicar A → draft B → retirar | Viewer não vê draft; publicação A permanece até publish explícito; retirada nega detalhe/mídia exclusivos |
| NEWS-03 | 409, save/upload pendente e commit sem ACK | Inputs/baseline preservados até ACK; reconciliação sem duplicação; não sair durante pending conforme contrato |
| NEWS-04 | Back/Forward dirty/pending, toolbar e History API | Tentativa/evento/decisão/resultado novos por tentativa; cancelar/cancelar/permitir; não confundir retenção sem evento com PASS |
| NEWS-05 | Sessão entre abas, expiry, permissão/conta revogada | Limpar editor/mídia; próxima request nega; signOut tardio não afeta UID novo; cancelar saída não faz DELETE |
| NEWS-06 | Logout editorial e Portal, DELETE indisponível | Editorial preserva Firebase; Portal revoga antes de signOut; falha mantém retry sem sucesso falso |
| NEWS-07 | Dashboard/News/categorias/paginação/vizinhos/deep link | IDs preservados; totais coerentes; histórico/foco/scroll e 503/retry sem fallback |
| NEWS-08 | Polls criar/publicar/votar/encerrar | SQL real, mesma escolha idempotente, outra 409, publicação concorrente, perda de resposta reconciliada |
| NEWS-09 | Snapshot A agendado + draft B, dois workers/restart | Snapshot correto, draft B preservado, efeitos únicos, cancel/retirada invalidam job antigo |
| NEWS-10 | Imagem/PDF/vídeo/Range e rich text | Bytes/hash/MIME, 206/416, retirada e URLs nativas/thumbnail/_next sem bypass; script não executa |

O RED original NEWS-04 permanece preservado. Se houver novo desenho aprovado,
usar suíte própria com seus oráculos, sem apagar evidência ou relaxar silenciosamente
o contrato pending bloqueado sem confirmação. Full-document não é solução aprovada
nem prova suficiente por si só.

## Editor CMS central — oito cenários adicionais

Todos em **NÃO EXECUTADO integrado**; oráculos definidos, execução browser real e
fixtures de áreas ainda pendentes. Base funcional: `public/cms.html` e `public/js/cms.js`.

| ID | Cenário nominal | Aceite esperado |
|---|---|---|
| HUB-01 | CMS central → seleção da área | knowledge/academy/academy_lesson/benefit/announcement/reminder filtrados pela capacidade; API nega acesso indevido |
| HUB-02 | Área → registro existente | `source_id` corresponde à entidade da área; exceção announcement; não criar entidade de domínio por suposição |
| HUB-03 | Registro → editar → salvar | Conteúdo associado ao registro certo; draft incompleto permitido; JSON editorial atômico preserva null e data civil; salvar não publica |
| HUB-04 | Salvar → prévia | Clássica embutida; Owner News Payload em outra aba da revisão salva; nada local pendente apresentado como persistido |
| HUB-05 | Publicar/agendar → leitor da área | Revisão/metadados/instante corretos, draft posterior isolado; Academy cobre descrição/materiais/capa, não confunde estrutura/ativação/player/progresso |
| HUB-06 | Trocar documento/área, menu, entrada Payload | Guard de dirty/upload/mutation; cancelar conserva contexto/inputs, não revoga; pending respeita contrato aprovado |
| HUB-07 | Histórico e mídia privada | Revisões/arquivos somente à capacidade da área; draft não vaza, referências compartilhadas preservadas |
| HUB-08 | Pós-cutover e destinos | Owner News legado read-only server-side; demais áreas operantes; distinguir retornar ao CMS central, ler News e sair; link específico não presumido existente |

## Regressões das áreas e dependências

| Área/gate | Oráculos mínimos | Estado |
|---|---|---|
| Knowledge | Leitura/busca/filtros/publicação e assets compartilhados | NÃO EXECUTADO integrado |
| Academy | Elegibilidade, materiais, player/progresso por conta; provedor real identificado separadamente | NÃO EXECUTADO integrado |
| Reminders | Audiência, agenda, histórico e cron continuam operantes; entrega externa não presumida | NÃO EXECUTADO integrado |
| Profile/Admin | Edição/foto; permissões, abas, listas e histórico de navegação | NÃO EXECUTADO integrado |
| AutoCard/Cards Pós | Flags DHO/superadmin, histórico; PNG AutoCard e imagem/PDF Cards Pós | NÃO EXECUTADO integrado |
| Benefícios | Rota preservada e gestão por capacidade, sem adicioná-la à navegação inicial | NÃO EXECUTADO integrado |
| Exportação/importação | IDs, conteúdo, null/proveniência, todas as revisões, bytes/hashes, retry/conflitos | NÃO EXECUTADO; contratos2–3 em integração |
| Autoridade | Prepare/reconcile/seal/activate; cron e escritor únicos; sem fallback; agenda suspensa/ator desconhecido explícitos | NÃO EXECUTADO; contrato4 em integração |
| Recuperação | Backup PortalDB+CMSDB+arquivos+staging/ledger, quiescência, restore isolado e rollback compatível | NÃO EXECUTADO; contrato5 em integração |

Não são parte deste piloto: migração das outras áreas, certificado/matrícula/quiz,
WhatsApp, estado lido/concluído de lembretes ou outras capacidades ausentes do
[inventário](../product/feature-inventory.md).

## Handoff comum e fechamento

Cada execução deve informar `scenarioId`, `documentId` separado quando aplicável,
responsável, SHA+diff, contrato, camada real/double, versões, comando sanitizado,
início/fim, exitCode/signal/timeout, esperado/observado, estado, logs/capturas
sanitizados e resultado de cleanup. Sem tokens/cookies/env/state/bundles privados.
Não sobrescrever falha histórica com log de retry.

Checks finais após integração: verify e build serializados, suíte real completa,
diff check e revisão independente do conjunto. Falta de implementação, FAIL e
NÃO EXECUTADO impedem declarar aceite integrado completo. Produção é gate distinto.
