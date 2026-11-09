# Aurora do login — verificação local em 2026-11-09

## Entrega e escopo

Implementada a especificação aprovada em
`docs/superpowers/specs/2026-11-09-login-aurora-design.md`, com os valores exatos
do brief da Task 1. Somente o final de `public/css/login.css` recebeu regras:
duas camadas fixas não interativas, gradientes roxo/laranja dos tokens existentes,
entrada única de 900 ms e composição estática com movimento reduzido.
O formulário continua opaco. Não foram modificados HTML, JavaScript de login,
tokens, autenticação, dependências ou páginas autenticadas.

Arquivos próprios:

- `public/css/login.css`: bloco aurora acrescentado após as 70 linhas existentes
  na árvore de trabalho; no recorte isolado, após as 55 linhas de `HEAD`.
- `tests/unit/login-aurora.test.mjs`: invariantes e isolamento do stylesheet.
- `tests/visual/check-login-aurora.mjs`: seis combinações de largura/movimento.
- Este relatório.
- `docs/superpowers/plans/2026-11-09-login-aurora.md`: plano aprovado, incluído
  no empacotamento sem alterar as marcações do controlador.

As alterações anteriores no login e os testes `login-approved-reference.test.mjs`,
`pending-registration.test.mjs`, `podfalar-brand-assets.test.mjs` e
`check-login-approved.mjs` foram preservados, sem edição por esta tarefa.

## Comandos executados e resultados

Os resultados e as capturas abaixo pertencem à **árvore de trabalho**, que inclui
alterações aprovadas anteriores ainda não commitadas no CSS, HTML, JavaScript,
assets e testes do login. Não validam a composição do commit isolado da aurora.

1. `node --test tests/unit/login-aurora.test.mjs`, antes do CSS: RED esperado,
   1 passou (isolamento), 2 falharam (ausência das camadas/gradientes).
2. `node --test tests/unit/login-aurora.test.mjs tests/unit/login-approved-reference.test.mjs tests/unit/pending-registration.test.mjs tests/unit/podfalar-brand-assets.test.mjs`:
   GREEN, 34 passaram, 0 falhas, 0 skips.
3. `node tests/visual/serve-conecta.mjs`: prévia apenas em `127.0.0.1:4178`,
   iniciada após confirmar ausência de listener nesta porta. Encerrada ao final.
4. `node tests/visual/check-login-aurora.mjs`: PASS, 6 casos
   (360, 402 e 1366 px × `reduce`/`no-preference`), sem overflow horizontal,
   sem bloqueio de rolagem e sem erros JavaScript. Recuperação/cadastro
   continuam acessíveis. Movimento normal: duas animações de 900 ms, uma
   iteração, ambas terminadas; movimento reduzido: nenhuma animação,
   transformação `none` e opacidade final 1.
5. `node tests/visual/check-login-approved.mjs`: PASS nas dez larguras
   320/360/402/768/769/1000/1001/1366/1440/1920, quatro estados por largura,
   40 auditorias axe sem violações WCAG A/AA. Também passaram foco/retorno,
   ordem por Tab, mostrar senha, contratos simulados, PodFalar em nova aba
   isolada e 360 × 480/568/667 com rolagem natural.
6. `npm.cmd run verify`, com `C:\Program Files\Git\bin` no início do PATH:
   PASS, 838 testes, 836 passaram, 0 falhas, 2 skips de semântica Linux
   (`flock` real e escapes por symlinks). Sintaxe, segurança e validação estática
   Compose concluídas; `verify: ok`. Nenhum serviço Docker foi iniciado/alterado.
   A execução passou com avisos preexistentes `MODULE_TYPELESS_PACKAGE_JSON`,
   inclusive nos módulos Cards Pós (`rich-text.js` e `preview-layout.js`) e
   Academy; não foram feitas alterações de código alheias à aurora para tratá-los.
7. `git diff --check`: PASS, sem saída.

Módulos externos utilizados, sem instalação no projeto:

```powershell
$env:PLAYWRIGHT_MODULE_PATH = 'C:/Users/Criação/AppData/Local/Temp/opencode/conecta-browser-tools/node_modules/playwright/index.mjs'
$env:AXE_MODULE_PATH = 'C:/Users/Criação/AppData/Local/Temp/opencode/conecta-browser-tools/node_modules/@axe-core/playwright/dist/index.mjs'
```

