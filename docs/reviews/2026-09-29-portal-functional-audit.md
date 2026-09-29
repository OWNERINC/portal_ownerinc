# Auditoria funcional do Portal — 29/09/2026

## Conclusão

O Portal está acessível, a sessão administrativa navega pelas dez áreas do menu,
a API responde e o banco passa no readiness. A suíte local passou com **537 testes,
sem falhas**. A estrutura atual é aproveitável e não exige uma reconstrução geral.

A aceitação completa ainda não está demonstrada: há áreas sem conteúdo em
produção, defeitos reproduzidos de estado/feedback e operações de gravação e
entrega externa que precisam de uma rodada com registros de teste controlados.

Os principais ajustes são: separar a saúde do cron dos erros de filtro, limpar o
histórico do CMS ao trocar de área, corrigir a chamada do Dashboard sem notícias,
atualizar dependências sinalizadas e revisar usuários ligados a cargos inativos.

## Ambiente e método

- Produção: `https://portal.ownerinc.com.br`.
- Código local: revisão `ff14c66`; árvore inicialmente limpa.
- Navegador do OpenChamber com a conta autenticada pelo usuário.
- Percurso nas dez áreas: Dashboard, Conhecimento, Lembretes, Academy, Owner
  News, Perfil, Admin, CMS, AutoCard e Cards Pós.
- Desktop em 1440 × 900; verificações móveis em 390 × 844 no Dashboard,
  navegação, AutoCard e Cards Pós. Não é uma validação em dispositivo físico.
- Inspeção do código de frontend, autenticação, políticas, rotas, proxy e cron;
  consultas HTTP sem credenciais; checks locais e auditoria de dependências.
- Formulários abertos e cancelados; no AutoCard foram digitados textos temporários
  na prévia. O usuário confirmou o descarte ao testar a proteção de saída.
- Nenhuma alteração intencional de usuários, cargos, perfil, publicação ou
  lembretes foi submetida. Leituras administrativas podem gerar os eventos de
  auditoria previstos pela aplicação.
- Não houve acesso direto ao PostgreSQL de produção, logs da VPS ou imagem
  executada no servidor. Os resultados do código local não comprovam, sozinhos,
  a versão de backend implantada.

### Como interpretar os resultados

- **Confirmado:** comportamento efetivamente observado no percurso descrito.
- **Parcial:** interface/código verificados, mas alguma parte do fluxo não foi
  concluída com persistência ou serviço externo.
- **Problema reproduzido:** desvio observado, acompanhado de passos e evidência.
- **Melhoria:** recomendação de usabilidade, operação ou manutenção.

## 1. O que funcionou no percurso

