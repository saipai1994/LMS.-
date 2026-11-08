import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from datetime import date, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from app import intent, linkedin
from app.cache import Cache
from app.engine import Engine
from app.main import create_app
from app.models import Company, Person, SearchRequest, Signal
from app.playbooks import ODOO, OPENPAGES
from app.providers.demo import DemoProvider
from app.providers.lusha import LushaProvider
from app.providers.apollo import ApolloProvider

TODAY = date(2026, 11, 8)


def eng(**kw):
    return Engine([DemoProvider(today=TODAY)], Cache(":memory:"), today=TODAY, **kw)


def sig(t, title, days, detail=""):
    return Signal(type=t, title=title, detail=detail, date=(TODAY - timedelta(days=days)).isoformat())


# --- linkedin ------------------------------------------------------------
@pytest.mark.parametrize("raw,kind,slug", [
    ("https://www.linkedin.com/in/Jane-Doe-123/", "person", "jane-doe-123"),
    ("linkedin.com/in/jane?utm=x", "person", "jane"),
    ("https://in.linkedin.com/company/Acme-Corp/about", "company", "acme-corp"),
])
def test_parse_ok(raw, kind, slug):
    r = linkedin.parse(raw)
    assert (r.kind, r.slug) == (kind, slug)


@pytest.mark.parametrize("raw", ["", "https://evil.com/in/x", "https://linkedin.com.evil.com/in/x", "https://linkedin.com/feed/"])
def test_parse_rejects(raw):
    with pytest.raises(linkedin.BadLinkedInUrl):
        linkedin.parse(raw)


# --- scoring -------------------------------------------------------------
def test_recent_relevant_signal_beats_old_or_irrelevant():
    fresh = [sig("hiring", "Hiring: Head of Operational Risk", 5)]
    old = [sig("hiring", "Hiring: Head of Operational Risk", 200)]
    junk = [sig("hiring", "Hiring: Barista", 5)]
    f, o, j = (intent.score_intent(OPENPAGES, s, TODAY)[0] for s in (fresh, old, junk))
    assert f > o and f > j


def test_existing_customer_is_flagged_and_penalised():
    c = Company(id="1", name="X", domain="x.example", industry="Banking", employees=5000, tech=["IBM OpenPages"])
    s = intent.score_company(OPENPAGES, c, [], today=TODAY)
    assert any("expansion" in f for f in s.flags)
    c2 = c.model_copy(update={"tech": ["RSA Archer"]})
    assert intent.score_company(OPENPAGES, c2, [], today=TODAY).fit > s.fit


def test_personas_rank_economic_buyer_first_and_drop_noise():
    ppl = [Person(name="a", title="Risk Analyst"), Person(name="b", title="Chief Risk Officer"),
           Person(name="c", title="Head of Marketing"), Person(name="d", title="Head of Operational Risk")]
    out = intent.rank_people(OPENPAGES, ppl)
    assert [p.name for p in out] == ["b", "d", "a"]
    assert intent.classify_person(ODOO, Person(name="x", title="Founder & CEO")).persona == "economic_buyer"


# --- engine --------------------------------------------------------------
def test_search_ranked_filtered_and_has_decision_makers():
    leads, _ = eng().search(SearchRequest(playbook="openpages", min_score=20, limit=10))
    assert leads
    totals = [l.score.total for l in leads]
    assert totals == sorted(totals, reverse=True)
    assert all(l.score.total >= 20 for l in leads)
    assert any(l.people for l in leads)
    assert all(p.email == "" for l in leads for p in l.people)  # search never spends reveal credits


def test_country_and_size_filters():
    leads, _ = eng().search(SearchRequest(playbook="odoo", countries=["India"], max_employees=100, limit=30))
    assert all(l.company.country == "India" and l.company.employees <= 100 for l in leads)


def test_reveal_fills_contact_and_caches():
    e = eng()
    leads, _ = e.search(SearchRequest(playbook="odoo", limit=3))
    p = next(p for l in leads for p in l.people)
    r = e.reveal(p)
    assert r.email.endswith(".example") and "demo" in r.sources
    assert e.cache.get("person:" + (p.linkedin_url or p.id).lower())


def test_lookup_person_by_linkedin_url():
    e = eng()
    leads, _ = e.search(SearchRequest(playbook="openpages", limit=5))
    p = leads[0].people[0]
    res = e.lookup(p.linkedin_url, "openpages")
    assert res.kind == "person" and res.person.email and res.company and res.score
    assert all(c.linkedin_url != p.linkedin_url for c in res.colleagues)


def test_lookup_unknown_profile_is_honest():
    res = eng().lookup("https://www.linkedin.com/in/nobody-here")
    assert res.person is None and res.warnings


def test_provider_failure_is_reported_not_fatal():
    class Boom(DemoProvider):
        name = "boom"
        def signals(self, c): raise RuntimeError("quota")
    e = Engine([Boom(today=TODAY)], Cache(":memory:"), today=TODAY)
    leads, warnings = e.search(SearchRequest(playbook="odoo", limit=3))
    assert leads and any("quota" in w for w in warnings)


# --- waterfall: apollo (email) then lusha (phone), mocked HTTP -------------
def test_waterfall_merges_apollo_email_and_lusha_phone():
    def handler(req: httpx.Request):
        if "apollo" in req.url.host:
            return httpx.Response(200, json={"person": {"id": "9", "name": "Jane Doe", "title": "CFO", "email": "jane@acme.example",
                                  "email_status": "verified", "organization": {"primary_domain": "acme.example", "name": "Acme"}}})
        return httpx.Response(200, json={"contact": {"data": {"fullName": "Jane Doe", "phoneNumbers": [{"number": "+1-555-0100", "phoneType": "mobile"}],
                                         "emailAddresses": [{"email": "j.doe@acme.example"}]}}})
    c = httpx.Client(transport=httpx.MockTransport(handler))
    e = Engine([ApolloProvider("k", c), LushaProvider("k", c)], Cache(":memory:"), today=TODAY)
    r = e.reveal(Person(name="Jane Doe", linkedin_url="https://www.linkedin.com/in/jane-doe"))
    assert r.email == "jane@acme.example" and r.email_status == "verified"   # verified Apollo email not overwritten
    assert r.phone == "+1-555-0100" and set(r.sources) == {"apollo", "lusha"}


# --- api -----------------------------------------------------------------
def test_api_end_to_end():
    c = TestClient(create_app(eng()))
    assert c.get("/api/meta").json()["demo_only"] is True
    d = c.post("/api/search", json={"playbook": "odoo", "limit": 3}).json()
    assert d["leads"]
    csv = c.post("/api/export.csv", json={"leads": d["leads"]})
    assert csv.status_code == 200 and csv.text.startswith("company,domain")
    assert c.post("/api/search", json={"playbook": "nope"}).status_code == 404
    assert c.post("/api/lookup", json={"url": "https://evil.com/in/x"}).status_code == 422
    assert c.get("/").status_code == 200
