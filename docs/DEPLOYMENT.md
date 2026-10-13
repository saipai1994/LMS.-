# Deployment (unverified beyond local development)

- Requirements: Node 22, PostgreSQL 16, persistent disk for `FILE_STORAGE_DIR`.
- Env: `DATABASE_URL`, `PORT`, `PLATFORM_BOOTSTRAP_TOKEN` (≥24 chars), `FILE_STORAGE_DIR`, `LOGIN_RATE_LIMIT_PER_MIN`, `DEMO_MODE` (never true in production), `DEMO_GATEWAY_SECRET`.
- Web: `API_URL` is a **build-time** variable; rebuild to change it.
- The app role must own the schema and is subject to forced RLS. Back up with a separate BYPASSRLS role (see `scripts/backup-restore-check.sh`).
- `apps/api/Dockerfile`, `apps/web/Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml` exist but **have not been built/run**.
- Run a single API instance until the rate limiter and scheduler move out of process. Terminate TLS in front of the app.
