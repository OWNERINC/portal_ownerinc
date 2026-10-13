# Payload native admin — aceite delimitado e evidência do Run 12

Atualização: 08/10/2026. **Estado: aceite técnico delimitado do Run 12 confirmado
pela sessão principal após revisão do conteúdo e verificação do checksum;
aceite visual continua pendente.** Run 11 permanece um
resultado observado, mas não é evidência aceita para a asserção de isolamento
Owner News descrita abaixo. Este registro não aceita o piloto, não autoriza
produção/cutover e não substitui as gates de migração, escrita, jobs ou recuperação.

## Escopo e fronteira

Aceite local delimitado da entrada administrativa geral do Payload, da sessão v2
do Portal e do isolamento contra leituras nativas de Owner News enquanto a
autoridade continua `legacy`. O único runtime exercitado foi o preview privado
isolado, em HTTPS local/loopback, projeto `ownerinc-payload-preview-d755db45c46d`.
O certificado local foi deliberadamente ignorado pelo cliente de teste; isto não
prova confiança em certificado público, segurança de hostname/proxy, implantação
ou prontidão de produção. O health/readiness local respondeu HTTP 200.

Não houve alteração de fonte da aplicação, instalação, build, rebuild, deploy,
apply de migration ou execução de `npm run verify` neste trabalho. O fluxo não
gravou conteúdo Owner News nem alterou autoridade: a asserção de ausência de
mutação passou, e autoridade/epoch permaneceram `legacy`/`1` antes e depois. A
entrada da área Owner News foi lida para exercitar sua UI. O teste selecionou
light/dark pelo controle nativo e usou o cookie de tema no contexto Playwright
isolado para as capturas; não observou requisição de escrita de preferências.
Sessão v2 e revogação de sessão foram exercitadas como parte do teste de login e
logout.

## Base e verificações offline

- Commit de aplicação/runtime declarado e confirmado no checkout:
  `b1b01230797be618bbde2fb97abaa179810ac411`.
- Imagem do preview: `sha256:505cf00f97324ef3fa6d8a55193fad4fb4c44418991be848a9ac81dd9015d8c2`.
- A sessão principal confirmou no log retido de `npm run verify`, pós-avatar:
  **1.678 PASS, 0 FAIL e 6 skips** (Portal: 1.349 PASS/3 skips;
  CMS: 329 PASS/3 skips; saída final `verify: ok`). Não houve reexecução
  dessa suíte durante o aceite de navegador.
- Verificações direcionadas desta correção: `node --check` do runner e collector
  Run 12 passou; fixtures offline do collector passaram **8/8**; fixtures do
  classificador estrito de logout passaram **13/13**. Um check estático confirmou
  os IDs do hub em `public/cms.html` e o controle/listeners em `public/js/cms.js`;
  `git diff --check` passou. GETs read-only ao login e readiness locais
  responderam HTTP 200.
- Nenhum check completo, build ou suíte real adicional foi executado além do
  único Run 12 autorizado.

## Correção do oráculo e tratamento do Run 11

A revisão independente do pacote copiado em
`docs/reviews/evidence/2026-10-08-native-admin-run11/` encontrou um defeito
substantivo no oráculo `legacy-News-entry-hidden` do Run 11: o hub ainda estava
em outra área, então `#owner-news-payload-entry` podia estar inicialmente oculto;
além disso, `.catch(() => true)` fazia um elemento ausente passar. O arquivo de
evidência e o relatório Run 11 foram preservados sem edição.

O runner Run 12, fora da fonte da aplicação, agora espera o controle real
`#content-types button` com rótulo Owner News ficar habilitado, clica nele pela
UI e aguarda a resposta GET da autoridade e o estado visível carregado. A
asserção exige simultaneamente: resposta da UI HTTP 200 com `mode=legacy` e
`epoch=1`; área Owner News efetivamente selecionada; seção/status de autoridade
presentes e visíveis com o estado de fonte anterior; e elemento
`#owner-news-payload-entry` existente, com atributo `hidden` e não visível. Não
há fallback de ausência para sucesso. A entrada administrativa geral permanece
uma asserção distinta.

## Resultado do Run 12

**PASS — 36/36 asserções; 0 FAIL; 0 não executadas.** O artefato privado
`artifacts-post-lock-fix-20261008-run12-b1b0123/browser-acceptance-report.json`
tem SHA-256
`73a770cefe6a2412835be063dbc8ed3399781d05cc779e5e77285422af5e2a74`.
O runner privado `post-lock-fix-run12.mjs` tem SHA-256
`67737dfff6fdaefd2bcf2456ec83b813ed3a01888cfc28a66d7dddcdabe86d84`; o collector
`run12-lifecycle-collector.mjs` tem SHA-256
`bbc369c06ced3f33e8adb9277730e92bff7719884be330319d6a90f0ada327ae`.
O resultado é evidência da execução delimitada, revisada conforme o handoff
abaixo; não transforma Run 11 em aceito nem apaga seus diagnósticos.

