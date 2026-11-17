# Academy e Vaga mobile — correções funcionais

Data: 17/11/2026
Base: `db7687d7f33416358be5678ae23bbd0cfe194dc3`
Estado: abordagem e especificação aprovadas; implementado e revalidado localmente.

Resultado: [revalidação D01–D07](../../reviews/2026-11-17-academy-vacancy-revalidation.md).

## Objetivo

Corrigir os defeitos D01–D07 reproduzidos na homologação local, repetir as
jornadas afetadas e atualizar o relatório com evidências novas. O usuário escolheu
um formulário curto na página para criar aulas, em vez de prompts sequenciais.

Relatório de origem:
`C:/Users/Criação/AppData/Local/Temp/opencode/portal-journeys-20261117/REPORT.md`.

## 1. Metadados e acessibilidade do curso — D01, D02, D06

- Inicializar cada select depois de inserir suas opções, usando o valor salvo
  ou o default de criação já estabelecido.
- Manter entrega, público, cargos, grupo visual, ícone e disponibilidade ao
  alterar somente título ou descrição.
- URL externa é obrigatória apenas para curso externo. Um curso interno não
  deve ser convertido implicitamente nem exigir URL externa.
- Usar associação nativa `label[for]` ao ID do controle; não alterar o helper
  global de UI se a correção puder ser restrita aos editores Academy.
- Conservar a validação de cargos e a indisponibilidade do seletor quando o
  catálogo de cargos não puder ser carregado.

## 2. Contrato de gestão das aulas — D04

A leitura de curso com `all=true`, já restrita a `manageAcademy`, fornecerá os
campos próprios necessários ao editor: descrição, tipo de mídia, ID YouTube ou
URL do arquivo. A projeção normal de aluno continuará sendo um resumo.

O editor deve abrir com a mídia real cadastrada. Alterar somente título deve
preservar descrição, origem normalizada do vídeo, ordem, disponibilidade,
`media_version` e progresso existente. Mudança explícita da mídia continua
seguindo a regra atual de versão/progresso.

Não é necessária migration: os dados já existem nas tabelas e são carregados
pelo serviço. A autorização de preview e as regras de audiência permanecem a
fronteira de leitura.

## 3. Criação de aula — D03

“Adicionar aula” abre um formulário curto no módulo:

- título e URL do vídeo, ambos obrigatórios;
- instrução de formatos aceitos: YouTube ou arquivo HTTPS MP4/WebM;
- botões “Criar aula” e “Cancelar”;
- foco no título ao abrir, labels associados e feedback acessível.

O POST só é iniciado após validar os campos obrigatórios. Tipo e URL são
enviados ao validador existente; URLs não aceitas pelo domínio continuam sendo
rejeitadas pelo servidor. A aula nova começa inativa, com descrição vazia e ordem
ao final do módulo.

Em erro de validação ou transporte, manter o formulário e os valores preenchidos
para correção/retry. Durante envio, bloquear submissão duplicada e descarte.
Depois do sucesso, atualizar a árvore com o estado confirmado e fechar somente
o formulário criado. Cancelar um formulário preenchido exige confirmar descarte.

## 4. Alterações pendentes e navegação — D05

- Marcar alterações nos eventos de digitação e checkbox, não apenas ao salvar.
- Conectar as guardas do lifecycle da gestão ao lifecycle principal da Academy
  e aos caminhos internos de navegação.
- Ao sair com alterações, “permanecer” mantém URL, tela e valores; “descartar”
  permite a navegação. Cobrir Voltar aos cursos, sidebar e Back/Forward.
- Durante mutação em andamento, impedir a saída e indicar que é preciso aguardar.
- Evitar reload completo após salvar curso: ele descarta alterações do currículo.
- Guardar edições por item. Salvar um módulo/aula ou reordenar a árvore não pode
  apagar campos pendentes em outros itens.
- Aplicar o estado confirmado pelo servidor ao item salvo, preservando os
  demais rascunhos locais. Falha mantém os campos e o estado pendente.
- Respostas tardias não devem remontar componentes descartados.

Salvar continua explícito. Não acrescentar autosave nem armazenamento local
persistente de rascunhos.

## 5. Vaga mobile — D07

Corrigir a composição do modelo Vaga em larguras pequenas: espaçamentos,
distribuição vertical e dimensões dos elementos devem permitir a fixture
reproduzida em 402 px, incluindo candidato, prazo, contato, rodapé e logo.

O ajuste será localizado no modelo, baseado na largura disponível. Preservar
conteúdo, proporção quadrada, identidade e exportação PNG de 1080×1080.
Preview e captura devem continuar com a mesma geometria.

Manter a detecção de overflow: textos realmente cortados e mais de quatro itens
de requisitos/benefícios continuam impedindo a exportação. Não ocultar conteúdo
nem afrouxar a tolerância para obter aprovação.

## 6. Verificação e aceite

### Academy

1. Criar/reabrir curso interno e externo, com valores não padrão.
2. Alterar somente título; comparar todos os metadados/cargos em API/SQL/reload.
3. Conferir associação nativa dos 12 labels aos controles.
4. Criar aula pela UI com vídeo válido; conferir POST, SQL e reload.
5. Exercitar campos vazios, URL inválida, erro de escrita, retry e cancelamento.
6. Abrir aula existente e alterar só título, preservando descrição, mídia,
   `media_version` e progresso; verificar outro UID isolado.
7. Exercitar permanecer/descartar e mutação pendente nas saídas internas,
   sidebar e histórico.
8. Editar dois itens, salvar/ordenar um e confirmar que o outro mantém edição.
9. Negar gestão/preview ao perfil sem capacidade e manter a projeção de aluno.

### AutoCard

1. Repetir a fixture Vaga original em 1366 e 402 px; inspecionar PNG completo.
2. Verificar larguras móveis próximas e as variações visuais existentes.
3. Confirmar bloqueio de conteúdo excessivo e limites das listas.
4. Repetir exportação dos demais modelos como regressão do fluxo compartilhado.

### Fechamento

- Testes de regressão devem executar comportamento; regex isolada não comprova
  selects nativos, payload integrado, guards nem layout.
- Executar jornadas com navegador, rotas, SQL e arquivos locais; documentar
  claramente PGlite e identidades/entrega sintéticas.
- Executar `npm run verify` e `git diff --check`.
- Atualizar documentação operacional correspondente e relatório/matriz.
- Preservar rodadas antigas; salvar novas capturas, resultados e manifesto em
  pasta própria, identificando exatamente a árvore testada.

## 7. Limites

Este lote cobre D01–D07. Contraste Pós D08, A18 de Pages, backup produtivo,
infraestrutura real e capacidade de 100 usuários mantêm seus registros próprios.
Não inclui mudança de schema, dependências, deploy scripts, push ou deploy.
O documento oficial de Ética e os worktrees/capturas existentes são preservados.

## Revisão da especificação

Revisão inline concluída: requisitos mapeados a D01–D07; contrato de mídia
permanece obrigatório; leitura adicional é restrita à gestão; salvamento não
descarta outros itens; overflow continua protegido. Sem requisitos em aberto
pendentes de decisão.
