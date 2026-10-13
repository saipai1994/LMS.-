# Security

- **Tenant isolation**: `tenant_id` on every tenant table, composite FKs, `ENABLE`+`FORCE ROW LEVEL SECURITY`; the API sets `app.tenant_id` per transaction.
- **AuthN**: scrypt password hashing, opaque session tokens stored as SHA-256, lockout after 5 failures, per-IP login rate limit (in-process), admin-issued password reset, enumeration-safe `forgot`. TOTP MFA is mandatory for any account holding a privileged permission.
- **AuthZ**: server-side permission checks with optional campus scope, resource-level rules (guardian link, own course, class teacher); invisible resources return 404. Role editing cannot grant permissions the editor lacks; the group-admin role is fixed and the last group admin cannot be removed.
- **Evidence integrity**: audit log, ledger, journals, gate movements, official marks and similar tables are append-only via triggers; journals must balance; maker-checker on sensitive approvals.
- **Payments**: idempotency keys, HMAC-signed webhooks with event-id dedupe and amount checks (Demo gateway only).
- **Files**: MIME allowlist plus magic-byte check, access via `file_links`.
- **Privacy**: DSAR tracking (30-day due date), student data export, retention-gated anonymisation. Not legally reviewed.
- **Secrets**: none committed; see `.env.example`. `npm audit` clean at last run.
- **Gaps**: no CSRF-relevant cookies (bearer tokens in sessionStorage → XSS is the main risk; CSP not yet tuned), no field-level encryption, no at-rest encryption config, no pen test. See KNOWN_LIMITATIONS.
