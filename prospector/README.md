# Prospector - B2B lead engine for IBM OpenPages and Odoo

Find companies that *fit* and are *buying now*, see the decision makers, reveal email/phone, or
paste a LinkedIn URL and get the same. Scoring is explainable: every point has a reason.

```bash
cd prospector
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest -q                      # 18 tests
.venv/bin/uvicorn app.main:app --port 8000         # http://localhost:8000
```

## Read this first: where the contact data comes from
No one can legally scrape LinkedIn at scale and no code can invent verified emails/phones. Apollo and
ZoomInfo are, underneath, *licensed data*. So this tool is the **intelligence layer on top of
licensed data providers**, and ships with a clearly-labelled **fictional demo provider** so it runs
with zero keys. Demo emails use `.example`, phones use 555-01xx - they can't reach a real person.

| Provider | What it contributes | Status |
|---|---|---|
| `demo` | fictional companies/people/signals | tested |
| `apollo` | company + people search, job-posting signals, email match by LinkedIn URL | **written to docs, not run against live API** (tested with mocked HTTP) |
| `lusha` | mobile/direct phone + email by LinkedIn URL | **written to docs, not run against live API** (mocked HTTP) |

`PROVIDERS=apollo,lusha` in `.env` sets the **waterfall**: each person is enriched by provider 1, then
gaps (usually phone) are filled by provider 2, and a verified email is never overwritten. Reveals are
cached in sqlite so you never pay twice. Adding Hunter/Cognism/PDL = one small class in `app/providers/`.

## How it's better than a database lookup
1. **Product playbooks** (`app/playbooks.py`) - who fits, which titles decide, which signals matter, for OpenPages and Odoo. Plain data; edit freely.
2. **Intent scoring** (`app/intent.py`) - hiring (e.g. "Head of Operational Risk", "ERP implementation lead"), regulation (DORA, e-invoicing...), new CRO/COO, tech replaceable stack (Archer, Tally, QuickBooks...), funding. Signals decay with a 45-day half-life. Score = 40% fit + 60% intent; "already uses OpenPages/Odoo" is flagged as expansion.
3. **Buying-committee roles** - decision makers are labelled economic buyer / champion / technical evaluator and ranked.
4. **Search is free, reveal is paid** - search never spends contact credits; you reveal per person.
5. **LinkedIn URL -> person + company + intent score + colleagues** (`/api/lookup`). The URL is only a lookup key.

## Honest gaps (not built)
- Real-time intent from web-wide sources (G2/Bing/bidstream "topic surge"), email-open/site-visit intent. Needs a paid intent vendor (Bombora, 6sense) or your own site tracking - add as a `Provider.signals()`.
- Regulatory/news/tax-filing feeds are only as good as the provider; no standalone news crawler yet.
- No email verification of its own, no CRM push, no auth/multi-user. Run it locally or behind your own auth.
- Compliance is on you: GDPR/UK-PECR, India DPDP, DNC lists for cold calls. Keep source + date per contact.
