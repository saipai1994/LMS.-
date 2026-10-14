# Deployment (unverified beyond local development)

- Requirements: Node 22, PostgreSQL 16, persistent disk for `FILE_STORAGE_DIR`.
- Env: `DATABASE_URL`, `PORT`, `PLATFORM_BOOTSTRAP_TOKEN` (≥24 chars), `FILE_STORAGE_DIR`, `LOGIN_RATE_LIMIT_PER_MIN`, `DEMO_MODE` (never true in production), `DEMO_GATEWAY_SECRET`.
- Web: `API_URL` is a **build-time** variable; rebuild to change it.
- The app role must own the schema and is subject to forced RLS. Back up with a separate BYPASSRLS role (see `scripts/backup-restore-check.sh`).
- `apps/api/Dockerfile`, `apps/web/Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml` exist but **have not been built/run**.
- Run a single API instance until the rate limiter and scheduler move out of process. Terminate TLS in front of the app.

## Render (demo)
`render.yaml` is a Blueprint for a **demo** deployment (Postgres + API + web, `DEMO_MODE=true`, seeds Greenwood on every start; seeding is idempotent). In Render: New → Blueprint → select this repo/branch. Then open the `lms-web` URL and sign in per the README.
Not verified on Render (no access from the dev sandbox): the API and web builds pass locally, the Blueprint itself has never been applied. Free-tier caveats: Postgres expires after ~30 days, services sleep when idle (slow first load), uploaded files are on ephemeral disk. Do not use for real student data.

## GitHub Codespaces (demo, runs entirely inside GitHub)
Repo → Code → Codespaces → Create codespace on `main`. `.devcontainer/` starts Postgres, seeds Greenwood, builds and starts API (:3001) and web (:3000); open the forwarded port 3000 and log in per the README. **Unverified**: the devcontainer has not been run (no Docker in the dev sandbox). Codespaces stop when idle and ports are private by default, so this is for the owner's own demos, not a public site.
