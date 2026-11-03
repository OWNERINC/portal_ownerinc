# OWN-38 — baseline pré-Payload em 240dee0

## Identificação e finalidade

- Projeto: P-OWN-3; issue: OWN-38; marco: M2 — Retrocesso seguro.
- Execução: 2026-11-03; início registrado no Linear em `2026-11-03T13:56:18.390Z`.
- Executor: Luna XHigh.
- Repositório: `https://github.com/OWNERINC/portal_ownerinc.git`.
- Finalidade: registrar a origem pré-Payload antes de qualquer remoção.
- Referência de implementação: `rewrite/portal-sem-cms`.
- Referência documental: `docs/own-38-pre-payload-baseline`.
- Commit medido: `240dee0a9553a5d7c397ae907b3fb75493eb08c7`.
- O documento foi criado de forma nova para OWN-38. O baseline M1 não foi copiado, mesclado nem cherry-picked.

## Gates de entrada

- OWN-36 foi revalidada como `Done`.
- OWN-37 foi revalidada como `Done`.
- M1 foi revalidado como aprovado com exceção explícita no comentário Linear `0966f350-8be6-43ed-a399-9f93911544e3`.
- Inventário M1 publicado em `8fc3afc74f8e626b6a4d689e44cff615f51c3050`: [arquivo imutável](https://github.com/OWNERINC/portal_ownerinc/blob/8fc3afc74f8e626b6a4d689e44cff615f51c3050/docs/reviews/portal-cleanup-branch-inventory.md).
- Referência documental anterior de OWN-36: `tiownerinc/own-36-freeze`, commit `3780779e9da3e273f790a7cf130b75502ca80c98`.
- OWN-39 permaneceu bloqueada e não foi iniciada.

### Preservação M1 revalidada

| Referência | Hash observado |
| --- | --- |
| `origin/main` | `a6d863e74908e7888d9fc99ee9cb82bb3d7edca5` |
| `archive/payload-platform-2026-11-03` | `a6d863e74908e7888d9fc99ee9cb82bb3d7edca5` |
| `archive/payload-pr82-2026-11-03` | `7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9` |
| `tiownerinc/own-36-freeze` | `3780779e9da3e273f790a7cf130b75502ca80c98` |
| `tiownerinc/own-37-branch-inventory` | `8fc3afc74f8e626b6a4d689e44cff615f51c3050` |
| peeled `payload-platform-frozen-2026-11-03` | `a6d863e74908e7888d9fc99ee9cb82bb3d7edca5` |
| peeled `payload-pr82-frozen-2026-11-03` | `7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9` |

Os objetos anotados das tags foram `c84860f9d09903be9525fe246bc39752c3d1a765` e `d0c9cd8f792b1e6d5a8d4316cc37c0e942a7f960`, respectivamente. A divergência preexistente entre `main` local (`2e004b347cff00750e0733501e4e8008e44f884a`) e `origin/main` foi preservada; nenhuma delas foi usada como origem.

### PR #82

- URL: [OWNERINC/portal_ownerinc#82](https://github.com/OWNERINC/portal_ownerinc/pull/82).
- Estado revalidado: `CLOSED`.
- `mergedAt`: `null`.
- `headRefName`: `fix/portal-final-acceptance`.
- `headRefOid`: `7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9`.
- Base: `main`.

## Isolamento e preservação

- Worktree novo: `C:\Users\Criação\.local\share\opencode\worktree\1d3818751ec06812d576140b7db36d298a97e7bd\portal-sem-cms`.
- A criação usou origem explícita, nunca `main`/default branch:
  `git -C <checkout-protegido> -c core.autocrlf=false worktree add -b rewrite/portal-sem-cms <worktree> 240dee0a9553a5d7c397ae907b3fb75493eb08c7`.
- Branch inicial: `rewrite/portal-sem-cms`.
- HEAD inicial: `240dee0a9553a5d7c397ae907b3fb75493eb08c7`.
- Colisão de branch local/remota e de caminho: nenhuma; o diretório não existia e não estava registrado como worktree.
- Checkout protegido antes da criação: branch `fix/payload-admin-news-read`, HEAD `8a89c4022bf5bca4aebce3e89ba19be2c3e9d8bc`.
- Checkout protegido: status inicial continha somente os quatro screenshots não rastreados indicados abaixo; nenhum foi movido, adicionado, apagado ou alterado.
- Fotografia inicial: 27 worktrees registrados. Os estados de HEAD, branch e status de cada worktree foram capturados fora do repositório; todos foram preservados.

### Screenshots preservados

| Arquivo | Tamanho | SHA-256 |
| --- | ---: | --- |
| `.openchamber/screenshots/linear-agent-history-2026-11-03T12-18-25-493.jpg` | 101230 | `41a4778313501339542736739d6973f35789681bdbd7694cf13dbe6e2b4ec925` |
| `.openchamber/screenshots/linear-delete-agent-2026-11-03T12-25-28-010.jpg` | 22216 | `9d15e93690edf5c6945b82e72b8281b875a591600284d1e382e6801a9b600a34` |
| `.openchamber/screenshots/linear-menu-open-2026-11-03T12-16-57-602.jpg` | 230818 | `19f9629bdfbb71217db735e881b672897de04a13c27111533bfb338965122377` |
| `.openchamber/screenshots/linear-project-actions-2026-11-03T12-16-45-306.jpg` | 226606 | `f0dead2ef4deb6b8c3f22ac97294afd409c7f88f9a856b1bf290c84eb54ab090` |

## Prova da fronteira

- `git rev-parse HEAD` = `240dee0a9553a5d7c397ae907b3fb75493eb08c7`.
- `f078489bfed4f56df914796915e7163cbe85280c` existe e seu pai direto é `240dee0a9553a5d7c397ae907b3fb75493eb08c7`.
- `git merge-base --is-ancestor f078489bfed4f56df914796915e7163cbe85280c HEAD` retornou **exit code 1**, a prova esperada de que o primeiro commit Payload não é ancestral da linha nova.
- `git ls-tree HEAD -- cms` teve saída vazia.
- `Test-Path cms` = `False`.
- O CMS legado ainda existe em caminhos históricos do commit-base, incluindo `api/cms/` e `public/cms.html`; essas remoções não começaram em OWN-38.

## Documentos e arquivos lidos antes da escrita

Foi lido o plano local somente leitura `C:\Users\Criação\.opencode\plan\2026-11-03-portal-sem-payload-sem-cms.md`, o plano central [Portal · Plano central de limpeza e retrocesso pré-Payload](https://linear.app/ownerinc/document/portal-plano-central-de-limpeza-e-retrocesso-pre-payload-8501668b725f), OWN-36, OWN-37, OWN-38 e OWN-39, incluindo os handoffs e a exceção M1.

No commit-base `240dee0a9553a5d7c397ae907b3fb75493eb08c7` foram lidos:

- `AGENTS.md`;
- `README.md`;
- `docs/product/brief.md`;
- `docs/architecture/overview.md`;
- `docs/architecture/boundaries.md`;
- `docs/operations/local-development.md`;
- `package.json`, `api/package.json` e `cron/package.json`;
- `scripts/verify.mjs`;
- `.github/workflows/ci.yml` e `.gitignore`.

## Ambiente

- Node: `v24.15.0` (`C:\Program Files\nodejs\node.exe`).
- npm: `11.12.1` (`C:\Program Files\nodejs\npm.cmd`).
- PowerShell: `5.1.26100.9711`.
- OS: `Microsoft Windows NT 10.0.26200.0`, arquitetura `AMD64`.
- Bash: indisponível; `bash.exe` encontrou WSL sem `/bin/bash` (`CreateProcessCommon:818`). O `verify` não executou as verificações Bash condicionadas a essa disponibilidade.
- Docker Compose: disponível (`v5.6.1`). O `verify` executou somente validação de configuração; nenhum container, serviço, banco ou emulador foi iniciado.
- O commit-base exige Node 24 (`>=24 <25` na raiz/API e `24` no cron). O `AGENTS.md` ainda menciona Node 18; essa divergência histórica foi registrada e não foi alterada. Esta execução não demonstra compatibilidade integral com Node 18.
- Após o bootstrap: `api/node_modules` e `cron/node_modules` presentes; `node_modules` da raiz e `cms/node_modules` ausentes. O bootstrap instalou somente API e cron.

## Comandos e resultados

Todos os comandos abaixo foram executados no worktree novo, sem iniciar runtime.

| UTC | Comando | Exit | Resultado |
| --- | --- | ---: | --- |
| `2026-11-03T14:00:32.018Z`–`14:00:46.905Z` | `npm run bootstrap` | 0 | API e cron instalados; manifests e árvore versionada permaneceram sem mudanças. |
| `2026-11-03T14:00:58.344Z`–`14:02:04.582Z` | `npm run verify` | 0 | 1108 testes; 1106 PASS, 0 FAIL, 0 cancelados, 2 SKIP; segurança, DHO e Compose concluídos. |
| `2026-11-03T14:02:04.582Z`–`14:02:04.671Z` | `node scripts/generate-public-shell.mjs --check` | 0 | Shell público consistente sem escrever arquivos. |
| `2026-11-03T14:02:04.671Z`–`14:02:04.761Z` | `git diff --check` | 0 | Sem erros de whitespace. |

Os dois skips do `verify` foram os checks explicitamente condicionados a semântica Linux: `Linux real flock excludes a concurrent receiver and times out; waiting resolves the new release under lock` e `Linux rejects symlink escape paths for release, runtime, backup, lock and required files`.

O bootstrap registrou avisos de depreciação para `node-domexception@1.0.0`, `glob@10.5.0` e `uuid@9.0.1`. Os audits informativos da instalação encontraram 20 vulnerabilidades na API (13 moderate, 6 high, 1 critical) e 1 moderate no cron. Nenhum `npm audit fix` foi executado.

Nota de instrumentação: uma captura preliminar da sessão chamou `npm.cmd` sem argumentos por erro do helper de captura e retornou 1; ela não é considerada o bootstrap. O comando literal `npm run bootstrap` acima foi executado depois e retornou 0.

## Falhas e limitações

- Não houve falha funcional no baseline: `npm run verify`, `generate-public-shell --check` e `git diff --check` ficaram verdes.
- Os dois skips Linux são limitações observadas da plataforma; não foram convertidos em PASS.
- Bash/WSL indisponível impediu apenas a cobertura Bash condicional do verificador; isso não foi tratado como falha de runtime.
- Os avisos de audit/depreciação são achados preexistentes da instalação. OWN-38 não atualizou dependências nem corrigiu runtime.
- O verify local não comprova PostgreSQL real, Firebase, Nginx efetivo, autenticação real, SMTP externo, reprodução de mídia, deploy, produção ou compatibilidade Node 18.
- Não foram iniciados Docker, API, cron, PostgreSQL, Firebase Emulator, migrações, banco remoto ou serviços externos.
- Nenhuma correção foi incorporada por OWN-38. A limpeza da interface CMS, Owner News, Payload e dependências pertence às issues seguintes.
- Logs brutos e snapshots de preservação foram mantidos fora dos checkouts em `C:\Users\Criação\AppData\Local\Temp\opencode\own-38-20261103T140010Z-6907f711`; esse caminho local não substitui a evidência versionada deste documento.

## Publicação inicial

- A branch de implementação foi publicada por push normal, sem PR e sem alvo `main`:
  `git push --set-upstream origin refs/heads/rewrite/portal-sem-cms:refs/heads/rewrite/portal-sem-cms`.
- Hash local: `240dee0a9553a5d7c397ae907b3fb75493eb08c7`.
- Hash remoto: `240dee0a9553a5d7c397ae907b3fb75493eb08c7`.
- Upstream: `origin/rewrite/portal-sem-cms`.
- Ahead/behind: `0/0`.
- Não foi aberto PR contra `main`.

## Escopo de alterações

- Na branch de implementação `rewrite/portal-sem-cms`: zero arquivos versionados alterados; HEAD permaneceu exatamente em `240dee0a9553a5d7c397ae907b3fb75493eb08c7`.
- Na referência documental desta branch: único arquivo versionado adicionado por OWN-38: `docs/reviews/portal-cleanup-baseline.md`.
- Nenhum documento M1 foi incorporado.
- Não houve alteração em aplicação, API, cron, frontend, Nginx, deploy, migrations, banco, uploads, produção, default branch ou serviços.

## Handoff para OWN-39

- Origem obrigatória: `rewrite/portal-sem-cms` em `240dee0a9553a5d7c397ae907b3fb75493eb08c7`.
- Worktree isolado: `C:\Users\Criação\.local\share\opencode\worktree\1d3818751ec06812d576140b7db36d298a97e7bd\portal-sem-cms`.
- Baseline desta execução: o commit documental desta referência, cujo hash será registrado no comentário final de OWN-38 após publicação.
- A implementação será recolocada ao final na branch `rewrite/portal-sem-cms`, limpa e ainda em `240dee0a9553a5d7c397ae907b3fb75493eb08c7`.
- A URL imutável deste arquivo será publicada no Linear após o commit documental.
- O M2 está pronto para revisão, mas OWN-38 deve ficar em `In Review`, não `Done`, até validação coordenadora das evidências e dos skips Linux.
- OWN-39 não está liberada por esta execução; não foi iniciada. Interface CMS, Owner News e demais remoções permanecem intocadas.
