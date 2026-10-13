# Architecture
Modular monolith (NestJS). Domains so far: `auth`, `tenants` (platform, users), `academics`, `admissions`, `sis`, `demo`; shared `common`, `db`.
**Tenancy:** every tenant table carries `tenant_id`, has `ENABLE + FORCE ROW LEVEL SECURITY`, and policies compare to `app.tenant_id`, set per transaction by `DbService.withTenant`. Composite FKs `(tenant_id, id)` prevent cross-tenant references. Session tokens are `<tenantId>.<secret>`; only the SHA-256 is stored.
**Authorization:** grants = role permissions × campus scope (null = tenant-wide). Controllers call `needs()`/`campusScope()`; resource-level rules (guardian link, own course) live in services. Not-visible resources return 404.
**Data model:** one `students` identity; `enrollments` and `residence_assignments` are effective-dated with GiST exclusion constraints (no overlaps) so boarder/day-scholar and class changes keep history.
**Errors:** `ErrorFilter` maps DB constraint errors to 4xx. Request bodies are validated with zod.
Planned: Next.js frontend, queue for notifications, S3 storage adapter, demo adapters for payments/messaging/GPS (not built).
