# K-12 ERP + LMS (day & boarding schools)

Multi-tenant school ERP with an integrated LMS: admissions → student records → academics/LMS → attendance → hostel/dismissal → finance/accounting → transport, library, inventory, HR/payroll, health, security, communications, reports.
**Not production-ready.** Read `docs/KNOWN_LIMITATIONS.md` and `docs/REQUIREMENTS_TRACEABILITY.md` for exactly what exists, what is verified and what is missing.

Stack: NestJS 11 (TypeScript) · PostgreSQL 16 with forced row-level security · plain SQL migrations (`apps/api/migrations`) · Next.js 16 / React 19 web app (`apps/web`) · Jest/supertest + Playwright/axe tests.

## Quick start
```bash
# prerequisites: Node 22, PostgreSQL 16 (role lms / password lms_dev_pw for local dev)
createdb -O lms lms_dev; createdb -O lms lms_test
cd apps/api && npm install && cd ../web && npm install && cd ../..
cp .env.example apps/api/.env
cd apps/api
npm test                                 # API tests (in band; wipes lms_test)
DEMO_MODE=true npm run db:seed           # idempotent demo data
DEMO_MODE=true npm run start:dev         # API :3001, migrations auto-applied
cd ../web && API_URL=http://localhost:3001 npm run build && npm start   # web :3000 (API_URL is read at BUILD time)
cd ../web && npx playwright test         # E2E + accessibility (uses lms_e2e, ports 3001/3100)
```

## Demo mode — Greenwood International Academy (entirely fictional)
300 students (220 day / 80 boarders), 250 guardians, 60 staff, 24 sections, 192 courses plus finance, attendance, hostel, transport, library, HR, health and accounting data. Deterministic and idempotent.
`DEMO_MODE=true CONFIRM_RESET=yes npm run db:reset-demo` wipes and reseeds (refuses outside demo mode). In-app reset: `POST /demo/reset`.

Tenant `greenwood`, password `Demo-Passw0rd!2026`, logins `<role>@greenwood.demo` for: admin, principal, admissions, accountant, teacher, parent, student, warden, transport, nurse, librarian, inventory, gate, registrar, examcoord, hr, kitchen, safeguarding, lmsadmin, campusadmin.
Accounts holding privileged permissions must enrol TOTP MFA; the demo secret is `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP` (`npm run demo:code` prints the current code).
Email, SMS, GPS, payment and AI providers are **not** connected: such features are labelled "Demo / Simulated" or "not configured".

## Platform onboarding
`POST /platform/tenants` with header `x-platform-token: $PLATFORM_BOOTSTRAP_TOKEN` (≥24 chars) creates a tenant, campus, system roles and an invited group admin.

## Docs
`docs/`: PRD, ARCHITECTURE, SECURITY, DEPLOYMENT, OPERATIONS, INTEGRATIONS, TEST_PLAN, ROADMAP, KNOWN_LIMITATIONS, REQUIREMENTS_TRACEABILITY, API (generated, 364 routes), DATABASE (generated, 157 tables).
