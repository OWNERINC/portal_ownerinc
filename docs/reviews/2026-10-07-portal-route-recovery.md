# Aceite — recuperação das rotas do Portal

## Base e escopo

- Base implantada auditada: `11c3bc0abd58f10d4318554616733c59d70018cd`.
- Branch de correção: `fix/portal-route-recovery`.
- Inventário: 18 arquivos HTML, 72 módulos JS/MJS e 13 arquivos CSS públicos.
- Este aceite cobre entrega estática, montagem das páginas, navegação e estados de
  disponibilidade. Não substitui o aceite de migração/ativação do Payload.

## Diagnóstico anterior à correção

| Cenário | Evidência |
|---|---|
| Dashboard, Knowledge, Lembretes, Academy, Owner News, CMS, prévia editorial e Benefícios | Falha de importação reproduzida no navegador: `asset-path.mjs` servido como `application/octet-stream` com HTTP 200 |
| Botão Abrir Editor CMS no Admin | Destino correto; importação falha e página anterior é preservada |
| Admin, Perfil, AutoCard, Cards Pós | Abertura observada; operações de gravação não exercitadas |
| Entrada editorial | Página abre; destino `/editorial/admin` retorna 502 |
| `/editorial` | HTTP 308 com destino absoluto HTTP em acesso HTTPS |
| Sólides | Erro genérico observado; causa autenticada específica ainda não confirmada |
| URL HTML inexistente | Fallback para HTML inicial com HTTP 200 |
| Health/readiness da API | HTTP 200; estados `ok` e `ready` |

## Gates

| Gate | Estado |
|---|---|
| 0 — baseline e propriedade dos arquivos | Concluído; checkout limpo antes de criar a branch |
| Preparação do aceite | Concluída por análise somente leitura; Nginx real necessário |
| 1 — implementação e testes focados | Concluído |
| 2 — revisão independente do diff | PASS: frentes e revisão integrada final aprovadas |
| 3 — verify e aceite Nginx/browser integrado | PASS local: verify, Nginx nativo e browser completo |
| 4 — PR e CI | Pendente |
| 5 — autorização e verificação pós-deploy | Pendente; sem autorização de merge/deploy desta correção |

## Ambiente de aceite previsto

Nginx Linux isolado, com `public/` e a configuração real montados somente para
leitura. Identidade e APIs do navegador usam fixtures sintéticas em memória.
Não reutilizar bancos, mídia ou launchers Task9. Aceite de montagem exige conteúdo
de fixture visível, além de ausência de falhas de módulos; headings estáticos e
HTTP 200 isolados não bastam. Identidade sintética não comprova Firebase real nem
autorização da API de produção.

O daemon Docker respondeu e a imagem Nginx fixada no Compose está disponível
localmente. Essa inspeção não iniciou containers nem comprova o aceite runtime.

## Entregas parciais

### Navegação e Sólides

- Implementador informou 46 testes focados aprovados, além de `node --check` e
  `git diff --check` aprovados.
- Escopo entregue: estado acessível de carregamento, mensagens por categoria de
  erro, preservação da página e retry do destino solicitado; tratamento distinto
  de vínculo ausente, 404, 401, 403 e 503 em Sólides.
- Revisão independente: **APPROVE**, sem bloqueios. O revisor executou 34/34
  testes em `persistent-navigation.test.mjs` e `solides-route-recovery.test.mjs`.
  O conjunto do revisor é um recorte dos checks focados do implementador; não
  somar essas contagens como testes distintos.
- Não há diagnóstico autenticado da causa operacional de Sólides em produção.
  Nenhuma ativação foi realizada. Aceite de navegador continua pendente.

### Entrada Payload

- Implementador informou 55 testes focados aprovados, além dos checks de sintaxe
  e whitespace do escopo.
- API autenticada de disponibilidade combina autoridade atual e readiness interna;
  a interface reconsulta antes da entrada e o servidor antes de emitir sessão.
- Revisão independente: **BLOCKED**. Ausência dos secrets opcionais da bridge
  fazia a disponibilidade retornar 503 e a interface apagar a autoridade legada,
  bloqueando a edição de Owner News no Portal sem overlay Payload. Correção
  devolvida ao implementador, com regressão exigida para bridge ausente e
  preservação da autoridade real. Os 44/44 testes executados pelo revisor não
  cobriam esse cenário; passar esses testes não libera o gate.
