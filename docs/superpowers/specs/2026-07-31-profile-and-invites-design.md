# Perfil, Convites e Shell de Navegacao

Data: 31 de julho de 2026
Status: aprovado pelo usuario

## Objetivo

Remover a saudacao personalizada do shell autenticado, revisar a experiencia de
Meu Perfil e substituir a criacao administrativa com senha inicial por um
convite real enviado por e-mail.

O convite aceitara qualquer endereco de e-mail valido. O Firebase continuara
sendo a autoridade de identidade, e o PostgreSQL continuara controlando a
admissao, role e permissoes do Portal.

## Fora de escopo

- Cadastro publico.
- Convite por dominio ou allowlist de dominios.
- Sistema proprio de tokens, tabela de convites ou link de autenticacao customizado.
- Alteracao do modelo de permissoes ou da regra de autorizacao server-side.
- Reenvio automatico em massa ou rastreamento de abertura do e-mail.

## Decisoes de produto

### Shell autenticado

- Remover o texto `Ola, nome` de todas as paginas autenticadas.
- Manter o titulo contextual da pagina no topbar.
- Remover a dependencia funcional do nome exibido no topbar; o carregamento do
  usuario continua necessario para autenticacao e conteudo, nao para saudacao.
- Preservar o shell mobile, o drawer, o skip link e o indicador de pagina ativa.

### Meu Perfil

A pagina sera organizada em quatro blocos de leitura:

1. Foto e acoes do avatar.
2. Dados pessoais editaveis: nome, bio, WhatsApp e LinkedIn.
3. Cargo na Ownerinc, exibido como informacao somente leitura quando existir.
4. Seguranca e dados: redefinicao de senha e exportacao.

O campo editavel sera apresentado como `Bio`, sem misturar cargo administrativo
com descricao pessoal. O salvamento tera feedback inline e acessivel para
sucesso, falha de API e validacao nativa. Upload, substituicao e remocao de
foto terao estados explicitos de carregamento, sucesso e erro, sem perder o
foco do controle acionado.

### Convite administrativo

O fluxo sera exposto como `Convidar usuario` e usara os campos atuais de
provisionamento, exceto senha:

- Nome.
- E-mail.
- Cargo.
- Tipo de contrato.
- Dia de nota para PJ, quando aplicavel.
- WhatsApp.
- Perfil e permissoes, apenas quando a autorizacao do administrador permitir.

O botao principal sera `Enviar convite`. A UI nao exibira nem solicitara senha
inicial.

## Fluxo tecnico do convite

1. O administrador abre o dialogo `Convidar usuario`.
2. O formulario valida nome, e-mail, contrato, cargo, dia PJ e permissoes.
3. A API cria a identidade Firebase sem senha inicial, com nome e e-mail.
4. A API insere o usuario no PostgreSQL usando a mesma politica atual de role e
   permissoes.
5. A API gera um link seguro de definicao de senha pelo Firebase.
6. O mailer existente envia a mensagem de convite com remetente
   `Portal Interno Ownerinc`.
7. A API retorna sucesso somente depois de concluir persistencia e envio.
8. A UI fecha o dialogo, atualiza a tabela e mostra o endereco convidado.

A identidade criada nao tera senha utilizavel antes de o convidado concluir o
link. O convite usara o destino de login existente do Portal.

### Falhas e compensacao

- E-mail invalido: rejeicao de formulario, sem chamada de API.
- E-mail ja cadastrado no Firebase: `409`, sem criar registro duplicado.
- Cargo invalido ou inativo: `400`, sem deixar identidade orfa.
- Falha no SMTP: rollback do registro PostgreSQL e exclusao compensatoria da
  identidade Firebase; a UI informa que o convite nao foi criado.
- Falha de commit ou de qualquer etapa posterior: executar a compensacao
  existente e registrar o erro sem expor credenciais ou link.
- Falha de rede no frontend: manter o dialogo aberto e liberar o botao. Se a
  API ja tiver confirmado o envio, uma nova tentativa retornara conflito pelo
  e-mail existente; a UI deve orientar o administrador a consultar a lista de
  usuarios antes de tentar outro convite.

O endpoint continuara protegido por `manageUsers`, e mudancas de role ou
permissoes continuarao exigindo super-admin conforme a politica atual.

## Contratos de interface

- `POST /api/users` deixara de exigir `password` na criacao e passara a enviar o
  convite como parte da operacao.
- O payload de criacao preservara os campos de perfil existentes, sem adicionar
  segredo de senha no frontend.
- O e-mail de convite tera assunto e texto distintos do fluxo de redefinicao,
  explicando que o acesso foi provisionado e que o destinatario deve definir a
  senha.
- A resposta de sucesso permanecera sem retornar senha, token ou link privado.

## Validacao e testes

- Teste de autorizacao: apenas `manageUsers` cria convite; role e permissoes
  seguem a regra de super-admin.
- Teste de criacao: Firebase e PostgreSQL recebem os dados esperados sem
  senha inicial enviada pelo frontend.
- Teste de e-mail: assunto, remetente, destinatario e link seguro corretos.
- Teste de compensacao: falha no envio remove a identidade e desfaz o registro.
- Teste de duplicidade: e-mail existente retorna conflito sem alterar conta.
- Testes de frontend: nenhuma pagina autenticada renderiza a saudacao
  personalizada; o dialogo usa `Enviar convite`, nao possui campo de senha e
  mostra estados de sucesso/erro.
- Testes de perfil: campos, upload/remocao de foto, feedback de salvamento,
  redefinicao de senha e exportacao continuam acessiveis.
- Rodar `npm run verify` antes de qualquer push.

## Criterios de aceite

1. Nenhuma area autenticada mostra `Ola, nome`.
2. Um administrador autorizado consegue enviar convite para qualquer e-mail
   valido sem definir senha inicial.
3. O destinatario recebe um e-mail com link para definir a senha e consegue
   entrar no Portal apos concluir o fluxo.
4. Falhas de validacao, duplicidade, SMTP e rede possuem mensagens acionaveis.
5. A pagina de perfil distingue dados editaveis, cargo, seguranca e exportacao.
6. O comportamento existente de autorizacao, auditoria, compensacao e protecao
   contra dados orfaos permanece preservado.
