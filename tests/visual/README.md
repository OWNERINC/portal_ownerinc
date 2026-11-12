# Prévia visual Conecta

O servidor abaixo é exclusivo para inspeção local. Serve o frontend real com
substitutos de autenticação e dados claramente rotulados. Escuta somente em
`127.0.0.1`, recusa gravações e não encaminha requisições para serviços externos.
Não comprova Firebase, banco, entrega de email ou persistência em produção.

```sh
node tests/visual/serve-conecta.mjs
```

Abra `http://127.0.0.1:4178/dashboard.html`. Instale Playwright em um diretório
temporário externo ao projeto. Para registrar capturas e testar reflow, headings,
imagens, menu mobile e navegação persistente:

```sh
PLAYWRIGHT_MODULE_PATH=/caminho/externo/node_modules/playwright/index.mjs \
node tests/visual/check-conecta.mjs
```

O navegador padrão é Chrome instalado (`BROWSER_CHANNEL=chrome`).
`VISUAL_OUTPUT` altera a pasta de evidências; `VISUAL_WIDTHS=1920,402` restringe
uma repetição àquelas larguras. O padrão confere 1920, 402, 360, 768 e 1366 px.
Capturas e resultados ficam no diretório local ignorado da execução SDD.

Para auditoria automatizada WCAG A/AA, instale também `@axe-core/playwright` no
diretório externo e execute:

```sh
PLAYWRIGHT_MODULE_PATH=/caminho/externo/node_modules/playwright/index.mjs \
AXE_MODULE_PATH=/caminho/externo/node_modules/@axe-core/playwright/dist/index.mjs \
node tests/visual/check-conecta-accessibility.mjs
```

O relatório `accessibility.json` inclui violações e itens que exigem revisão
manual. `VISUAL_ROUTES=dashboard,knowledge` restringe as rotas dessa auditoria.
Ausência de violações automatizadas não substitui inspeção de teclado, foco,
alvos de toque e estados interativos.

### Login V3.5 revisado

`check-login-approved.mjs` confere as pranchetas P17D-R1 e P17M-R1 do arquivo
`Conecta-Ownerinc-V3.5-Aprovado.pen`: marca responsiva, frase de boas-vindas,
botões de largura igual e espaçamento de 12 px. O bloco público PodFalar fica
em cartão independente logo abaixo do cartão de acesso, com a mesma largura e
intervalo de 16 px, fora de todos os formulários, conforme a revisão solicitada
após a aprovação das pranchetas. Confere alinhamento nos quatro estados de acesso.
Confere também o carregamento da logo horizontal original do PodFalar, sua
largura de 108 px, proporção e nome acessível, sem distorções ou overflow.
Percorre login, recuperação e cadastro com senha em dez larguras de
320 a 1920 px, com axe WCAG A/AA e restauração do foco. No mobile, mede a
centralização vertical/horizontal do conjunto; em 360 × 480/568/667 px verifica
rolagem natural e acesso aos campos de login/cadastro e ao rodapé, sem cortes no topo. Isso não
substitui teste com teclado virtual em aparelho físico. Exercita ordem por Tab,
mostrar/ocultar senha, confirmação divergente sem envio, limpeza das senhas,
contratos de envio simulados e nova aba isolada do canal.

```sh
PLAYWRIGHT_MODULE_PATH=/caminho/externo/node_modules/playwright/index.mjs \
AXE_MODULE_PATH=/caminho/externo/node_modules/@axe-core/playwright/dist/index.mjs \
node tests/visual/check-login-approved.mjs
```

Aceita `VISUAL_ORIGIN` somente em `127.0.0.1`. `VISUAL_OUTPUT` escolhe a pasta de
capturas e `results.json`; o padrão usa `opencode/login-approved-visual` no
diretório temporário do sistema. Todas as gravações e a navegação externa são
substituídas no navegador: esse teste não envia emails nem acessa o canal real.

`check-conecta-interactions.mjs` usa a mesma variável `PLAYWRIGHT_MODULE_PATH`
para conferir detalhes, modais, Escape/retorno de foco, validação de filtros,
curso/aula e erro independente/retentativa do dashboard em 1920/402/360 px.
Também percorre AutoCard, Cards Pós, perfil, administração e dashboard no mesmo
documento, verificando a superfície do shell, fonte, heading único e reflow.

`check-conecta-editor-focus.mjs` percorre o formulário Vaga do AutoCard com
Tab/Shift+Tab em 360×874, 768×874 e 1366×768. Verifica os limites do viewport e
usa hit-testing para detectar controles focados cobertos pela barra de ações.

`check-pos-inline-viewport.mjs` verifica o editor inline dos Cards Pós com
redução sintética do visualViewport, offsets, restauração, abertura com área já
reduzida, mudança de breakpoint e descarte de listeners/overrides na navegação.
É uma regressão de geometria/oclusão; não representa teste em aparelho físico.

`compare-conecta-art.mjs` compara a árvore renderizada das artes de quatro
modelos AutoCard e dos dois Cards Pós em larguras iguais. Extraia o `public/`
da revisão-base em uma pasta temporária e sirva uma segunda instância:

```sh
VISUAL_PUBLIC_ROOT=/caminho/temporario/base/public PORT=4179 \
node tests/visual/serve-conecta.mjs
PLAYWRIGHT_MODULE_PATH=/caminho/externo/node_modules/playwright/index.mjs \
node tests/visual/compare-conecta-art.mjs
```

O servidor em 4178 continua servindo o checkout atual. A comparação registra
fontes, cores, geometria e capturas dos canvases, sem realizar exportação ou
gravação autenticada. Diferenças devem ser inspecionadas; somente executar o
script não comprova que as artes estão preservadas.