| Área | Resultado observado | Limite da conclusão |
| --- | --- | --- |
| Sessão | A conta já autenticada acessou as dez áreas e permaneceu conectada durante a revisão. | Login foi realizado pelo usuário; logout, expiração e revogação não foram repetidos nesta rodada. |
| Navegação | Links laterais abriram as respectivas áreas, com título e seleção coerentes. | Não foi feita instrumentação de identidade dos nós DOM nem teste de todos os atalhos de teclado. |
| Histórico do navegador | Conhecimento com `q=política` → Academy → Voltar restaurou a URL e o estado de busca; Avançar retornou à Academy. | Fluxos com artigos publicados e paginação de conteúdo dependem de dados. |
| Navegação móvel | Menu abriu; a navegação para Cards Pós foi concluída após confirmação de descarte do AutoCard. | Teste em viewport reduzido, sem leitor de tela físico. |
| Dashboard | Seções e links carregaram; estados vazios de notícias, cursos e próximos lembretes apareceram. | A chamada de leitura sem notícia é inadequada, conforme F03. |
| Conhecimento | Buscas por `onboarding` e `política` atualizaram a URL e exibiram ausência de resultados. O formulário Novo artigo abriu e cancelou. Submissão vazia permaneceu no formulário. | A base estava vazia; ranking, busca positiva, leitura, anexos e CRUD completo não foram homologados ao vivo. |
| Owner News | Página e opção Todas abriram; estado sem publicações apareceu. | Sem publicações para testar detalhe, editorias, capas privadas e paginação. |
| Academy | Catálogo abriu com estado vazio. No Admin, Novo curso abriu e cancelou. | Sem cursos para testar links externos e filtros com resultados. |
| Lembretes | Listagem, formulário novo e histórico abriram. Sem filtro inválido, o painel mostrou cron ativo com heartbeat de 29/09/2026 às 08:00. Limpar restaurou a consulta após erro. | Nenhum lembrete/entrega disponível; não houve envio de e-mail. |
| Perfil | Dados da conta, cargo e controles de foto, edição e redefinição de senha carregaram. | Gravação do perfil, troca de foto e envio de redefinição não foram acionados. |
| Admin — usuários | Tabela de usuários e estados carregou. Convite abriu com cargos ativos e cancelou. Painel de CSV abriu com modelo, instruções e confirmação inicialmente desabilitada. | Convites, importação, alterações de permissões e desativação não foram submetidos. |
| Admin — solicitações | Aba abriu e informou ausência de solicitações pendentes. | Aprovação/rejeição não foi executada. |
| Admin — cargos | Catálogo e estados carregaram; edição de um cargo abriu os controles de atividade e acesso a AutoCard/Cards Pós e foi cancelada. | Alteração efetiva das permissões não foi testada com outras contas. |
| Admin — catálogos | Abas Academy e Benefícios abriram, ambas sem registros. | Benefícios permanece fora do menu principal por decisão de produto. |
| Auditoria administrativa | Eventos carregaram; Próxima mudou de página 1/7 para 2/7 com eventos anteriores. | Não foram percorridas todas as sete páginas. |
| CMS | Documento existente abriu, mostrando rascunho, ferramentas de blocos e dez revisões. Owner News informou ausência de documentos; Novo abriu o formulário e Cancelar fechou. | Não foram acionados autosave, publicação, despublicação ou agendamento. Há erro de histórico residual, F02. |
| AutoCard | Galeria, histórico, busca/filtro e editor de comunicado abriram. Edição de título/corpo atualizou a prévia e contadores; biblioteca encontrou `alert` e aplicou o ícone. | Histórico vazio; outros modelos e upload/crop não foram homologados individualmente. |
| AutoCard — saída | A guarda de alterações não salvas pediu confirmação antes de navegar; o usuário confirmou o descarte. | Diálogo nativo exigiu interação do usuário porque bloqueou a automação. |
| AutoCard — PNG | Botão de exportação foi acionado e voltou a ficar disponível, sem erro visível capturado. | O arquivo gerado não foi recuperado/inspecionado; exportação final fica parcialmente validada. |
| Cards Pós | Modelos Convidado e Owner abriram, alternaram e exibiram as respectivas prévias; Histórico e busca por `Gramado` responderam com estado vazio. | CRUD do histórico e upload não foram executados. |
| Cards Pós — PDF | Exportar PDF concluiu o fluxo dos dois modelos com a mensagem `PDF baixado com o card completo.` | Os arquivos não foram recuperados para inspeção de páginas, conteúdo e resolução; o sucesso observado é o informado pelo aplicativo. |
| Cards Pós — móvel | Prévia inteira do Owner ficou contida na tela; controles Arte inteira/Ampliar estavam disponíveis e Ampliar foi acionado no desktop. | Houve erro de ResizeObserver na sequência de redimensionamento/ampliação, F05. |

Capturas complementares:
[prévia editada do AutoCard](../../.openchamber/screenshots/audit-autocard-preview-2026-09-29T13-37-11-778.jpg)
e [Owner em mobile](../../.openchamber/screenshots/audit-pos-owner-mobile-2026-09-29T13-39-56-905.jpg).

## 2. Problemas e achados técnicos

### F01 — Erro de filtro é apresentado como indisponibilidade do cron

**Prioridade: média. Confirmado em produção e explicado pelo código.**

1. Abrir Lembretes; observar `Cron ativo`.
2. No filtro Lembrete, digitar `inexistente` e clicar Filtrar.
3. A tabela exibe erro genérico e o indicador muda para `Cron indisponível`,
   ainda com a aparência verde anterior.
4. Clicar Limpar restaura o cron ativo e o histórico vazio.

`public/js/reminders.js:248` agrupa consulta de entregas e saúde em `Promise.all`.
O catch em `public/js/reminders.js:320` trata qualquer falha como indisponibilidade
do cron. A API exige UUID em `api/routes/reminders.js:71`; a rejeição do filtro é
esperada, mas a comunicação da interface está errada.