`VISUAL_OUTPUT` foi definido separadamente como
`C:/Users/Criação/AppData/Local/Temp/opencode/login-aurora-task-1` e
`C:/Users/Criação/AppData/Local/Temp/opencode/login-aurora-task-1-approved`.
Ambos contêm `results.json` e suas capturas.

## Inspeção visual e evidências

Foram abertas e lidas as capturas `login-360-reduce.png`,
`login-1366-reduce.png`, `login-360-no-preference.png` e
`login-1366-no-preference.png` no primeiro diretório de evidências acima.
Os gradientes aparecem discretos e atrás do conteúdo, com roxo no alto/esquerda
e laranja abaixo/direita; o cartão mantém a superfície opaca e os controles
legíveis. Nenhuma redução adicional de opacidade foi necessária.

Também foi inspecionado o painel de navegador OpenChamber em 390 × 844 e
1440 × 900, incluindo entrada/retorno de recuperação. A captura desktop de
1366 px foi aberta no painel de arquivos. Evidências adicionais do painel:

- `.openchamber/screenshots/login-aurora-task-1-mobile-2026-11-09T14-42-39-732.jpg`
- `.openchamber/screenshots/login-aurora-task-1-desktop-2026-11-09T14-45-02-583.jpg`

## Ajustes necessários no teste de navegador

O exemplo do brief precisou de dois ajustes de observação, sem mudar o CSS:
`getAnimations({ subtree: true })` inclui as animações dos pseudo-elementos;
sem a opção, o Chrome retornou zero. Com preenchimento `both`, o Chrome
serializa a transformação final `none` como matriz identidade. O teste confirma
identidade via `DOMMatrixReadOnly`, mantém `none` estrito em movimento reduzido
e acrescenta duração, iteração única e estado terminado. Não aceita
transformação residual nem animação contínua.

## Limites e checks não executados

- Prévia local com fixtures; não comprova Firebase/autenticação real,
  persistência, cadastro real, entrega de email ou acesso ao canal externo real.
- Inspeção executada no Chrome instalado, não em Safari/Firefox nem em aparelho
  físico com teclado virtual. Fallback de navegador sem `color-mix` não foi
  executado; a declaração não suportada mantém o fundo base existente por CSS.
- Os dois testes Linux citados foram explicitamente pulados no Windows.
- Sem produção, deploy, publicação, merge ou alterações de serviços.
- A faixa de prévia local nas capturas é injetada pelo servidor de fixtures;
  não pertence ao login publicado.

## Revisão de preservação

O prefixo inteiro anterior ao bloco aurora mantém SHA-256
`6589b8e11a444b21e2c338ee28e8baec24f8560df4f95e7e6e2ecb209958f3a7`, igual
ao arquivo lido antes da edição. Tokens, HTML, JavaScript de login e os dois
arquivos de referência aprovados também mantiveram seus hashes. O empacotamento
da aurora usa apenas o CSS de `HEAD` mais o sufixo aprovado, aplicado ao índice;
não inclui os hunks anteriores do login nem escreve no CSS da árvore de trabalho.
O plano é incluído como está; suas marcações continuam sob gestão do controlador.

## Integração isolada pendente

O commit de escopo restrito reúne o append CSS, os dois testes novos, este
relatório e o plano. **Esse recorte isolado ainda não foi validado em outra
worktree**. As capturas e os 34 testes direcionados/40 auditorias axe anteriores
não demonstram que o baseline commitado reproduza o login aprovado pendente.

Em particular, o teste visual foi exercitado sobre a composição aprovada ainda
não commitada, e a regressão `check-login-approved.mjs` e seus assets/testes de
referência não fazem parte deste commit. A nova worktree deve validar o recorte
isolado e decidir explicitamente sobre essa dependência de integração, sem
assumir que as capturas correspondem a `HEAD` mais aurora. Merge permanece
pendente; o checkout principal não foi alterado por este empacotamento.

Antes do commit de escopo restrito, `npm.cmd run verify` foi repetido na árvore
de trabalho completa: 838 testes, 836 passaram, zero falhas, dois skips Linux e
os avisos de módulos já descritos; `verify: ok`. Para cumprir a restrição desta
etapa de não executar Docker, seus diretórios foram excluídos apenas do PATH
do processo de verificação; Compose foi explicitamente pulado como indisponível.
Esse resultado não substitui a validação futura do commit isolado.
