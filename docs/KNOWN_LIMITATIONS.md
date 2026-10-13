# Known limitations and defects

Honest list as of the latest session. Nothing here is hidden behind a "success" message in the UI.

## Not connected / simulated
- **No real email, SMS, WhatsApp, push, payment gateway, GPS, biometric/RFID/QR hardware, SSO or AI provider.** Notifications are in-app only; email/SMS are recorded as `not_configured`. The payment gateway is a signed-webhook **Demo** gateway.
- Plagiarism checking, live classes, AI tools, adaptive pathways, gamification: not implemented.
- PDFs: printable HTML only; no server-side PDF generation.

## Features absent or partial (see traceability matrix)
- Custom fields/workflows engine, curriculum/syllabus/lesson plans, terms/semesters, sports houses, question papers/banks.
- Admission-fee collection, GST, SaaS billing, tenant data deletion/offboarding.
- Laundry, duty rosters, cafeteria wallet. Sibling/emergency-contact UIs.
- Some accounting setup (manual journals, budgets, bank-statement import), grade/activity-scoped consents and the privacy module are **API-only** (no UI).
- Privacy: anonymisation only blanks the student row identifiers; derived records (guardian contacts, documents, free text in other modules) are not scrubbed. Needs legal/DPDP review.

## Operational
- Rate limiter and the announcement scheduler are in-process: single instance only.
- Docker images and `docker-compose.yml` have **not been built or run** (no usable Docker daemon in the dev environment).
- Backups need a BYPASSRLS role (forced RLS blocks `pg_dump` as the app role). `scripts/backup-restore-check.sh` passed once on demo data; no scheduled backups or PITR.
- Files are stored on local disk; no virus scanning or object storage.
- Platform administration uses a bootstrap token, not an MFA-protected user.
- No load, penetration or independent accessibility testing; a11y checks are automated axe (WCAG2A/AA) on key pages only.
- Migrations are forward-only.
- Legal/regulatory review (DPDP, education, accounting/GST) has not been done.
