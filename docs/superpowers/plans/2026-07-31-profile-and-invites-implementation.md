# Plano de Implementacao: Perfil, Convites e Shell

Referencia: `docs/superpowers/specs/2026-07-31-profile-and-invites-design.md`

## 1. Preparacao e baseline

- Confirmar `origin/main` atualizado sem sobrescrever as alteracoes locais de
  UI ja existentes.
- Revisar os testes atuais de frontend, usuarios, SMTP e rotas protegidas.
- Manter separadas as alteracoes anteriores de UI e o novo conjunto de convite
  no commit final, sem reverter trabalho do usuario.

## 2. Remover saudacao do shell

Arquivos:

- `public/dashboard.html`
- `public/knowledge.html`
- `public/reminders.html`
- `public/academy.html`
- `public/benefits.html`
- `public/ombudsman.html`
- `public/profile.html`
- `public/solides.html`
- `public/admin.html`
- `public/js/auth.js`
- `public/js/profile.js`

Passos:

- Remover os spans `topbar-user` de todas as paginas autenticadas.
- Remover a funcao de renderizacao da saudacao e seus imports/chamadas, ou
  reduzi-la a um contrato sem efeito somente se algum consumidor legitimo
  permanecer.
- Ajustar o salvamento de perfil para nao procurar `topbar-user-name`.
- Adicionar uma invariante que rejeite `Olá,`, `Ola,` e `topbar-user-name` em
  paginas autenticadas e scripts de shell.

## 3. Revisar Meu Perfil

Arquivos:

- `public/profile.html`
- `public/js/profile.js`
- `public/css/components.css`
- `public/css/layout.css`

Passos:

- Separar visualmente `Bio` do cargo administrativo somente leitura.
- Retirar estilos inline repetidos somente nos controles tocados, usando os
  componentes existentes para nao ampliar o escopo.
- Garantir `type="submit"` ou `type="button"` em todos os botoes.
- Adicionar regioes de feedback inline para salvar perfil e foto, com
  `aria-live` e `aria-describedby` quando houver erro de campo.
- Marcar campos invalidos e focar o primeiro erro quando a validacao customizada
  falhar.
- Preservar `protectForm`, upload normalizado, remocao de foto, reset de senha e
  exportacao de dados.
- Limpar o valor do input de foto apos erro e manter o controle acionado
  utilizavel para nova tentativa.
- Validar em viewport mobile e em teclado os estados de avatar, formulario,
  seguranca e exportacao.

## 4. Alterar provisionamento para convite

Arquivos:

- `api/middleware/validation.js`
- `api/routes/users.js`
- `api/integrations/password-reset-email.js`
- `public/admin.html`
- `public/js/admin.js`

Passos:

- Alterar `validateUser(..., { creating: true })` para exigir e-mail e nome,
  mas nao aceitar senha no payload de criacao.
- Manter allowlist de campos e as validacoes atuais de role, contrato, PJ,
  cargo, telefone e permissoes.
- Criar a identidade Firebase sem senha inicial e com o nome informado.
- Inserir o registro PostgreSQL dentro da transacao atual.
- Gerar o link Firebase de definicao de senha para o e-mail cadastrado.
- Extrair ou adicionar um construtor de mensagem de convite no mailer, sem
  duplicar configuracao SMTP e sem incluir credenciais ou link na resposta API.
- Enviar o e-mail antes de confirmar o sucesso HTTP.
- Em erro de cargo, duplicidade, SMTP, transacao ou etapa posterior, executar
  rollback e exclusao compensatoria da identidade quando aplicavel.
- Usar resposta `409` para e-mail ja existente e mensagens seguras para o
  frontend.
- Preservar `manageUsers`, a regra de super-admin e a auditoria `user.create`.
- Confirmar com o SDK Firebase instalado se `createUser` sem `password` e
  `generatePasswordResetLink` sao suportados no ambiente atual; se a API exigir
  senha, usar uma senha aleatoria gerada server-side que nunca seja retornada,
  registrada ou enviada ao frontend.

## 5. Melhorar a experiencia de convite no Admin

Arquivos:

- `public/admin.html`
- `public/js/admin.js`
- `public/css/components.css`

Passos:

- Renomear `Novo usuário` para `Convidar usuário`.
- Remover `password-group` e qualquer tratamento de senha inicial do modal.
- Renomear titulo, textos auxiliares e botao para explicar que o destinatario
  definira a senha pelo e-mail.
- Mostrar ou esconder o dia PJ conforme o contrato, preservando o comportamento
  atual.
- Alterar o submit para enviar apenas o payload permitido e tratar:
  - sucesso com o e-mail convidado;
  - `400` de validacao;
  - `403` de permissao;
  - `409` de e-mail existente;
  - falha de SMTP/API/rede.
- Manter o modal aberto em erro, restaurar foco no primeiro campo relevante e
  desabilitar o botao durante o envio.
- Fechar o modal somente apos sucesso, atualizar a tabela e exibir toast/status
  acionavel.

## 6. Testes

Arquivos novos ou existentes:

- `tests/unit/password-reset-email.test.mjs`
- `tests/unit/api-routes.test.mjs`
- `tests/unit/api-security.test.mjs`
- `tests/unit/frontend-invariants.test.mjs`
- `tests/unit/operations-invariants.test.mjs`

Adicionar verificacoes para:

- convite sem senha no payload/frontend;
- link e mensagem de convite com remetente Ownerinc;
- Firebase sem senha exposta e PostgreSQL com o usuario correto;
- compensacao de Firebase/PostgreSQL em falha SMTP;
- e-mail duplicado sem registro parcial;
- autorizacao de `manageUsers` e super-admin para privilegios;
- ausencia da saudacao e do `topbar-user-name` nas paginas autenticadas;
- perfil com grupos de dados, cargo somente leitura e controles nomeados.

## 7. Verificacao e entrega

- Rodar `npm run verify`.
- Rodar `git diff --check`.
- Revisar `git diff` e `git status` para garantir que somente arquivos
  intencionais foram alterados.
- Nao fazer push ou deploy automaticamente; apresentar o resultado para
  aprovacao do usuario.
