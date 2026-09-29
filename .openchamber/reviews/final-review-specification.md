# PR #42 — revisão final independente

## Objetivo e autoridade

Revisão nova R2, somente leitura, do **diff completo contra `ff14c66`** e do lote 5
após corrigir P2/P3 da rodada final R1. Um único implementador executou os lotes; o primário inspecionou
as alterações, repetiu verificações e executou as jornadas locais reais.
Retornar parecer `ship`, `fix-first` ou `rethink`, com qualquer achado concreto
por severidade, arquivo/linha, reprodução e correção delimitada.

## Fontes

- `README.md`, `AGENTS.md`, `docs/product/brief.md`.
- `docs/superpowers/plans/2026-09-29-portal-corrections.md` e especificações em
  `.openchamber/reviews/`; o despacho 5 excluiu Admin para congelar o aceite 4B.
- Snapshot imutável `.openchamber/reviews/final-r2-ff14c66-20260929.diff`, incluindo
  todos os arquivos novos de aplicação/testes/documentação desta entrega.
- Manifesto `.openchamber/reviews/final-review-inputs-r2-20260929.json` associa
  hashes aos arquivos efetivos. Diffs intermediários são artefatos locais de
  revisão; não compõem o PR nem precisam ser relidos como novas alterações.
- Registro primário `docs/reviews/2026-09-29-portal-corrections-acceptance.md` e
  relatórios por lote. O estado consolidado prevalece sobre rodadas históricas.
- Outputs de navegador em `docs/reviews/2026-09-29-portal-browser-evidence.json`,
  copiados dos cinco percursos primários com hashes dos arquivos de origem.

## Aceites anteriores

Lotes 1, 2, 3 R3, 4A e 4B receberam `ship` de revisores novos. O lote 5 ainda
requer seu parecer; esta revisão deve avaliar também integração e todo o diff,
sem presumir que os pareceres anteriores comprovam o estado atual.

R1 `ses_f11a78df3ffe3m84npVIbw9PEo` retornou `fix-first` por gate truthy no novo
link CMS e promessa documental de UID visível na auditoria. O primário confirmou
ambos. O mesmo implementador entregou o gate estrito local, 30 regressões novas
e as duas correções textuais, conforme `batch-5-final-corrections.md`. Revalidar
esses pontos e o diff integral; não presumir aceite só por esse relato.

## Conferências prioritárias

1. Lembretes: filtros, erros e saúde independentes; tokens/lifecycle.
2. CMS: limpeza completa após transição aceita, renderer/recursos privados e
   guardas preservados. Tradução só visual, fallback de texto, enums intactos.
3. Dependências: patch dirigido, parsing/multipart/memoryStorage e limites.
4. Dashboard e ferramentas: estados úteis, IDs 38/16 preservados, JSON de save,
   defaults reais contra validador, ownership de exportação e histórico,
   serialização de mutações, descarte de frames, geometria PNG/PDF.
5. API administrativa: filtros parametrizados antes da paginação/contagem,
   busca literal, booleanos estritos, datas civis São Paulo, identidade atual
   em auditoria sem snapshot persistido; política server-side preservada.
6. Admin: URL/router/Back/Forward na mesma aba, controles obsoletos e retries,
   catálogo integral independente, mutações/seleções de cargos e regras por ação.
7. Knowledge: ajuda legado/CMS contextual e link canônico autorizado, com
   metadados/blocos/PDF e guardas de edição, gravação/upload/descarte preservados.
8. Testes realmente comportamentais, doubles explícitos, documentação e limites
   alinhados ao código/evidência, sem alegações de produção não demonstradas.

## Evidência primária atual

- `npm run verify`: **788 aprovados**, zero falhas, skips ou cancelamentos;
  hashes de código/testes estáveis, gerador `--check` e whitespace aprovados.
- `npm run security`: zero vulnerabilidades para API/cron no escopo sem
  dev/opcionais. Audit integral anterior: seis entradas moderadas opcionais,
  nenhuma alta/crítica; cadeia não instalada na imagem local reconstruída.
- Chromium/API/PostgreSQL reais: seis modelos POST/reabertura/PUT e exportações
  recuperadas/inspecionadas; 24 combinações de preview; employee mobile 40/40 px.
- Admin: 55 usuários/105 cargos, filtros/composição/paginação/histórico/stale
  success+503, proteções, CSV, mutações de cargo sintético e retry da segunda
  página do catálogo, teclado e 390 px; zero erros de página.
- Editorial final repetido após último HTML e após gate estrito: ajuda, preservação de conteúdo ao
  editar metadados, tradução, cancelar/aceitar descarte e leitor sem ações;
  quatro hashes estáveis, zero erros de página.
- Navegação integrada final: **20 trocas desktop e quatro mobile**, shell
  preservado, zero novas navegações de documento, zero erros de página/429/5xx.
  Drawer e largura 390 px conferidos. Confirmações nativas de saída respeitadas.
  Rodada anterior atingiu a janela 300 requisições/15 minutos; a rodada final
  passou após liberação natural, sem alterar o rate limit.

## Limites conhecidos

Recebimento externo de e-mails, caminho positivo de convites/importação, dados
oficiais, dispositivos físicos/tecnologia assistiva e produção não homologados.
Node 24.15.0 é o runtime usado; suporte integral Node 18 não foi comprovado.
A causa original do aviso ResizeObserver de produção não foi isolada; há prova
de estabilidade local. PDF: interface/upload 100 MiB, associação no editor
simples 50 MiB, divergência preexistente documentada sem mudança de contrato.

Sem editar arquivos, delegar, commitar, operar serviços, acessar credenciais,
modificar dados ou publicar revisão no GitHub. Diferenciar inspeção própria de
evidência relatada. Se shell estiver indisponível, ler o diff completo por
seções e declarar a limitação em vez de atribuir execução própria aos checks.
