# Requirements traceability (last updated: session 1)

Statuses: Not started · In progress · Implemented, tests pending · Verified · Blocked · Deferred.
"Verified" = automated tests executed and passing (21/21 at this checkpoint: `apps/api/test/slice.spec.ts`, `seed.spec.ts`).
Source spec: master prompt received in session; **its text was truncated mid-§6G (after "Advanced learning")** in the first message and
resent in full later; the demo-data addendum is also in scope.

## Module summary
| ID | Module | Status | Notes |
|---|---|---|---|
| A | Organization & administration | In progress | tenants, campuses, academic years, grades, sections, subjects: **Verified** (create/list). Terms, holidays, buildings, houses, branding UI, approval chains, settings inheritance: Not started |
| B | Admissions & enrollment | In progress | application → state machine → enroll (student ID, guardian, parent invite, section capacity, residence, LMS access): **Verified**. CRM enquiries, doc verification, tests/interviews, scholarships, offers/agreements, withdrawals: Not started |
| C | SIS | In progress | student master, guardians, effective-dated enrollment & residence history (DB-enforced non-overlap), section transfer, restricted medical alerts: **Verified**. Documents, pickup persons workflow, leaving certificates, duplicate detection, corrections: Not started |
| D | Academic management | Not started | (only sections/subjects/courses scaffolding) |
| E | Attendance | Not started | |
| F | Exams & report cards | Not started | |
| G | LMS | In progress | courses per section/subject/teacher, roster sync on enroll/transfer, teacher roster access: **Verified**. Lessons, content, homework, assessments, gradebook, ERP sync: Not started |
| H | Boarding & hostel | Not started | residence type only |
| I | Day scholar / dismissal | Not started | |
| J | Transport | Not started | |
| K | Finance | Not started | |
| L | Portals | In progress | API-only: parent `GET /me/children`, `GET /students/:id/overview`. No UI |
| M | Health/safeguarding | In progress | medical alerts with separate permission + audited reads: **Verified**. Rest Not started |
| N–S | Security/visitors, library/inventory, HR, meals/sports, communication, compliance/analytics | Not started | |
| T | Security & infra | In progress | see below |

## Implemented requirements
| Req | Description | Location | Tests | Status |
|---|---|---|---|---|
| SEC-1 | Tenant isolation (Postgres RLS forced on all tenant tables) | migrations 001/002, `DbService.withTenant` | slice.spec "isolates tenants", "RLS blocks…" | Verified |
| SEC-2 | Server-side RBAC with campus-scoped grants; configurable role tables; 21 seeded roles (platform admin = platform token, see limitations) | `common/http.ts`, `permissions.ts` | slice.spec | Verified (only roles with permissions are exercised) |
| SEC-3 | Passwords (scrypt), opaque hashed sessions, lockout, login rate limit, MFA (TOTP) enforced for privileged accounts, disable → immediate revoke | `auth/*` | slice.spec | Verified (rate limit is in-memory) |
| SEC-4 | Append-only audit log for sensitive actions | `common/audit.ts`, trigger | slice.spec | Verified (coverage partial) |
| SEC-5 | Parent sees only linked children; teacher only own-course students, without family data; unrelated parent gets 404 | `sis/students.controller.ts` | slice.spec | Verified |
| WF-1 | Admission → enrollment → student ID → class → parent account → LMS → residence (boarding **assignment type only**; no bed/transport) | `admissions/*` | slice.spec, seed.spec Scenario A | Verified (partial: no bed/transport) |
| WF-6 | Transfer: section change + residence change with history preserved (no fee/access steps) | `sis/*` | slice.spec | In progress |
| DEMO-1 | Deterministic idempotent seed, reset command w/ production guard, demo info, demo MFA | `demo/*` | seed.spec | Verified for implemented modules only |
| DEMO-2 | Dummy data for all other modules, interactive UI, demo adapters, in-app reset, scenarios B–G | — | — | Not started |
| WF-2,3,4,5,7 | Leave/gate, pickup, LMS→report card, invoice→payment, safety incident | — | — | Not started |
