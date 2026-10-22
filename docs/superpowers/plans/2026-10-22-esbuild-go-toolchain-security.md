# Esbuild Go Toolchain Security Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the CMS `esbuild` 0.28.2 executable with Go 1.26.10 so the blocking Trivy scan no longer reports `CVE-2026-111943`.

**Architecture:** Preserve the existing isolated Go rebuild stage and replace only its pinned compiler image, version assertions, CI mirror metadata, and contract expectations. Keep the same esbuild source module and checksums, and retain the existing fail-closed Trivy policy.

**Tech Stack:** Docker BuildKit, Go modules, Node.js 24, Node test runner, GitHub Actions, Trivy 0.75.0.

## Global Constraints

- Keep `esbuild` at exactly `0.28.2`.
- Use `golang:1.26.10-alpine3.23` pinned to OCI index digest `sha256:107301490755aa2ea1b0b43788b6e62cff2faae45a538028b193becc06aaffba`.
- Preserve `GOTOOLCHAIN=local`, `CGO_ENABLED=0`, `-mod=readonly`, `-trimpath`, and `-buildvcs=false`.
- Do not add Trivy ignores or change `HIGH,CRITICAL`, `ignore-unfixed`, or `exit-code: 1`.
- Do not modify production deployment scripts or application behavior.
- Preserve LF line endings in Docker and workflow files.

## File Map

- `tests/unit/cms-image-pipeline.test.mjs`: contract for the exact Go builder version and digest.
- `cms/Dockerfile`: builds and verifies the replacement esbuild executable.
- `cms/go-build/go.mod`: declares the minimum local Go toolchain used for the isolated build.
- `scripts/prepare-ci-registry-pulls.mjs`: pre-pulls the exact Go image through the hosted-CI mirror.
- `.github/workflows/ci.yml`: verifies the raw OCI index hash before builds.
- `docs/operations/payload-owner-news.md`: records incident, provenance, scope, and validation evidence.

---

### Task 1: Pin and enforce the patched Go toolchain

**Files:**
- Modify: `tests/unit/cms-image-pipeline.test.mjs:405-409`
- Modify: `cms/Dockerfile:42-57,96-98`
- Modify: `cms/go-build/go.mod:3`
- Modify: `scripts/prepare-ci-registry-pulls.mjs:8-14`
- Modify: `.github/workflows/ci.yml:171-179`
- Test: `tests/unit/cms-image-pipeline.test.mjs`
- Test: `tests/unit/ci-registry-pulls.test.mjs`

**Interfaces:**
- Consumes: official `golang:1.26.10-alpine3.23` OCI index digest `107301490755aa2ea1b0b43788b6e62cff2faae45a538028b193becc06aaffba`.
- Produces: a CMS image build contract whose esbuild executable reports Go `1.26.10` while retaining esbuild `0.28.2` and its existing module sum.

- [ ] **Step 1: Update the contract test first**

Replace the three Go 1.26.9 assertions in `tests/unit/cms-image-pipeline.test.mjs` with:

```js
  assert.match(dockerfile, /FROM --platform=\$BUILDPLATFORM golang:1\.26\.10-alpine3\.23@sha256:107301490755aa2ea1b0b43788b6e62cff2faae45a538028b193becc06aaffba AS esbuild-builder/,
    'esbuild must use the registry-pinned official Go 1.26.10 toolchain fixing the crypto/x509 finding');
  assert.match(goMod, /^go 1\.26\.10$/mu, 'the module floor must agree with the patched local toolchain');
  assert.match(dockerfile, /test "\$\(go version \| awk '\{print \$3\}'\)" = "go1\.26\.10"/u,
    'the build must verify the actual compiler version, not only its image tag');
```

- [ ] **Step 2: Run the focused contract test and confirm it fails**

Run:

```sh
node --test tests/unit/cms-image-pipeline.test.mjs
```

Expected: FAIL because `cms/Dockerfile` and `cms/go-build/go.mod` still contain Go 1.26.9.

- [ ] **Step 3: Update the build and CI pins**

Apply these exact substitutions:

```text
cms/Dockerfile:
  golang:1.26.9-alpine3.23@sha256:96123126...a8f888
  -> golang:1.26.10-alpine3.23@sha256:10730149...6aaffba
  go1.26.9 -> go1.26.10
  comments mentioning "Go 1.26.9" -> "Go 1.26.10"

cms/go-build/go.mod:
  go 1.26.9 -> go 1.26.10

scripts/prepare-ci-registry-pulls.mjs:
  ['golang', '1.26.9-alpine3.23', '96123126...a8f888']
  -> ['golang', '1.26.10-alpine3.23', '10730149...6aaffba']

.github/workflows/ci.yml:
  ['golang', '96123126...a8f888']
  -> ['golang', '10730149...6aaffba']
```

