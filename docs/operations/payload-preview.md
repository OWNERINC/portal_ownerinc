# Payload local preview preparation (Gate 2)

This is a **prepare-only** harness for a new, isolated local Portal + Payload +
Firebase Auth Emulator stack. Preparation writes per-run configuration and
launchers; it does not invoke Docker, start or stop services, run migrations,
read `.env`, or connect to production. It never reuses the Task9/finalizer
database or Firebase port assignments.

## Prerequisites and safety boundary

- Run with the repository's supported Node.js version. No package installation
  is needed.
- Choose an absolute, new run-directory path on a local filesystem, outside this
  checkout and every Git repository. Its parent must already exist. Symlink and
  junction ancestors are rejected. The requested directory is created
  exclusively; an existing path is never overwritten or removed.
- Choose two distinct free loopback ports (1024–65535). The default Auth
  Emulator port 9099 is deliberately not used because another protected stack
  may own it. Port availability is checked before creating the run directory.
- On POSIX, generated directories/files use owner-only `0700`/`0600` modes. On
  Windows, preparation removes inherited ACLs and grants access only to the
  current user and Local System. If it cannot establish those permissions, it
  fails before writing secrets. Treat the generated `compose.env` as a
  credential file: do not commit, upload, paste, or share it.
- The target database and CMS Postgres remain unpublished. Only the generated
  HTTP port and selected Auth Emulator port bind to `127.0.0.1`.

## Prepare

First run the offline source-contract check; it performs no Docker calls and
does not write files:

```sh
node scripts/prepare-payload-preview.mjs --check
```

Example in PowerShell (choose/create an external parent that is not inside a
Git repository; the generated name makes a fresh run directory):

```powershell
$runRoot = 'C:/payload-preview-runs'
New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
$runDirectory = Join-Path $runRoot ("ownerinc-payload-preview-" + [guid]::NewGuid().ToString('N'))
node scripts/prepare-payload-preview.mjs prepare --directory $runDirectory --http-port 18080 --auth-port 19099
```

The same interface works from POSIX shells; select an external parent that is
not inside a Git repository and use a new directory name:

```sh
run_id="$(node -e "process.stdout.write(require('node:crypto').randomUUID().replaceAll('-', ''))")"
run_root="/var/tmp/ownerinc-payload-preview-runs" # use another external, non-Git root if needed
mkdir -p "$run_root"
run_dir="${run_root}/ownerinc-payload-preview-${run_id}"
node scripts/prepare-payload-preview.mjs prepare --directory "$run_dir" --http-port 18080 --auth-port 19099
```

Create the POSIX parent directory in advance if needed. If either port is
occupied, the command fails closed without creating the run directory; choose
different free ports and retry with a different new directory. The command
prints paths and a resource summary, never generated credentials. The
`--help` option documents the command line.

## What preparation creates

- A private `compose.env` containing new random Portal database, CMS database,
  Payload, bridge, worker, and dummy SMTP secrets. Portal's database is
  `portal_test`; the independent CMS Postgres keeps the required
  `ownerinc_cms` database. The admin/migrator/runtime role credentials and
  connection URLs are distinct and generated for each run.
- A per-run Compose override that assigns project-scoped volumes and the default
  network through a unique project name. API, CMS, Firebase Emulator (and the
  unused Cron service) get run-specific image tags instead of shared `latest`
  tags. The preview override makes both PostgreSQL healthchecks require TCP on
  `127.0.0.1` with their configured user/database, so the temporary
  initialization-only Unix socket cannot mark either database healthy early.
- A copy of the browser Firebase module using only a synthetic
  `demo-<run>` project ID and the selected loopback Auth port. It retains the
  module's `auth` export and pinned SDK imports. Nginx receives a private copy
  with only its existing CSP `connect-src` emulator origins replaced by the
  selected loopback Auth endpoint; other directives and routes remain intact.
- Read-only bind mounts for the checkout's `public/` tree, generated Firebase
  module override, and generated Nginx configuration.
