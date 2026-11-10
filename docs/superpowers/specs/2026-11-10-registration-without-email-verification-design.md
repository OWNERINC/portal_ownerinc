# Cadastro com senha e aprovação, sem confirmação de email

## Decisão aprovada

Retirar a confirmação obrigatória de email dos novos cadastros. A pessoa informa
nome, email, senha e confirmação da senha no cadastro e aguarda aprovação
administrativa. Após a aprovação e a habilitação concluída, entra com a senha
escolhida. Não há acesso parcial nem aprovação automática.

Este documento substitui, para esta mudança, a exigência de confirmação de email
do fluxo atual. Não comprova implementação nem publicação em produção.

## Segurança e autorização

- Email passa a ser identificador de login, não prova de posse da caixa postal.
  A aprovação administrativa é a fronteira de admissão; o operador deve conferir
  a identidade e o endereço informado antes de aprovar.
- Não marcar `emailVerified: true` artificialmente para novos cadastros. A
  identidade nasce com `emailVerified: false` e `disabled: true`.
- Retirar o requisito de email verificado da aprovação e da autorização da API.
  Preservar token Firebase válido e não revogado, admissão no PostgreSQL, conta
  local ativa, habilitação concluída e permissões de cada operação.
- Aprovação exige `manageUsers`, cargo ativo e contrato CLT/PJ válido; cria
  somente `viewer`. Preservar locks, auditoria e reconciliação de habilitação.
- Recuperar ou criar senha nunca aprova nem habilita uma conta.
- Senha existe apenas na memória transitória e no Firebase. Não persistir em
  PostgreSQL, filas, storage do navegador, URLs, logs, auditoria ou emails.

## Cadastro e repetição

- `POST /api/auth/register` aceita estritamente `name`, `email` e `password`.
  Preservar validação e normalização atuais de nome/email e proteção contra
  campos privilegiados. Senha não sofre trim nem normalização.
- Senha tem entre 12 e 128 unidades UTF-16 e não pode ser composta apenas por
  espaços em branco. Aceitar espaços e Unicode, sem regras de composição.
- Frontend valida confirmação exata, usa `autocomplete="new-password"`, permite
  colar e gerenciadores de senha, bloqueia envios concorrentes e limpa senhas
  após cada tentativa ou abandono do formulário.
- Criar identidade com a senha escolhida, desabilitada e não verificada. Não
  gerar ou enviar link de confirmação. Recebimento mantém HTTP 202 com
  `{status: 'accepted', state: 'received'}`; duplicidades não revelam existência.
- Repetição pública nunca troca a senha nem reabre aprovação/rejeição de uma
  solicitação existente; preserva UID, nome, estado e idade da solicitação.
- Não adotar automaticamente identidade órfã apenas pelo email. Reconstrução de
  identidade ausente de solicitação ainda pendente exige locks, ausência de
  usuário admitido/conflitos/cleanup e usa a senha da nova tentativa.
- Preservar limites de requisição/operações externas e compensação durável de
  identidades comprovadamente criadas pela operação. Resultado ambíguo exige
  reconciliação sem apagar identidade potencialmente admitida.

## Aprovação, login e recuperação

- Listagem administrativa apresenta solicitações pendentes de aprovação sem
  condicionar a ação à confirmação do email. Remover mensagens e estados que
  orientam aguardar a confirmação antes de aprovar.
- Remover a etapa separada de criação de senha do fluxo normal de cadastro.
  Mensagem de sucesso orienta aguardar aprovação e usar a senha escolhida.
- Login de conta desabilitada informa que o acesso pode aguardar aprovação ou
  estar desativado, sem afirmar o estado individual de conta desconhecida.
- `/api/auth/password-reset` atende usuários admitidos ativos mesmo sem email
  verificado. Também permite definir senha de solicitação ainda pendente,
  mantendo identidade desabilitada, correspondência com a solicitação e ausência
  de cleanup. Este ramo atende cadastros antigos sem senha conhecida.
- Preservar `/api/auth/registration-password` como compatibilidade, sem exigir
  email verificado e sem habilitar conta. Respostas continuam genéricas.
- Não permitir recuperação como caminho para reativar conta administrativamente
  desativada. Preservar checagens locais e de habilitação.
- Links antigos de confirmação não são mais necessários nem liberam acesso.
  Não adicionar aviso automático de aprovação nesta entrega.

## Limites

- Não alterar convites administrativos, importação CSV ou bootstrap do primeiro
  superadministrador, exceto testes compartilhados indispensáveis à regressão.
- Não alterar schema nem adicionar armazenamento de credenciais.
- Preservar Node 18 e fronteiras `api/`, `cron/`, `public/` e `nginx/`.
- Não alterar scripts de deploy, produção ou serviços em execução. Não iniciar
  Docker ou usar banco remoto. Portal e Ownerinc Brain permanecem separados.

## Verificação

- Testar validação de senha, campos extras, confirmação divergente, Unicode e
  espaços; backend não depende da validação HTML.
- Comprovar em testes que o cadastro não gera/envia confirmação, passa a senha
  apenas ao Firebase e mantém a conta desabilitada/não verificada.
- Cobrir duplicidade, órfãos, identidade ausente, cleanup e resultados ambíguos,
  sem substituição de senha ou reabertura de decisões.
- Aprovar email não verificado deve funcionar; sem aprovação ou com conta
  desativada/habilitação pendente, acesso continua bloqueado.
- Cobrir recuperação de usuários ativos e pendentes antigos, sem habilitação,
  enumeração pública ou regressão em convites/importação.
- Atualizar documentação funcional e de arquitetura. Rodar `npm run verify` e
  `git diff --check`. Separar evidência local de homologação externa: não afirmar
  entrega real de email, autenticação real ou publicação sem teste autorizado.
