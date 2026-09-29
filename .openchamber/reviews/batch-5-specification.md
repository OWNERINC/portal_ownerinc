# Lote 5 — linguagem e documentação

Etapa do plano autorizado; implementar depois do lote 4B com o mesmo worker.

## Escopo de edição

`public/js/cms.js`, `public/cms.html`, `public/js/knowledge.js`,
`public/knowledge.html`. Refinamento do despacho: `public/admin.html` ficou fora
deste lote, pois o 4B já concluiu a ajuda do CSV e estava congelado para revisão.
`docs/product/feature-inventory.md`, `docs/architecture/data-flow.md`,
`docs/operations/local-development.md` se necessário, e novo
`docs/reviews/2026-09-29-portal-corrections-batch-5.md`.
Regressões de comportamento pertinentes nos testes CMS/Knowledge existentes
ou novo arquivo focado; não refatorar handlers, upload, lifecycle ou renderers.
Plano, ledger de aceitação e artefatos/scrips temporários são da sessão principal.

## Resultado exigido

1. Tradução somente de apresentação no CMS: revisões draft/published/scheduled/
   archived como Rascunho/Publicado/Agendado/Arquivado, preservando enum, payload,
   URLs, filtros, classes e ações. Inspector → Configuração e publicação;
   rótulo de área Knowledge → Base de Conhecimento, conservando `knowledge`.
   Código desconhecido deve ter fallback seguro de texto, sem inventar estado.
2. Ajuda contextual honesta na Base de Conhecimento: editor simples mantém
   título/categoria/anexo; para artigo legado, texto simples continua editável.
   Para `cms_managed=true`, explicar por que o campo corpo fica desabilitado e
   que corpo/blocos, revisões, publicação e agendamento ficam no Editor CMS.
   Link `./cms.html` somente para perfil autorizado; sem parâmetros/deep links
   que o CMS não implementa. Orientar a selecionar área/documento existente.
   Preservar metadados/corpo CMS, tratamento de PDF e guards ao seguir esse link.
3. Ajuda do CMS pode explicar rascunho versus publicação, sem prometer autosave
   como publicação, nem limpar/alterar estados de lote 1.
4. Documentação alinhada ao código:
   - Dashboard usa destaque Owner News e estados distintos; não existe a
     saudação personalizada alegada no inventário antigo.
   - Owner: 1448 × 3361 px / 108 × 250,68 mm; Convidado: 1448 × 2347 px /
     108 × 175,1 mm; AutoCard PNG 1080 px.
   - Novos filtros administrativos server-side, URLs por seção, opções de cargos
     completas e independentes, auditoria com nome atual/ator removido.
   - Separação do editor simples/CMS e tradução apenas de apresentação.
   - Diferenciar checks/homologação local de produção e entregas externas;
     arquivo de aceitação da sessão principal é a fonte dos resultados reais.
   - Runtime atual Node 24; esta rodada não prova compatibilidade integral Node
     18 exigida pela instrução preexistente. Não alterar manifests/engines/AGENTS.
5. Relatório deste lote referencia histórico F01–F08 e os achados F09/F10/F11 da
   homologação, mas não reescreve a auditoria histórica. Não declarar o plano
   inteiro concluído enquanto falta revisão/aceite final da sessão principal.

## Verificação

Regressões de rótulos renderizados com enums de transporte preservados e ajuda
CMS/legado/permissões, sem testar apenas cópias literais do implementation.
Reexecutar invariantes importantes de preservação de metadados/corpo/PDF.
`npm run verify`, gerador `--check`, `git diff --check`; registrar limites reais.
Sem commit, push, produção, operação Docker, credenciais, schema ou delegação.

A sessão principal fará percurso CMS/Conhecimento no Chromium e nova revisão
independente do diff completo após a entrega. O recebimento externo de e-mails,
cargos/conteúdo oficiais, produção e dispositivos físicos não têm aceite automático.
