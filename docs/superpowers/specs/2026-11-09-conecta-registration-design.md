# Conecta — cadastro com senha, confirmação de e-mail e aprovação

## Objetivo e decisão aprovada

Simplificar o cadastro pela própria pessoa: informar nome, e-mail e senha,
confirmar o endereço pelo link recebido e aguardar a aprovação administrativa.
Após a habilitação, entrar com o e-mail e a senha escolhida no cadastro.

O usuário confirmou nesta sessão a opção **Sem acesso até aprovação**. Não haverá
sessão de acompanhamento, tela autenticada de status nem acesso parcial ao Portal.
O e-mail é o login; não criar um nome de usuário separado.

Esta especificação descreve comportamento futuro. Sua aprovação não comprova
implementação, entrega de e-mail, publicação ou homologação em produção.

## Abordagens consideradas

1. **Manter a identidade Firebase desabilitada até a aprovação:** escolhida.
   Reutiliza a fronteira atual e a reconciliação de habilitação, acrescentando a
   senha inicial ao cadastro. O login bloqueado não distingue sozinho pendência
   de aprovação de desativação; a mensagem deve ser honesta sobre essa limitação.
2. **Permitir autenticação somente para uma tela de status:** não escolhida.
   Daria acompanhamento individual, mas exige uma nova superfície autenticada e
   separação adicional de autorização. Não faz parte desta entrega.

## Jornada e interface

### Cadastro

- Em `public/login.html`, coletar nome, e-mail, senha e confirmação da senha.
  Preservar identidade Conecta, navegação por teclado, foco visível e feedback
  anunciado por tecnologia assistiva. Não redesenhar o restante da página.
- Senha e confirmação usam `autocomplete="new-password"`. Permitir colar e usar
  gerenciador de senhas. Eventuais controles de mostrar/ocultar têm nome acessível
  e estado explícito; não exigir digitação cega da confirmação.
- Política desta entrega: entre 12 e 128 unidades UTF-16, contadas da mesma forma
  pelo HTML e pelo JavaScript no servidor. Aceitar espaços e Unicode, sem trim,
  normalização ou regras obrigatórias de maiúsculas/símbolos. Rejeitar senha
  composta apenas por espaços em branco. Não mudar senhas de contas existentes.
- A confirmação deve coincidir exatamente com a senha e é validada no navegador;
  não precisa ser transmitida. O backend sempre valida a própria senha.
- Bloquear envio duplicado e navegação entre formulários durante o envio. Ao
  terminar a tentativa ou abandonar o formulário, limpar os campos de senha;
  falhas preservam nome/e-mail e pedem que a senha seja informada novamente.
- Não salvar senha em storage, URL, analytics ou mecanismos de restauração de
  formulário do aplicativo. Não criar persistência de sessão no cadastro.
- Confirmar recebimento somente após o contrato HTTP esperado. Texto proposto:
  “Se o cadastro puder ser processado, você receberá um link para confirmar seu
  e-mail. Após a confirmação, aguarde a aprovação do administrador. Quando seu
  acesso for liberado, entre com seu e-mail e a senha escolhida no cadastro.”
  A resposta não promete entrega na caixa de entrada nem revela duplicidades.

### Confirmação e aprovação

- Usar o link de verificação do Firebase e o SMTP já existentes. Atualizar as
  instruções da mensagem para explicar a espera por aprovação, sem orientar uma
  segunda criação de senha para os novos cadastros.
- A confirmação deve funcionar com a identidade desabilitada; isso é requisito
  de homologação externa, não uma conclusão baseada apenas nos mocks atuais.
  Não habilitar contas antecipadamente para contornar falha do provedor.
- A listagem administrativa continua distinguindo e-mail não confirmado de
  confirmado. A aprovação exige confirmação consultada no Firebase, permissão
  `manageUsers`, cargo ativo, contrato CLT/PJ e dia válido para PJ.
- A aprovação cria somente `viewer`, sem privilégios administrativos, persiste
  a decisão e habilita a mesma identidade. Nunca altera sua senha.
- Preservar `firebase_enable_pending`: erro ou resultado ambíguo não é apresentado
  como acesso já liberado. A reconciliação existente conclui a habilitação sem
  reativar contas desativadas localmente.