Use the complete digest from Global Constraints in every source file; the shortened forms above are explanatory only and must not be copied.

- [ ] **Step 4: Run both focused test files**

Run:

```sh
node --test tests/unit/cms-image-pipeline.test.mjs tests/unit/ci-registry-pulls.test.mjs
```

Expected: PASS with no failed tests. The registry test must continue proving that the workflow probe set and `CI_BASE_PINS` are identical.

- [ ] **Step 5: Check the complete pin set**

Run:

```sh
git grep -n -E '1\.26\.9|96123126ac58e910f4dd3619a8901e2fb6d1ad84b59b1232cac7c9ea65a8f888' -- cms/Dockerfile cms/go-build/go.mod scripts/prepare-ci-registry-pulls.mjs .github/workflows/ci.yml tests/unit/cms-image-pipeline.test.mjs
```

Expected: no output and exit code 1, meaning no old active pin remains in build, CI, or test files.

- [ ] **Step 6: Commit the toolchain update**

```sh
git add cms/Dockerfile cms/go-build/go.mod scripts/prepare-ci-registry-pulls.mjs .github/workflows/ci.yml tests/unit/cms-image-pipeline.test.mjs
git commit -m "fix(cms): rebuild esbuild with Go 1.26.10"
```

### Task 2: Record provenance and verify the repository

**Files:**
- Modify: `docs/operations/payload-owner-news.md:327-356`
- Reference: `docs/superpowers/specs/2026-10-22-esbuild-go-toolchain-security-design.md`

**Interfaces:**
- Consumes: PR #63 CI run `39670953652`, job `119468373876`, Go release history, OCI index digest, and `linux/amd64` manifest digest.
- Produces: an operational record that distinguishes local/static checks from authoritative hosted Trivy evidence.

- [ ] **Step 1: Add the 2026-10-22 security gate record**

Append a subsection after the existing 2026-10-09 gate with these facts:

```markdown
### Gate de segurança Go de 2026-10-22 — CVE-2026-111943

O job `validate` da PR #63 (run `39670953652`, job `119468373876`)
falhou no scan Trivy da imagem CMS. O target
`app/cms/node_modules/@esbuild/linux-x64/bin/esbuild`, recompilado com Go
`1.26.9`, contém `CVE-2026-111943` HIGH em `crypto/x509`; o scanner informa
correção em Go `1.26.10` ou `1.27.3`.

O patch mantém esbuild `0.28.2` e a linha Go 1.26, elevando somente o toolchain
para o release oficial Go `1.26.10`, publicado em 2026-10-19 com correção de
segurança em `crypto/x509`. A imagem oficial
`golang:1.26.10-alpine3.23` usa o índice OCI
`sha256:107301490755aa2ea1b0b43788b6e62cff2faae45a538028b193becc06aaffba`;
o manifesto `linux/amd64` observado é
`sha256:9d1e2c4fda593efb2c405e1c855c75ec17fe42dc02f6b7142a5ea7af7f386bf4`.
O gate Trivy permanece inalterado e não recebe exceções. Testes locais não
substituem o scan hospedado; o gate permanece pendente até o novo CI passar.
```

- [ ] **Step 2: Run the full repository verification**

Run:

```sh
npm run verify
```

Expected: exit code 0. If dependencies are absent, run `npm run bootstrap` once and repeat `npm run verify`; do not modify lockfiles.

- [ ] **Step 3: Check whitespace and inspect the final diff**

Run:

```sh
git diff --check
git diff --stat HEAD~1
git status --short
```

Expected: `git diff --check` exits 0; only the operational document is uncommitted after Task 1; the final scope contains the files listed in this plan plus the already committed spec and plan.

- [ ] **Step 4: Commit the operational evidence**

```sh
git add docs/operations/payload-owner-news.md
git commit -m "docs: record esbuild x509 security gate"
```

- [ ] **Step 5: Re-run final clean-tree checks**

Run:

```sh
git status --short --branch
git log -3 --oneline
```

Expected: clean branch with the design, implementation, and operational-record commits. The hosted CI run after push remains the authoritative Trivy result.