- Correção entregue pelo implementador: autoridade consultada independentemente
  da disponibilidade opcional; legacy confirmado preserva edição quando só o
  runtime falha, autoridade ausente/conflitante fecha a edição e os modos Payload
  não recuam para legacy. Disponibilidade autenticada não depende da configuração
  de cookies/secrets da sessão opcional. **56 testes focados PASS informados**;
  re-revisão independente **APPROVE**, com 45/45 testes do recorte revisado.
  Revisor confirmou que somente GET availability dispensa a configuração opcional,
  autenticação/permissão continuam obrigatórias e emissão de sessão permanece
  protegida. A autoridade de escrita segue validada no lock de mutação do CMS.
- A causa operacional do 502 público permanece não diagnosticada. Readiness do
  serviço interno não comprova entrega pelo ingresso/Nginx, renderização ou
  autenticação em produção. Não houve ativação, cutover ou alteração de serviços.

### Runner dedicado de navegador

- Entregues `scripts/test-route-recovery-browser.mjs`, fixtures em memória e
  quatro testes de guardas aprovados pelo implementador. Sintaxe também aprovada.
- Revisão independente iniciada; ainda não executado contra Nginx/browser.
- Playwright 1.62.1 e seu executável Chromium foram localizados no cache local;
  nenhuma dependência foi instalada. Navegador Windows contra Nginx Linux deve
  ser identificado como tal na evidência, sem alegar execução de browser Linux.

### Nginx e entrega estática

- Implementador informou 29 testes focados aprovados e um skip de Nginx nativo no
  Windows; revisão independente em andamento.
- Orquestrador executou `nginx -t` na imagem Linux fixada: aprovado.
- Probes HTTP no Nginx isolado `127.0.0.1:52077`: `.mjs` servido como
  `application/javascript`, `no-cache` e `nosniff`; CMS/alias AutoCard HTTP 200;
  HTML/MJS ausentes HTTP 404; `/editorial` HTTP 308 com Location relativo.
- Teste `nginx-route-delivery.test.mjs` executado em container descartável da
  mesma imagem com Node 24.18.1: **1/1 PASS, zero skips**. Inclui proxies locais
  sintéticos API/CMS, headers e 14 rotas diretas. Checkout montado somente leitura.
- CI passa a executar esse teste explicitamente na imagem Nginx de produção,
  evitando depender de um binário Nginx opcional no runner host.
- Browser permanece pendente: revisão do runner bloqueou variantes codificadas
  de URL, fixture impossível, cleanup não limitado e comparação insuficiente dos
  corpos estáticos. Correções devolvidas ao implementador antes de execução.
- Runner corrigido entregue com oito testes focados aprovados pelo implementador;
  re-revisão independente **APPROVE**, oito testes executados pelo revisor.
- Primeira execução real de browser pelo orquestrador: **FAIL**, timeout de 20s
  aguardando `Synthetic Knowledge Fixture` em `#articles-list`. Não equivale a
  sucesso das oito rotas. Diagnóstico delegado ao implementador do runner com
  lease exclusivo do browser sintético no Nginx isolado; causa ainda pendente.
- Revisão Nginx/smoke bloqueou inferência de 404 por corpo vazio (200 vazio podia
  passar) e apontou precedência do deny de arquivos ocultos. Ajustes devolvidos ao
  implementador. O alerta sobre ausência do gate Nginx no CI foi baseado no estado
  anterior à edição da orquestração: a etapa dedicada está agora presente, com
  `command -v nginx` obrigatório antes do teste. Aceite nativo será repetido após
  a correção de precedência; resultado anterior é parcial, não aprovação final.
- Re-revisão Nginx/smoke/CI: **APPROVE** por inspeção, sem runtime pelo revisor.
- Rerun nativo após fixture oculta: **FAIL** ao aguardar resposta 200 do Nginx.
  A nova raiz estática está sob `mkdtemp`; hipótese de acesso do worker ao diretório
  temporário devolvida ao implementador para diagnóstico Linux real. Não declarar
  aceite concluído com o PASS da versão anterior.
- Orquestração adicionou etapa Chromium/Nginx ao CI, com Playwright 1.62.1
  instalado em diretório temporário do runner, mounts somente leitura, readiness
  HTTP limitada e cleanup do container exclusivo. Revisão dessa etapa adicional
  e execução do CI permanecem pendentes.