- Não acrescentar e-mail automático de aprovação nesta entrega. A comunicação da
  liberação continua administrativa; a interface não promete esse aviso.

### Login e recuperação

- Antes da liberação, não abrir dashboard, shell privado ou área de status.
  Preservar as verificações de token, e-mail, admissão, conta ativa e habilitação
  concluída na API, mesmo se alguém tentar acessar os recursos diretamente.
- O erro Firebase de conta desabilitada não prova aprovação pendente. Usar uma
  mensagem que oriente confirmar o e-mail e aguardar aprovação quando houver
  cadastro recente, sem afirmar o estado individual de uma conta desconhecida.
- O caminho normal dos novos cadastros não tem “Primeiro acesso: criar senha”.
  A opção de recuperação de senha passa a orientar também quem fez um cadastro
  antigo sem senha, evitando manter dois caminhos concorrentes na tela inicial.
- `/api/auth/password-reset` mantém a recuperação atual para usuários ativos.
  Para uma solicitação pendente, reutiliza a rotina protegida de envio de link
  apenas quando o e-mail estiver confirmado, a identidade estiver desabilitada e
  não houver limpeza pendente. O link não aprova nem habilita a conta.
- Preservar `/api/auth/registration-password` para compatibilidade com clientes
  antigos, com os limites e verificações existentes. Não apagar o endpoint.
- A recuperação responde genericamente para e-mail inexistente, não confirmado,
  pendente ou ativo; não revela qual ramo foi executado. Contas administrativamente
  desativadas não recebem um caminho de reativação pela recuperação.

## API, identidade e persistência

### Criação inicial

- `POST /api/auth/register` aceita estritamente `name`, `email` e `password`, todos
  obrigatórios. Preservar os limites atuais de nome/e-mail, a normalização apenas
  desses dois campos e a rejeição de campos desconhecidos e privilégios enviados.
- Passar a senha validada exclusivamente para `firebaseAuth.createUser`, mantendo
  `emailVerified: false` e `disabled: true`. Não usar senha aleatória nesse caminho.
- PostgreSQL continua recebendo somente os metadados da solicitação; não criar
  coluna de senha, hash, cópia cifrada ou confirmação. Firebase gerencia a senha.
- Manter HTTP 202 com `{ status: 'accepted', state: 'received' }` para recebimento
  e duplicidades tratadas, 400 para entrada inválida e 429/503 para limites ou
  indisponibilidade conhecidos. Não retornar senha, token ou link de ação.
- Clientes antigos que enviam cadastro sem senha recebem 400 e devem recarregar
  a página atualizada. Isso não invalida solicitações já persistidas.

### Repetição, recuperação de falhas e concorrência

- Uma nova chamada pública com o mesmo e-mail nunca pode executar `updateUser`
  para definir uma senha ou substituir a senha já escolhida. Isso permitiria
  tomada de conta antes de a vítima abrir o link de confirmação.
- Se uma solicitação e sua identidade já existem, preservar UID, senha, estado
  de confirmação, data da solicitação e decisão administrativa. Reenviar apenas
  a verificação ainda necessária, respeitando a janela de limitação existente;
  não reabrir aprovação ou rejeição automaticamente.
- Para solicitação pendente cuja identidade desapareceu, permitir reconstrução
  somente depois de revalidar ausência de usuário admitido, conflitos e limpeza
  pendente sob os mesmos locks. A nova identidade usa a senha da nova tentativa,
  começa não verificada/desabilitada e exige nova confirmação por e-mail.
- Identidade Firebase sem solicitação correspondente não pode ser adotada
  automaticamente só por compartilhar e-mail e estar desabilitada. Retornar
  resposta pública genérica e deixar a investigação/reconciliação operacional
  resolver sua origem; não trocar sua senha nem apagar identidade sem prova de
  propriedade. Isso restringe a recuperação automática atual de órfãos.
- Preservar ordem determinística dos locks de e-mail/UID, limites por IP, teto
  global, limite de operações externas simultâneas e verificações de referências
  entre cadastros, convites, importações e usuários admitidos.
