# Fechamento das pendências de homologação

Data: 17/11/2026. Base: `02a3e5449a50f52c81c8ad3c03f56eed2c3d17ba`.

## Objetivo e autorização

Fechar as reprovações D09/D08 e avançar os gates operacionais do Portal,
mantendo cada resultado vinculado à revisão e ao ambiente executados.

O usuário aprovou no formulário **Autorizar fechamento técnico**:

- paginação da gestão Academy em lotes de 20, com Anterior/Próxima, posição
  na URL, retorno e retry;
- escurecimento localizado dos dois títulos dos Cards Pós para contraste
  mínimo de 4,5:1, com efeito no preview e PDF e respectiva revalidação;
- CI Linux isolada: commits das correções, publicação da branch de homologação
  no GitHub e execução dos testes em ambientes descartáveis.

A publicação autorizada é da branch de homologação. O fluxo atual de CI
condiciona imagens publicadas e deploy-production à referência `main`.
As execuções desta etapa devem usar a branch e conferir essa condição.

O pacote será executado em duas frentes delimitadas: correções funcionais/visuais
e qualificação operacional. Esta especificação define as correções e o uso da
CI existente; a carga completa e as integrações exigem seus parâmetros próprios.

## D09 — Paginação da gestão Academy

### Comportamento

- Usar a API existente, `all=true`, `limit=20` e offset, mantendo a autorização
  `manageAcademy` e a ordenação retornada pelo servidor.
- Exibir Anterior/Próxima, posição da página e total de cursos.
- Armazenar o offset em `manage_offset` na URL da Academy. Ausência equivale
  à primeira página; valores inválidos são normalizados para uma posição válida.
- Navegar pelas páginas, recarregar e usar Back/Forward devem conservar a
  posição correspondente. Abrir um curso e cancelar/retornar à gestão deve
  recuperar o lote de origem.
- Criação de curso permanece acessível. Seus links e retornos preservam o
  contexto de gestão sem levar os parâmetros para o catálogo do aluno.
- Se a última página deixar de existir por alteração do catálogo, recuperar
  uma página válida usando o total da resposta, sem repetição infinita.

### Arquitetura

Mudanças localizadas em `public/academy/manage-view.js` e no encaminhamento
de parâmetros da Academy, quando necessário. Reutilizar `fetchAPIPage`,
`page.location`, a navegação/lifecycle atuais e a aparência da paginação existente.
O backend e seu limite máximo de resposta permanecem o contrato de referência.

A lista será responsável por carregamento, erro/retry, vazio, total e controles.
Os editores de curso/currículo continuam responsáveis por seus rascunhos,
gravações e guardas. A paginação não deve introduzir uma segunda confirmação.

### Carregamento, erros e acessibilidade

- Impedir requisições duplicadas por cliques durante carregamento.
- Descartar respostas de uma montagem já encerrada.
- Informar erro e oferecer Tentar novamente para o mesmo lote.
- Diferenciar catálogo vazio de falha de leitura.
- Identificar a navegação de páginas, anunciar a posição e preservar foco
  utilizável após troca de página, erro e retorno.
- Manter controles utilizáveis em desktop e viewport estreito.

### Critério de aceite

Com pelo menos 105 cursos, alcançar o último curso pela interface, abrir seu
editor, voltar ao lote, recarregar e navegar pelo histórico. Conferir que cada
lote respeita o limite, que o total vem da API e que não há cursos omitidos ou
duplicados no percurso estável. Exercitar erro/retry, resposta tardia, ausência
de permissão e catálogo vazio. Revalidar os editores já corrigidos.

## D08 — Contraste dos títulos dos Cards Pós

Alterar somente a cor de texto dos dois títulos da caixa de benefícios do
modelo Convidado, hoje selecionados por `.guest-body .benefit-box h3`.

Cor proposta: **`#6f6250`**, mantendo o tom terroso da composição. Sobre o fundo
existente `#e9e6de`, o cálculo WCAG resulta em aproximadamente **4,76:1**,
acima do mínimo de 4,5:1. O resultado também será medido no browser.

A regra compartilhada do preview/exportação produzirá a mesma cor no PDF.
Geometria, texto e imagens não precisam mudar para corrigir o contraste.

### Critério de aceite

- Axe sem a violação D08 em 1366 e 402 px, com os alvos presentes.
- Cor computada e razão de contraste registradas.
- PDFs Convidado e Owner gerados e renderizados; verificar integridade e
  consistência entre viewports, registrando a alteração esperada de cor.
- Manter resultados `incomplete` como pendentes de inspeção; não tratá-los
  como aprovação manual.

## Verificação e entrega das correções

- Regressões direcionadas de paginação/navegação e contraste.
- Jornadas reais locais de navegador/API/SQL em nova pasta de evidências.
- Revalidar Academy e exportações afetadas.
- `npm run verify`, `npm run security`, shell/build Pages em `--check`
  e `git diff --check`.
- Revisão independente read-only, seguida da consolidação das evidências.
- Preservar integralmente os pacotes anteriores e o documento oficial de Ética.

## Qualificação operacional na CI Linux

Depois das correções e verificações locais:

1. Fixar o commit candidato e publicar a branch de homologação.
2. Executar `ci.yml` com a referência explícita dessa branch.
3. Conferir resultados de Linux, PostgreSQL 16, migrations fresh/upgrade,
   grants/readiness, integração Academy, recuperação DB-only Pages, Nginx
   config, builds e scanners.
4. Preservar logs, IDs, revisão, artefatos e jobs efetivamente executados.
5. Atualizar apenas os critérios comprovados: `nginx -t` não comprova proxy
   em execução; recuperação DB-only não comprova uploads/off-host/retomada.

## Etapas que ainda precisam de parâmetros específicos

- **Carga:** alvo e hardware representativos, perfil de uso/NAT, SLOs e limites
  de interrupção. A proposta anterior 20→50→100/30 minutos continua pendente
  desses parâmetros. CI não certifica capacidade da VPS por equivalência.
- **Firebase/SMTP reais:** projeto, contas, remetente e caixa de teste designados;
  credenciais somente por cartão privado. Emulador não é prova do provedor real.
- **Recuperação integral/off-host:** destino descartável, armazenamento externo,
  conjunto banco/uploads e critérios de retomada.
- **Dispositivos e aceite humano:** participação do usuário em roteiro observável.

Pages A18 e manutenção de permissões/retenção de backups produtivos mantêm seu
escopo próprio.

## Autorrevisão da especificação

- Correções delimitadas e critérios verificáveis.
- Método de execução e efeitos aprovados registrados.
- Sem mudança implícita de autorização, banco, conteúdo ou escopo de produção.
- Nenhum gate é encerrado apenas pela criação de teste ou por substituto sintético.
- Especificação pronta para revisão do usuário antes do plano de implementação.
