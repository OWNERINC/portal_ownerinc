# Owner News — autoridade legada e controle parcial (Task12)

Esta entrega implementa os guards da API, não autoriza cutover. Novo deploy ou
cutover remoto exige autorização explícita do usuário. Migração/seal, prova de
freeze CMS e ativação de agendas dependem da integração das Tasks10/11/12/13.

## Fonte e escritores

| Modo | Leitura Owner News | Escrita normal |
|---|---|---|
| legacy | Legado | Legado |
| frozen | Legado | Nenhuma |
| payload | Payload | Payload |
| payload_frozen | Payload | Nenhuma |

O backend não faz fallback para legado se Payload falhar. A API consulta a
autoridade corrente, sem cache duradouro. Ausência de autoridade falha fechada.

Rotas de criação, draft, publicação, agenda, cancelamento, retirada e exclusão de
revisão announcement consultam autoridade dentro da transação, depois do lock
7193029 e antes dos locks de documento/revisão. Home usa o mesmo protocolo nos
helpers, também quando chamados fora do router. A transação é do chamador.
Mutação explícita bloqueada devolve409/news_read_only. Os dois importadores
legados recebem o mesmo bloqueio antes de escrever arquivos ou registros.

O promotor pula announcement fora de legacy ANTES de validar/promover/arquivar
agendas. Chamadas de leitura em frozen continuam funcionando. O cron sem filtro
continua outras áreas e usa somente SELECT na autoridade sob7193029. É necessário
copiar api/owner-news/authority.js na imagem cron; não conceder UPDATE ao cron.

Referências legadas de notícia continuam retendo os arquivos. Em payload e
payload_frozen elas não concedem leitura por /api/cms/assets/:id, nem mesmo por
um grant de editor legado. Grants independentes válidos de Knowledge/Academy e
outras áreas continuam funcionando; a leitura de notícia usa o endpoint próprio
da fonte ativa. Assets referenciados não podem ser removidos; a API não oferece
substituição de bytes/metadados de um asset existente. Upload novo independente
continua permitido. Respostas de arquivos legados usam private,no-store.

## CLI parcial / CAS

`scripts/owner-news-payload/cutover.mjs` aceita os seis nomes do plano e exige
`--epoch N`. O padrão apenas retorna o plano, sem conectar ao banco; não é um
check de readiness. Exemplo sintético sem mutação:

```sh
node scripts/owner-news-payload/cutover.mjs freeze-legacy --epoch 1
```

Execução explícita usa `--apply`, OWNER_NEWS_CONTROL_DATABASE_URL e
OWNER_NEWS_ACTOR_UID fornecidos privadamente. Não carrega .env nem usa DATABASE_URL
implicitamente. Ator precisa existir, estar habilitado e ter permissão editorial.
Não registra connection string ou erros internos. Não executar contra produção
com base nesta documentação.

Freeze/unfreeze legado e freeze/resume Payload têm CAS(mode,epoch), incremento
monotônico, auditoria na mesma transação e lock_timeout5s. Resposta de COMMIT
perdida é commit_outcome_unknown, sem retry automático. Freeze Payload retorna
cmsDrainConfirmed:false: fecha admissão no Portal, mas não alega drenagem do CMS.

**activate-payload e rollback-before-edit falham com news_cutover_proof_required**
nesta entrega, inclusive se alguém fornecer um objeto proof/hash/boolean ao
helper. Ainda não existe ligação ao ledger durável e fingerprint final de origem;
um arquivo JSON alegando reconciliação não substitui essa ligação.

## Integração ainda necessária

Preparação autorizada somente em frozen, vinculada a run/manifesto/epoch no ledger
real. Seal fecha esse run sob7194030. Nenhuma transação Portal pode esperar o CMS.
Parar ingressos/worker/import/manutenção e confirmar fim da finalização de jobs
nativos precede a prova de drain; o lock CMS sozinho não congela esses efeitos.

Agendas importadas ficam suspensas. Somente após autoridade payload e epoch/run
selado confirmados, materialização de queue+activation record compõe uma única
transação CMS idempotente. Agenda vencida aguarda decisão explícita; ator ausente
nunca é inferido. Exceções pendentes impedem aceite integral do cutover.

Rollback-before-edit exige ledger completo SEM qualquer mutação após baseline,
incluindo autosave, restauração, mídia, home, jobs/imports e editar-e-desfazer;
igualdade de hashes não basta. Após edição, recuperar aplicação compatível ou
backup coordenado PortalDB+CMSDB+uploads legados+mídia/staging/ledger CMS, mantendo
Payload como fonte. Preserve estado atual antes de restauração.

## Evidência

Os testes unitários/Express com doubles exercitam negações, ordem dos locks,
promotor seletivo, grants compartilhados, CAS e erro de COMMIT. Não comprovam
concorrência PostgreSQL, runner nativo, snapshot de filesystem, restore ou aceite
de produção. Essas provas e verify/build integrados pertencem ao coordenador.