**Ajuste:** validar/explicar o filtro, carregar a saúde independentemente e
apresentar o erro junto ao campo. Preferir seleção por título do lembrete e
nome/e-mail de usuário aos identificadores técnicos.

[Captura](../../.openchamber/screenshots/audit-reminders-invalid-filter-2026-09-29T13-30-27-544.jpg)

### F02 — Histórico de revisões do CMS permanece depois de trocar a área

**Prioridade: média. Confirmado em produção e explicado pelo código.**

1. Abrir um documento existente em Knowledge e aguardar suas revisões.
2. Selecionar Owner News, sem documento selecionado.
3. Editor e metadados ficam vazios, mas as revisões do documento anterior continuam
   na coluna Histórico. O status superior também continua `Salvo`.

`public/js/cms.js:207` limpa documento, editor e prévia na troca de área, mas não
limpa `historyNode`, `historyPagination` nem redefine o status de salvamento.

**Ajuste:** limpar todo o estado associado à seleção e mostrar `Selecione um
documento`. Cobrir essa transição com um teste de regressão de comportamento.

[Captura](../../.openchamber/screenshots/audit-cms-stale-history-2026-09-29T13-34-47-992.jpg)

### F03 — Dashboard oferece “Ler publicação” quando não há publicação

**Prioridade: média de UX. Confirmado em produção.**

A área principal informa ausência de notícias, mas mantém `Ler publicação`.
O clique abre a listagem vazia, não uma publicação. Em mobile, o destaque vazio
e a seção vazia seguinte ocupam praticamente a primeira tela inteira.

`public/js/dashboard.js:92` troca o destino para a listagem quando não há notícia,
mas não adapta o texto/visibilidade da ação.

**Ajuste:** usar um estado inicial compacto com atalhos úteis. Para gestores,
oferecer uma ação contextual de criação; para leitores, informar quando haverá
conteúdo sem prometer uma leitura inexistente.

[Captura móvel](../../.openchamber/screenshots/audit-dashboard-empty-mobile-2026-09-29T13-43-04-315.jpg)

### F04 — Auditoria de dependências sinaliza quatro pacotes na API

**Prioridade: manutenção de segurança. Evidência local, severidade moderada.**

`npm run security` reportou quatro ocorrências moderadas na API, envolvendo
`multer`, `qs` e dependências da cadeia `body-parser`/`express`. O cron reportou
zero vulnerabilidades no escopo analisado.

