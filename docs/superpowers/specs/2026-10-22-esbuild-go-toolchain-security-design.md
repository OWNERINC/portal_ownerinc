# Esbuild Go Toolchain Security Update

## Context

The `validate` job for PR #63 failed while scanning the CMS image. Trivy found
`CVE-2026-111943` in the Go standard library embedded in
`node_modules/@esbuild/linux-x64/bin/esbuild`. The repository already rebuilds
the upstream `esbuild` 0.28.2 command from its pinned module source instead of
shipping the npm-provided executable, but the current rebuild uses Go 1.26.9.
The vulnerability is fixed in Go 1.26.10 and 1.27.3.

## Decision

Keep `esbuild` at 0.28.2 and update only its rebuild toolchain to the official
Go 1.26.10 Alpine 3.23 image. Remaining on the 1.26 release line minimizes the
change while incorporating the `crypto/x509` security fix. Do not add a Trivy
exception or change scanner severity thresholds.

The official image is pinned to the OCI index digest
`sha256:107301490755aa2ea1b0b43788b6e62cff2faae45a538028b193becc06aaffba`.
The inspected `linux/amd64` manifest is
`sha256:9d1e2c4fda593efb2c405e1c855c75ec17fe42dc02f6b7142a5ea7af7f386bf4`.

## Changes

- Update the CMS Dockerfile builder image and embedded compiler-version checks
  from Go 1.26.9 to Go 1.26.10.
- Raise the isolated `cms/go-build/go.mod` toolchain floor to Go 1.26.10.
- Update the hosted-CI registry mirror pin and pre-pull metadata to the exact
  Go 1.26.10 index digest.
- Update the CMS image pipeline contract test to require the new version and
  digest.
- Extend the Payload Owner News operational record with the failure, official
  release provenance, image provenance, and validation status.

No application behavior, production deployment script, esbuild source version,
Go module checksum, or Trivy policy changes.

## Failure Handling

The existing fail-closed controls remain in place. The build must reject an
unexpected compiler version, target architecture, esbuild version, module
checksum, or registry digest. CI mirror verification continues to hash the raw
OCI index bytes before any build.

## Verification

1. Run the focused CMS image pipeline contract test.
2. Run `npm run verify`.
3. Run `git diff --check`.
4. If the local environment can perform it without affecting running services,
   build the disposable CMS image and scan it with the CI-pinned Trivy policy.
5. Treat the hosted CI CMS scan as the authoritative confirmation that the new
   binary no longer contains `CVE-2026-111943`.

The change is successful when all repository checks pass and the hosted
`validate` job completes its CMS image scan without the Go 1.26.9 finding.