Resultados relevantes:

| Prova | Observado |
|---|---|
| Login e autoridade Owner News antes/depois | HTTP 200; `legacy`, epoch `1` |
| Oráculo UI legado corrigido | Owner News selecionada; seção/status de autoridade visíveis; link Payload existe e está oculto |
| Entrada administrativa geral | Visível separadamente no hub; sessão Payload v2 emitida |
| Home nativa | Heading esperado; nenhuma requisição de dashboard Owner News |
| Fence de acesso | Locks HTTP 200, vazio e sem identidade; tentativa de criação de lock com corpo vazio HTTP 403; artigos, versões, global, mídia e jobs negados ou vazios conforme contrato |
| Cookies/sessão | Cookie host-only seguro observado; logout real HTTP 204; cookie editorial limpo; probes com cookie revogado retornaram 401; sessão Firebase do Portal permaneceu ativa |
| Mutações e rede | Nenhuma mutação de conteúdo Owner News; nenhuma tentativa externa ou de Firebase de produção |
| Navegação | Reload, Back e Forward chegaram aos destinos esperados com Document HTTP 200 |
| Erros | Zero page errors; zero erros de console inesperados; zero falhas de request inesperadas |

Os oito erros de console observados foram apenas respostas negativas previstas
pelos probes (seis 403 de leitura/lock e dois 401 de cookie revogado). A única
falha de request foi o cancelamento restrito do DELETE de logout, aceito pelo
classificador somente após observar a revogação HTTP 204, navegação iniciada por
script e cancelamento `net::ERR_ABORTED` da **mesma request univocamente
correlacionada**. Não foi adicionada uma exceção geral para aborts ou GETs. Não
houve cleanup direto necessário.

## Ciclo de requests e incerteza residual

O collector acompanhou 351 requests Playwright e 351 eventos CDP. As correlações
foram 185 únicas, 166 ambíguas e zero sem correspondência. IDs candidatos
ambíguos foram mantidos como candidatos; nenhum ID foi inferido. A captura de
aceite ocorreu com o contexto vivo. Um inventário calculado por estado de
terminal, sem contagem ou caminhos hardcoded, registra requests sem
`requestfinished`/`requestfailed` no Playwright e sem
`loadingFinished`/`loadingFailed` no CDP. A fronteira de aceite continha 12
registros pendentes em cada canal; os dois canais podem representar a mesma
request lógica, não 24 requests distintas. A captura final após teardown continha
11 em cada canal; a consulta de perfil Firebase que ainda estava pendente na
fronteira recebeu evento terminal entre as capturas.

Inventário Playwright da fronteira de aceite (sem IDs de request):

| Fase | Método e path | HTTP observado | Estado na fronteira | Correlação |
|---|---|---:|---|---|
| login | GET `/api/users/me` | 200 | resposta sem evento terminal | única |
| hub | GET `/js/owner-news/content-contract.js` | — | sem resposta/evento terminal | ambígua, 2 candidatos |
| hub | GET `/api/users/me` | — | sem resposta/evento terminal | ambígua, 2 candidatos |
| read-probes | GET `/editorial/api/news-articles` | 403 | resposta sem evento terminal | única |
| read-probes | GET `/editorial/api/news-articles/versions` | 403 | resposta sem evento terminal | única |
| read-probes | GET `/editorial/api/globals/news-home` | 403 | resposta sem evento terminal | única |
| read-probes | GET `/editorial/api/news-media` | 403 | resposta sem evento terminal | única |
| read-probes | GET `/editorial/api/payload-jobs` | 403 | resposta sem evento terminal | única |
| negative-lock-create | POST `/editorial/api/payload-locked-documents` | 403 | resposta sem evento terminal | única |
| revoked-cookie-check | GET `/api/cms/v2/session` | 401 | resposta sem evento terminal | única |
| revoked-cookie-check | GET `/editorial/api/portal-editors/me` | 401 | resposta sem evento terminal | única |
| firebase-retained-check | GET `/api/users/me` | 200 | resposta sem evento terminal na fronteira; terminal antes da captura final | única |

As respostas 401/403 acima tiveram status HTTP observado e esperado; a ausência
do evento terminal é uma lacuna de lifecycle, não uma falha de request. Os dois
GETs do hub continuam sem resposta e com mapeamento ambíguo; requests posteriores
da mesma área não são usados para atribuir seus IDs. Não se declara que toda a
rede terminou. O inventário completo, correlações candidatas e eventos sanitizados
estão no relatório privado Run 12.

