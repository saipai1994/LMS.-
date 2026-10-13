# Test plan and recorded results

Only results from runs actually executed are listed.

| Layer | Command | Last result |
|---|---|---|
| API integration (Jest/supertest, real PostgreSQL `lms_test`, 16 suites) | `cd apps/api && npm test` | 111/111 passing across 16 suites (full run after the admin/privacy work) |
| Type check | `cd apps/api && npx tsc --noEmit` | clean |
| Web build | `cd apps/web && npm run build` | clean at last web change |
| E2E + axe (Playwright/Chromium) | `cd apps/web && npx playwright test` | 26/26 at last full run (before admin/privacy API work; no UI changed since) |
| Backup/restore | `PGUSER=lms_backup PGPASSWORD=… SRC_DB=lms_dev scripts/backup-restore-check.sh` | 123 tables identical after restore, RLS preserved |
| Dependency audit | `npm audit --omit=dev` (api, web) | 0 vulnerabilities |

Covered: tenant isolation and RLS, RBAC/resource-level access, MFA enforcement, lockout, idempotent payments and webhooks, balanced journals, append-only evidence, seed determinism, dismissal gating, lifecycle workflows, privacy gates.
Not covered: load/performance, penetration testing, real-provider integrations, Docker builds, cross-browser, mobile devices.
