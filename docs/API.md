# API (Bearer token from `/auth/login`; JSON errors `{error, ...}`)
Public: `POST /auth/login|activate`, `GET /demo/info` (demo only). Platform (x-platform-token): `POST /platform/tenants`, `PATCH /platform/tenants/:id/status`.
Auth: `GET /auth/me`, `POST /auth/logout|mfa/setup|mfa/enable`.
Admin: `POST /users`, `POST /users/:id/disable`, `GET /audit-log`, `POST|GET /academic-years|grade-levels|sections`, `POST /subjects`, `POST /courses`, `GET /courses/:id/roster`.
Admissions: `POST|GET /admissions`, `POST /admissions/:id/transition`, `POST /admissions/:id/enroll`.
SIS: `GET /students`, `GET /me/children`, `GET /students/:id/overview`, `POST /students/:id/residence|section-transfer|medical-alerts`.
OpenAPI generation not yet added.
