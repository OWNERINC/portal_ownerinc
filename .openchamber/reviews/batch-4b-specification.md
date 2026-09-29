# Lote 4B — interface administrativa sobre o contrato 4A

Implementação já autorizada no plano principal. Este documento delimita o
trabalho do implementador único após as correções do lote 3.

## Arquivos e limites

- Editar `public/js/admin.js` e `public/admin.html`.
- `public/css/admin.css` apenas para encaixe responsivo dos controles e ajuda;
  reutilizar classes existentes e preservar a linguagem visual.
- Pode criar um helper pequeno em `public/js/admin-list-state.js` se reduzir
  duplicação; não criar framework de filtros nem reestruturar o painel inteiro.
- Criar regressões comportamentais pertinentes em `tests/unit/` e um harness
  em `tests/helpers/` se necessário; preservar testes de política/lifecycle.
- Criar `docs/reviews/2026-09-29-portal-corrections-batch-4b.md`.
- API, pacotes, CMS, ferramentas, gerador, plano e aceitação são fora deste lote.
  Não editar scripts temporários de QA da sessão principal.

Leia README, AGENTS, arquitetura de navegação, plano congelado do lote 4,
relatório 4A e callers reais. Sem nova aprovação, delegação, commit, push,
deploy, credenciais ou operação de serviços. Compose readonly no verify é
permitido. Preservar Node 18 na sintaxe nova sem alegar suporte integral.

## Filtros e elementos

Formulários com botão explícito Aplicar e Limpar; filtros ficam disponíveis
enquanto a consulta anterior está pendente. A tabela antiga e suas ações não
devem permanecer acionáveis durante a troca. IDs pedidos pela sessão principal:

| Formulário | Campos |
| --- | --- |
| `users-filters` | `users-q`, `users-role`, `users-state`, `users-job-title-id` |
| `titles-filters` | `titles-q`, `titles-active` |
| `audit-filters` | `audit-action`, `audit-from`, `audit-to` |

Labels claros, `maxlength` conforme API, selects com opção Todos e mensagens
de validação associadas aos campos. Auditoria permanece dentro do painel de
usuários, exclusiva de super-admin; ação é texto/código exato, pode usar
datalist de códigos conhecidos, mas deve aceitar código novo/desconhecido.
Ajuda das datas: dias civis de São Paulo. Validar datas reais/ordem e não enviar
consulta inválida; não interpretar data no timezone do navegador.

Usuários: nome/e-mail, viewer/admin, active/disabled/enable_pending, UUID de
cargo. Cargos: nome, ativo/inativo/todos; default da tabela continua todos,
enviando `all=true` e opcional `active`; API `active` explícito prevalece.
Busca literal na API, sem filtragem adicional client-side de uma página.

## URL, paginação e concorrência

- Parâmetros congelados: `users_q`, `users_role`, `users_state`,
  `users_job_title_id`, `users_page`; `titles_q`, `titles_active`, `titles_page`;
  `audit_action`, `audit_from`, `audit_to`, `audit_page`. Página base 1.
- Filtros aplicados reiniciam somente sua seção em página 1. Limpar faz o mesmo.
  Alterações e paginação geram entradas que Back/Forward consegue restaurar.
- Usar `page.location` e `page.history`, preservando metadados do router,
  parâmetro tab e filtros das outras seções. Não enviar nomes de UI à API.
- Restaurar controles e dados em acesso direto, reload e popstate dentro da
  mesma aba; o early return existente de switchTab não pode impedir reload.
- Query malformada de URL não pode gerar 500, paginação negativa/infinita,
  opções perdidas nem passar diretamente para a API. Normalizar ou apresentar
  validação coerente. Filtros vazios são omitidos.
- Contagem é `X-Total-Count`, 50 itens por página. Criar
  `job-titles-pagination`, independente das opções de cargo. Resposta vazia em
  página removida deve recuperar última página válida sem loop.
