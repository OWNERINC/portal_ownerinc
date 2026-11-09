# Fundo aurora no login do Conecta

## Objetivo e direção aprovada

Adicionar um fundo aurora discreto somente ao login do Portal. Manter a base
clara e usar roxo e laranja da identidade Conecta, sem reproduzir o fundo preto
e a paleta multicolorida da demonstração React enviada como referência.

## Arquitetura e escopo

O frontend permanece estático em `public/`, conforme
`docs/architecture/overview.md`. O efeito será implementado em CSS nativo,
localizado em `public/css/login.css`. Não serão instalados React, Tailwind,
TypeScript, shadcn, Framer Motion ou Lottie. A pasta `components/ui` não é
necessária para esta adaptação: ela é uma convenção de projetos React/shadcn,
não um requisito para reproduzir o efeito na arquitetura atual.

Usar pseudo-elementos decorativos no fundo da página, sem novos elementos
interativos, dados, props, estado JavaScript ou providers. O conteúdo existente
deve ficar acima das camadas decorativas. Nenhuma regra deve alterar os tokens
globais nem alcançar as páginas autenticadas.

## Aparência e movimento

- Preservar `--bg` (`#F7F6F2`) como base e usar gradientes radiais de baixa
  opacidade derivados de `--primary` (`#2A275E`) e `--accent` (`#E84F1C`).
- Manter o painel do formulário opaco, com sua superfície atual, garantindo
  legibilidade de campos, mensagens e ações.
- Aplicar uma entrada única e suave, com duração de até um segundo, animando
  somente opacidade e transformação. Não haverá movimento contínuo.
- Com `prefers-reduced-motion: reduce`, eliminar animações e transformações
  decorativas, mantendo a composição estática final.
- Evitar filtros de desfoque animados e grandes superfícies desnecessárias;
  obter bordas suaves prioritariamente pelos próprios gradientes.

## Preservação de comportamento e trabalho existente

Preservar logos, textos, espaçamentos estruturais, formulário de login,
cadastro, recuperação de senha, criação da primeira senha e acesso público ao
PodFalar. Não modificar a autenticação nem `public/js/login.js`.

As alterações locais já existentes nos arquivos de login, assets, documentação
e testes pertencem ao trabalho em andamento e não devem ser descartadas,
sobrescritas ou incluídas por acidente em commits desta tarefa.

## Responsividade, acessibilidade e fallback

As camadas decorativas não recebem foco e usam `pointer-events: none`. Devem
ficar contidas no viewport sem introduzir rolagem horizontal, cortar mensagens
ou impedir rolagem vertical em formulários mais altos que a tela. Preservar os
breakpoints e a ordem de leitura atuais em desktop e celular.

O efeito não carrega recursos externos. Sem suporte a animações, a página deve
continuar funcional com fundo estático; sem gradientes, a cor de base permanece.
Não há novos erros de rede, estados de carregamento ou persistência associados.

## Verificação e critérios de aceite

- Acrescentar testes de regressão para o isolamento do efeito no login,
  camadas não interativas e tratamento de movimento reduzido, seguindo os
  padrões existentes de `tests/unit/`.
- Inspecionar o login em desktop e celular, incluindo largura de 360 px,
  verificando entrada/final estático, legibilidade, ordem de camadas, ausência
  de overflow e preservação dos estados de formulário.
- Usar a prévia local existente quando disponível, sem iniciar Docker nem
  acessar serviços de produção. Uma prévia com fixtures não comprova
  autenticação real ou envio de emails.
- Executar `npm run verify` e `git diff --check` antes da entrega.
- Atualizar a documentação pertinente com os resultados efetivamente
  observados, distinguindo limitações de validação.

## Fora de escopo

Migração do frontend, componentes TSX, tema escuro, aurora contínua, animação
Lottie, imagens de banco, novos ícones, alterações de API/banco, scripts de
deploy, publicação e alterações nas demais páginas do Portal.
