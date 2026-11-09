# PodFalar no login

## Decisão aprovada

Substituir somente o botão “Primeiro acesso: criar senha” no login por um
link “PodFalar” para
`https://app.denouncefy.com/portal/canaldedenunciaownerinc`, mantendo o estilo
atual e abrindo em nova aba com `rel="noopener noreferrer"`.

O usuário escolheu não realocar o acesso à criação da primeira senha. O fluxo
existente no backend e seu formulário não serão removidos neste ajuste. O
listener do botão substituído deve ser retirado para evitar erro JavaScript.
As instruções de cadastro devem deixar de indicar o botão que não existe mais,
sem prometer envio de senha por um mecanismo que não foi implementado.

## Escopo e aceite

- Alterar apenas login, instruções relacionadas, teste e documentação pertinente.
- Manter login, cadastro e recuperação de senha existentes, sem alterar a API.
- Verificar rótulo, URL, isolamento da nova aba e ausência do listener antigo.
- Executar `npm run verify` e `git diff --check`.
- Abrir PR separado, revisar o diff e conferir os checks do GitHub.
- Tentar aprovação formal apenas se permitida para a identidade autenticada;
  não contornar a proibição do GitHub de aprovar o próprio PR.
- Não mesclar nem publicar em produção, pois isso não foi solicitado.
