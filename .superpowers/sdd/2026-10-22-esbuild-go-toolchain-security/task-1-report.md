# Task 1 Report: Pin and enforce the patched Go toolchain

## Status

DONE_WITH_CONCERNS

## Implementation commit

`99539acc630bbe80cada917f01a9d5cf0f08ea76` (`fix(cms): rebuild esbuild with Go 1.26.10`)

## Files changed

- `tests/unit/cms-image-pipeline.test.mjs`
  - Updated the image, module-floor, compiler-version, and embedded-toolchain contracts to Go 1.26.10.
- `cms/Dockerfile`
  - Pinned `golang:1.26.10-alpine3.23` to OCI index digest `107301490755aa2ea1b0b43788b6e62cff2faae45a538028b193becc06aaffba`.
  - Updated compiler and binary metadata attestations to Go 1.26.10 while retaining esbuild 0.28.2 and its existing module checksum.
- `cms/go-build/go.mod`
  - Raised the local toolchain floor from Go 1.26.9 to Go 1.26.10.
- `scripts/prepare-ci-registry-pulls.mjs`
  - Updated the Golang tag and digest in `CI_BASE_PINS`.
- `.github/workflows/ci.yml`
  - Updated the Golang digest in the hosted-CI mirror probe set.
- `.superpowers/sdd/2026-10-22-esbuild-go-toolchain-security/task-1-report.md`
  - Added this execution report.

## Commands and outcomes

1. `node --test tests/unit/cms-image-pipeline.test.mjs`
   - **Expected FAIL (red phase):** 5 passed, 1 failed.
   - Failure was the newly updated Go 1.26.10 image contract observing the still-unmodified Go 1.26.9 Dockerfile.
2. `node --test tests/unit/cms-image-pipeline.test.mjs tests/unit/ci-registry-pulls.test.mjs`
   - **PASS:** 22 passed, 0 failed.
   - This includes the registry contract proving that the workflow probe set and `CI_BASE_PINS` remain identical.
3. `git grep -n -E '1\.26\.9|96123126ac58e910f4dd3619a8901e2fb6d1ad84b59b1232cac7c9ea65a8f888' -- cms/Dockerfile cms/go-build/go.mod scripts/prepare-ci-registry-pulls.mjs .github/workflows/ci.yml tests/unit/cms-image-pipeline.test.mjs`
   - **PASS:** no matches; underlying `git grep` exit code was 1 as expected.
4. `git diff --check`
   - **PASS:** no whitespace errors.
5. `npm run verify`
   - **BLOCKED BY LOCAL DEPENDENCY STATE:** verification stopped during the offline CMS typecheck because `cms/node_modules/typescript/bin/tsc` is absent (`MODULE_NOT_FOUND`). The verifier did not reach the remaining checks.
6. `git commit -m "fix(cms): rebuild esbuild with Go 1.26.10"`
   - **PASS:** created implementation commit `99539acc630bbe80cada917f01a9d5cf0f08ea76`.

## Self-review

- Confirmed the implementation diff is localized to the five files named by the task brief.
- Confirmed the exact full Go image digest is consistent across the Dockerfile, CI pull preparation, workflow probe, and contract test.
- Confirmed both the direct compiler check and built executable metadata attestation require Go 1.26.10.
- Confirmed esbuild remains at 0.28.2 and the existing `h1:A2uETn4jrQTcXaT/shwTDTYBxDjl7fV7nXmUrJxfA2w=` module checksum is unchanged.
- Confirmed the old Go tag, compiler version, and digest are absent from all scoped active build/CI/test files.
- Confirmed no unrelated source changes were included in the implementation commit.

## Concerns

- The full `npm run verify` result is unavailable because this worktree has no installed CMS TypeScript dependency. No dependency installation or lockfile change was made because it is outside Task 1 scope. The two required focused test files pass completely.
