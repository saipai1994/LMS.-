"""Apollo.io REST adapter (https://docs.apollo.io). Search is credit-free for previews;
enrichment spends credits.

STATUS: written against Apollo's documented endpoints but NOT exercised against the live
API in this repo - validate with a real key before relying on it. Apollo returns phone
numbers asynchronously via webhook, so this adapter returns email only; the waterfall
fills phones from another provider (Lusha).
"""
from __future__ import annotations
from typing import Optional

import httpx

from .. import config
from ..linkedin import LinkedInRef
from ..models import Company, Person, Signal
from .base import Provider, ProviderError

BASE = "https://api.apollo.io/api/v1"


class ApolloProvider(Provider):
    name = "apollo"

    def __init__(self, api_key: str = "", client: Optional[httpx.Client] = None):
        self.key = api_key or config.APOLLO_API_KEY
        self.http = client or httpx.Client(timeout=30)

    def configured(self) -> bool:
        return bool(self.key)

    def _post(self, path: str, body: dict) -> dict:
        r = self.http.post(f"{BASE}{path}", json=body, headers={"X-Api-Key": self.key, "Content-Type": "application/json"})
        if r.status_code >= 400:
            raise ProviderError(f"apollo {path}: HTTP {r.status_code} {r.text[:200]}")
        return r.json()

    def _get(self, path: str, params: dict | None = None) -> dict:
        r = self.http.get(f"{BASE}{path}", params=params, headers={"X-Api-Key": self.key})
        if r.status_code >= 400:
            raise ProviderError(f"apollo {path}: HTTP {r.status_code} {r.text[:200]}")
        return r.json()

    @staticmethod
    def _company(o: dict) -> Company:
        return Company(id=str(o.get("id", "")), name=o.get("name", ""), domain=o.get("primary_domain") or o.get("website_url", "") or "",
                       industry=o.get("industry", "") or "", employees=o.get("estimated_num_employees"),
                       country=o.get("country", "") or "", city=o.get("city", "") or "",
                       linkedin_url=o.get("linkedin_url", "") or "", description=(o.get("short_description") or "")[:300],
                       tech=[t.get("name", "") for t in (o.get("current_technologies") or [])], provider="apollo")

    def search_companies(self, pb, *, countries, industries, keywords, min_emp, max_emp, limit):
        body: dict = {"per_page": min(limit * 3, 100), "page": 1,
                      "q_organization_keyword_tags": (keywords or pb.industry_keywords)}
        lo, hi = min_emp or pb.emp_min, max_emp or pb.emp_max
        body["organization_num_employees_ranges"] = [f"{lo},{hi}"]
        if countries:
            body["organization_locations"] = countries
        data = self._post("/mixed_companies/search", body)
        orgs = (data.get("organizations") or []) + (data.get("accounts") or [])
        return [self._company(o) for o in orgs if o.get("primary_domain") or o.get("website_url")]

    def people_at(self, pb, company, limit=10):
        titles = ["chief", "head", "director", "vp", "founder", "owner", "manager"]
        data = self._post("/mixed_people/api_search", {"q_organization_domains_list": [company.domain],
                                                       "person_titles": titles, "per_page": limit, "page": 1})
        out = []
        for p in data.get("people") or []:
            name = " ".join(x for x in (p.get("first_name"), p.get("last_name") or p.get("last_name_obfuscated")) if x)
            out.append(Person(id=str(p.get("id", "")), name=name or "(name hidden)", title=p.get("title", "") or "",
                              company_domain=company.domain, company_name=company.name,
                              linkedin_url=p.get("linkedin_url", "") or "", provider="apollo"))
        return out

    def signals(self, company):
        if not company.id or company.provider != "apollo":
            return []
        data = self._get(f"/organizations/{company.id}/job_postings")
        return [Signal(type="hiring", title="Hiring: " + j.get("title", ""), detail=j.get("location", "") or "",
                       date=(j.get("posted_at") or "")[:10] or "1970-01-01", source="apollo", url=j.get("url", "") or "")
                for j in data.get("organization_job_postings") or []]

    def _from_match(self, data: dict) -> Optional[Person]:
        p = data.get("person")
        if not p:
            return None
        org = p.get("organization") or {}
        return Person(id=str(p.get("id", "")), name=p.get("name", ""), title=p.get("title", "") or "",
                      company_domain=org.get("primary_domain", "") or "", company_name=org.get("name", "") or "",
                      linkedin_url=p.get("linkedin_url", "") or "", email=p.get("email") or "",
                      email_status=p.get("email_status") or ("unknown" if p.get("email") else ""),
                      provider="apollo", sources=["apollo"])

    def enrich_person(self, p):
        body = {"reveal_personal_emails": False}
        if p.linkedin_url:
            body["linkedin_url"] = p.linkedin_url
        elif p.id:
            body["id"] = p.id
        else:
            body.update({"name": p.name, "domain": p.company_domain})
        return self._from_match(self._post("/people/match", body))

    def lookup_linkedin(self, ref: LinkedInRef):
        return self._from_match(self._post("/people/match", {"linkedin_url": ref.url, "reveal_personal_emails": False}))

    def company_by_domain(self, domain):
        data = self._get("/organizations/enrich", {"domain": domain})
        o = data.get("organization")
        return self._company(o) if o else None
