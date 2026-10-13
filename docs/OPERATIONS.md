# Operations
- Health: `GET /health`. Audit trail: `GET /audit-log` (permissioned). Per-tenant usage and export via `/platform/*`.
- Backup/restore: `scripts/backup-restore-check.sh`; schedule your own backups (none provided).
- Migrations run on boot; forward-only. Demo reset: `npm run db:reset-demo` (demo mode only).
- No metrics/alerting or log shipping configured. Announcements dispatch from a 60s in-process timer.