## Capturas visuais e histórico

Quatro capturas distintas de home nativa light/dark, desktop/mobile foram
verificadas por hash no artefato privado; não foram copiadas para o repositório.
Os nomes e SHA-256 são:

| Arquivo | SHA-256 |
|---|---|
| `native-home-desktop-light.png` | `48128f1ada1f1ccd48fd98c35aa9af83bb393fa737861bbdb22edc3a939fd420` |
| `native-home-mobile-light.png` | `418d947dd503236b439378ca65c1bbe3b364f8854f2a1aef5b02927ee1e91ead` |
| `native-home-desktop-dark.png` | `02fe5057c47cf4f7c58085689d7cced2331e27ff044c401f33258c326554f9ca` |
| `native-home-mobile-dark.png` | `6afd43697e4fdc8eb756ef1e22d27e342f7c8021a3e4c84cdb5a21c4b1106dfb` |

O avatar nativo SVG e ausência de tentativa Gravatar passaram. As telas confirmam
somente a renderização/captura automatizada no preview; **aprovação visual do
usuário continua pendente**.

Run 9 e Run 10 continuam como FAILs históricos preservados. Run 9: 35 PASS/1
FAIL; relatório SHA-256
`3acf79b2a68bc00e8f14d9701a787c8ad63ee7be1d55be33bde3a6ade8c75d32`. Run 10:
35 PASS/1 FAIL; relatório SHA-256
`705f054e8166f5e188b2fbb7a35e590a3ec4b7d69cd4f7cabe7a7be185f24518`. Run 11
continua imutável com status observado 36 PASS e SHA-256
`655a415feb4cf1910f138bd61b4f0f211bd7632eca2e3e81db4e1f164ebc95d8`, mas sua
asserção vacuosa não serve como prova de isolamento Owner News. No Run 12, Reload,
Back e Forward retornaram 200; a falha histórica GET `/editorial/admin` de Run 10
não recorreu. Sua causa retrospectiva permanece **não confirmada**.

Correções confirmadas que compõem a base examinada incluem o escopo vazio de
locks para o ator genérico restrito (`cd02ed8`) e o tratamento fail-closed de
status de autenticação REST que Payload pode concatenar entre estratégias
(`42b5546`). O seletor de tema foi corrigido no harness para escolher controles
nativos reais; não é correção de defeito da aplicação. A instrumentação de
histórico acrescenta diagnóstico, mas não prova a causa do abort histórico.

## Gates que permanecem separadas

Este aceite não afirma que todas as áreas do CMS estão concluídas: a home nativa
é informativa e não consulta Owner News. Também não cobre CRUD Owner News, escrita
ou publicação, jobs, mídia de migração, agenda pós-cutover, Sólides, nem o 502 de
`/editorial/admin` em ambiente de produção; o preview local não diagnostica esse
502.

As gates de migração continuam bloqueadas e independentes. O finalizador nativo
existe em `cms/scripts/finalize-news-protocol.ts`; seu aceite anterior de
instalação não comprova operações nativas nem ativação: ele retorna
`ready: false` e `coverageVersion: 0`. A integração operacional protegida e a
comprovação de readiness/coverage permanecem pendentes. Continuam necessários aceite separado de
writes/jobs nativos, instrumentação e selo durável de run/manifesto/epoch em
`frozen`, finalização/drain, prova durável pela autoridade primária, writer por
unidade documental com auditoria, reconciliação real do destino, registro staged
de mídia, materialização de agendas suspensas e evidência de rollback/COMMIT
perdido/Linux. Nada neste teste aplica migration, altera autoridade ou ativa
Payload para leitores reais.

## Handoff de revisão

O achado **FIX-FIRST** do Run 11 foi corrigido no harness privado e o Run 12
passou. A revisão independente confirmou a consistência do oráculo corrigido,
das 36 asserções e da sequência correlacionada de logout. Seu último parecer
permaneceu **fix-first** exclusivamente porque a ferramenta de checksum estava
bloqueada para o revisor. A sessão principal resolveu essa pendência: recalculou
o SHA-256 do relatório copiado com Node `crypto` e, separadamente, PowerShell
`Get-FileHash`; ambos retornaram o digest registrado acima. Essa confirmação é da
sessão principal, não uma execução atribuída ao revisor. Com isso, a sessão
principal aceita apenas o escopo técnico delimitado descrito neste documento.
O pacote revisado está em
`docs/reviews/evidence/2026-10-08-native-admin-run12/`; o scanner de segredos passou.
As capturas continuam aguardando aprovação visual do usuário. O pacote
`docs/reviews/evidence/2026-10-08-native-admin-run11/` foi tratado como evidência
de propriedade da sessão principal e não foi alterado.
