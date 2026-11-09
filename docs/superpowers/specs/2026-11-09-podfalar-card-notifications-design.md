# PodFalar independente e nomenclatura Notificações

## Proposta aprovada

Separar o canal PodFalar do cartão de autenticação e substituir a nomenclatura
Lembretes por Notificações na interface do Portal.

## Login e PodFalar

- Manter a marca Conecta, o fundo aurora e os fluxos de autenticação atuais.
- Agrupar o cartão de acesso e o cartão PodFalar em uma mesma coluna.
- Posicionar o PodFalar fora do cartão de acesso, imediatamente abaixo, com
  espaçamento entre eles e a mesma largura externa; sua altura permanece compacta.
- Usar detalhes nas cores da logo original para identificar o cartão PodFalar,
  sem alterar os SVGs fornecidos nem competir com o formulário.
- Preservar os textos Canal de denúncias e Disponível sem login, a logo
  horizontal proporcional e o nome acessível do link.
- Preservar o destino Denouncefy, abertura em nova aba e noopener noreferrer.
- Manter um único canal público disponível nos estados de login, cadastro,
  recuperação e criação de senha, fora de todos os formulários.
- No mobile, manter os dois cartões alinhados, sem overflow horizontal,
  centralização do conjunto quando houver espaço e rolagem em telas baixas.

## Notificações

- Trocar o nome da área nos menus compartilhados e gerados, dashboard,
  administração, prévia e página de gerenciamento.
- Atualizar também singular, textos de ações, mensagens de carregamento,
  vazio, erro, exclusão, edição e nomes acessíveis associados à área.
- Ajustar concordância: Nova notificação, Editar notificação e equivalentes.
- Não alterar rotas reminders.html, endpoints, IDs, permissões, tabelas,
  processamento cron nem conteúdo persistido de notificações existentes.
- Atualizar documentação atual pertinente; registros históricos de entregas
  anteriores não precisam ser reescritos.

## Limites e verificação

Mudanças concentradas no frontend, gerador de shell, documentação e testes.
Sem deploy, Docker, alterações de banco ou integrações de produção.

Atualizar regressões de estrutura do login e nomenclatura. Conferir login e
estados secundários em desktop e mobile com fixtures locais, logo e link,
alinhamento dos cartões, foco e reflow. Verificar os textos da área de
Notificações, executar npm run verify e git diff --check. Resultados com
fixtures não comprovam autenticação real, envio de e-mail ou persistência.
