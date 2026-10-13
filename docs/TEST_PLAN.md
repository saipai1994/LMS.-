# Test plan
Executed (session 1): `npm test` in `apps/api` — 21 tests, 2 suites, all passing: auth/MFA/lockout/rate limit; admission workflow & capacity; parent/teacher/medical access; history preservation; tenant isolation (URLs, ids, bodies, lists, forged token, RLS, audit immutability); seed counts/relationships/determinism/idempotency; Scenario A.
Not yet: browser E2E, accessibility, performance, migration-upgrade, payment idempotency, notification failure, export tests (features absent).
