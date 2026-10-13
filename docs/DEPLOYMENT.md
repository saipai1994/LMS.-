# Deployment
Not yet verified. Requirements: Node 22, PostgreSQL 16 (extensions pgcrypto, citext, btree_gist), env `DATABASE_URL`, `PLATFORM_BOOTSTRAP_TOKEN`, `PORT`. Build `npm run build`, run `node dist/main.js` (applies migrations at start). Use a non-superuser DB role (RLS is forced, but superusers bypass it). No Dockerfile/CI yet. Never set `DEMO_MODE` in production.
