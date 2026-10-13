# Architecture

Monorepo: `apps/api` (NestJS, `pg`, zod) and `apps/web` (Next.js; browser calls same-origin `/api/*`, rewritten to the API using the build-time `API_URL`).
- One controller per domain under `apps/api/src/<domain>`; shared helpers in `common/` (permissions, entitlements, audit, GL posting, crypto, error mapping).
- `DbService.withTenant` wraps each request in a transaction with `app.tenant_id` set; errors flagged `commit:true` still commit (failed-login counters).
- Plain SQL migrations 001–018 applied automatically on boot.
- Plan entitlements map URL segments to licensable features (basic/standard/premium) and are enforced in the auth guard.
- Accounting: finance, payroll and refund events auto-post idempotent balanced journals.
- Demo seeding is deterministic and lives in `src/demo`.
- Money is integer minor units; dates are `YYYY-MM-DD` strings; campus-local time zones drive dismissal logic.
Generated references: `API.md`, `DATABASE.md`.
