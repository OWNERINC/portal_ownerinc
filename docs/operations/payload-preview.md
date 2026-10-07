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
  is rejected without buffering it all in memory. Around native Docker calls,
  PowerShell temporarily uses `Continue` for `ErrorActionPreference` and restores
  the prior value in `finally`; this keeps normal CLI stderr from becoming a
  terminating `NativeCommandError` under Windows PowerShell 5.1. The launcher
  still checks each captured native exit code, and build/up diagnostics remain
  available to caller redirection such as `*> launch.log`.

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

### Temporary HTTPS recovery artifacts

Use this separate, **prepare-only** path only for a specifically authorized
recovery of an existing private preview. It does not edit the original `compose.env`,
preview override, Firebase module, Nginx configuration, or image tags. It reads
only `COMPOSE_PROJECT_NAME`, `PREVIEW_RUN_DIR`, `FIREBASE_PROJECT_ID`, `HTTP_PORT`,
and `AUTH_PORT` from the run's private environment for identity checks; those values
are never printed. The `--project` value is mandatory, must match the anchored
`ownerinc-payload-preview-<run-id>` format, and must exactly match the run
metadata. The output must be a new direct child named
`recovery-https-<label>`; collisions are rejected. POSIX artifacts are owner-only
`0700`/`0600`; Windows artifacts use the existing current-user/Local System ACL
policy. The certificate and key inputs must be absolute, regular, non-symlink
files outside Git repositories. On POSIX, both source files must also have
owner-only permissions. The script validates certificate dates, self-signature,
key correspondence, and SANs for `127.0.0.1` and `localhost`, then copies the
validated pair into the new private recovery directory.

Create a short-lived local certificate separately, only after the main session
authorizes that one-shot container action. Do not install OpenSSL or generate a
key on the host as part of preparation. Use an already-approved OpenSSL
container image pinned by digest, with network disabled and a newly-created
private input directory under the existing run. For example, in a POSIX shell
(replace the image placeholder only with an approved, already-available digest):

```sh
tls_input="$run_dir/tls-input"
umask 077
mkdir -m 700 "$tls_input"
docker run --rm --network none \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$tls_input,dst=/out" \
  '<approved-openssl-image@sha256:...>' \
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
    -keyout /out/localhost.key -out /out/localhost.crt \
    -subj '/CN=127.0.0.1' \
    -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' \
    -addext 'keyUsage=critical,digitalSignature,keyEncipherment' \
    -addext 'extendedKeyUsage=serverAuth'
chmod 600 "$tls_input/localhost.key" "$tls_input/localhost.crt"
```

On Windows, use an equivalently approved disposable image and a bind mount to a
new directory under the run; ensure that directory inherits/restricts access to
the current user and Local System before writing the inputs. Do not use a
publicly trusted certificate, production key, or a certificate for any host
other than this loopback-only preview.

After inspecting the paths and confirming the selected HTTPS port is free,
prepare a distinct output child. Preparation performs no Docker calls, reads no
service state, and launches nothing:

```powershell
node scripts/prepare-payload-preview-https.mjs prepare `
  --run-directory 'C:/Users/Public/ownerinc-payload-preview-gate2-20261007-b' `
  --output-directory 'C:/Users/Public/ownerinc-payload-preview-gate2-20261007-b/recovery-https-20261007-a' `
  --project 'ownerinc-payload-preview-d755db45c46d' `
  --https-port 19443 `
  --certificate 'C:/Users/Public/ownerinc-payload-preview-gate2-20261007-b/tls-input/localhost.crt' `
  --private-key 'C:/Users/Public/ownerinc-payload-preview-gate2-20261007-b/tls-input/localhost.key'
```

Choose values that match the actual protected run and a currently free loopback
port; the illustrative project/run values above are not auto-discovered. Run
`node scripts/prepare-payload-preview-https.mjs --check` beforehand for the
offline source-contract check. Generated launchers pin the current checkout,
original private env file, project name and original `compose.preview.yml`, then
append only the HTTPS override. They use the existing image tags without
building, retain the existing project-scoped volumes and credentials, run
`docker compose config --quiet`, and request only `nginx`, `cms`, and
`firebase-auth`. The override publishes only `127.0.0.1:<HTTPS-port>:443`, removes
the host-published Auth Emulator/UI ports, changes the API public URL and CORS
plus the CMS public origin to the exact HTTPS loopback origin, and sets CMS plus
migration `NODE_ENV=production` for secure `__Host-` cookie behavior. It adds no HTTP
redirect. Auth SDK traffic uses the HTTPS origin and Nginx forwards only POSTs
to the three exact sign-in, account-lookup, and token-refresh emulator paths;
there is no arbitrary emulator proxy. Nginx clears loopback HSTS state and
trusts its own TLS scheme rather than an inbound forwarded-protocol value.

If the existing run depends on an earlier recovery/base override (for example,
an explicitly reviewed runtime-fix YAML), pass its absolute path with
`--base-override`. That file must already exist inside this same private run; it
is appended after `compose.preview.yml` and before the HTTPS override. There is
no filename auto-discovery. Omitting the option assumes the original
`compose.preview.yml` already contains the required TCP database healthchecks
and preview migration settings.

Review all generated artifacts and run the launcher only under separate
authorization: it changes/recreates services in the existing preview project
when invoked. A successful prepare or Compose configuration check is not
runtime, cookie, sign-in, Gate 2, or native-admin acceptance. In particular, it
does not diagnose or claim to fix any prior cookie HTTP 503; that remains a
separate runtime observation.

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
