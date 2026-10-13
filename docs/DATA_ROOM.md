# Data room index

Everything below is in this repository (branch `claude/zealous-carson-wttk5s`). Statuses are honest; see the limitations file before relying on any claim.

## 1. Product & scope
- [PRD](PRD.md) · [Requirements traceability](REQUIREMENTS_TRACEABILITY.md) · [Roadmap](ROADMAP.md)

## 2. Quality evidence
- [Test plan and recorded results](TEST_PLAN.md): API 111/111 (16 suites), Playwright E2E+axe 26/26 (before the latest API-only work), backup/restore check once, `npm audit` 0 vulnerabilities.
- Test sources: `apps/api/test/`, `apps/web/e2e/`

## 3. Architecture, security, operations
- [Architecture](ARCHITECTURE.md) · [Security](SECURITY.md) · [Deployment](DEPLOYMENT.md) · [Operations](OPERATIONS.md) · [Integrations](INTEGRATIONS.md)
- Generated references: [API (364 routes)](API.md) · [Database (157 tables)](DATABASE.md)

## 4. Risks and gaps
- [Known limitations](KNOWN_LIMITATIONS.md): no real email/SMS/payment/GPS/AI providers, Docker unbuilt, single-instance only, no legal/DPDP review, many listed features not started.

## 5. Running the demo (Greenwood International Academy, fictional data)
See the root [README](../README.md). Tenant `greenwood`, password `Demo-Passw0rd!2026`, logins `<role>@greenwood.demo`; privileged roles need TOTP (`npm run demo:code`).
