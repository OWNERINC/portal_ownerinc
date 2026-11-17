# Academy e Vaga mobile — revalidação D01–D07

Data: 17/11/2026. Resultado: **D01–D07 corrigidos e revalidados localmente**.

## Evidências

Pacote novo:
`C:/Users/Criação/AppData/Local/Temp/opencode/portal-corrections-20261117-r1/`.

- `REPORT.md`: relatório atualizado, contexto, resultados e limitações.
- `matrix.json`: J01–J35, com origem explícita para os recortes não repetidos.
- `defeitos.md`: fechamento D01–D07 e manutenção de D08 em aberto.
- `academy-release/results.json`: **17/17 cenários integrados PASS**.
- `exports-final/results.json`: **29/29 exportações PASS**, 25 PNGs 1080×1080 e
  quatro PDFs Guest/Owner.
- `pdf-render-final/results.json`: quatro PDFs renderizados com PyMuPDF, uma
  página cada, pixels desktop/mobile idênticos dentro de cada modelo.
- `verify-final.log`: **1.274 testes / 1.270 PASS / 4 SKIP / 0 FAIL**;
  security e Compose config aprovados.
- `git-state.json`, `tested-sources.json`, `tested.patch`, `manifest.json` e
  `manifest.sha256`: revisão, fontes e integridade dos artefatos.

A execução original em `portal-journeys-20261117/` permanece preservada.

## Correções verificadas

- **D01/D02:** abrir e salvar somente título em cursos interno/externo conserva
  entrega, público/cargos, grupo, ícone, disponibilidade e demais metadados.
  Criação, PUT, SQL e reload foram executados com valores não padrão.
- **D03:** título e URL no formulário inline; vazio não envia POST; URL inválida
  recebe 400 real; 503 injetado preserva campos e permite retry. Cancelamento
  permite permanecer ou descartar somente a nova aula.
- **D04:** gestão autorizada recebe mídia/descrição; editar título de aulas
  YouTube e arquivo conserva descrição, mídia, versão e progresso entre UIDs.
  Projeção de aluno permanece resumida; GET de gestão e PUT sem capacidade negados.
- **D05:** rascunhos sobrevivem ao save de outro item, do curso e à reordenação;
  guarda única para navegação interna, sidebar, Cancelar, Back/Forward; mutação
  bloqueia saída/duplo envio. Marca SVG usa atributo de classe compatível com
  SVG nativo, permitindo remount após carregar os assets.
- **D06:** 12 labels associados por `for`, conferidos por `label.control`.
- **D07:** dimensões da composição Vaga proporcionais ao preview; altura de
  linha do título comporta a fonte em larguras fracionárias. PNG completo em
  1366/402 e variantes light/dark/beige em 360/375/390/402/420/768.
  Conteúdo excessivo e cinco requisitos continuam bloqueando exportação.

## Revisão e casos adicionais

Revisão independente read-only identificou três P2, corrigidos antes do fechamento:

1. Aplicar o ACK de create/save/reorder antes do GET; erro de leitura conserva
   estado confirmado. PUT de metadados não reenvia ordem antiga.
2. Bloquear troca de entrega com currículo pendente; congelar controles durante
   escrita; desmontar currículo ao confirmar externo e reler ao voltar a interno.
3. Classificar mídia pelo hostname exato, incluindo YouTube sem cookies e
   arquivo com `youtube.com` apenas na query string.

Os três casos têm regressões executadas. Segunda revisão focal aprovada.
Não houve `pageerror` nem erro não tratado de servidor nas rodadas finais.

## Limites do resultado

Frontend, rotas Express e SQL reais locais; PGlite em disco serializado e
Firebase/SMTP sintéticos. Reabertura comparou 18 tabelas em cada harness final.
Isso não comprova concorrência/pool PostgreSQL nativos nem infraestrutura real.

O lote fecha os defeitos D01–D07 no recorte executado. D08 de contraste Pós,
Pages A18, capacidade de 100 usuários, dispositivos físicos, serviços externos e
backup produtivo continuam nos registros anteriores. Não é aprovação integral
do Portal. O documento oficial de Ética foi preservado.
