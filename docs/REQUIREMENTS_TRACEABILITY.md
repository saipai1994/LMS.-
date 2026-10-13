# Requirements traceability (latest session)

Statuses: **Verified** = covered by automated tests that were executed and passed (API Jest, Playwright E2E). **Implemented, untested** = code exists, no dedicated test. **Partial**, **Not started**, **Deferred**.
"API-only" = no UI. Test suites: `apps/api/test/*.spec.ts`, `apps/web/e2e/*.spec.ts`.

| Area | Status | Evidence / notes |
|---|---|---|
| Tenancy, RLS, plans/entitlements, platform onboarding, usage, export | Verified | `slice`, `reports_saas_security` |
| Auth: login, activation, lockout, MFA (TOTP), reset, sessions, password change | Verified | `slice`, `reports_saas_security`, `admin_privacy` (password/session coverage is light) |
| RBAC: roles/permissions editor, campuses, user lifecycle & role grants | Verified (API) / Partial UI | `admin_privacy`; role editor has no web UI |
| Academic setup (years, grades, sections, subjects), SIS, guardians, residence | Verified | `slice`, `seed` |
| Admissions: application → offer/consent → enrol → LMS access | Verified | `slice`, `finance_admissions_extras`, E2E. Admission-fee collection: Not started |
| Student lifecycle: promotion, withdrawal/transfer, clearance, documents, corrections | Verified | `lifecycle` |
| Attendance, leave, hostel, dismissal (late/early), incidents | Verified | `attendance`, `hostel`, E2E |
| LMS: courses, lessons, assignments, quizzes, discussions, analytics, files | Verified | `lms`, `engagement_advanced` |
| Grades, official marks, report cards, exams, timetable | Verified | `lms`, `reports_saas_security`, `campus_comms_scheduling` |
| Curriculum/syllabus/lesson plans, terms/semesters, question bank/papers | Not started | |
| Learning pathways, gamification, AI tools, live classes, plagiarism | Not started | |
| Finance: fee heads/structures, invoices, payments (idempotent), receipts, concessions, credit notes, refunds, Demo gateway | Verified | `finance`, `finance_admissions_extras` (online payments are DEMO / SIMULATED). GST: Not started |
| Accounting: chart of accounts, auto-posted balanced journals, trial balance, backfill | Verified | `accounting`. Manual journals, budgets, bank import: API-only |
| Transport, library, inventory/procurement | Verified | `transport`, `library_inventory`; real GPS: Not started |
| HR/payroll, health/medication, security/visitors | Verified | `hr_health_security` |
| Meals, activities, awards, calendar, tickets, communications, notifications | Verified | `campus_comms_scheduling`, E2E. Email/SMS delivery: not configured |
| Consents (grade/activity scoped) | Partial | API-only |
| Reports and dashboards (role-based) | Verified | `reports_saas_security`, E2E |
| Privacy: DSAR, export, retention, anonymisation | Implemented, API-only; Verified | `admin_privacy`; anonymisation scope is minimal; no legal review |
| Demo mode (Greenwood, deterministic, idempotent, reset) | Verified | `seed`, E2E |
| Custom fields/workflows, sports houses, laundry, duty rosters, cafeteria wallet, WhatsApp, SSO | Not started | |
| QR/RFID/biometric input, device integrations | Not started | |
| PDF generation, SaaS billing, tenant data deletion, monitoring | Not started | |
| Sibling/emergency-contact UIs | Not started | |
| Deployment: Docker, CI workflow, backup/restore | Docker/CI unverified; backup/restore Verified once | see `KNOWN_LIMITATIONS.md` |
| Accessibility | Partial | automated axe WCAG2A/AA on key pages; no manual audit |