- Em falha de SMTP ou persistência, compensar apenas identidades comprovadamente
  criadas pela operação. Commit ou rollback ambíguo exige reconciliação/limpeza
  durável com checagem de referências; nunca apagar identidade possivelmente
  admitida. Não enfileirar senha nem a reexecutar em background.
- Links expirados podem ser reenviados pela repetição do cadastro pendente, dentro
  dos limites. Deixar claro na ajuda que repetir o cadastro não redefine a senha;
  para isso, usar a recuperação após confirmar o e-mail.

### Proteção de credenciais

- Senhas trafegam por HTTPS em produção e existem somente na memória transitória
  da requisição e no serviço Firebase. Não registrar body, senha, confirmação,
  link de ação ou erro completo do provedor com dados sensíveis.
- Auditoria e logs usam apenas eventos/códigos limitados e `requestId`. Revisar
  os caminhos de erro tocados, inclusive compensação e tratamento global, para
  impedir que entradas ou exceções contendo credenciais sejam serializadas.
- Administradores continuam sem acesso à senha. Nenhuma senha aparece em e-mail,
  exportação, resposta administrativa ou fixture capturada.

## Compatibilidade e limites da mudança

- Cadastros antigos pendentes mantêm UID e confirmação existentes. Podem criar
  senha pela recuperação; a aprovação continua sujeita às mesmas exigências.
- Cadastros antigos já aprovados usam a recuperação de conta ativa, como hoje.
- Não inferir que uma senha foi escolhida por ler um hash/metadado Firebase nem
  alterar retroativamente credenciais para uniformizar o histórico.
- Convites administrativos, CSV, superadministrador inicial e gerenciamento de
  privilégios mantêm seus fluxos e contratos. Convites ainda usam o link próprio
  de criação de senha; essa exceção não deve ser removida dos seus templates.
- Não há necessidade de migration ou mudança de schema nesta abordagem. Se a
  implementação encontrar necessidade real, revisar o desenho antes de adicionar
  armazenamento ou marcadores, especialmente qualquer material de credencial.
- Preservar rejeição, retenção, auditoria e separação entre `api/`, `cron/`,
  `public/` e `nginx/`. Não alterar deploy, serviços em execução ou produção.

## Verificação e critérios de aceite

1. Validação de senha ausente, tipos inválidos, limites, Unicode/espaços,
   confirmação divergente, campos extras e privilégios. API não depende do HTML.
2. Criação Firebase recebe exatamente a senha escolhida e permanece desabilitada
   e não verificada. SQL, logs, auditoria e respostas não contêm credenciais.
3. Repetir cadastro não muda senha, nome, aprovação, confirmação ou idade da
   solicitação existente; não assume identidade órfã. Reconstrução de identidade
   ausente e falhas ambíguas mantêm as salvaguardas de referências e limpeza.
4. Confirmação sem aprovação não libera acesso; aprovação sem confirmação falha;
   aprovação completa preserva senha/UID e admite apenas `viewer`. Falha de enable
   mantém acesso bloqueado até reconciliação, respeitando desativação concorrente.
5. Recuperação cobre pendentes antigos/novos e usuários ativos, sem habilitar
   contas, vazar existência ou afetar convites/CSV. Endpoint legado continua seguro.
6. Frontend cobre senha/confirmar, feedback de erro, contrato exato de sucesso,
   limpeza dos campos, prevenção de envios concorrentes, teclado e ausência da
   etapa extra no fluxo normal. Preservar a navegação segura após login.
7. Rodar regressões de cadastro, autenticação, convite, importação e mailer,
   `npm run verify` e `git diff --check`. Atualizar inventário funcional e
   documentação de arquitetura/operação para refletir o comportamento implementado.
8. Homologação externa posterior, com autorização e contas de teste: confirmar
   e-mail de identidade desabilitada, abrir link expirado/repetido, aprovar no
   Portal e entrar com a senha original. Registrar evidência separada de SMTP
   aceito, mensagem recebida e acesso real. Mocks não comprovam essas etapas.

## Fora do escopo

Nome de usuário separado, login social, MFA, sessão de acompanhamento, aprovação
automática, aviso novo de aprovação, mudança do fluxo de convite/CSV, migração de
senhas, publicação automática e retomada da prévia local cancelada na porta 4180.
