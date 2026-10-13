# Known limitations and defects (session 1)
- **No frontend.** No dashboards, no Next.js app; the "demo" is API + seeded data. No accessibility/localization work.
- Most modules (D–F, H–K, N–S, most of G) are not started; seed data exists only for implemented tables.
  The 100-lessons/150-assignments/500-attendance/200-invoice/library/etc. demo targets are **not met**.
- Platform administrator is a bootstrap token (`PLATFORM_BOOTSTRAP_TOKEN`), not a user with MFA/audit identity. No tenant offboarding/export.
- Email/SMS/push are not configured: invite tokens are returned in API responses to the authorised caller. No password reset flow yet.
- Login rate limiter is in-memory (per process); needs Redis/DB store for multiple instances. No CSRF concerns yet (bearer tokens, no cookies).
- Audit coverage is partial (admissions, enrolment, user, medical, auth, residence); reads other than medical are not audited. Audit log can be deleted only by dropping the schema (reset command).
- Roles for unbuilt modules have empty permission sets; users with those roles can log in but see nothing.
- Teacher scoping covers courses only (no timetable/attendance scoping yet). No field-level encryption, no encryption-at-rest configuration, no file storage.
- Legal: DPDP/education/accounting obligations not yet assessed; no consent workflows. Demo data is fictional.
- Migrations are forward-only SQL; no down migrations or backup/restore procedure tested.
- `npm audit` reports advisories in dev dependencies; not yet triaged.
- Tests must run in band (`npm test`); they wipe `lms_test`.
