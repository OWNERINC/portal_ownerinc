# Inventário de branches antes da limpeza do Portal

**Issue:** OWN-37 · Inventariar e limpar branches com segurança
**Projeto:** P-OWN-3 · Portal  -  limpeza e retrocesso pré-Payload
**Snapshot principal:** 2026-11-03T13:46:42.723Z
**Branch documental:** `tiownerinc/own-37-branch-inventory`
**Base exigida:** `3780779e9da3e273f790a7cf130b75502ca80c98` (origin/tiownerinc/own-36-freeze)

> Documento somente documental: nenhuma limpeza física ou alteração de runtime foi autorizada ou executada.

## Resultado executivo

- **KEEP:** 19; **REVIEW:** 14; **DELETE_SAFE:** 0.
- **Exclusões:** zero. Nenhum `git push origin --delete`, `git branch -D` ou equivalente foi executado.
- **Force/rewrite:** zero force-push, reset, stash, rebase, merge, gc, prune ou expiração de reflog. `main`, `archive/*`, OWN-36, a branch documental e todos os worktrees foram preservados.
- O parecer Astra Medium aprova **zero exclusões**. `REVIEW` significa handoff conservador por ausência de autorização específica futura; não é bloqueio do handoff para OWN-38 quando os arquivos, hashes, worktrees e referências de recuperação estão comprovados.
- O snapshot encontrou alterações em worktrees ocupados e 13 commits preexistentes não alcançáveis sem reflogs. Esses gates impedem qualquer limpeza física, mas não impedem este inventário documental.

## Pré-condições e preservação

- OWN-36 está **Done** no Linear; OWN-37 foi movida para **In Progress** antes do inventário e recebeu comentário inicial.
- `origin/main` e `archive/payload-platform-2026-11-03` = `a6d863e74908e7888d9fc99ee9cb82bb3d7edca5`.
- `archive/payload-pr82-2026-11-03` = `7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9`.
- `origin/tiownerinc/own-36-freeze` e worktree OWN-36 = `3780779e9da3e273f790a7cf130b75502ca80c98`.
- PR #82: `CLOSED`, `mergedAt=null`, head `7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9`; nenhuma PR aberta foi retornada pelo comando completo.
- Tags anotadas: `payload-platform-frozen-2026-11-03` objeto `c84860f9d09903be9525fe246bc39752c3d1a765`, peeled `a6d863e74908e7888d9fc99ee9cb82bb3d7edca5`; `payload-pr82-frozen-2026-11-03` objeto `d0c9cd8f792b1e6d5a8d4316cc37c0e942a7f960`, peeled `7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9`.
- A branch documental foi criada com `git worktree add -b tiownerinc/own-37-branch-inventory ... 3780779...` e publicada normalmente com upstream; antes deste commit documental, remoto e local apontavam para `3780779...`.
- A futura `rewrite/portal-sem-cms` não existe neste snapshot; permanece explicitamente reservada como **KEEP** quando criada pela OWN-38, sem ser antecipada.

## Método e comandos executados

Todos os comandos de inspeção abaixo foram executados sem alterar o checkout original; a única escrita de produto foi este arquivo na branch documental isolada. A criação/publicação da branch documental foi normal e não destrutiva.

| Comando | Resultado observado |
|---|---|
| `git status --short --branch` | checkout original em `fix/payload-admin-news-read`; somente quatro screenshots untracked conhecidos |
| `git worktree list --porcelain` + status por worktree | 27 worktrees; 13 DIRTY; ocupação detalhada abaixo |
| `git branch -a --no-color` / `git show-ref --head` | branches locais/remotas, tags e HEAD registrados; nenhum ref protegido alterado |
| `git for-each-ref refs/remotes/origin --format=...` | branches remotas e data/assunto coletados |
| `gh pr list --state all --limit 200 --json number,title,state,headRefName,headRefOid,baseRefName,mergedAt,closedAt,url,author,updatedAt` | 66 PRs: 64 MERGED, 2 CLOSED, 0 OPEN; PRs Payload relevantes abaixo |
| `git ls-remote --heads origin archive/payload-*` / tags | hashes e tags peeled conferidos abaixo |
| merge-base individual por ref | 61 refs testadas contra ambos archives; tabela completa abaixo; códigos 0/1 registrados |
| `git fsck --no-reflogs --unreachable` e `git fsck --unreachable` | ambos código 0; comparação de conjuntos abaixo; nenhuma limpeza posterior |

## Ocupação dos worktrees e gate de segurança

O status é conservador: qualquer worktree ocupado ou sujo é preservado. Os 13 worktrees abaixo estavam DIRTY no snapshot; nenhuma alteração foi movida, copiada, ignorada, adicionada ou apagada.

| Worktree | HEAD | Cabeçalho/status | Entradas |
|---|---|---|---:|
| `C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-accelerated-pr2-runtime` | `8a89c4022bf5bca4aebce3e89ba19be2c3e9d8bc` | ## fix/payload-admin-news-read...origin/fix/payload-admin-news-read | 4 |
| `C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-artifact-digest` | `7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9` | ## fix/portal-final-acceptance...origin/fix/portal-final-acceptance | 181 |
| `C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-cms-go-live-pr1` | `e741ce71f06ecae79773ca2ce50ec5aed302763c` | ## feat/payload-cms-go-live-pr1 | 6 |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-b0-verify-7eb35c12` | `a6d863e74908e7888d9fc99ee9cb82bb3d7edca5` | ## HEAD (no branch) | 40 |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-browser-diagnostics-5227a9ec` | `52b63ad482af70590238f25708e2cf83bcb2ecdf` | ## HEAD (no branch) | 6 |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-ci-fixture-fixes-cc299128` | `88c18eb64402534e37781578fc504615458b8dfa` | ## HEAD (no branch) | 6 |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-editorial-fixed-9226a2f1` | `86b61eab5784b411b7993f089aaa3c2db53e6df5` | ## HEAD (no branch) | 63 |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-editorial-verify-c265faa7` | `4ec9e06ccc50e7a181e5565c54d210fab249be49` | ## HEAD (no branch) | 56 |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-finalizer-diagnostics-8e53702c` | `c80825fa3086d08a538f3b2b87611ec30d55ce8a` | ## HEAD (no branch) | 5 |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-monitor-fixed-2df42a74` | `86b61eab5784b411b7993f089aaa3c2db53e6df5` | ## HEAD (no branch) | 32 |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-monitor-verify-e764ebe9` | `4ec9e06ccc50e7a181e5565c54d210fab249be49` | ## HEAD (no branch) | 29 |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-preview-fixed-2401f050` | `86b61eab5784b411b7993f089aaa3c2db53e6df5` | ## HEAD (no branch) | 105 |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-reviewed-6b8200b2` | `86b61eab5784b411b7993f089aaa3c2db53e6df5` | ## HEAD (no branch) | 101 |

Worktrees detached (sem branch) também foram preservados; os sujos estão incluídos na tabela acima:

