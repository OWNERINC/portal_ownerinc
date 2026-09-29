# Correções do Portal — lote 1 (F01/F02)

## Escopo

Implementação localizada sobre `ff14c66`, limitada a Lembretes e ao estado de
seleção do CMS. Sem alterações em API, cron, permissões, banco, runtime, deploy
ou produtos vizinhos. Auditoria, capturas e plano principal preexistentes foram
preservados. Não houve commit, acesso à produção ou execução do Docker.

## F01 — histórico de entregas e consulta do cron

- Histórico e saúde têm loaders, tokens de requisição, feedback e retries
  independentes. Uma resposta pendente ou com erro não impede a outra seção.
- Falhas de consulta da saúde não afirmam falha de execução. Texto, classe e
  título do badge são redefinidos ao carregar, receber `null` ou falhar.
  Permanecem as regras existentes de heartbeat de 26 horas e a distinção entre
  execução e falhas de entrega.
- UUID de versões 1–5, UID (`[A-Za-z0-9._:-]{1,128}`), datas civis válidas e
  intervalo crescente são validados antes da consulta de entregas. Entradas de
  data incompletas (`badInput`) também são rejeitadas. A ajuda esclarece que os
  filtros continuam sendo identificadores técnicos, não título/nome/e-mail.
- Erros visíveis são associados por `aria-describedby` e `aria-invalid`; o
  primeiro campo inválido recebe foco. A autorização do backend não mudou.
- Cada consulta aceita ou rejeitada localmente invalida a anterior, remove os
  dados/paginadores antigos e apresenta o estado correspondente. Filtrar/Limpar
  começa na página zero. Paginação, retry e recuperação de página fora do total
  usam o snapshot dos filtros da própria consulta, não edições ainda não enviadas.
- Callbacks antigos não retomam a consulta; retries de uma seção não reiniciam
  a outra. O lifecycle real aborta as requisições ao desmontar a página.
- Leitores não fazem consultas de entregas ou saúde. WhatsApp permanece como
  canal de consulta histórica, sem habilitar novos envios ou permissões.

## F02 — seleção do CMS

- Um reset central limpa documento/view, geração e DOM do editor, configurações
  e índice de bloco, histórico/paginação/offset/token, metadados, erro, campo de
  agendamento e status de salvamento.
- A prévia é limpa com `renderBlocks(..., [])`, liberando URLs de blobs e
  abortando downloads de assets **antes** da substituição do DOM conectado.
  Respostas tardias de mídia continuam sendo descartadas/revogadas pelo renderer.
- O reset ocorre na inicialização e nas transições aceitas pelas guardas
  existentes. Trocar A por B limpa A imediatamente, inclusive enquanto B carrega
  e quando B falha. A mesma seleção com erro continua podendo ser tentada novamente.
- Estado inicial e seleção vazia exibem `Selecione um documento`. O único texto
  gerado alterado é o span `save-state`, sincronizado no gerador e em `cms.html`.
- Área/lista são preservadas ao selecionar um documento. Histórico antigo não
  reaparece por respostas tardias, e seus paginadores antigos perdem validade.
- `saving`, `saveInFlight`, `actionBusy` e uploads não são zerados pelo reset.
  Navegação interna suja continua bloqueada; cancelar saída externa preserva o
  rascunho. Coalescência de autosave, `editVersion` e revisão usada na publicação
  continuam cobertos por testes executáveis.

## Arquivos

- `public/js/reminders.js`
- `public/reminders.html`
- `public/js/cms.js`
- `public/cms.html`
- `scripts/generate-public-shell.mjs` — somente texto inicial do CMS
- `tests/helpers/cms-harness.mjs` — DOM/transporte/timers compartilhados pelos
  dois novos testes; monta módulos, UI, editor, renderer e lifecycle reais
- `tests/unit/reminder-delivery-ui.test.mjs`
- `tests/unit/cms-selection-state.test.mjs`
- `tests/unit/cms-frontend.test.mjs` — ajustes estruturais das assertions afetadas
  pela extração do reset e pelas guardas reforçadas, sem relaxar contratos
- `docs/reviews/2026-09-29-portal-corrections-batch-1.md`

## Verificação local

Ambiente: Node **24.15.0**. As adições usam sintaxe compatível com Node 18, mas
isso **não estabelece suporte da aplicação a Node 18**: manifests/verificador
existentes exigem Node 24 e não foram alterados.

| Comando | Resultado |
| --- | --- |
| `node --test tests/unit/reminder-delivery-ui.test.mjs tests/unit/cms-selection-state.test.mjs` | 41 testes aprovados, zero falhas/cancelados/pulados. |
| Novos testes + `cms-frontend`, `frontend-invariants` e `persistent-navigation` | 104 testes aprovados, zero falhas/cancelados/pulados. |
| `node scripts/generate-public-shell.mjs --check` | Exit 0; nenhuma divergência gerada. |
| `npm run verify` | Exit 0; 578 testes aprovados (537 anteriores + 41 novos), sintaxe, scan de possíveis segredos e naming aprovados. Compose deliberadamente não validado, conforme abaixo. |
| `git diff --check` | Exit 0; sem erros de whitespace. |

O verificador chama Docker automaticamente. Para respeitar a proibição deste
dispatch, os diretórios do executável Docker foram retirados apenas do `PATH` do
processo durante `npm run verify`, com restauração ao final. A saída confirmou
`Docker Compose unavailable, skipping compose validation`. Nenhum arquivo do
verificador foi modificado. Os testes existentes de Cards Pós emitiram avisos
`MODULE_TYPELESS_PACKAGE_JSON`, sem falhas; runtime não faz parte deste lote.

Durante o desenvolvimento, duas assertions estruturais antigas do CMS falharam
após a extração do reset. Foram atualizadas para exigir as mesmas proteções no
helper e nos seus pontos de chamada; o recorte de `loadDocument` passou a excluir
`loadDocuments`. Todas as verificações finais acima passaram.

## Limites e próximo gate

- Testes comportamentais usam DOM e transportes controlados, sem serviços ou
  credenciais reais. Não substituem inspeção visual, teclado/leitor de tela nem
  aceitação com API/dados locais.
- Navegador, fixtures, validação Compose e revisão independente permanecem com
  a sessão principal. Este relatório não afirma homologação ou publicação em
  produção, envio externo ou recebimento de e-mail.
- Sem bloqueador de implementação conhecido dentro dos arquivos autorizados.
  Lotes F03–F08, tradução editorial e novas buscas administrativas não foram
  incluídos.
