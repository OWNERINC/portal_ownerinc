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

### Conteúdo demonstrativo

As páginas compartilham registros fictícios consistentes, sem inserir conteúdo
no banco ou alterar o frontend de produção:

- **6 lembretes**, com próximos eventos calculados a partir da data local de São
  Paulo e exemplos de histórico de entregas (nenhum email é enviado).
- **8 artigos completos** na Base de Conhecimento: integração, pessoas, tecnologia
  e atendimento. Representam as “postagens” da demonstração, sem feed de notícias
  ou reativação do CMS. Os textos não são políticas oficiais.
- **2 trilhas na Academy**, cada uma com dois módulos e seis aulas:
  `culture` — Primeiros passos na Ownerinc (3/6 concluídas) e `service` —
  Atendimento e relacionamento com o cliente (não iniciada). Ambas ficam
  disponíveis à pessoa fictícia. Formação inicial/por cargo são grupos visuais;
  esta prévia não comprova autorização por cargo real.
- **6 usuários, 5 cargos, 2 solicitações de cadastro** e exemplos de auditoria;
  dados pessoais fictícios e emails sob `example.test`.
- **4 benefícios**, **4 AutoCards** e **2 Cards Pós**, incluindo histórico e
  abertura de itens salvos. As artes e os renderizadores existentes não mudam.
- Resumo, jornada semanal, ajustes e marcações **simulados** na página Sólides.
  A integração administrativa continua desativada: não há consulta externa,
  vínculo real, alteração de ponto ou aprovação real de ajustes.

Catálogos, filtros, busca e paginação usam os contratos existentes; totais são
calculados antes do recorte da página. IDs desconhecidos retornam 404.
O dashboard usa os mesmos lembretes e o progresso da trilha de integração.

As aulas têm descrições próprias, mas **não têm vídeo reproduzível**. O player
existente exibe seu estado de mídia não suportada, acompanhado da descrição
demonstrativa. Criação, edição, exclusão e conclusão continuam retornando 405;
as telas de edição podem ser abertas para inspeção, mas nada é salvo. Login,
email, exportação autenticada, progresso e integração reais não são validados.

Para conferir os conteúdos e filtros no navegador em 1366/402 px:

```sh
PLAYWRIGHT_MODULE_PATH=/caminho/externo/node_modules/playwright/index.mjs \
node tests/visual/check-conecta-content.mjs
```

`PORT` escolhe outra porta para o servidor. `VISUAL_ORIGIN` informa essa origem
a `check-conecta-content.mjs`, `check-conecta.mjs`,
`check-conecta-interactions.mjs` e `check-conecta-accessibility.mjs` (padrão:
`http://127.0.0.1:4178`). Reinicie o processo do servidor após editar as fixtures:
os módulos de dados são carregados na inicialização, sem hot reload.

Os testes de dados e isolamento HTTP não precisam de Playwright:

```sh
node --test tests/unit/conecta-preview.test.mjs
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