| Worktree detached | HEAD | Entradas | Estado |
|---|---|---:|---|
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-b0-verify-7eb35c12` | `a6d863e74908e7888d9fc99ee9cb82bb3d7edca5` | 40 | DIRTY |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-browser-diagnostics-5227a9ec` | `52b63ad482af70590238f25708e2cf83bcb2ecdf` | 6 | DIRTY |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-ci-fixture-fixes-cc299128` | `88c18eb64402534e37781578fc504615458b8dfa` | 6 | DIRTY |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-editorial-fixed-9226a2f1` | `86b61eab5784b411b7993f089aaa3c2db53e6df5` | 63 | DIRTY |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-editorial-verify-c265faa7` | `4ec9e06ccc50e7a181e5565c54d210fab249be49` | 56 | DIRTY |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-finalizer-diagnostics-8e53702c` | `c80825fa3086d08a538f3b2b87611ec30d55ce8a` | 5 | DIRTY |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-monitor-fixed-2df42a74` | `86b61eab5784b411b7993f089aaa3c2db53e6df5` | 32 | DIRTY |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-monitor-verify-e764ebe9` | `4ec9e06ccc50e7a181e5565c54d210fab249be49` | 29 | DIRTY |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-preview-fixed-2401f050` | `86b61eab5784b411b7993f089aaa3c2db53e6df5` | 105 | DIRTY |
| `C:/Users/Criação/AppData/Local/Temp/opencode/portal-reviewed-6b8200b2` | `86b61eab5784b411b7993f089aaa3c2db53e6df5` | 101 | DIRTY |

## PRs relevantes

O comando completo retornou 66 PRs; a janela relevante para as branches presentes é:

| PR | Head | Head OID | Estado | mergedAt |
|---|---|---|---|---|
| [#62](https://github.com/OWNERINC/portal_ownerinc/pull/62) | `feat/payload-b0-01a-envelope` | `c00a8b2cd7d79419157bf9b96b13bc0ab96b911d` | MERGED | 2026-10-16T19:07:05Z |
| [#63](https://github.com/OWNERINC/portal_ownerinc/pull/63) | `fix/cards-pos-remove-lunch` | `7fda4c28752a95cd3f66260347add98e5a109b18` | MERGED | 2026-10-23T11:29:49Z |
| [#64](https://github.com/OWNERINC/portal_ownerinc/pull/64) | `fix/deploy-production-condition` | `09ec1f976ce45b99e1d5277884eb520240f69da1` | MERGED | 2026-10-23T12:39:28Z |
| [#65](https://github.com/OWNERINC/portal_ownerinc/pull/65) | `feat/payload-accelerated-pr1-impl` | `c8a95e72cc3a04485d0d34b16c5e4aea751a78ee` | MERGED | 2026-10-27T11:40:05Z |
| [#66](https://github.com/OWNERINC/portal_ownerinc/pull/66) | `feat/payload-accelerated-pr2-runtime` | `3b19f0402d197b17e96466ca47679d199ea88b30` | MERGED | 2026-10-27T11:16:45Z |
| [#67](https://github.com/OWNERINC/portal_ownerinc/pull/67) | `feat/payload-cms-live-gates` | `dc97fd516c4c3962cdd2bf94531ce540601f7f0a` | MERGED | 2026-10-30T18:02:41Z |
| [#68](https://github.com/OWNERINC/portal_ownerinc/pull/68) | `fix/payload-b0-inventory` | `46f062a4dbfb544381461c73b25a90cd7eaa8f2d` | MERGED | 2026-10-30T21:07:51Z |
| [#69](https://github.com/OWNERINC/portal_ownerinc/pull/69) | `fix/payload-preauth-owner-url` | `e702b0839eb82e9464b8ec0957d19a8bc91d9002` | MERGED | 2026-10-31T05:09:39Z |
| [#70](https://github.com/OWNERINC/portal_ownerinc/pull/70) | `fix/payload-preauth-observer-password` | `3bd1d7215c66d61df16c1afa6261bc2194f7d304` | MERGED | 2026-10-31T05:51:51Z |
| [#71](https://github.com/OWNERINC/portal_ownerinc/pull/71) | `fix/payload-admin-ledger-read` | `fcf992fddad7e55d2ec4a8f8a611cbf66cad3db3` | MERGED | 2026-10-31T06:34:11Z |
| [#72](https://github.com/OWNERINC/portal_ownerinc/pull/72) | `fix/payload-native-guard-schema` | `c43b13b9153776f7d3606882e0d1b180e149c02e` | MERGED | 2026-10-31T07:34:23Z |
| [#73](https://github.com/OWNERINC/portal_ownerinc/pull/73) | `fix/payload-admin-news-read` | `8a89c4022bf5bca4aebce3e89ba19be2c3e9d8bc` | MERGED | 2026-10-31T08:21:32Z |
| [#74](https://github.com/OWNERINC/portal_ownerinc/pull/74) | `fix/payload-preauthority-liveness` | `e12eeb88fc275494957a9910319dc40f9a553e98` | MERGED | 2026-11-01T17:33:20Z |
| [#75](https://github.com/OWNERINC/portal_ownerinc/pull/75) | `fix/payload-preauthority-smoke` | `7012f376f960e615b00f027c53d2836b1a57c3d5` | MERGED | 2026-11-01T19:35:50Z |
| [#76](https://github.com/OWNERINC/portal_ownerinc/pull/76) | `fix/payload-shared-postgres-fixture` | `4265041683cdb4bc353ae50c721b6e4aaafee0ed` | MERGED | 2026-11-01T20:31:59Z |
| [#77](https://github.com/OWNERINC/portal_ownerinc/pull/77) | `fix/payload-cms-fingerprint-role` | `a13f205bbb0421ecf9b88ff2ec217fde23e0fec0` | MERGED | 2026-11-01T21:51:58Z |
| [#78](https://github.com/OWNERINC/portal_ownerinc/pull/78) | `fix/payload-worker-hold-check` | `037a14a577989037977171068252f9bc8df3d41b` | MERGED | 2026-11-01T23:19:30Z |
| [#79](https://github.com/OWNERINC/portal_ownerinc/pull/79) | `fix/payload-portal-identity-check` | `90d8f99516e9b8f1ff0b6ebddb0cce6df6873ee6` | MERGED | 2026-11-02T01:05:35Z |
| [#80](https://github.com/OWNERINC/portal_ownerinc/pull/80) | `fix/payload-artifact-digest` | `d5399b52ceeed313b77ab2dab336bf07efeb0830` | MERGED | 2026-11-02T02:44:54Z |
| [#81](https://github.com/OWNERINC/portal_ownerinc/pull/81) | `feat/payload-policy-rotation` | `5485fcf1cb72b891ddef75e9a63b7ad06e3a9bb0` | MERGED | 2026-11-02T16:02:30Z |
| [#82](https://github.com/OWNERINC/portal_ownerinc/pull/82) | `fix/portal-final-acceptance` | `7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9` | CLOSED | null |

## Inventário completo de branches

**Legenda merge-base:** P = `git merge-base --is-ancestor <ref> archive/payload-platform-2026-11-03`; R = mesmo teste contra `archive/payload-pr82-2026-11-03`; os números são os códigos de saída observados (0 ancestral, 1 não ancestral). U = `git rev-list --count <ref> --not <archive-platform> <archive-pr82>`, isto é, commits no tip que não estão cobertos por nenhum dos dois archives. O teste é evidência, não autorização de exclusão.

A tabela contém as 25 branches remotas retornadas e as 8 branches somente locais. `origin/HEAD` é ref simbólica, não branch candidata, e aparece na prova de refs. Quando hashes local/remoto divergem, ambos são mantidos e a divergência é explicitada.

### Branches remotas e branches locais relacionadas

| Branch remota | Hash remoto | Data / assunto | PR e estado | Local / worktree relacionado | P/R/U | Classificação | Referência de recuperação | Justificativa | Ação executada |
|---|---|---|---|---|---|---|---|---|---|
| origin/archive/payload-platform-2026-11-03 | `a6d863e74908e7888d9fc99ee9cb82bb3d7edca5` | 2026-11-02T13:02:30-03:00  -  Merge pull request #81 from OWNERINC/feat/payload-policy-rotation | nenhuma PR associada | local `a6d863e74908` | remoto P=0; R=0; U=0 | **KEEP** | origin/archive/payload-platform-2026-11-03<br>refs/heads/archive/payload-platform-2026-11-03<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03 | KEEP obrigatório: archive/* é recuperação do congelamento. | Preservada; nenhuma exclusão. |
| origin/archive/payload-pr82-2026-11-03 | `7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9` | 2026-11-03T01:26:14-03:00  -  test: reap inherited preparation descendants through owned waits | nenhuma PR associada | local `7cd7058f6862` | remoto P=1; R=0; U=0 | **KEEP** | origin/archive/payload-pr82-2026-11-03<br>refs/heads/archive/payload-pr82-2026-11-03<br>archive/payload-pr82-2026-11-03 | KEEP obrigatório: archive/* é recuperação do congelamento. | Preservada; nenhuma exclusão. |
| origin/feat/payload-accelerated-pr1-impl | `c8a95e72cc3a04485d0d34b16c5e4aea751a78ee` | 2026-10-27T08:16:45-03:00  -  Merge pull request #66 from OWNERINC/feat/payload-accelerated-pr2-runtime | [#65](https://github.com/OWNERINC/portal_ownerinc/pull/65) MERGED; mergedAt=2026-10-27T11:40:05Z | local `eee60944a9eb` (DIVERGE de remoto c8a95e72cc3a)<br>worktree `C:/PROJETOS/_ownerinc_portal/.worktrees/payload-accelerated-pr1-impl`  -  clean | remoto P=0; R=0; U=0<br>local P=0; R=0; U=0 | **KEEP** | origin/feat/payload-accelerated-pr1-impl<br>refs/heads/feat/payload-accelerated-pr1-impl<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03<br>worktree C:/PROJETOS/_ownerinc_portal/.worktrees/payload-accelerated-pr1-impl | KEEP: branch ocupada por worktree; alterações locais são trabalho potencial de terceiros e não foram tocadas. | Preservada; nenhuma exclusão. |
| origin/feat/payload-accelerated-pr2-runtime | `3b19f0402d197b17e96466ca47679d199ea88b30` | 2026-10-26T20:01:13-03:00  -  fix(cms): scope readiness trigger inventory | [#66](https://github.com/OWNERINC/portal_ownerinc/pull/66) MERGED; mergedAt=2026-10-27T11:16:45Z | local `3b19f0402d19` | remoto P=0; R=0; U=0 | **REVIEW** | origin/feat/payload-accelerated-pr2-runtime<br>refs/heads/feat/payload-accelerated-pr2-runtime<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03 | REVIEW: sem aprovação específica registrada para esta branch; alcançabilidade/PR não substitui autorização de exclusão. | Preservada; nenhuma exclusão por ausência de aprovação específica. |
| origin/feat/payload-b0-01a-envelope | `c00a8b2cd7d79419157bf9b96b13bc0ab96b911d` | 2026-10-16T14:21:09-03:00  -  docs: record Payload B0 native qualification | [#62](https://github.com/OWNERINC/portal_ownerinc/pull/62) MERGED; mergedAt=2026-10-16T19:07:05Z | local `b8557dd7acf2` (DIVERGE de remoto c00a8b2cd7d7) | remoto P=0; R=0; U=0<br>local P=0; R=0; U=0 | **REVIEW** | origin/feat/payload-b0-01a-envelope<br>refs/heads/feat/payload-b0-01a-envelope<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03 | REVIEW: sem aprovação específica registrada para esta branch; alcançabilidade/PR não substitui autorização de exclusão. | Preservada; nenhuma exclusão por ausência de aprovação específica. |
| origin/feat/payload-cms-live-gates | `dc97fd516c4c3962cdd2bf94531ce540601f7f0a` | 2026-10-30T14:46:19-03:00  -  fix(cms): close go-live qualification gaps | [#67](https://github.com/OWNERINC/portal_ownerinc/pull/67) MERGED; mergedAt=2026-10-30T18:02:41Z | local `dc97fd516c4c` | remoto P=0; R=0; U=0 | **REVIEW** | origin/feat/payload-cms-live-gates<br>refs/heads/feat/payload-cms-live-gates<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03 | REVIEW: sem aprovação específica registrada para esta branch; alcançabilidade/PR não substitui autorização de exclusão. | Preservada; nenhuma exclusão por ausência de aprovação específica. |
| origin/feat/payload-policy-rotation | `5485fcf1cb72b891ddef75e9a63b7ad06e3a9bb0` | 2026-11-02T12:52:21-03:00  -  docs(payload): mark rotation verification complete | [#81](https://github.com/OWNERINC/portal_ownerinc/pull/81) MERGED; mergedAt=2026-11-02T16:02:30Z | local `5485fcf1cb72` | remoto P=0; R=0; U=0 | **REVIEW** | origin/feat/payload-policy-rotation<br>refs/heads/feat/payload-policy-rotation<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03 | REVIEW: sem aprovação específica registrada para esta branch; alcançabilidade/PR não substitui autorização de exclusão. | Preservada; nenhuma exclusão por ausência de aprovação específica. |
| origin/fix/cards-pos-remove-lunch | `7fda4c28752a95cd3f66260347add98e5a109b18` | 2026-10-22T17:06:37-03:00  -  Merge remote-tracking branch 'origin/main' into fix/cards-pos-remove-lunch | [#63](https://github.com/OWNERINC/portal_ownerinc/pull/63) MERGED; mergedAt=2026-10-23T11:29:49Z | local `7fda4c28752a` | remoto P=0; R=0; U=0 | **REVIEW** | origin/fix/cards-pos-remove-lunch<br>refs/heads/fix/cards-pos-remove-lunch<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03 | REVIEW: sem aprovação específica registrada para esta branch; alcançabilidade/PR não substitui autorização de exclusão. | Preservada; nenhuma exclusão por ausência de aprovação específica. |
| origin/fix/deploy-production-condition | `09ec1f976ce45b99e1d5277884eb520240f69da1` | 2026-10-23T09:15:28-03:00  -  fix(ci): restore production deploy eligibility | [#64](https://github.com/OWNERINC/portal_ownerinc/pull/64) MERGED; mergedAt=2026-10-23T12:39:28Z | local `09ec1f976ce4` | remoto P=0; R=0; U=0 | **REVIEW** | origin/fix/deploy-production-condition<br>refs/heads/fix/deploy-production-condition<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03 | REVIEW: sem aprovação específica registrada para esta branch; alcançabilidade/PR não substitui autorização de exclusão. | Preservada; nenhuma exclusão por ausência de aprovação específica. |
| origin/fix/payload-admin-ledger-read | `fcf992fddad7e55d2ec4a8f8a611cbf66cad3db3` | 2026-10-31T03:26:20-03:00  -  fix(payload): grant admin ledger inspection | [#71](https://github.com/OWNERINC/portal_ownerinc/pull/71) MERGED; mergedAt=2026-10-31T06:34:11Z | local `fcf992fddad7` | remoto P=0; R=0; U=0 | **REVIEW** | origin/fix/payload-admin-ledger-read<br>refs/heads/fix/payload-admin-ledger-read<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03 | REVIEW: sem aprovação específica registrada para esta branch; alcançabilidade/PR não substitui autorização de exclusão. | Preservada; nenhuma exclusão por ausência de aprovação específica. |
| origin/fix/payload-admin-news-read | `8a89c4022bf5bca4aebce3e89ba19be2c3e9d8bc` | 2026-10-31T05:13:31-03:00  -  fix(payload): allow bounded admin inspection | [#73](https://github.com/OWNERINC/portal_ownerinc/pull/73) MERGED; mergedAt=2026-10-31T08:21:32Z | local `8a89c4022bf5`<br>worktree `C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-accelerated-pr2-runtime`  -  DIRTY (4 entradas) | remoto P=0; R=0; U=0 | **KEEP** | origin/fix/payload-admin-news-read<br>refs/heads/fix/payload-admin-news-read<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03<br>worktree C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-accelerated-pr2-runtime | KEEP: branch ocupada por worktree; alterações locais são trabalho potencial de terceiros e não foram tocadas. | Preservada; nenhuma exclusão. |
| origin/fix/payload-artifact-digest | `d5399b52ceeed313b77ab2dab336bf07efeb0830` | 2026-11-01T23:37:48-03:00  -  fix(payload): normalize artifact digests | [#80](https://github.com/OWNERINC/portal_ownerinc/pull/80) MERGED; mergedAt=2026-11-02T02:44:54Z | local `d5399b52ceee` | remoto P=0; R=0; U=0 | **REVIEW** | origin/fix/payload-artifact-digest<br>refs/heads/fix/payload-artifact-digest<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03 | REVIEW: sem aprovação específica registrada para esta branch; alcançabilidade/PR não substitui autorização de exclusão. | Preservada; nenhuma exclusão por ausência de aprovação específica. |
| origin/fix/payload-cms-fingerprint-role | `a13f205bbb0421ecf9b88ff2ec217fde23e0fec0` | 2026-11-01T18:43:54-03:00  -  fix(payload): scope CMS fingerprint reader | [#77](https://github.com/OWNERINC/portal_ownerinc/pull/77) MERGED; mergedAt=2026-11-01T21:51:58Z | local `a13f205bbb04`<br>worktree `C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-cms-fingerprint-role`  -  clean | remoto P=0; R=0; U=0 | **KEEP** | origin/fix/payload-cms-fingerprint-role<br>refs/heads/fix/payload-cms-fingerprint-role<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03<br>worktree C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-cms-fingerprint-role | KEEP: branch ocupada por worktree; alterações locais são trabalho potencial de terceiros e não foram tocadas. | Preservada; nenhuma exclusão. |
| origin/fix/payload-native-guard-schema | `c43b13b9153776f7d3606882e0d1b180e149c02e` | 2026-10-31T04:26:03-03:00  -  fix(payload): exclude ownership guard schema | [#72](https://github.com/OWNERINC/portal_ownerinc/pull/72) MERGED; mergedAt=2026-10-31T07:34:23Z | local `c43b13b91537` | remoto P=0; R=0; U=0 | **REVIEW** | origin/fix/payload-native-guard-schema<br>refs/heads/fix/payload-native-guard-schema<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03 | REVIEW: sem aprovação específica registrada para esta branch; alcançabilidade/PR não substitui autorização de exclusão. | Preservada; nenhuma exclusão por ausência de aprovação específica. |
| origin/fix/payload-portal-identity-check | `90d8f99516e9b8f1ff0b6ebddb0cce6df6873ee6` | 2026-11-01T21:56:57-03:00  -  fix(payload): verify Portal restore identity | [#79](https://github.com/OWNERINC/portal_ownerinc/pull/79) MERGED; mergedAt=2026-11-02T01:05:35Z | local `90d8f99516e9`<br>worktree `C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-portal-identity-check`  -  clean | remoto P=0; R=0; U=0 | **KEEP** | origin/fix/payload-portal-identity-check<br>refs/heads/fix/payload-portal-identity-check<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03<br>worktree C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-portal-identity-check | KEEP: branch ocupada por worktree; alterações locais são trabalho potencial de terceiros e não foram tocadas. | Preservada; nenhuma exclusão. |
| origin/fix/payload-preauth-observer-password | `3bd1d7215c66d61df16c1afa6261bc2194f7d304` | 2026-10-31T02:44:15-03:00  -  fix(payload): seed observer fixture credential | [#70](https://github.com/OWNERINC/portal_ownerinc/pull/70) MERGED; mergedAt=2026-10-31T05:51:51Z | local `3bd1d7215c66` | remoto P=0; R=0; U=0 | **REVIEW** | origin/fix/payload-preauth-observer-password<br>refs/heads/fix/payload-preauth-observer-password<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03 | REVIEW: sem aprovação específica registrada para esta branch; alcançabilidade/PR não substitui autorização de exclusão. | Preservada; nenhuma exclusão por ausência de aprovação específica. |
| origin/fix/payload-preauth-owner-url | `e702b0839eb82e9464b8ec0957d19a8bc91d9002` | 2026-10-31T02:01:17-03:00  -  fix(payload): use owner URL in preauthority fixture | [#69](https://github.com/OWNERINC/portal_ownerinc/pull/69) MERGED; mergedAt=2026-10-31T05:09:39Z | local `e702b0839eb8` | remoto P=0; R=0; U=0 | **REVIEW** | origin/fix/payload-preauth-owner-url<br>refs/heads/fix/payload-preauth-owner-url<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03 | REVIEW: sem aprovação específica registrada para esta branch; alcançabilidade/PR não substitui autorização de exclusão. | Preservada; nenhuma exclusão por ausência de aprovação específica. |
| origin/fix/payload-preauthority-liveness | `e12eeb88fc275494957a9910319dc40f9a553e98` | 2026-11-01T14:24:46-03:00  -  fix(payload): separate preauthority liveness | [#74](https://github.com/OWNERINC/portal_ownerinc/pull/74) MERGED; mergedAt=2026-11-01T17:33:20Z | local `e12eeb88fc27`<br>worktree `C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-preauthority-liveness`  -  clean | remoto P=0; R=0; U=0 | **KEEP** | origin/fix/payload-preauthority-liveness<br>refs/heads/fix/payload-preauthority-liveness<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03<br>worktree C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-preauthority-liveness | KEEP: branch ocupada por worktree; alterações locais são trabalho potencial de terceiros e não foram tocadas. | Preservada; nenhuma exclusão. |
| origin/fix/payload-preauthority-smoke | `7012f376f960e615b00f027c53d2836b1a57c3d5` | 2026-11-01T16:21:54-03:00  -  fix(payload): preserve fixture smoke mode | [#75](https://github.com/OWNERINC/portal_ownerinc/pull/75) MERGED; mergedAt=2026-11-01T19:35:50Z | local `7012f376f960`<br>worktree `C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-preauthority-smoke`  -  clean | remoto P=0; R=0; U=0 | **KEEP** | origin/fix/payload-preauthority-smoke<br>refs/heads/fix/payload-preauthority-smoke<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03<br>worktree C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-preauthority-smoke | KEEP: branch ocupada por worktree; alterações locais são trabalho potencial de terceiros e não foram tocadas. | Preservada; nenhuma exclusão. |
| origin/fix/payload-shared-postgres-fixture | `4265041683cdb4bc353ae50c721b6e4aaafee0ed` | 2026-11-01T17:22:34-03:00  -  fix(payload): use shared postgres fixture | [#76](https://github.com/OWNERINC/portal_ownerinc/pull/76) MERGED; mergedAt=2026-11-01T20:31:59Z | local `4265041683cd`<br>worktree `C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-shared-postgres-fixture`  -  clean | remoto P=0; R=0; U=0 | **KEEP** | origin/fix/payload-shared-postgres-fixture<br>refs/heads/fix/payload-shared-postgres-fixture<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03<br>worktree C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-shared-postgres-fixture | KEEP: branch ocupada por worktree; alterações locais são trabalho potencial de terceiros e não foram tocadas. | Preservada; nenhuma exclusão. |
| origin/fix/payload-worker-hold-check | `037a14a577989037977171068252f9bc8df3d41b` | 2026-11-01T20:12:26-03:00  -  fix(payload): inspect held worker by labels | [#78](https://github.com/OWNERINC/portal_ownerinc/pull/78) MERGED; mergedAt=2026-11-01T23:19:30Z | local `037a14a57798`<br>worktree `C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-worker-hold-check`  -  clean | remoto P=0; R=0; U=0 | **KEEP** | origin/fix/payload-worker-hold-check<br>refs/heads/fix/payload-worker-hold-check<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03<br>worktree C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-worker-hold-check | KEEP: branch ocupada por worktree; alterações locais são trabalho potencial de terceiros e não foram tocadas. | Preservada; nenhuma exclusão. |
| origin/fix/portal-final-acceptance | `7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9` | 2026-11-03T01:26:14-03:00  -  test: reap inherited preparation descendants through owned waits | [#82](https://github.com/OWNERINC/portal_ownerinc/pull/82) CLOSED; mergedAt=null | local `7cd7058f6862`<br>worktree `C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-artifact-digest`  -  DIRTY (181 entradas) | remoto P=1; R=0; U=0 | **KEEP** | origin/fix/portal-final-acceptance<br>refs/heads/fix/portal-final-acceptance<br>archive/payload-pr82-2026-11-03<br>worktree C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-artifact-digest | KEEP: branch ocupada por worktree; alterações locais são trabalho potencial de terceiros e não foram tocadas. | Preservada; nenhuma exclusão. |
| origin/main | `a6d863e74908e7888d9fc99ee9cb82bb3d7edca5` | 2026-11-02T13:02:30-03:00  -  Merge pull request #81 from OWNERINC/feat/payload-policy-rotation | nenhuma PR associada | local `2e004b347cff` (DIVERGE de remoto a6d863e74908)<br>worktree `C:/PROJETOS/_ownerinc_portal`  -  clean | remoto P=0; R=0; U=0<br>local P=1; R=1; U=1 | **KEEP** | origin/main<br>refs/heads/main<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03<br>worktree C:/PROJETOS/_ownerinc_portal | KEEP obrigatório: main e worktree ocupado. | Preservada; nenhuma exclusão. |
| origin/tiownerinc/own-36-freeze | `3780779e9da3e273f790a7cf130b75502ca80c98` | 2026-11-03T10:20:46-03:00  -  docs: record PR 82 closure | nenhuma PR associada | local `3780779e9da3`<br>worktree `C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/own-36-freeze`  -  clean | remoto P=1; R=1; U=2 | **KEEP** | origin/tiownerinc/own-36-freeze<br>refs/heads/tiownerinc/own-36-freeze<br>worktree C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/own-36-freeze | KEEP obrigatório: baseline OWN-36 publicado e ocupado. | Preservada; nenhuma exclusão. |
| origin/tiownerinc/own-37-branch-inventory | `3780779e9da3e273f790a7cf130b75502ca80c98` | 2026-11-03T10:20:46-03:00  -  docs: record PR 82 closure | nenhuma PR associada | local `3780779e9da3`<br>worktree `C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/own-37-branch-inventory`  -  clean | remoto P=1; R=1; U=2 | **KEEP** | origin/tiownerinc/own-37-branch-inventory<br>refs/heads/tiownerinc/own-37-branch-inventory<br>worktree C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/own-37-branch-inventory | KEEP obrigatório: branch documental desta issue, derivada de 3780779. | Preservada; nenhuma exclusão. |

### Branches somente locais

| Branch remota | Hash local | Data / assunto | PR e estado | Local / worktree relacionado | P/R/U | Classificação | Referência de recuperação | Justificativa | Ação executada |
|---|---|---|---|---|---|---|---|---|---|
|  -  (local-only) | ` - ` | 2026-10-26T09:09:06-03:00  -  docs: plan accelerated payload go-live | nenhuma PR associada | local `4097b4b6a3dc`<br>worktree `C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/brave-zebra`  -  clean | local P=0; R=0; U=0 | **KEEP** | refs/heads/docs/account-creation-flow<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03<br>worktree C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/brave-zebra | KEEP: branch ocupada por worktree; alterações locais são trabalho potencial de terceiros e não foram tocadas. | Preservada; nenhuma exclusão. |
|  -  (local-only) | ` - ` | 2026-10-26T09:09:06-03:00  -  docs: plan accelerated payload go-live | nenhuma PR associada | local `4097b4b6a3dc` | local P=0; R=0; U=0 | **REVIEW** | refs/heads/docs/payload-cms-go-live-plan<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03 | REVIEW: sem aprovação específica registrada para esta branch; alcançabilidade/PR não substitui autorização de exclusão. | Preservada; nenhuma exclusão por ausência de aprovação específica. |
|  -  (local-only) | ` - ` | 2026-10-26T09:09:06-03:00  -  docs: plan accelerated payload go-live | nenhuma PR associada | local `4097b4b6a3dc`<br>worktree `C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-accelerated-pr1`  -  clean | local P=0; R=0; U=0 | **KEEP** | refs/heads/feat/payload-accelerated-pr1<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03<br>worktree C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-accelerated-pr1 | KEEP: branch ocupada por worktree; alterações locais são trabalho potencial de terceiros e não foram tocadas. | Preservada; nenhuma exclusão. |
|  -  (local-only) | ` - ` | 2026-10-23T14:57:02-03:00  -  feat(payload): authenticate invariant observation policies | nenhuma PR associada | local `e741ce71f06e`<br>worktree `C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-cms-go-live-pr1`  -  DIRTY (6 entradas) | local P=1; R=1; U=3 | **KEEP** | refs/heads/feat/payload-cms-go-live-pr1<br>worktree C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/payload-cms-go-live-pr1 | KEEP: branch ocupada por worktree; alterações locais são trabalho potencial de terceiros e não foram tocadas. | Preservada; nenhuma exclusão. |
|  -  (local-only) | ` - ` | 2026-10-28T15:27:37-03:00  -  fix(academy): restore catalog focus after load | nenhuma PR associada | local `50d1862c9a8f`<br>worktree `C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/portal-conteudos-mvp`  -  clean | local P=1; R=1; U=54 | **KEEP** | refs/heads/feat/portal-conteudos-modulares<br>worktree C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/portal-conteudos-mvp | KEEP: branch ocupada por worktree; alterações locais são trabalho potencial de terceiros e não foram tocadas. | Preservada; nenhuma exclusão. |
|  -  (local-only) | ` - ` | 2026-10-22T16:42:41-03:00  -  fix(cms): patch critical Next and DOMPurify advisories | nenhuma PR associada | local `004e8fac6666` | local P=0; R=0; U=0 | **REVIEW** | refs/heads/fix/cms-critical-advisories<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03 | REVIEW: sem aprovação específica registrada para esta branch; alcançabilidade/PR não substitui autorização de exclusão. | Preservada; nenhuma exclusão por ausência de aprovação específica. |
|  -  (local-only) | ` - ` | 2026-10-30T17:57:50-03:00  -  fix(payload): create inventory for native B0 | [#68](https://github.com/OWNERINC/portal_ownerinc/pull/68) MERGED; mergedAt=2026-10-30T21:07:51Z | local `46f062a4dbfb` | local P=1; R=1; U=3 | **REVIEW** | refs/heads/fix/payload-b0-inventory | REVIEW: sem aprovação específica registrada para esta branch; alcançabilidade/PR não substitui autorização de exclusão. | Preservada; nenhuma exclusão por ausência de aprovação específica. |
|  -  (local-only) | ` - ` | 2026-10-22T14:58:39-03:00  -  docs: clarify Go image provenance | nenhuma PR associada | local `d658192c9d29`<br>worktree `C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/fix-trivy-esbuild-cve`  -  clean | local P=0; R=0; U=0 | **KEEP** | refs/heads/fix/trivy-esbuild-cve<br>archive/payload-platform-2026-11-03<br>archive/payload-pr82-2026-11-03<br>worktree C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/fix-trivy-esbuild-cve | KEEP: branch ocupada por worktree; alterações locais são trabalho potencial de terceiros e não foram tocadas. | Preservada; nenhuma exclusão. |

**Política aplicada:** não há nenhuma linha `DELETE_SAFE`. Mesmo branches com PR mesclada e P/R=0 ficam em `REVIEW` se não forem obrigatoriamente KEEP/ocupadas, porque não existe aprovação específica registrada para aquele nome. Nenhuma branch `REVIEW` foi removida.

## Prova merge-base de cada ref

Foram testadas todas as refs Git observadas: 61 no total (33 branches locais, 26 refs remotas incluindo `origin/HEAD`, e 2 tags). A tabela registra os códigos individuais, inclusive refs que não são candidatas de exclusão.

| Ref | Tipo | Commit resolvido | P code | R code | U |
|---|---|---|---:|---:|---:|
| `refs/heads/archive/payload-platform-2026-11-03` | local-branch | `a6d863e74908e7888d9fc99ee9cb82bb3d7edca5` | 0 | 0 | 0 |
| `refs/heads/archive/payload-pr82-2026-11-03` | local-branch | `7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9` | 1 | 0 | 0 |
| `refs/heads/docs/account-creation-flow` | local-branch | `4097b4b6a3dc1cb2caffe673183c2c981d780c20` | 0 | 0 | 0 |
| `refs/heads/docs/payload-cms-go-live-plan` | local-branch | `4097b4b6a3dc1cb2caffe673183c2c981d780c20` | 0 | 0 | 0 |
| `refs/heads/feat/payload-accelerated-pr1` | local-branch | `4097b4b6a3dc1cb2caffe673183c2c981d780c20` | 0 | 0 | 0 |
| `refs/heads/feat/payload-accelerated-pr1-impl` | local-branch | `eee60944a9eb5198280a11d7aea26239ba403bf7` | 0 | 0 | 0 |
| `refs/heads/feat/payload-accelerated-pr2-runtime` | local-branch | `3b19f0402d197b17e96466ca47679d199ea88b30` | 0 | 0 | 0 |
| `refs/heads/feat/payload-b0-01a-envelope` | local-branch | `b8557dd7acf2012d6bc20a03433739210e04584c` | 0 | 0 | 0 |
| `refs/heads/feat/payload-cms-go-live-pr1` | local-branch | `e741ce71f06ecae79773ca2ce50ec5aed302763c` | 1 | 1 | 3 |
| `refs/heads/feat/payload-cms-live-gates` | local-branch | `dc97fd516c4c3962cdd2bf94531ce540601f7f0a` | 0 | 0 | 0 |
| `refs/heads/feat/payload-policy-rotation` | local-branch | `5485fcf1cb72b891ddef75e9a63b7ad06e3a9bb0` | 0 | 0 | 0 |
| `refs/heads/feat/portal-conteudos-modulares` | local-branch | `50d1862c9a8f542d694dc2af0ff130a487db0625` | 1 | 1 | 54 |
| `refs/heads/fix/cards-pos-remove-lunch` | local-branch | `7fda4c28752a95cd3f66260347add98e5a109b18` | 0 | 0 | 0 |
| `refs/heads/fix/cms-critical-advisories` | local-branch | `004e8fac6666254273a71ebf5285673a464849ab` | 0 | 0 | 0 |
| `refs/heads/fix/deploy-production-condition` | local-branch | `09ec1f976ce45b99e1d5277884eb520240f69da1` | 0 | 0 | 0 |
| `refs/heads/fix/payload-admin-ledger-read` | local-branch | `fcf992fddad7e55d2ec4a8f8a611cbf66cad3db3` | 0 | 0 | 0 |
| `refs/heads/fix/payload-admin-news-read` | local-branch | `8a89c4022bf5bca4aebce3e89ba19be2c3e9d8bc` | 0 | 0 | 0 |
| `refs/heads/fix/payload-artifact-digest` | local-branch | `d5399b52ceeed313b77ab2dab336bf07efeb0830` | 0 | 0 | 0 |
| `refs/heads/fix/payload-b0-inventory` | local-branch | `46f062a4dbfb544381461c73b25a90cd7eaa8f2d` | 1 | 1 | 3 |
| `refs/heads/fix/payload-cms-fingerprint-role` | local-branch | `a13f205bbb0421ecf9b88ff2ec217fde23e0fec0` | 0 | 0 | 0 |
| `refs/heads/fix/payload-native-guard-schema` | local-branch | `c43b13b9153776f7d3606882e0d1b180e149c02e` | 0 | 0 | 0 |
| `refs/heads/fix/payload-portal-identity-check` | local-branch | `90d8f99516e9b8f1ff0b6ebddb0cce6df6873ee6` | 0 | 0 | 0 |
| `refs/heads/fix/payload-preauth-observer-password` | local-branch | `3bd1d7215c66d61df16c1afa6261bc2194f7d304` | 0 | 0 | 0 |
| `refs/heads/fix/payload-preauth-owner-url` | local-branch | `e702b0839eb82e9464b8ec0957d19a8bc91d9002` | 0 | 0 | 0 |
| `refs/heads/fix/payload-preauthority-liveness` | local-branch | `e12eeb88fc275494957a9910319dc40f9a553e98` | 0 | 0 | 0 |
| `refs/heads/fix/payload-preauthority-smoke` | local-branch | `7012f376f960e615b00f027c53d2836b1a57c3d5` | 0 | 0 | 0 |
| `refs/heads/fix/payload-shared-postgres-fixture` | local-branch | `4265041683cdb4bc353ae50c721b6e4aaafee0ed` | 0 | 0 | 0 |
| `refs/heads/fix/payload-worker-hold-check` | local-branch | `037a14a577989037977171068252f9bc8df3d41b` | 0 | 0 | 0 |
| `refs/heads/fix/portal-final-acceptance` | local-branch | `7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9` | 1 | 0 | 0 |
| `refs/heads/fix/trivy-esbuild-cve` | local-branch | `d658192c9d292607d6288a244bc12be4ddf18ea4` | 0 | 0 | 0 |
| `refs/heads/main` | local-branch | `2e004b347cff00750e0733501e4e8008e44f884a` | 1 | 1 | 1 |
| `refs/heads/tiownerinc/own-36-freeze` | local-branch | `3780779e9da3e273f790a7cf130b75502ca80c98` | 1 | 1 | 2 |
| `refs/heads/tiownerinc/own-37-branch-inventory` | local-branch | `3780779e9da3e273f790a7cf130b75502ca80c98` | 1 | 1 | 2 |
| `refs/remotes/origin/HEAD` | remote-ref | `a6d863e74908e7888d9fc99ee9cb82bb3d7edca5` | 0 | 0 | 0 |
| `refs/remotes/origin/archive/payload-platform-2026-11-03` | remote-ref | `a6d863e74908e7888d9fc99ee9cb82bb3d7edca5` | 0 | 0 | 0 |
| `refs/remotes/origin/archive/payload-pr82-2026-11-03` | remote-ref | `7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9` | 1 | 0 | 0 |
| `refs/remotes/origin/feat/payload-accelerated-pr1-impl` | remote-ref | `c8a95e72cc3a04485d0d34b16c5e4aea751a78ee` | 0 | 0 | 0 |
| `refs/remotes/origin/feat/payload-accelerated-pr2-runtime` | remote-ref | `3b19f0402d197b17e96466ca47679d199ea88b30` | 0 | 0 | 0 |
| `refs/remotes/origin/feat/payload-b0-01a-envelope` | remote-ref | `c00a8b2cd7d79419157bf9b96b13bc0ab96b911d` | 0 | 0 | 0 |
| `refs/remotes/origin/feat/payload-cms-live-gates` | remote-ref | `dc97fd516c4c3962cdd2bf94531ce540601f7f0a` | 0 | 0 | 0 |
| `refs/remotes/origin/feat/payload-policy-rotation` | remote-ref | `5485fcf1cb72b891ddef75e9a63b7ad06e3a9bb0` | 0 | 0 | 0 |
| `refs/remotes/origin/fix/cards-pos-remove-lunch` | remote-ref | `7fda4c28752a95cd3f66260347add98e5a109b18` | 0 | 0 | 0 |
| `refs/remotes/origin/fix/deploy-production-condition` | remote-ref | `09ec1f976ce45b99e1d5277884eb520240f69da1` | 0 | 0 | 0 |
| `refs/remotes/origin/fix/payload-admin-ledger-read` | remote-ref | `fcf992fddad7e55d2ec4a8f8a611cbf66cad3db3` | 0 | 0 | 0 |
| `refs/remotes/origin/fix/payload-admin-news-read` | remote-ref | `8a89c4022bf5bca4aebce3e89ba19be2c3e9d8bc` | 0 | 0 | 0 |
| `refs/remotes/origin/fix/payload-artifact-digest` | remote-ref | `d5399b52ceeed313b77ab2dab336bf07efeb0830` | 0 | 0 | 0 |
| `refs/remotes/origin/fix/payload-cms-fingerprint-role` | remote-ref | `a13f205bbb0421ecf9b88ff2ec217fde23e0fec0` | 0 | 0 | 0 |
| `refs/remotes/origin/fix/payload-native-guard-schema` | remote-ref | `c43b13b9153776f7d3606882e0d1b180e149c02e` | 0 | 0 | 0 |
| `refs/remotes/origin/fix/payload-portal-identity-check` | remote-ref | `90d8f99516e9b8f1ff0b6ebddb0cce6df6873ee6` | 0 | 0 | 0 |
| `refs/remotes/origin/fix/payload-preauth-observer-password` | remote-ref | `3bd1d7215c66d61df16c1afa6261bc2194f7d304` | 0 | 0 | 0 |
| `refs/remotes/origin/fix/payload-preauth-owner-url` | remote-ref | `e702b0839eb82e9464b8ec0957d19a8bc91d9002` | 0 | 0 | 0 |
| `refs/remotes/origin/fix/payload-preauthority-liveness` | remote-ref | `e12eeb88fc275494957a9910319dc40f9a553e98` | 0 | 0 | 0 |
| `refs/remotes/origin/fix/payload-preauthority-smoke` | remote-ref | `7012f376f960e615b00f027c53d2836b1a57c3d5` | 0 | 0 | 0 |
| `refs/remotes/origin/fix/payload-shared-postgres-fixture` | remote-ref | `4265041683cdb4bc353ae50c721b6e4aaafee0ed` | 0 | 0 | 0 |
| `refs/remotes/origin/fix/payload-worker-hold-check` | remote-ref | `037a14a577989037977171068252f9bc8df3d41b` | 0 | 0 | 0 |
| `refs/remotes/origin/fix/portal-final-acceptance` | remote-ref | `7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9` | 1 | 0 | 0 |
| `refs/remotes/origin/main` | remote-ref | `a6d863e74908e7888d9fc99ee9cb82bb3d7edca5` | 0 | 0 | 0 |
| `refs/remotes/origin/tiownerinc/own-36-freeze` | remote-ref | `3780779e9da3e273f790a7cf130b75502ca80c98` | 1 | 1 | 2 |
| `refs/remotes/origin/tiownerinc/own-37-branch-inventory` | remote-ref | `3780779e9da3e273f790a7cf130b75502ca80c98` | 1 | 1 | 2 |
| `refs/tags/payload-platform-frozen-2026-11-03` | tag | `a6d863e74908e7888d9fc99ee9cb82bb3d7edca5` | 0 | 0 | 0 |
| `refs/tags/payload-pr82-frozen-2026-11-03` | tag | `7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9` | 1 | 0 | 0 |

## fsck: commits preexistentes e retenção

### Comparação com e sem reflogs

Executados novamente, sem expirar nem alterar reflogs:

- `git fsck --no-reflogs --unreachable`: código **0**, conjunto de 165 objetos: 87 trees, 65 blobs, 13 commits.
- `git fsck --unreachable`: código **0**, conjunto de 113 objetos: 55 trees, 54 blobs, 4 commits.
- Interseção exata: **113** objetos; somente no conjunto sem reflogs: **52** SHAs; somente com reflogs: **0** SHAs.
- Commits ainda reportados com reflogs: `e00d08739a6e0fa88b553556788859d4ab61b0a2`, `0f14650b5b2d848bc2a317787918ec025a2a00d0`, `a6b16fe97904aa88db297c4ac996d72dfbf9640d`, `97cc39eca793197ca43bc95756f8f102a63aa586`.
- A diferença não é tratada como descarte seguro: reflog alcançável não é branch publicada, e listar SHA não garante retenção durável. Os archives Payload **não cobrem** os 13 commits abaixo; nenhum ref foi criado para resgatá-los.

SHAs completos que apareceram somente no conjunto sem reflogs (comparação de conjuntos, não apenas contagem):

```text
0d07a52c041e1559ef43e03da961aa485b821faa
16a0888906fc6485a953dd4830ffdded2f7da252
1ceb55be8aa3d8d4806ff8435acaf26caa33544e
20988247911a16fd8bba0c0e8fe151ac20d90135
22bf0ff9093e4454907d655c65004ea0c32c6292
2f519f85ab688b4bd2e8bc4a0a4f857e0f6ba999
3b420439150081c4550bfca9200e332e8a9b6353
4620d6657cfcea6fb025b31c076458a59a7ebfdd
4a6fa5824d37ee9b14075a83de024ebbd63a92fc
4d2a3b81cce91bfad580a1f3137dfa2983ed8aad
52c44579d506d76d6775fd4fe5236cfbfdb238c3
53b8fc8f682c4777988145cb9b6991c5d30fef57
547f57ea87f06e60debff824f984eaa359cdaec5
56d3ab77162bd8cced76f599e4e53766fc68052b
5a9d234dbbea2ab4f0a3af601f7ffd61a717a6ad
5dd371308ee04ce3ddc71b6ce56b666a932ce531
6ba54a5a5dd5f0c312f1546a7c54cd8243ce1177
745d0e87c8c0ce4ff284df616193b0bacc75aa4d
76ab3ea3601f8de74f12b51df8b45b2314317d9a
78a2d7e0a255b3875261708ce71e24d8ea3cddce
794a153be01aa45c03718a19c0b8ce2f88c5b2f6
82376e03a5d7ce75c8046366ad7fc67d66dc59ba
85155a695fd69e160642759aed16298decc5f097
862072ee6087344ba9978f87f960d41b870b2abd
87b3d2d9ba12b5b1a0bca0a626398c829892b544
8e676fc40830dc7acedfec0dd04e8fbb8588aae8
8fa35539d0166ec69ff64cc13e8802d17ddc759d
927651ba8143f892074659ef539353228b043e50
93a6632a344211bb018fc072bb5657774292691e
947bc6737b9c4a321cbc045323133c029a55b476
95b73f8cfa06780d28aeb6df2b72a8262dfaf713
961f994fe276c7d94323b1cd2d15f31ab9bf8944
96a1a5ab01456f7399394f7ede5b3bed482bbb4f
9a35f63436258c3bd18ec11d9807e67bb96839b2
a23d648d2c973c10b21b62d0db03ded8fa8cc618
a599322a9f70ba3ae74c1dcdb9287aa7de8b9b8e
a714ccd59639fcac23a6a229cdb3972f8086eb61
a75775e89a83ab46072f27769f4a3996738b26ed
b2089be92fbb84debcca7135410594fd06d4e92a
b277f4d90005490c40046980db5049a5fa208cd6
b9178a549552dd206e2b4992581edba919de4096
be44a4ced46131705a61dc91555c1e579488bed7
c00e33b2f6fdd98203661134d959ecdbddeade24
c2e0126310d2ff891e796a643742f52251efc1d9
c4b0ffa153c22a27afdf51188071a09210658fd0
c56d81d278a029e1784324ee7b140952d04a8cc9
c9fae72b4bbccb292a9ca21424fd9b54ff75187a
d04275d4103d6d32fe2f507062c9c995f4a8c71d
d88b62404f5d286985895f11388b0fca79034074
da28bb63ec1a005d546be9e93e29311e604b0058
dd31636ac9895e4155997de72a9368082857283b
eefe4313551a4997ab5eac8a0403b2cd5c014761
```

### Os 13 commits sem reflogs

Todos permanecem **UNREACHABLE_REVIEW**: conteúdo/necessidade desconhecidos quando não indicado; descarte não autorizado. Não foram criadas refs, não houve recuperação de stash, `gc`, `prune` ou expiração de reflog.

| SHA | Data | Assunto | Pais | Classificação e risco |
|---|---|---|---|---|
| `e00d08739a6e0fa88b553556788859d4ab61b0a2` | 2026-10-01T18:47:00-03:00 | release: harden Owner News migration and integration gates | `786ed5e20e70924615aefb15422883d32a7bc708` | **UNREACHABLE_REVIEW**  -  necessidade desconhecida; descarte não autorizado |
| `0f14650b5b2d848bc2a317787918ec025a2a00d0` | 2026-10-13T15:18:11-03:00 | untracked files on feat/payload-cms-final: be6db91 fix(cms): accept four fixture writers in the bounded stop budget | `nenhum` | **UNREACHABLE_REVIEW**  -  necessidade desconhecida; descarte não autorizado |
| `85155a695fd69e160642759aed16298decc5f097` | 2026-10-26T10:04:14-03:00 | feat(news): compose legacy and payload reads | `22bc99a3653f98c4314aa474a35fb31f69dbd65b` | **UNREACHABLE_REVIEW**  -  necessidade desconhecida; descarte não autorizado |
| `b9178a549552dd206e2b4992581edba919de4096` | 2026-09-24T16:44:46-03:00 | fix: keep cards pos mount scope valid | `3ce7af675e09450966c76bd788bf4831a3ef92a1` | **UNREACHABLE_REVIEW**  -  necessidade desconhecida; descarte não autorizado |
| `862072ee6087344ba9978f87f960d41b870b2abd` | 2026-10-31T02:16:06-03:00 | fix(payload): seed observer fixture credential | `50b485f75ab7e41c76ac2b834e6aba067838d0fd` | **UNREACHABLE_REVIEW**  -  necessidade desconhecida; descarte não autorizado |
| `c4b0ffa153c22a27afdf51188071a09210658fd0` | 2026-11-01T17:12:42-03:00 | fix(payload): use shared postgres fixture | `23002526602bf2d125c6fa28c01e5ecbd65f7e9c` | **UNREACHABLE_REVIEW**  -  necessidade desconhecida; descarte não autorizado |
| `a6b16fe97904aa88db297c4ac996d72dfbf9640d` | 2026-10-13T15:18:11-03:00 | On feat/payload-cms-final: OpenChamber: session ses_f02efc48affe5wo5qsFCbotflB moved to worktree payload-production-completion | `be6db919dd740dba6057191e8d7f204c6b0437ae 97cc39eca793197ca43bc95756f8f102a63aa586 0f14650b5b2d848bc2a317787918ec025a2a00d0` | **UNREACHABLE_REVIEW**  -  stash-like; os três pais observados são preservados abaixo; o terceiro pai contém o design e quatro .pyc. |
| `97cc39eca793197ca43bc95756f8f102a63aa586` | 2026-10-13T15:18:11-03:00 | index on feat/payload-cms-final: be6db91 fix(cms): accept four fixture writers in the bounded stop budget | `be6db919dd740dba6057191e8d7f204c6b0437ae` | **UNREACHABLE_REVIEW**  -  necessidade desconhecida; descarte não autorizado |
| `2f519f85ab688b4bd2e8bc4a0a4f857e0f6ba999` | 2026-10-23T08:55:15-03:00 | docs: plan production deploy condition fix | `74f80dccf1913bd101f4c70dd17b89dff1954a58` | **UNREACHABLE_REVIEW**  -  necessidade desconhecida; descarte não autorizado |
| `745d0e87c8c0ce4ff284df616193b0bacc75aa4d` | 2026-10-31T02:24:44-03:00 | fix(payload): seed observer fixture credential | `50b485f75ab7e41c76ac2b834e6aba067838d0fd` | **UNREACHABLE_REVIEW**  -  necessidade desconhecida; descarte não autorizado |
| `8e676fc40830dc7acedfec0dd04e8fbb8588aae8` | 2026-10-31T02:12:36-03:00 | fix(payload): seed observer fixture credential | `50b485f75ab7e41c76ac2b834e6aba067838d0fd` | **UNREACHABLE_REVIEW**  -  necessidade desconhecida; descarte não autorizado |
| `c56d81d278a029e1784324ee7b140952d04a8cc9` | 2026-10-19T15:31:09-03:00 | fix(cms): confirm upload commits and stream chunks lock-free | `f5442174588ec9f208c2614cebd047b3541836f6` | **UNREACHABLE_REVIEW**  -  necessidade desconhecida; descarte não autorizado |
| `547f57ea87f06e60debff824f984eaa359cdaec5` | 2026-10-31T02:34:17-03:00 | fix(payload): seed observer fixture credential | `50b485f75ab7e41c76ac2b834e6aba067838d0fd` | **UNREACHABLE_REVIEW**  -  necessidade desconhecida; descarte não autorizado |

O commit `a6b16fe97904aa88db297c4ac996d72dfbf9640d` é tratado como stash-like e não descartável: os três pais observados são `be6db919dd740dba6057191e8d7f204c6b0437ae`, `97cc39eca793197ca43bc95756f8f102a63aa586` e `0f14650b5b2d848bc2a317787918ec025a2a00d0`. O terceiro pai foi inspecionado somente por leitura e contém `docs/superpowers/specs/2026-10-08-payload-owner-news-functional-demo-design.md` e quatro `.pyc` em `ops/__pycache__/`; listar o SHA não garante retenção durável e seu descarte não foi autorizado.

## Screenshots do checkout original

O checkout original não foi usado para escrever o inventário e continua fora desta branch documental. A verificação final observou exatamente quatro arquivos untracked, preservados e não staged:

| Arquivo | Tracking final | Bytes | SHA-256 |
|---|---|---:|---|
| `.openchamber/screenshots/linear-agent-history-2026-11-03T12-18-25-493.jpg` | untracked, preservado, não staged | 101230 | `41A4778313501339542736739D6973F35789681BDBD7694CF13DBE6E2B4EC925` |
| `.openchamber/screenshots/linear-delete-agent-2026-11-03T12-25-28-010.jpg` | untracked, preservado, não staged | 22216 | `9D15E93690EDF5C6945B82E72B8281B875A591600284D1E382E6801A9B600A34` |
| `.openchamber/screenshots/linear-menu-open-2026-11-03T12-16-57-602.jpg` | untracked, preservado, não staged | 230818 | `19F9629BDFBB71217DB735E881B672897DE04A13C27111533BFB338965122377` |
| `.openchamber/screenshots/linear-project-actions-2026-11-03T12-16-45-306.jpg` | untracked, preservado, não staged | 226606 | `F0DEAD2EF4DEB6B8C3F22AC97294AFD409C7F88F9A856B1BF290C84EB54AB090` |

## Checks, ações e handoff

- Documento isolado: este arquivo somente; código/runtime/app não foi alterado.
- Prova staged final: `git diff --cached --check` terminou com exit code **0**; `git diff --cached --name-only` retornou somente `docs/reviews/portal-cleanup-branch-inventory.md`.
- `npm run verify` terminou com exit code **1**: 6 fases top-level, 2 alcançadas (`syntax` PASS e `CMS types` FAIL), 4 não alcançadas (`tests`, `security`, `dho`, `compose`); 0 suítes de teste foram executadas. A falha foi `MODULE_NOT_FOUND` para `cms/node_modules/typescript/bin/tsc`, sem alteração fora do escopo.
- Commit sugerido: `docs: inventory branches before Portal cleanup`; push normal com upstream, sem force.
- Resultado operacional desta issue: zero exclusões, zero force, zero reescritas, zero alterações em produção/banco/uploads/migrations/deploy/serviços. OWN-37 deve ir para **In Review**, não Done; OWN-38 permanece sem execução nesta sessão, com o handoff permitido pelo parecer Astra somente após a revisão coordenadora.

## Riscos e handoff

1. Worktrees DIRTY e detached preservam trabalho potencial de terceiros; não remover nem limpar sem decisão específica por caminho/branch.
2. Os 13 commits fsck são objetos não alcançáveis sem reflogs; a necessidade é desconhecida e a retenção durável não está garantida. Não criar refs automaticamente e não descartar.
3. Existem branches locais/remotas com hashes divergentes (por exemplo, `main`, `feat/payload-accelerated-pr1-impl` e `feat/payload-b0-01a-envelope`); foram preservadas e marcadas no inventário.
4. `REVIEW` é um handoff de autorização futura, não uma autorização implícita. Qualquer limpeza posterior deve ser individual, explicitamente aprovada pelo nome e revalidada contra os dois archives.

## Registro de ações executadas

- Status Linear OWN-37: Todo -> In Progress; comentário inicial publicado.
- Criada e publicada branch/worktree documental a partir exatamente de `3780779e9da3e273f790a7cf130b75502ca80c98`.
- Inventário de branches, worktrees, refs e PRs coletado; provas de merge-base executadas por ref.
- fsck com e sem reflogs reexecutado e conjuntos comparados; nenhum objeto foi alterado.
- **Nenhuma exclusão executada.**
