# CMS Drag and Drop do Portal

## Objetivo

Criar um CMS baseado em blocos reordenáveis para todas as áreas editoriais do
Portal: Base de Conhecimento, Academia, Benefícios, Comunicados e Avisos e
Lembretes.

## Arquitetura

O CMS terá um documento editorial e revisões versionadas. Os registros atuais
de conhecimento, academia, benefícios e lembretes continuam sendo a fonte dos
metadados operacionais e recebem uma ligação por `content_type` e `source_id`.
Comunicados e avisos terão um tipo editorial próprio.

Cada documento poderá ter rascunho, uma revisão publicada e uma publicação
agendada. Conteúdos antigos sem revisão continuam usando seus campos textuais
atuais como fallback, sem migração destrutiva.

O editor será nativo do Portal, com blocos reordenáveis por arrastar e soltar.
Não haverá HTML arbitrário nem canvas livre. A prévia e a página publicada
usarão o mesmo renderer seguro.

## Áreas e Permissões

- Base de Conhecimento: `manageKnowledge`.
- Academia: `manageAcademy`.
- Benefícios: `manageBenefits`.
- Comunicados e Avisos: `manageKnowledge` inicialmente.
- Lembretes: `manageReminders`.

Usuários com a permissão da área podem criar rascunhos, editar, publicar,
agendar, cancelar agendamento e despublicar. Leitura continua respeitando as
regras atuais de autenticação, área, público e estado ativo.

## Blocos do MVP

- `heading`: título ou subtítulo;
- `paragraph`: texto simples;
- `list`: lista ordenada ou não ordenada;
- `callout`: informação, alerta ou destaque;
- `image`: imagem autenticada com texto alternativo;
- `divider`: separador visual;
- `link`: link ou botão com URL HTTPS;
- `pdf`: documento protegido com visualização e download autenticados;
- `video`: URL HTTPS segura ou mídia hospedada.

Cada bloco terá schema estrito, limite de tamanho e ordem explícita. Imagens e
PDFs usarão armazenamento privado do Portal; URLs públicas externas serão
permitidas somente para links e vídeos validados.

## Publicação

- `draft`: somente autores autorizados e administradores;
- `published`: conteúdo visível pelas telas normais da área;
- `scheduled`: revisão futura com data UTC e publicação automática quando
  consultada após o horário, sem expor o rascunho antes disso.

Publicação, agendamento, cancelamento, despublicação e exclusão de revisão
serão auditados. Uma revisão publicada não será alterada diretamente; uma nova
revisão será criada para cada edição posterior.

Lembretes mantêm `trigger_day`, `target_users` e `channel`. O cron renderiza a
revisão publicada como texto simples, usando o fallback `description` quando
não houver revisão editorial.

## Compatibilidade

- Artigos atuais continuam renderizando `content` até serem editados no CMS.
- Cursos continuam mantendo `url`, `category`, `order` e `active`.
- Benefícios continuam mantendo empresa, categoria, ordem e estado ativo.
- Lembretes continuam com a lógica atual de recorrência, público, retries e
  `notifications_log`.
- Nenhuma tabela ou conteúdo existente será apagado no rollout inicial.

## Segurança

- APIs administrativas exigem autenticação e a permissão correspondente.
- Conteúdo publicado não aceita scripts, HTML livre ou URLs inseguras.
- PDFs e imagens privadas passam por endpoints autenticados.
- O backend valida blocos novamente mesmo quando o editor já validou no cliente.
- Logs não registrarão conteúdo integral, tokens ou dados de upload.

## Rollout

1. Criar migration para documentos, revisões e comunicados.
2. Criar schemas de blocos e API de rascunho/publicação.
3. Integrar leitura publicada e fallback nas cinco áreas.
4. Criar editor Drag and Drop e preview administrativo.
5. Rodar migration/testes em PostgreSQL real.
6. Publicar via CI e validar criação, publicação, agendamento e fallback no
   ambiente live.
