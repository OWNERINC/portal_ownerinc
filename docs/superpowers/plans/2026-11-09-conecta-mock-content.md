# Conteúdo demonstrativo Conecta — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preencher a prévia local com lembretes, artigos, duas trilhas e exemplos nas demais páginas existentes.

**Architecture:** Fixtures exclusivamente em `tests/visual/`, separando conteúdo de projeções HTTP. O frontend real permanece intacto; o servidor local entrega as projeções compatíveis e recusa escritas.

**Tech Stack:** Node.js, ES modules, node:test e Playwright externo para inspeção.

## Global Constraints

- Não iniciar Docker, não acessar banco remoto, não alterar deploy e não publicar em produção.
- Exatamente duas trilhas internas, dois módulos e três aulas por módulo.
- “Postagens” serão representadas pelos artigos da Base de Conhecimento.
- Sem vídeos externos, persistência simulada ou reativação de CMS/notícias.
- Dados fictícios e limitações explicitamente identificados na prévia.
- Preservar `public/`, `api/`, `cron/` e `nginx/`.

## Arquivos e responsabilidades

- `tests/visual/conecta-content.mjs`: registros de artigos, usuários, benefícios e históricos.
- `tests/visual/conecta-academy-fixtures.mjs`: duas árvores de formação e projeções de currículo/aula/progresso.
- `tests/visual/conecta-fixtures.mjs`: seleção de rotas, filtros, datas, paginação e dados de lembretes/Sólides.
- `tests/visual/serve-conecta.mjs`: integração HTTP, totais e aviso de demonstração.
- `tests/unit/conecta-preview.test.mjs`: regressões das fixtures e isolamento HTTP.
- `tests/visual/check-conecta-content.mjs`: inspeção de conteúdo desktop/mobile.
- `tests/visual/README.md`: uso, inventário e limites.

### Task 1: Conteúdo e projeções coerentes

**Interfaces:** preservar `fixtureData(url) -> object|array|undefined` e `user`; acrescentar `fixtureResponse(url, now = new Date()) -> {data, total}|undefined` para o servidor e testes determinísticos.

- [x] Escrever testes de contagens, duas trilhas/currículos, detalhes desconhecidos, categorias, busca, limit/offset e datas relativas.

```js
const response = fixtureResponse(new URL('http://localhost/api/academy?limit=1'));
assert.equal(response.total, 2);
assert.equal(response.data.length, 1);
assert.equal(fixtureData(new URL('http://localhost/api/academy/lessons/missing')), undefined);
```

- [x] Executar `node --test tests/unit/conecta-preview.test.mjs` e confirmar falha antes de implementar.
- [x] Implementar os três módulos de fixtures. Derivar o progresso dos estados das seis aulas de cada curso, preservar IDs `culture`/`service` e a aula `culture-4` para compatibilidade com a inspeção existente. Usar `media: null` e descrições demonstrativas em aulas, sem prometer reprodução.
- [x] Preencher oito artigos, seis lembretes, usuários/cargos, benefícios, entregas e históricos; conferir nomes de campos nos consumidores antes de gerar cada objeto. Sólides retorna envelopes válidos de resumo, escala, ajustes e marcações, sempre sob o aviso de simulação.
- [x] Executar o teste direcionado e confirmar PASS.

### Task 2: Servidor seguro e verificação de navegador

**Interfaces:** o servidor consome `fixtureResponse(url)` e envia `X-Total-Count` do conjunto filtrado; continua expondo `fixtureData` a consumidores existentes.

- [x] Acrescentar testes HTTP por processo filho em porta livre, aguardando a mensagem de inicialização e encerrando no teardown.

```js
const response = await fetch(`${base}/api/knowledge?limit=1`);
assert.equal(response.headers.get('X-Total-Count'), '8');
assert.equal((await response.json()).length, 1);
assert.equal((await fetch(`${base}/api/knowledge`, { method: 'POST' })).status, 405);
assert.equal((await fetch(`${base}/api/academy/lessons/missing`)).status, 404);
```

- [x] Executar o teste direcionado, observar falha de total/paginação no servidor antigo, integrar `fixtureResponse` e ajustar o aviso para mencionar claramente ausência de gravações e integração real.
- [x] Criar inspeção Playwright com `PLAYWRIGHT_MODULE_PATH`: em 1366/402 px conferir conteúdo não vazio, artigo completo, filtro, lembrete, ambos os cursos e aulas, benefícios, administração e históricos de cards; registrar erros de página e overflow.
- [x] Executar a inspeção com o servidor de loopback, corrigindo somente fixtures/servidor se houver inconsistência. Não alterar o frontend para acomodar objetos inválidos.
- [x] Atualizar `tests/visual/README.md` com o inventário e os limites de mídia/escrita.
- [x] Executar `npm run verify`, `git diff --check` e os harnesses visuais existentes pertinentes; registrar o resultado e quaisquer limites de ambiente na resposta final.