- Implementador corrigiu permissões de travessia somente da raiz temporária e
  direcionou stderr/log de falha do Nginx para diagnóstico. Executou a versão
  corrigida na imagem Linux fixada, Node 24.18.1: **1 PASS, 0 FAIL, 0 SKIP**.
  Container descartável `ownerinc-route-native-worker-20261007` removido via
  `--rm`; runtime de browser preservado. Suite focada: 31 PASS, 1 skip Windows
  coberto pela execução Linux. Revisão final desse delta e CI browser: **APPROVE**.

### Verificação integrada

- Primeiro `npm run verify`: **FAIL**, dois testes de contrato em
  `cms-routes.test.mjs` e `operations-invariants.test.mjs` não reconheceram a
  nova regra genérica `^~ /api/`. Ajustes delegados preservando verificações de
  prioridade e limite de upload; nenhum teste foi removido.
- Ajustes dos dois contratos entregues: validação de `^~`/prefixo mais específico,
  limites isolados, MIME/cache MJS e herança de headers. **48 PASS, 0 FAIL, 0 SKIP**
  informados pelo implementador; revisão independente pendente. Nginx não mudou.
- Diagnóstico de Knowledge encerrado: fixture usava envelope em vez do array da
  API real. Ajustados também locator duplicado Academy, totais de paginação e
  classificação estrita dos fallbacks de imagem bloqueados, com nove guardas PASS.
  Revisão independente do delta do runner iniciada.
- Rodada seguinte do runner: montagem sintética de Dashboard, Knowledge,
  Lembretes, Academy, Owner News e prévia editorial passou antes de falhar em
  Benefícios. Diagnóstico identificou defeito de produto: `const categories`
  sombreia a variável externa e causa ReferenceError em `loadBenefits`.
  Correção delegada ao implementador frontend com regressão exigida. CMS/histórico
  e cenários seguintes não foram alcançados; ainda não há aceite final.
- Lease de browser liberado; orquestrador validou `nginx -t` e recarregou apenas
  o container isolado de QA com a configuração final de bloqueio de ocultos.

## Aceite de navegador integrado — PASS local

Após corrigir Benefits (renomear o mapa local para `benefitsByCategory`), revisão
independente aprovou a alteração e executou 27/27 testes focados. O orquestrador
executou novamente o runner completo contra Nginx Linux e Chromium Windows:

- 18 HTML, 72 JS/MJS e 13 CSS: GET e comparação byte a byte aprovados.
- Oito rotas diagnosticadas mais Admin montadas com conteúdo de fixture real.
- Admin → CMS → Back → Forward preservou o documento; reload recriou bootstrap.
- Sólides vinculado/não vinculado e entrada editorial indisponível aprovados.
- 58 requests API de fixture, 30 stubs SDK Firebase, 11 respostas MJS reais.
- Cinco recusas esperadas, incluindo um fallback de imagem externo bloqueado.
- Zero escritas API, APIs desconhecidas, requests externos não allowlisted,
  caminhos não canônicos ou erros de browser não tratados.

Verify seguinte teve uma falha em teste de cleanup extraído do CMS: o contexto VM
antigo não declarava `newsAuthorityRequest`. Ajuste de fixture delegado, exigindo
asserção da invalidação do contador no cleanup. Gate verify continua aberto.

## Consolidação local

- Fixture de cleanup corrigida, com asserção de invalidação do token pendente;
  29 testes focados aprovados pelo implementador.
- Reexecução integrada pelo orquestrador: **verify: ok**, 1.309 Portal + 314 CMS
  = **1.623 PASS, 0 FAIL, 6 SKIP**. Inclui typecheck, sintaxe, scanner e Compose.
  O skip Nginx do host Windows é coberto pelo teste Linux separado descrito acima;
  os demais skips não são promovidos a PASS.
- Revisões independentes de todas as frentes e revisão integrada final por novo
  revisor **APPROVE**, sem bloqueios no diff. Revisor não repetiu runtime; o verify
  verde foi executado pelo orquestrador. Resultados anteriores são cronológicos,
  não o estado final quando superados pela consolidação.
- Container isolado `ownerinc-route-qa-20261007-a` encerrado e removido pelo
  orquestrador após liberar o browser. Containers/bancos anteriores preservados.
- PR/CI, autorização de merge/deploy e aceite público pós-deploy ainda pendentes.
