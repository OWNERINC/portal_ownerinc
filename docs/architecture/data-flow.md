# Fluxo de Dados

## Requisição autenticada

1. O usuário autentica no Firebase pelo frontend.
2. `public/js/auth.js` inclui o token Bearer na requisição.
3. A API valida o token pelo Firebase Admin.
4. A API cria ou carrega o perfil correspondente no PostgreSQL.
5. A rota aplica a permissão necessária e consulta ou altera o banco.

## Cadastro pendente

1. O visitante envia nome e e-mail para `/api/auth/register`; a rota aplica validação estrita e rate limit.
2. A API cria uma identidade Firebase desabilitada com senha aleatória não exposta e uma linha `pending_registrations` dentro da transação PostgreSQL.
3. O Firebase gera o link de verificação e o SMTP existente envia a mensagem; falhas compensam a identidade criada e, se a exclusão externa falhar, gravam `firebase_cleanup_queue` para retry pelo cron. Cadastro pendente, convites/importações e o worker compartilham locks transacionais determinísticos por e-mail/UID; o cleanup verifica referências locais antes de apagar.
4. Depois da confirmação do e-mail, o solicitante usa `Primeiro acesso: criar senha` para criar a própria senha pelo fluxo do Firebase; a solicitação continua pendente de aprovação e não aceita role ou permissões privilegiadas.
5. A aprovação exige cargo ativo e `contract_type`; PJ persiste `is_pj=true` com dia de nota de 1 a 31, enquanto CLT persiste `is_pj=false` e `pj_due_day=NULL`. O usuário nasce como `viewer`, marca a habilitação externa como pendente e o helper de enable bloqueia a linha local, decide o estado ativo e atualiza o Firebase na mesma seção crítica; falhas ou commit ambíguos mantêm o marcador para retry/reconciliação sem reativar contas localmente desativadas. A rejeição registra auditoria e remove a identidade, mantendo-a desabilitada e sujeita à retenção/retry se a remoção externa falhar.

## Convite e importação administrativa

1. Um operador autorizado do DHO cria o usuário pelo convite administrativo, com cargo ativo, contrato validado e sem senha fornecida pela administração; o e-mail de convite orienta a criação da primeira senha.
2. A identidade e o usuário local são compensados em falhas de SMTP, PostgreSQL ou commit ambíguo. Uma identidade Firebase reutilizada de outro fluxo não é apagada; a fila de limpeza só remove identidades criadas pela operação quando não houver referência local e o worker tiver adquirido o lock compartilhado.
3. A importação CSV valida preview e confirmação com o mesmo normalizador de contrato, sempre cria `viewer` sem permissões privilegiadas e registra cada linha no job durável. O job só pode ser consultado/reprocessado pelo operador que o criou ou por superadmin; IDs inválidos retornam 400, jobs expirados retornam 410 e jobs de terceiros não são revelados. Após reload, a UI consulta o ID persistido por usuário autenticado e limpa referências 404/410. Commit ambíguo mantém a linha `processing`, registra `last_error`, persiste o UID conhecido e reconcilia por UID/e-mail sem apagar identidade reutilizada; UID com cleanup pendente não consome tentativa nem vira `failed`.

## Lembretes

1. O cron executa diariamente às 08:00 no fuso de São Paulo.
2. O serviço seleciona lembretes ativos para o dia corrente.
3. Os destinatários são resolvidos a partir dos usuários no PostgreSQL.
4. O Resend SMTP envia o email.
5. O resultado é registrado em `notifications_log`.

## Conteúdo CMS

1. O editor cria uma revisão `draft` validada; cada nova gravação recebe uma
   versão imutável e atualiza somente o ponteiro do draft.
2. Publicar ou agendar adquire o lock de assets antes do documento, confirma
   que a revisão selecionada ainda é o draft atual e valida novamente os
   assets referenciados. Uma seleção concorrente retorna `409` sem alterar a
   publicação.
3. O leitor promove scheduled vencido com a mesma ordem de lock somente depois
   de validar blocos e assets. Revisão inválida é arquivada e auditada sem
   substituir a publicação anterior. A leitura consulta somente `published` e
   descarta revisão inválida; busca, resumo, detalhes e lembretes usam
   `blocksToText`/blocos validados; texto legado só existe como fallback quando
   não há documento CMS.
4. Unschedule arquiva o scheduled quando já existe draft mais novo;
   unpublish arquiva published e scheduled, deixando o draft independente.
   Assim, um lembrete despublicado não é enviado pelo fallback legado.
5. Exclusão de uma fonte remove seu `cms_document` e revisões, tornando os
   assets inacessíveis até a retenção remover arquivos sem referências.

6. A edição legacy de PDF altera somente o único bloco PDF sem ambiguidade.
   Quando há múltiplos blocos PDF, a operação é rejeitada e o Editor CMS é o
   caminho obrigatório para escolher o bloco correto.

## Uploads

1. O usuário autenticado envia uma imagem para `/api/upload/photo`.
2. A API grava o arquivo no volume `uploads_data`.
3. A URL relativa é armazenada no perfil.
4. O Nginx encaminha `/uploads/` para a API.

## Sólides DP/Ponto

1. O dashboard consulta `/api/solides/me/status`; a rota responde 404 quando o
   estágio ou o UID não permitem descobrir a integração.
2. A API resolve o UID autenticado em `solides_employee_links`; o navegador
   nunca informa o `employeeId` consultado.
3. A API chama somente hosts HTTPS configurados para Employer e Punch com o
   token Basic mantido no servidor.
4. As respostas são normalizadas por allowlist antes de chegar ao frontend;
   CPF, PIS, PIN, fotos, localização e payloads brutos são descartados.
5. A página Minha Jornada apresenta dados read-only e mantém link de
   contingência para a aplicação oficial.
6. O estágio padrão `off` não exige token e mantém todas as ferramentas ocultas.