- Token separado para usuários, tabela de cargos, auditoria e opções completas.
  Sucesso, erro, finally, retry e controles de paginação antigos não podem
  sobrescrever o pedido atual; descarte da página impede alterações.
- Preservar carregamentos/abas/guards de solicitações, Academy, Benefícios e
  Sólides, inclusive descoberta tardia e intenção tab=solides.

## Opções de cargos independentes

O array usado na tabela não pode alimentar diretamente os formulários.
Carregar `/api/job-titles?all=true&limit=100&offset=N` até completar o total,
deduplicando o loader pendente e tratando falha sem publicar catálogo parcial.
As opções de convite/aprovação aceitam todos os ativos; edição inclui o cargo
inativo atualmente atribuído. Filtro de usuário pode selecionar cargo inativo.

Filtro/página da tabela de cargos não altera opções/seleção de nenhum formulário.
Criar/editar/ativar/desativar cargo invalida/recarrega catálogo completo e tabela
com segurança; preservar seleção quando ainda válida. Formulários aguardam o
catálogo e oferecem feedback/retry se falhar, sem abrir editor editável incompleto.
Caso existam cargo selecionado/usuário antes do catálogo, preservar ID/rótulo
conhecidos até reconciliar. Não limitar opções aos primeiros 100.

## Ações e orientação F08

Alinhar UI com os handlers/policy existentes sem modificar a autoridade da API:

- Própria conta: editar campos permitidos continua disponível; desativar,
  reativar e anonimizar ficam indisponíveis, com explicação visível/associada.
- Alvo `role=admin` e `permissions.superAdmin === true`: gestor sem super-admin
  não pode editar nem alterar estado; motivo explícito. Strings não concedem
  privilégio. Um super-admin pode agir sobre outro segundo o servidor.
- Último super-admin continua protegido pelo servidor; não inferir quantidade
  global a partir de página filtrada nem ocultar ações permitidas genericamente.
- Anonimização: super-admin, alvo diferente, não super-admin e desativado;
  respeitar requisito booleano real do handler. Preservar confirmação existente.
- Estado exibido segue disabled → enable_pending → active, inclusive string
  JSON `accountDisabled: "true"` conforme a API de leitura.
- Cargo inativo: aviso no usuário/editor de que o vínculo permanece e o acesso
  derivado fica indisponível até atribuição/ativação autorizada; não equivale a
  conta desativada. Não alterar cargos/usuários automaticamente.

## Auditoria e CSV

Auditoria mostra data/hora em São Paulo, `actor_name` atual (fallback
`Sistema ou conta removida` se nulo), ação com tradução útil e código técnico,
alvo e request ID. Ação desconhecida continua legível; nome é texto seguro,
sem HTML e sem snapshot histórico. Não colocar termos de filtro em logs novos.

Associar label ao `bulk-csv` e `aria-describedby` à ajuda UTF-8, colunas, preview,
limite 500, remoção dos exemplos. Preservar parser, preview ticket, job polling,
armazenamento por UID e confirmação. Não adicionar promessa de entrega de e-mail.

## Regressões exigidas

Harness monta página real/HTML e fluxo de URL/lifecycle com transportes
controlados (não só regex de fonte): filtros isolados/combinados, total/páginas,
troca+reset, URL direta e same-tab Back/Forward, respostas sucesso/erro em ordem
inversa, controles antigos/retry/descarte. Catálogo 105+ itens, segunda página,
tabela filtrada separada, cargo inativo selecionado, falha parcial/retry,
convite+edição+aprovação completos. Matriz own/manager/super/target protegido;
auditoria data inválida/nulo/desconhecido e label CSV.

Executar testes focados, `npm run verify`, gerador `--check`, `git diff --check`.
Relatar arquivos, comportamento e limites; a sessão principal possui script
Chromium `portal-correcoes-admin-browser.cjs` e fixtures reais para aceitação.
