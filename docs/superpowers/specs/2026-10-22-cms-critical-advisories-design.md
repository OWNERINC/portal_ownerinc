# CMS Critical Advisories Remediation

## Context

The hosted CI run `39830792188` proved that the Go 1.26.10 rebuild removed the
blocking esbuild finding: the API, cron, and CMS Trivy scans all passed. The
following `npm run security` gate then found three critical dependency findings
in the CMS production graph:

- Next.js 16.3.8 is affected by `GHSA-2464-fhr4-w9xw`,
  `GHSA-p3m5-59mp-jv5r`, and `GHSA-673q-mjm6-r5xr`.
- DOMPurify 3.4.16 is affected by `GHSA-cg2g-xh64-v4q7`,
  `GHSA-mrv2-3pqr-j5jr`, and `GHSA-c6gr-qvv4-5v3f` through Monaco Editor.

The npm registry reports Next.js 16.4.2 and DOMPurify 3.4.17 as the current
fixed releases.

## Decision

Update only the two vulnerable pins:

- `next`: 16.3.8 to exactly 16.4.2.
- the `monaco-editor@0.57.0` `dompurify` override: 3.4.16 to exactly 3.4.17.

Regenerate `cms/package-lock.json` from those exact declarations. Keep Payload,
Monaco Editor, React, esbuild, Node, and all other dependencies unchanged. Do
not add audit exceptions or weaken the `high` audit threshold.

## Verification

The lockfile must resolve Next.js 16.4.2 and DOMPurify 3.4.17, and no stale
16.3.8/3.4.16 production entry may remain. Run the focused CMS tests and
typecheck, `npm run security`, `npm run verify`, and `git diff --check`.

After publication, the hosted `validate` job is authoritative. It must retain
green Trivy scans and pass the production dependency audit before PR #63 is
updated from `main`.

## Scope

No application code, database schema, deployment script, Trivy policy, API or
cron dependency changes are included. Any compatibility failure caused by the
two upgrades must be fixed explicitly and tested rather than bypassed.
