# OWN-41 — Domínios mantidos sem CMS

## Objetivo

Corrigir o candidato `730cbd6` sem reescrever seu histórico, mantendo Knowledge,
Benefits, Reminders e Academy funcionais com seus próprios campos, rotas e
contratos. O runtime dos quatro domínios não pode consultar `cms_documents`,
`cms_revisions` ou `cms_assets`, adquirir o advisory lock CMS `7193029`, usar
`/api/cms` ou depender do renderer/CSS compartilhado do CMS.

O CMS, suas migrations, registros históricos, revisões, assets e uploads não
serão apagados, convertidos, sobrescritos ou usados como fallback ativo. O PDF
ativo será retirado por ausência de rota própria; a API rejeitará qualquer
tentativa de enviar campos PDF legados.

## Limites preservados

- `730cbd6` permanece ancestral; não haverá reset, rebase, force-push, alteração
  de default branch, banco remoto, produção, serviços, Docker ou emuladores.
- As fronteiras `api/`, `cron/`, `public/` e `nginx/` permanecem.
- Migrations, dados, arquivos históricos, quatro screenshots existentes e
  uploads operacionais permanecem intactos.
- OWN-42 não será iniciada nem desbloqueada por esta execução.
- Node runtime modificado continua compatível com Node 18; checks usam o
  ambiente local disponível.

## Arquitetura por domínio

### Knowledge

`api/routes/knowledge.js` continua responsável por CRUD, autenticação,
`manageKnowledge`, validação de título/categoria/content, busca, categoria,
paginação, `X-Total-Count`, auditoria e rollback. Antes de qualquer SQL ou
mutação, o payload que possuir `pdf_asset_id`, `pdf_title` ou campos PDF legados
será rejeitado com 400; não haverá descarte silencioso.

O frontend exibirá e editará somente texto próprio com DOM seguro. Serão
removidos input, preview, download, associação, promises, cleanup, foco,
close-guards e listeners de PDF, além de `content_blocks`, renderer e
`/api/cms`. DELETE de Knowledge afetará somente `knowledge_base`; operações de
texto não tocarão documentos, revisões ou assets históricos.

### Benefits

As rotas usarão exclusivamente `benefits` para listagem, categorias, filtros,
paginação, `all=true`, CRUD, autorização e auditoria. O frontend renderizará
`description` e `instructions` como texto seguro, sem CMS, renderer ou assets.
Benefits permanece fora da navegação inicial.

### Reminders e cron

API e cron usarão title/description próprios, sem promoção editorial, joins,
helpers ou lock CMS. Serão preservados audiência, datas civis, channels,
ledger, claim/idempotência, retries, reaper, heartbeat e a rechecagem
imediatamente anterior ao envio para active/data/channel/audiência/usuário.

`content_url` será uniforme em list/upcoming/detail/create/update e será null
para delivery órfã; nunca será gerado `reminder-null`. Dashboard e frontend
renderizarão description segura, sem `content_blocks`, renderer ou mensagem de
conteúdo publicado.

### Academy

O desacoplamento remove capa, materiais, publicação CMS, documentos e assets
CMS das leituras e mutações mantidas, mas preserva catálogo, currículo, player,
elegibilidade, preview administrativo, gestão, audiência por cargo, progresso
por UID, CAS/media_version, ativação jogável, limites concorrentes, reorder,
locks de linha curso→módulo→aula, rollback/auditoria e exclusões
transacionais. Descrição e mídia próprias continuam sendo a fonte ativa.

Nenhuma autorização será substituída por ocultação de frontend. O lifecycle
de player, progresso, navegação, foco, acessibilidade, abort, dispose e
respostas tardias continuará testado nos módulos reais.

## Evidência e testes

O contrato compartilhado será ampliado para executar rotas/CRUD, frontend,
Academy/progresso e cron através dos harnesses reais existentes. Instrumentação
de pool/client e `fetchAPI` falhará imediatamente ao observar SQL contendo
`cms_documents|cms_revisions|cms_assets`, o advisory lock `7193029` ou caminho
`/api/cms`. Cada cenário também exigirá pelo menos uma chamada ao domínio
próprio, evitando falso positivo por mock vazio ou regex isolada.

As provas cobrirão leitura e mutação, permissões, validação antes de SQL,
paginação/busca, auditoria/rollback, segurança de texto, audiência, datas,
delivery URL, ledger/retry/reaper/heartbeat, locks de domínio, concorrência,
reorder, limites, ativação, CAS/media_version, lifecycle e acessibilidade.

Serão restaurados ou reescritos os 56 casos introduzidos como skips por
`730cbd6`. Casos exclusivamente CMS removidos serão apagados somente quando
documentados no handoff; casos mistos serão adaptados para manter as garantias
de domínio. Não serão introduzidos `test.skip`, `todo`, `.only`, filtros de
runner ou reduções de glob.

RED será registrado por expectativa comportamental/SQL/HTTP/consumidor ou
skip, nunca por ENOENT. GREEN será demonstrado por suites focadas reais dos
quatro domínios, lifecycle compartilhado, `npm run build:public`,
`node scripts/generate-public-shell.mjs --check`, `npm run verify` sem falhas
e `git diff --check`.

## Fechamento do renderer

Todos os consumidores ativos serão migrados, incluindo Knowledge, Benefits,
Reminders, Dashboard e Academy. Serão removidos links para `css/cms.css`,
classes exclusivas e imports do renderer; a prancha
`docs/design/academy-frontend-preview.html` também deixará de carregar o CSS.
Somente depois de confirmar zero consumidores, serão apagados
`public/js/cms-block-renderer.js` e `public/css/cms.css`, e o contrato de
remoção será ampliado para proteger a ausência final.

## Sequência de commits

1. `docs(OWN-41): record CMS decoupling design`
2. `test(OWN-41): restore real domain contract coverage`
3. `refactor(OWN-41): restore simple Knowledge and Benefits`
4. `refactor(OWN-41): preserve reminder delivery contracts`
5. `refactor(OWN-41): decouple Academy without CMS`
6. `refactor(OWN-41): remove shared CMS rendering consumers`
7. `test(OWN-41): prove historical preservation and final absence`

Cada commit de implementação será stageado por caminhos explícitos, validado
antes do commit e mantido verde. O push final será fast-forward normal para
`origin/rewrite/portal-sem-cms`. O Linear receberá OWN-41 em In Review com
hashes, contagens, arquivos, RED/GREEN, negativos SQL/HTTP, preservação
histórica, skips exclusivamente removidos justificados e a declaração:
“PDF ativo retirado por ausência de rota própria”.
