# Portal — evidência de conclusão em andamento (2026-11-02)

## Estado e escopo

Execução da cadeia OWN-23 → OWN-32 → OWN-33 → OWN-28 → OWN-35 → OWN-24 →
OWN-25 → OWN-26 → OWN-31 → OWN-34. Este registro não é aceite de produção.
As correções estão na branch `fix/portal-final-acceptance`, ainda sem candidato
final qualificado para os novos bytes. Planejamento, decisões e implementação
delegados a Astra xhigh por solicitação do usuário.

O candidato histórico `a7b7f35792ca5c7b3f5db82094f406b56912ba70` permanece
evidência histórica. Mudanças no PDF, workflow e preparação exigem nova
qualificação e bindings correspondentes antes de uso operacional.

## Verificações executadas antes da conclusão da barreira B0

| Verificação | Resultado observado | Limite da evidência |
|---|---|---|
| PDF e suites relacionadas | 159 aprovados, zero falhas/skips | HTTP multipart real; persistência e identidade dobradas |
| CI/preparação/operações focados | 94 aprovados, seis skips | Skips nativos não provam Linux/root |
| `npm run verify` | 2.092 aprovados, duas falhas, 32 skips na suíte raiz | Duas falhas por timeout Bash no Windows; execução integral não aprovada |
| Repetição isolada `payload-operations.test.mjs` | 20 aprovados, zero falhas/skips, 124,1 s | Timeout anterior não reproduzido; não substitui novo verify integral |
| `npm run test:cms` | 477 aprovados, zero falhas, 11 skips | PGlite opcional e capacidades Linux indisponíveis nesta execução Windows |
| `npm run typecheck:cms` | PASS | Offline; não valida runtime produtivo |
| `CMS_BUILD_ONLY=true npm --prefix cms run build` | PASS | Build com entradas sintéticas, sem inicialização produtiva |
| `npm run security` | PASS no threshold high | API: um advisory moderado qs; cron: zero; CMS: oito baixos na cadeia deepmerge/Payload |

O build reportou warning de tracing de filesystem dinâmico em
`cms/src/migration/staging.ts:125`. Compilação, TypeScript e geração das páginas
concluíram. O warning não é evidência de exposição de conteúdo ou falha de runtime.

Esses resultados precedem a conclusão da barreira B0. A barreira requer testes
próprios, revisão fresca e qualificação nativa positiva capture/accept/resume.

### Segunda execução integral e revisão da barreira

A segunda execução de `npm run verify`, com o pacote B0 em revisão, terminou na
suíte raiz com **2.099 PASS, quatro FAIL, 33 SKIP**. Duas falhas detectaram novos
erros B0 ausentes nas allowlists finitas de diagnóstico; outra detectou um
extrator de teste ainda preso à assinatura anterior do initializer. A quarta
foi o timeout de 15 segundos do subprocesso Bash do fixture de operações no
Windows. Nenhuma dessas falhas foi ignorada: correções delimitadas estão em
andamento, preservando as invariantes e os limites produtivos.

A revisão independente Astra xhigh retornou **fix-first** por dois findings
High: correspondência incompleta entre inputs de retomada e receipt protegido;
reparo de head interrompido antes da conferência da identidade assinada do
lease. Ambos foram confirmados por leitura primária e encaminhados para
correção/testes adversariais. Esse pacote permanece sem aprovação de revisão e
sem qualificação Linux/root até nova evidência.

A revisão de retorno encerrou os dois findings com veredito **ship** para o
pacote B0 delimitado: `payload-resume-v3` vincula os 19 campos ao registro
autenticado antes de reparar/publicar, e o callback de reparo compara o lease
assinado com FD9 e pathname. O revisor inspecionou o source, mas não pôde executar
shell; os **120 PASS / 11 platform skips** são do implementador. A qualificação
Linux/root e o verify integrado continuam necessários. O CMS editorial segue em
implementação separada e não foi abrangido por essa revisão.

As três regressões de diagnóstico/extração foram corrigidas e repetidas pelo
primário: **29 PASS, zero FAIL, zero SKIP** nas três suites afetadas, incluindo
negações de códigos desconhecidos, contexto/action/frame inválidos e preservação
da ordem B0/grants/provisioning. O check Compose envolvido usa somente parser
CLI, sem contatar/iniciar serviços. O fixture Bash recebeu orçamento externo de
45 s somente no Windows (Linux continua 15 s); o implementador repetiu seus
20 testes com zero falhas/skips, e o primário conferiu o diff. Limites operacionais
produtivos não foram alterados. O próximo verify integral ainda é necessário.

### Pacote B0 estabilizado — verify integral aprovado

O snapshot delimitado B0/PDF/qs/diagnósticos foi verificado em checkout temporário
separado, com os mesmos locks e diretórios de dependências instaladas. O source
editorial, a recuperação pré-floor e os demais pacotes em implementação não
integram esse snapshot. Árvore Git verificada:
`21215e73000780d7603e62d16f35cabd505e3ce8`.

Após fixar a fixture histórica do receiver nos bytes de SHA-256
`7a5da50bbb36a6d0f95c66898e0c4e12bc0ba319fd7dd8d4ccbd4aac8c3ea2db`, sem mudar
o hash autorizado pelo instalador, `npm run verify` terminou com **PASS**:

- Suíte raiz: **2.109 PASS, zero FAIL, 33 SKIP**.
- CMS offline: **477 PASS, zero FAIL, 11 SKIP**.
- Sintaxe, typecheck CMS, scanner de segredos, nomenclatura e validação Compose:
  concluídos; nenhum serviço Docker foi iniciado.
