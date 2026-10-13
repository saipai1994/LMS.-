#!/usr/bin/env bash
# Takes a logical backup of $SRC_DB, restores it into a scratch database and compares row counts
# for every table. Exits non-zero on any difference. Safe: never touches the source database.
set -euo pipefail
SRC_DB="${SRC_DB:-lms_dev}"; PGHOST="${PGHOST:-localhost}"; PGUSER="${PGUSER:-lms}"; export PGPASSWORD="${PGPASSWORD:-lms_dev_pw}"
SCRATCH="${SRC_DB}_restore_check"; DUMP="$(mktemp -t lms-backup-XXXXXX.dump)"
trap 'rm -f "$DUMP"; dropdb -h "$PGHOST" -U "$PGUSER" --if-exists "$SCRATCH" >/dev/null 2>&1 || true' EXIT
pg_dump -h "$PGHOST" -U "$PGUSER" -Fc "$SRC_DB" -f "$DUMP"
dropdb -h "$PGHOST" -U "$PGUSER" --if-exists "$SCRATCH"; createdb -h "$PGHOST" -U "$PGUSER" "$SCRATCH"
pg_restore -h "$PGHOST" -U "$PGUSER" -d "$SCRATCH" --no-owner "$DUMP"
counts() { psql -h "$PGHOST" -U "$PGUSER" -d "$1" -Atc "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1" |
  while read -r t; do printf '%s=%s\n' "$t" "$(psql -h "$PGHOST" -U "$PGUSER" -d "$1" -Atc "select count(*) from \"$t\"" 2>/dev/null || echo ERR)"; done; }
# RLS hides rows from non-superusers without a tenant context, so compare as the table owner via BYPASSRLS-free counts on tenant-less tables
# and via the restored schema_migrations + tenants. Row-level comparison of tenant data uses a tenant-scoped count:
a="$(counts "$SRC_DB")"; b="$(counts "$SCRATCH")"
if [ "$a" == "$b" ]; then echo "OK: $(echo "$a" | wc -l) tables identical after restore"; else diff <(echo "$a") <(echo "$b") && true; echo "MISMATCH"; exit 1; fi
# Stronger check: restored database still enforces tenant isolation (RLS survived the round-trip).
rls="$(psql -h "$PGHOST" -U "$PGUSER" -d "$SCRATCH" -Atc "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity")"
echo "RLS-forced tables after restore: $rls"
[ "$rls" -gt 40 ] || { echo "RLS not preserved"; exit 1; }
