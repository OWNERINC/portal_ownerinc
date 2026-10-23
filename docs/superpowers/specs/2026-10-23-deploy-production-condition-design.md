# Production Deploy Condition Correction

## Context

The merged `main` commit `0a51dc1a1100cce3ed59c36719567e819d65d1e0`
passed the complete hosted `validate` job in push run `39946474596` and manual
run `39947566880`. In both runs, `Deploy production` was skipped before any
step ran, so no GitHub deployment was created and the VPS was not changed.

The normal validation graph intentionally skips `isolated-b0-recovery` and
allows `validate` to run through an explicit status function. The downstream
deploy condition has no status function. GitHub therefore applies its implicit
`success()` check, which can propagate the skipped ancestor and prevent the
deploy job from evaluating its otherwise eligible normal-main policy.

## Decision

Keep the existing event, branch, and mode restrictions, but make dependency
handling explicit. `Deploy production` will run only when all of these are true:

- the workflow has not been cancelled;
- the direct `validate` dependency concluded `success`;
- the event is `push` or `workflow_dispatch`;
- the ref is exactly `refs/heads/main`;
- `cms_image_only` is not enabled;
- `publish_candidate_only` is not enabled.

Use `!cancelled()` rather than `always()` so a cancelled run cannot become
eligible for production. Keep `needs: validate`, the production environment,
serialized concurrency, immutable image outputs, restricted SSH, backup,
migration, smoke, retry, and rollback behavior unchanged.

## Contract Tests

Replace the deploy condition's text-only assertion with a contract that binds
the exact explicit status guard and evaluates the intended decision matrix:

- successful `push` on `main` deploys;
- successful normal `workflow_dispatch` on `main` deploys;
- pull requests and non-main refs do not deploy;
- CMS-only and candidate-only dispatches do not deploy;
- failed validation and cancelled workflows do not deploy.

The tests remain offline and dependency-free. They validate both the workflow
expression and the policy scenarios so a future textual refactor cannot silently
restore implicit skipped-ancestor behavior.

## Documentation and Verification

Update `docs/operations/deployment.md` to state that normal main deployment uses
an explicit successful-validation guard because candidate recovery is expected
to skip in that path. Run focused workflow contract tests, `npm run verify`, and
`git diff --check`, then obtain a fresh independent review.

Publish this correction in a separate pull request. After approval and merge,
observe the automatic main run. The production job must be created, execute the
existing backup/migration/smoke/rollback receiver, and finish successfully. Do
not bypass the workflow with direct SSH or a manual VPS command.

## Scope

No application code, dependency, image, database schema, deploy receiver,
production secret, environment protection, or Trivy/audit policy changes are
included.
