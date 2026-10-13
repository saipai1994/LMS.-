# K-12 ERP + LMS (boarding & day schools)

Multi-tenant K-12 School ERP with an integrated LMS. **Work in progress — not production-ready.**
See `docs/REQUIREMENTS_TRACEABILITY.md` for exactly what exists and what does not, and `docs/KNOWN_LIMITATIONS.md`.

Stack: NestJS (TypeScript) · PostgreSQL 16 with row-level security · plain SQL migrations · Jest/supertest.
**There is no frontend yet** (Next.js is planned; see roadmap). Today the product is a tested REST API.

## Quick start
```bash
# prerequisites: Node 22, PostgreSQL 16
createuser -P lms            # password lms_dev_pw for local dev
createdb -O lms lms_dev; createdb -O lms lms_test
cd apps/api && npm install
cp ../../.env.example .env   # or export DATABASE_URL / PLATFORM_BOOTSTRAP_TOKEN
npm test                     # runs against lms_test (it is wiped on every run)
DEMO_MODE=true npm run db:seed          # idempotent demo data
DEMO_MODE=true npm run start:dev        # API on :3001, migrations auto-applied
```

## Demo mode (Greenwood International Academy — entirely fictional)
Seed: 300 students (220 day scholars / 80 boarders), 250 guardian accounts (50 with two children), 60 staff,
12 grades × 2 sections, 8 subjects, 192 LMS courses with rosters, 5 admission applications, 1 medical alert.
Deterministic and idempotent. `DEMO_MODE=true CONFIRM_RESET=yes npm run db:reset-demo` wipes the configured
database and reseeds (refuses in production / without DEMO_MODE).

Tenant slug `greenwood`, password `Demo-Passw0rd!2026`. Logins: `<role>@greenwood.demo` for
admin, principal, admissions, accountant, teacher, parent, student, warden, transport, nurse, librarian, inventory.
Privileged accounts (admin, principal, admissions, nurse, campusadmin) require MFA; the demo TOTP code is `npm run demo:code`.
`GET /demo/info` (demo mode only) lists this. Accounts for modules not yet built log in but have few/no permissions.

```bash
curl -s localhost:3001/auth/login -H 'content-type: application/json' \
 -d '{"tenant":"greenwood","email":"parent@greenwood.demo","password":"Demo-Passw0rd!2026"}'
```

## Platform onboarding
`POST /platform/tenants` with header `x-platform-token: $PLATFORM_BOOTSTRAP_TOKEN` (≥24 chars) creates a tenant, campus, system roles and an invited group admin.