- POSIX and PowerShell launchers. Before building or starting anything, each
  launcher requires Docker Compose 2.24.4 or newer, rejects non-local Docker
  contexts, and runs quiet Compose config validation. Each invocation pins the
  base Compose files and project directory to the current checkout and points
  `--env-file` to the private generated file. It clears inherited Compose
  interpolation variables to avoid accidental host `.env`/shell values. The
  PowerShell launcher is UTF-8 with a BOM so Windows PowerShell 5.1 preserves
  Unicode checkout and run-directory paths. Both launcher variants inspect the
  selected context with the quote-free `{{.Endpoints.docker.Host}}` template;
  this preserves PowerShell 5.1 native argument serialization while still
  rejecting contexts whose endpoint is not a local `unix://` or `npipe://` pipe.
  PowerShell drains each native probe to completion, checks its exit status, and
  accepts only one well-formed output line before proceeding. It retains at most
  two lines of up to 256 characters while draining, so extra or oversized output
  is rejected without buffering it all in memory.

The run uses `NODE_ENV=development` for the local HTTP cookie behavior. The
preview override applies it to both the CMS runtime and migration one-shot; the
production Payload Compose overlay remains unchanged. The database-only CMS
provisioning one-shot is not changed. It does not change production settings or
production credentials. SMTP targets
container loopback `127.0.0.1:1` (no SMTP service is started) and uses
synthetic `.invalid` identities. Sólides is explicitly off. No cron or Payload
worker is started by the generated launchers.

## Launch later, only when authorized

Preparation itself does not launch services. Review its output, confirm both
selected ports are still free, and then choose **one** generated launcher:

```powershell
& 'C:/absolute/path/to/the-run/launch.ps1'
```

```sh
sh '/absolute/path/to/the-run/launch.sh'
```

Both scripts reference the run's `compose.env` and run `docker compose config
--quiet`, build the run-specific API/CMS/Auth images, then request only
`nginx`, `cms`, and `firebase-auth`. Compose starts their normal dependencies:
the isolated Portal and CMS Postgres services and their existing migration
services. Those services migrate only their new per-run databases. The
launchers do not request `cron`, `cms-worker`, `bootstrap-admin`, or the
Firebase Emulator UI. The Auth Emulator is exposed only on the selected
loopback port; Nginx is exposed only on the selected loopback HTTP port.
The launchers wait up to five minutes for Compose health/running readiness;
this only establishes service readiness and does not authenticate a user.

Launch-time port use can change after preparation; Docker will reject a port
that became occupied. No teardown or volume deletion is automated. Do not use
`docker compose down -v` against a run when its data should be retained.

For a correction to an already-created run, do not rerun `prepare` into that
directory or overwrite its `compose.env`, original override, project name, or
image tags. Render a new recovery override and separate launchers under a fresh
child directory of the same private run, creating each file exclusively and
preserving the run's restrictive ACL/mode. Pass the existing checkout, run
directory, and project name to `renderLaunchers`, with the new override in
`additionalComposeFiles`; the existing env-file path and project-scoped volumes
then remain unchanged, and the recovery override is appended after the original
one. Validate the same ordered file set with read-only `docker compose config`
before any authorized launch. Configuration validation is not service readiness.

## Gate boundary and evidence

This harness prepares a disposable runtime for **Gate 2 service readiness**, not
an authenticated-admin or News-activation acceptance. It does not seed an
administrator, manufacture identities/content, bypass CMS/API authorization,
or activate Owner News. The existing activation guard can still return the
expected `not-activated` session result; that is a blocked acceptance, not a
reason to bypass the guard. Authenticated-admin acceptance waits for the
separate Gate 3 change that legitimately decouples admin access from News
activation. A browser screenshot or real sign-in is not evidence produced by
preparation.

Images are built from the current checkout when the generated launcher is
explicitly used; this preparation does not prove equivalence with a production
artifact. It does not apply production changes or touch existing protected
containers, volumes, networks, ports, accounts, or data.
