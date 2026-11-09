# PodFalar Login Implementation Plan

**Goal:** Substituir o botão de primeiro acesso por PodFalar, conforme o escopo aprovado.

**Architecture:** Link HTML nativo com o estilo existente, sem dependência de
Firebase para navegar. Remover apenas o listener do botão substituído e corrigir
as instruções relacionadas; preservar formulário e API de primeira senha.

**Tech Stack:** HTML, JavaScript ES modules e testes nativos de Node.js.

## Restrições

- URL exata: `https://app.denouncefy.com/portal/canaldedenunciaownerinc`.
- Nova aba com `rel="noopener noreferrer"`.
- Não realocar a criação da primeira senha; não alterar backend ou deploy.
- Não mesclar o PR nem contornar as regras de aprovação do GitHub.

## Execução nesta sessão

- [x] Adicionar regressão em `tests/unit/pending-registration.test.mjs` para o link
  PodFalar, seus atributos, ausência do botão/listener antigo e das instruções antigas;
  executar o teste isolado e confirmar falha antes da implementação.
- [x] Em `public/login.html`, substituir o botão por
  `<a class="forgot-link" href="https://app.denouncefy.com/portal/canaldedenunciaownerinc" target="_blank" rel="noopener noreferrer">PodFalar</a>`.
  Em `public/js/login.js`, remover o listener de `registration-password-link`.
  Nos dois arquivos, orientar confirmação de e-mail, aprovação e contato com suporte
  para a primeira senha, sem indicar o botão removido.
- [x] Documentar a limitação de acesso à primeira senha em
  `docs/product/feature-inventory.md`; executar o teste isolado e `npm run verify`,
  verificar `git diff --check` e revisar o diff.
- [ ] Commitar, publicar a branch e criar PR para `main`; conferir revisão e checks,
  registrar resultado e informar qualquer bloqueio de aprovação formal.
