# Conteúdo demonstrativo Conecta — evidências locais

## Entrega

Prévia local preenchida conforme
`docs/superpowers/specs/2026-11-09-conecta-mock-content-design.md`:
seis lembretes, oito artigos, duas trilhas com seis aulas cada, usuários/cargos,
solicitações e auditoria, benefícios, históricos AutoCard/Cards Pós e envelopes
demonstrativos da página Sólides. Fixtures isoladas em `tests/visual/`.
Nenhum arquivo de `public/`, `api/`, `cron/`, `nginx/` ou deploy foi alterado.

Catálogos, detalhes, retomada e progresso compartilham registros. Busca,
categorias, filtros e paginação respeitam as consultas dos consumidores; o total
é calculado antes de limit/offset. Datas de lembretes usam o dia corrente de São
Paulo. O servidor só escuta em loopback, recusa escritas e não encaminha APIs.

## Verificações em 09/11/2026

- `node --test tests/unit/conecta-preview.test.mjs`: **7 PASS**. Inclui árvore
  Academy, busca/categorias, totais/paginação, detalhes ausentes, isolamento de
  referências, viradas de mês/ano/fevereiro e servidor HTTP read-only real em
  porta efêmera. Os testes foram observados falhando antes da implementação.
- `npm run verify`: **825 PASS, zero falhas, dois skips Linux**, `verify: ok`.
  Total de 827 testes, incluindo os sete novos. Nenhum serviço Docker iniciado.
- `check-conecta.mjs`: **55/55 páginas/larguras PASS**, mais drawer e navegação
  recolhida persistente. Larguras: 1920, 402, 360, 768 e 1366 px. Sem overflow,
  imagens quebradas ou erros JavaScript nos estados inspecionados.
- `check-conecta-interactions.mjs`: **39/39 PASS** em 1920/402/360 px.
- `check-conecta-content.mjs`: **42/42 PASS** em 1366/402 px: artigos completos,
  busca/categoria, lembrete e filtro de entregas, ambas as trilhas e aulas,
  benefícios, perfil, usuários/filtro/cargos/solicitações, históricos e abertura
  de cards salvos, resumo/jornada/histórico Sólides. Sem erros JavaScript ou
  overflow nos cenários conferidos.
- `check-conecta-accessibility.mjs`: **18/18 cenários sem violações WCAG A/AA
  automatizadas**, em 1920/402 px, cobrindo dashboard, conhecimento, lembretes,
  Academy, curso/aula de atendimento, administração, benefícios e Sólides.
- `git diff --check`: sem problemas.

Playwright e axe usados de instalação temporária externa ao projeto. Inspeção
em `http://127.0.0.1:4180`, pois já existia outro processo na porta 4178, mantido
intacto. Os harnesses aceitam `VISUAL_ORIGIN` para selecionar a instância correta.
Evidências locais em `C:/Users/Criação/AppData/Local/Temp/opencode/` nas pastas
`conecta-mock-content`, `conecta-mock-regressions`, `conecta-mock-interactions` e
`conecta-mock-accessibility`; capturas não integram os assets de produção.

## Limites

Conteúdo e pessoas são fictícios, não políticas oficiais. Postagens são artigos
da Base de Conhecimento, sem reativação editorial. Aulas apresentam descrições
próprias e o estado de mídia não suportada do player existente, sem vídeo real.
Operações de escrita continuam indisponíveis (405).

Não há comprovação de Firebase, PostgreSQL, envio de mensagens, reprodução de
vídeo, persistência, exportação autenticada ou Sólides reais. A integração
administrativa Sólides continua desativada. Auditoria automatizada não substitui
revisão integral de acessibilidade. Nenhum deploy ou mudança em produção.
