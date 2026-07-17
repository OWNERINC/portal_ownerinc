# Repository Instructions

## Use this repo

- Read `README.md` and the relevant document under `docs/` before changing code.
- Start with `docs/product/brief.md` when the project is new to you.
- Keep changes small and localized.
- Preserve the current `api/`, `cron/`, `public/`, and `nginx/` boundaries.
- Use `npm run verify` for repeatable checks.
- Update matching documentation and tests when behavior changes.

## Main Areas

- `api/`: Express API with PostgreSQL and Firebase Admin.
- `cron/`: Node cron service for reminders and notifications.
- `public/`: static web application served by Nginx.
- `nginx/`: static hosting and API proxy configuration.
- `docker-compose.yml`: service orchestration.
- `docs/`: product, architecture, and operations decisions.
- `scripts/`: local checks that also run in CI.
- `tests/`: dependency-free automated checks.

## Rules

- Treat this as Linux/VPS-targeted code.
- Preserve LF line endings for `.sh`, Docker, and Nginx-related files.
- Do not hardcode database credentials, Firebase credentials, SendGrid keys, or service account data.
- Keep Node 18 compatibility.
- Do not change production deploy scripts unless the task is explicitly about deploy.
- Keep Portal and Ownerinc Brain as separate products and repositories.
- Keep `ownerinc-novo-agente/` outside this repository's scope.

## Commands

- Run all checks with `npm run verify`.
- Start the local stack with `docker compose up --build`.
- API-only start: `npm start` from `api/`.
- Cron-only start: `npm start` from `cron/`.
- Docker commands require explicit user approval when they affect running services.

## Verification

- Run `npm run verify` before sharing changes.
- Prefer local checks over production service changes.
