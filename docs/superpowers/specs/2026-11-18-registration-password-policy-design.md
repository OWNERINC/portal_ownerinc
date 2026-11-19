# Senha de cadastro com oito caracteres e maiúscula

## Escopo aprovado

- Novos cadastros aceitam senhas de 8 a 128 unidades UTF-16, com pelo menos uma
  letra maiúscula Unicode. Não exigir números, símbolos nem letras minúsculas.
- Não normalizar, aparar ou registrar senhas. Manter confirmação exata.
- Aplicar a mesma regra no formulário e na validação da API.
- Exibir erro textual quando os campos não forem válidos, inclusive quando a
  validação nativa impediria o evento de envio. Preservar bloqueio de envios
  concorrentes e limpeza das senhas após tentativa ou abandono.
- Não alterar senhas existentes, login, recuperação de senha, aprovação,
  Firebase, banco, limites de tráfego ou scripts de publicação.
- Não incluir timeout de rede nesta mudança.

## Abordagem

Modificar a validação existente e seus testes, sem criar outro serviço ou
dependência. No formulário, controlar a validação no evento de envio para que
o Portal possa apresentar um erro antes de limpar os campos de senha. Manter
as restrições HTML como informação para navegadores e gerenciadores de senha.
Usar `reportValidity()` para os demais campos e mostrar também uma mensagem
textual no formulário. Não enviar requisição quando os campos forem inválidos.

Alterar apenas a tela deixaria a API recusando senhas de oito caracteres.
Alterar apenas o mínimo manteria o bloqueio silencioso. A abordagem aprovada
atualiza tela, API e retorno de validação em conjunto.

## Verificação

- Rejeitar menos de oito caracteres, mais de 128 e ausência de maiúscula.
- Aceitar oito caracteres com maiúscula, inclusive maiúscula acentuada.
- Preservar espaços e Unicode sem normalização.
- Testar confirmação divergente e campos inválidos com mensagem visível,
  sem requisição, seguidos de nova tentativa válida.
- Atualizar documentação operacional com a nova regra.
- Executar `npm run verify` e `git diff --check`.
- Não publicar nem modificar serviços de produção como efeito implícito.
