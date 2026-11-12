# Polimento do editor — Implementation Plan

## Steps
- [x] Padronizar controles e organizar cabeçalho, metadados e barras do editor.
- [x] Verificar estados desktop/mobile e preservar os fluxos de edição/mídias.
- [x] Revisar diff, obter revisão fresca e atualizar a prévia local/documentação.

**Goal:** aplicar o polimento completo aprovado em
`docs/superpowers/specs/2026-11-10-pages-editor-polish-design.md`.

**Architecture:** CSS e markup locais do editor, sem modificar dados ou contratos.
Um implementador possui runtime/unitários; primário possui verificação visual e documentos.

**Tech Stack:** HTML/CSS/JavaScript, Manrope e tokens Conecta existentes.

## Global constraints

- Preservar todas as alterações não commitadas do piloto e do primeiro lote.
- Não editar backend, migrations, publicação/CAS/autorizações ou demais domínios.
- Não adicionar dependências, fontes ou assets; não commitar/merge/deploy.
- Não parar/reiniciar o preview local que contém edições sintéticas do usuário.
- Controles de 44 px, sem overflow global, foco visível e reduced motion.

## Task 1 — Polimento localizado

Files: `public/css/pages.css`, `public/pages/editor.js`, opcional
`public/pages/dom.js` se a composição de classes exigir correção Pages-only;
testes unitários Pages para os wrappers/labels alterados. Não alterar renderer,
ProseMirror, Sortable ou estado/salvamento sem achado funcional que justifique.

- Reusar os tokens de `public/css/tokens.css` e o padrão `.btn` de components.css.
- Selects seguem fonte, padding, borda e fundo dos inputs. Handle recebe estilo
  deliberado, sem botão nativo, mantendo classe e comportamento de arraste.
- Criar wrappers dedicados de cabeçalho/ações de seção/linha/bloco. Não destruir
  os nós ProseMirror ao reagrupar; callbacks continuam resolvendo IDs atuais.
- Metadados e ações usam grid/flex explícito com gaps 8/12/16/24 px. Inputs e
  selects alinhados; status não disputa espaço com ações principais.
- Toolbar contextuais agrupam movimento/apresentação/formatação. Presets visíveis
  usam rótulos em português, conservando seus valores internos e nomes de automação.
- Estilos novos escopados ao editor para não propagar mudanças ao Portal/leitor.

## Task 2 — Verificação primária

Primary owns `tests/visual/check-pages-polish.mjs` e capturas temporárias. Conferir
as cinco larguras, controles selecionados, geometrias, fontes, gaps, reflow e axe.
Repetir `tests/visual/check-pages.mjs`, `tests/visual/check-pages-pilot.mjs` e
`npm run verify`. Conferir bundle, shell e `git diff --check`.

O preview atual serve os arquivos do disco: atualizar a aba sem reiniciar o servidor.
Não recarregar se o usuário tiver edição local não salva; abrir aba nova para inspeção.

## Task 3 — Revisão e handoff

Revisão fresca read-only do diff localizado e das evidências; corrigir achados e
repetir checks. Registrar evidências na documentação Pages e mostrar a prévia
atualizada ao usuário. Não declarar que CSS bem formado ou testes funcionais
substituem inspeção visual de botões/alinhamento.