- Nova negação confirma que o receiver atual com o path histórico não é um
  predecessor aprovado.

A revisão B0 permanece `ship`. Os skips Linux/root e PGlite são limitações
declaradas; CI nativo ainda é obrigatório. Esse PASS não se estende aos arquivos
concorrentes nem estabelece instalação ou restore produtivos.

### Remediação posterior de qs

O lock da API foi atualizado de `qs@6.16.0` para `6.16.2`, mantendo o manifest e
as demais entradas do lock. A revisão primária confirmou o diff de três campos
e repetiu os testes de dependências API e do advisory: **19 PASS, zero FAIL,
zero SKIP**. O implementador registrou RED/GREEN das quatro regressões e audit
de produção da API com zero findings. Detalhes, fontes e distinção dos advisories
opcionais estão em [Dependências](2026-11-02-dependency-advisories.md).

A fonte oficial CVE foi consultada também pelo primário e confirma
`CVE-2026-93753` como `REJECTED`. O feed residual npm/GitHub continua documentado;
não houve downgrade, override ou supressão do Payload.

### SBOMs locais

`npm run sbom` concluiu após a atualização do lock. Os três documentos foram
abertos e validados como JSON SPDX-2.3; API contém `qs@6.16.2`.

| Documento local | Pacotes | SHA-256 dos bytes gerados |
|---|---:|---|
| `api.spdx.json` | 316 | `a52d5ab3713b268af28a4ac48ef0a56d2bfc680bb5fdbe708c624e2c37b41941` |
| `cron.spdx.json` | 18 | `465d266b88ed7128f2c95e9da65346e63ececa725d38137aa0365c0ee0423020` |
| `cms.spdx.json` | 443 | `74319d6b223713ec1f52f53981c5b993d45beec7b173273112743f44cd9e5050` |

São inventários locais dos locks, não SBOMs das futuras imagens qualificadas.
IDs, digests e scans das imagens do candidato final continuam pendentes.

## Baseline produtivo observado por leitura

Observação do host em `2026-11-02T21:18:24Z`:

- Release apontada: `b573a3d900c823a700c167878717bb7534bef500`.
- Policy SHA-256: `bfd564a5e8c3e99badacdafe47a85daee4aa07b6ca3f576031915821e2216aa0`.
- Registry de candidatos: zero registros; launcher autenticado ainda ausente.
- Receiver legado `/usr/local/libexec/ownerinc-portal-deploy` presente, regular,
  root-owned `0755`. Wrapper produtivo Payload, receiver/helper novo, launcher,
  guard Gate E e fragmento sudo Payload ainda ausentes nos paths previstos.
- Usuário `deploy` observado com UID/GID 1000; nenhum usuário cujo nome contenha
  `payload` ou `cutover` encontrado. Essa busca não demonstra separação de
  identidades nem transporte SSH não-root efetivamente qualificado.
- API, cron e PostgreSQL reportaram healthy; Nginx running.
- Espaço livre observado: aproximadamente 66,84 GiB.
- HTTPS `/api/health`: 200, JSON `status=ok`.
- HTTPS `/api/ready`: 200, JSON `status=ready`.

O Nginx legado observado ainda responde `/editorial` com 308 para
`/editorial/admin`, e `/editorial/ready` com 502. A inspeção read-only de `nginx -T`
confirmou o proxy legado amplo para `/editorial/`, com CMS ausente. Portanto,
**não há evidência de rota privada moderna instalada nem de Gate D concluído**.
O status 200 HTML de `/health` ou `/ready` fora de `/api` não é prova de saúde da
API e foi descartado como oracle.

Não houve rotação, preparação aplicada, instalação, promoção de rota ou cutover
nesta rodada. Essa observação de baseline não aprova source, restore ou aceitação.

Consulta read-only de systemd também encontrou o timer de backup ativo, último
disparo em `2026-11-02 06:00:00 UTC`, próximo em `2026-11-03 06:00:00 UTC`; o
serviço reportou `Result=success`, `ExecMainStatus=0`. O timer de renovação do
certificado está ativo. Esses estados não verificam conteúdo/restore dos backups,
entrega de alertas ou recuperação coordenada do futuro CMS.

## Dependências externas verificadas

A conta GitHub disponível continua com `push=true`, `admin=false`,
`maintain=false`. A API lista apenas `production` e `staging`, sem
`protection_rules`. Os Environments `payload-cutover-preflight` e
`payload-cutover-activation` estão ausentes. Registrado em OWN-23, comentário
`311ffcc2-4387-4967-90a3-4fc78dd96116`.

Não foi obtida permissão para configurar esses controles com a conta atual.
Autorizações conversacionais não substituem a configuração nem os approvals
autenticados previstos nos workflows.

## Critérios de fechamento ainda pendentes

- Barreira B0 completamente testada e revisada; novo candidato e closure.
- Preparação protegida, transporte não-root e Environments de OWN-23.
- B0 exato restaurado/qualificado, evidência privada e aceite posterior previsto.
- Instalação privada e B1 recuperável, vinculados ao candidato final.
- Rota e jornadas reais de admin, editor e leitor independente.
- Gate E com identidades, approvals e deadline próprios; autoridade observada.
- Handoff com SHA/digests/receipts reais, responsáveis e alertas definidos.

Nenhum desses critérios será fechado por fixtures, geração de um documento,
aprovação antecipada de evidência inexistente ou apenas por testes offline.