- `api/package-lock.json:1171`: body-parser 1.20.6.
- `api/package-lock.json:1711`: express 4.22.2.
- `api/package-lock.json:2986`: multer 2.3.0.
- `api/package-lock.json:3374`: qs 6.15.3.
- Avisos: [multer](https://github.com/advisories/GHSA-3pph-fpjx-jg34),
  [qs — array limit](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx),
  [qs — isBuffer](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g).

O comando termina com sucesso porque seu limite é `--audit-level=high`; isso não
significa ausência de avisos moderados. As quatro ocorrências não representam
quatro explorações independentes comprovadas. Os uploads inspecionados usam
`memoryStorage`, relevante para avaliar o aviso de escrita em disco do multer.

**Ajuste:** atualizar versões compatíveis e verificar contratos de parser e
upload. Confirmar o lockfile da imagem de produção antes de atribuir os avisos
ao servidor. Nenhuma exploração ou atualização foi realizada nesta auditoria.

### F05 — Erro de ResizeObserver nos Cards Pós

**Prioridade: baixa a média. Observado no navegador; causa não isolada.**

Depois de visualizar/exportar os modelos em mobile, retornar ao desktop e
acionar Ampliar, o console registrou:

```text
ResizeObserver loop completed with undelivered notifications.
```

As ações seguintes continuaram funcionando. A região a investigar é
`public/cards-pos/preview-layout.js:2`: o callback do observer mede e escreve
dimensões e observa o próprio container e a toolbar.

**Ajuste:** reproduzir isoladamente o ciclo de layout, aplicar dimensões apenas
quando mudarem e avaliar atualização agendada por frame. Não há evidência nesta
rodada de que o erro tenha corrompido um PDF.

### F06 — Busca de ícones exige termos em inglês e não explica resultado vazio

**Prioridade: baixa de UX. Confirmado em produção.**

No AutoCard, `alerta` não retornou ícones nem uma mensagem explicativa; `alert`
retornou `triangle-alert`. O restante da interface está em português.

**Ajuste:** adicionar nomes/sinônimos em português e uma mensagem de busca sem
resultados. Local relevante: `public/autocard/app.js`, função `renderAssets`.

### F07 — Histórico vazio dos Cards Pós repete a mensagem

**Prioridade: baixa de UX. Confirmado em produção e código.**

`Nenhum convite salvo ainda.` aparece duas vezes. Com busca preenchida, a mensagem
também não distingue ausência de resultados de ausência global de convites.

`public/cards-pos/app.js:695` escreve a mesma informação no estado vazio e em
`setStatus`.

**Ajuste:** concentrar a mensagem em um local e diferenciar busca vazia de
biblioteca vazia; oferecer limpar busca/criar primeiro convite conforme o caso.

### F08 — Administração oferece desativar a própria conta

**Prioridade: baixa de UX; autorização de backend está prevista.**

O botão Desativar é exibido também na linha da conta em uso.
`public/js/admin.js:361` cria a ação sem filtrar o próprio UID;
`api/middleware/policy.js:37` proíbe a operação para a própria conta.

**Ajuste:** desabilitar/omitir a ação com explicação coerente com a política.
Não foi acionada desativação para demonstrar uma recusa já explícita no código.

## 3. Configuração e conteúdo a revisar

### Cargos inativos ainda vinculados a usuários ativos

As telas de usuários e cargos mostraram vínculos ativos com os cargos inativos
**Coordenador de DHO, Liderança e Tecnologia**. A preservação desses vínculos é
permitida pelo modelo de dados, mas precisa de uma decisão operacional.

`api/middleware/policy.js:21` e `:25` exigem cargo ativo e a flag da página para
acesso derivado às ferramentas; super-admin tem exceção. Portanto, não se pode
inferir o acesso efetivo de todos esses usuários só porque sua role é admin.

Revisar as atribuições com os responsáveis, sem simplesmente reativar todos os
cargos históricos. Mostrar um aviso de cargo inativo na lista de usuários ajudaria.

### Conteúdo de produção

Não apareceram artigos públicos, cursos, notícias, lembretes, convites salvos ou
cards salvos nas consultas realizadas. No CMS existia um documento de teste em
Knowledge; Owner News não tinha documentos.

Os estados vazios não comprovam defeito de persistência. Eles impedem validar
buscas positivas, paginação e leitura completas. O inventário existente registra
a importação da Owner News como local, sem aplicação em produção; isso é coerente
com o que foi observado, e não evidência de uma importação live perdida.

### Documentação divergente

- `docs/product/feature-inventory.md:37` descreve saudação personalizada;
  `public/js/dashboard.js` e os testes atuais refletem a sua remoção.
- O inventário descreve o PDF Owner com 108 × 248,6 mm, enquanto
  `public/cards-pos/card-geometry.js:3` e a interface usam 108 × 250,68 mm.
- `AGENTS.md` pede compatibilidade Node 18; manifests, verificação e Dockerfiles
  atualmente exigem/usam Node 24.

Atualizar os contratos/documentos com a decisão vigente evita que uma revisão
futura classifique mudanças intencionais como regressões.

## 4. Frontend e backend: avaliação estrutural

### Pontos sólidos

- Fronteiras claras entre `public/`, `api/`, `cron/` e `nginx/`.
- Shell e navegação compartilhados, com lifecycle explícito para recursos das páginas.
- Firebase autentica; a API valida token revogado, e-mail verificado, admissão,
  desativação e habilitação pendente antes de entregar recursos.
- Políticas de permissões centralizadas; esconder um botão não é a única barreira.
- API e cron usam PostgreSQL; não houve motivo para usar uma conexão Supabase
  alheia ao ambiente do Portal.
- CMS possui contratos de revisões, assets privados e leitura publicada cobertos
  por testes locais; notificações possuem ledger e regras de agendamento testadas.
- HTTP público apresentou HSTS, CSP, `nosniff` e bloqueio de frames.
- Os checks locais cobrem autenticação, rotas, estados assíncronos, CMS,
  importação, convites, navegação, mídias, cron e contratos de schema.

### Melhorias estruturais recomendadas

1. **Padronizar estados de página:** seleção vazia, loading, erro de campo, erro
   de consulta, indisponibilidade de serviço e sucesso precisam ser independentes.
2. **Melhorar administração para uso diário:** busca por nome/e-mail e filtros de
   cargo, estado e perfil; filtro de cargos ativos/inativos; auditoria com ação
   legível, identidade do ator e filtros por período/ação.
3. **Unificar linguagem editorial:** trocar `Knowledge`, `draft`, `published`,
   `archived` e `Inspector` por termos consistentes em português na interface.
4. **Explicar edição simples versus CMS:** deixar claro onde editar metadados,
   anexos, corpo estruturado e publicação, com links contextuais entre as telas.
5. **Melhorar acessibilidade pontual:** `public/admin.html:94` não associa um nome
   acessível ao input de CSV. Evitar considerar os avisos automáticos de todos os
   demais inputs como defeitos: vários possuem labels associados no HTML.
6. **Adicionar confirmação de exportação PNG:** o fluxo termina em `link.click()`
   sem mensagem de sucesso. Diferenciar geração iniciada/concluída de confirmação
   de que um arquivo efetivamente foi salvo pelo navegador.
7. **Criar E2E com dados conhecidos:** a suíte local aprovada não cobre todas as
   transições reais identificadas aqui nem substitui homologação dos serviços.

## 5. Evidências automatizadas e HTTP

### Checks locais

| Verificação | Resultado |
| --- | --- |
| `npm run verify` | 537 testes aprovados; zero falhas, cancelados ou pulados. Sintaxe, scan de possíveis segredos e configuração do Compose aprovados. |
| `npm run security` | API: quatro ocorrências moderadas; cron: zero no escopo `omit=dev,optional`. Exit code de sucesso pelo limiar high. |
| Referências estáticas dos HTMLs | 16 HTMLs, 448 referências locais verificadas, nenhum destino local ausente. Não equivale a testar todos os links externos ou respostas HTTP. |
| Comparação de arquivos públicos | Os 15 HTMLs da raiz e scripts/estilos amostrados coincidiram em conteúdo com o local. Quatro diferenças textuais iniciais eram apenas o marcador BOM. Não prova a versão do backend. |

### HTTP sem credenciais

| Endpoint | Resultado |
| --- | --- |
| `/api/health` | 200, `status: ok` |
| `/api/ready` | 200, `status: ready` |
| `/api/users/me` | 401 |
| `/api/knowledge` | 401 |
| `/api/academy` | 401 |
| `/api/announcements` | 401 |
| `/api/reminders` | 401 |
| `/api/cms/documents` | 401 |
| `/api/cards` | 401 |
| `/api/pos-cards/cards` | 401 |
| `/api/job-titles` | 401 |

Essas respostas comprovam a barreira de autenticação nos endpoints consultados,
não a matriz completa de autorização entre usuários autenticados.

## 6. O que falta para aceitação ponta a ponta

- Contas de teste de leitor, admin granular, DHO autorizado, cargo sem acesso e
  conta desativada; verificar os dois lados de cada permissão.
- Criar, consultar, editar e remover registros de teste em cada módulo, conferindo
  persistência após recarga e comportamento de erro.
- Publicar/agendar/despublicar conteúdo de teste e validar sua circulação e mídia.
- Testar uploads válidos/inválidos, PDF protegido, substituição/crop e retenção.
- Recuperar e abrir os arquivos PNG/PDF exportados, verificando dimensões e conteúdo.
- Entregar convites, redefinição e lembretes em caixas de teste monitoradas.
- Validar cron/ledger, retries e não duplicação com o serviço e banco reais.
- Executar migrations em PostgreSQL descartável; validar backup/restore e logs
  operacionais no ambiente apropriado.
- Conferir teclado, leitor de tela e dispositivos físicos.

Funcionalidades documentadas como ausentes ou futuras — WhatsApp, LMS completo,
MFA/login social, dark mode, benefícios com resgate e integração Sólides liberada
ao público geral — não foram classificadas como botões quebrados desta versão.

## 7. Ordem de execução sugerida

1. Corrigir F01/F02 e revisar dependências F04, com regressões específicas.
2. Corrigir o Dashboard vazio e revisar cargos/conteúdo para a operação real.
3. Tratar layout/feedback de Cards Pós e buscas/ações administrativas.
4. Atualizar a documentação e executar a aceitação ponta a ponta com fixtures.

Somente o relatório e as capturas desta auditoria foram adicionados ao repositório;
nenhuma correção de aplicação ou alteração de deploy foi implementada.
