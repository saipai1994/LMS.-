"""Lusha REST adapter (https://docs.lusha.com). Strong on direct dials / mobiles.

STATUS: written from Lusha's public v2 docs but NOT exercised against the live API in
this repo - response parsing is deliberately defensive; validate with a real key.
"""
from __future__ import annotations
from typing import Optional

import httpx

from .. import config
from ..linkedin import LinkedInRef
from ..models import Company, Person
from .base import Provider, ProviderError

BASE = "https://api.lusha.com/v2"


class LushaProvider(Provider):
    name = "lusha"

    def __init__(self, api_key: str = "", client: Optional[httpx.Client] = None):
        self.key = api_key or config.LUSHA_API_KEY
        self.http = client or httpx.Client(timeout=30)

    def configured(self) -> bool:
        return bool(self.key)

    def _get(self, path: str, params: dict) -> dict:
        r = self.http.get(f"{BASE}{path}", params=params, headers={"api_key": self.key})
        if r.status_code == 404:
            return {}
        if r.status_code >= 400:
            raise ProviderError(f"lusha {path}: HTTP {r.status_code} {r.text[:200]}")
        return r.json()

    @staticmethod
    def _parse(data: dict, fallback: Person | None = None) -> Optional[Person]:
        d = (data.get("contact") or {}).get("data") or data.get("data") or {}
        if not d:
            return None
        emails = d.get("emailAddresses") or []
        phones = d.get("phoneNumbers") or []
        mobile = next((x for x in phones if "mobile" in str(x.get("phoneType", "")).lower()), None)
        ph = mobile or (phones[0] if phones else {})
        comp = d.get("company") or {}
        job = d.get("jobTitle") or {}
        base = fallback or Person(name="")
        return base.model_copy(update={
            "name": d.get("fullName") or base.name,
            "title": (job.get("title") if isinstance(job, dict) else job) or base.title,
            "company_name": comp.get("name") or base.company_name,
            "company_domain": comp.get("domain") or base.company_domain,
            "email": (emails[0].get("email") if emails else "") or base.email,
            "email_status": (emails[0].get("emailConfidence") or "unverified").lower() if emails else base.email_status,
            "phone": ph.get("number", "") or base.phone,
            "phone_type": str(ph.get("phoneType", "")).lower() or base.phone_type,
            "provider": "lusha", "sources": sorted(set(base.sources + ["lusha"])),
        })

    def enrich_person(self, p):
        if p.linkedin_url:
            params = {"linkedinUrl": p.linkedin_url}
        elif p.name and p.company_domain:
            first, _, last = p.name.partition(" ")
            params = {"firstName": first, "lastName": last, "companyDomain": p.company_domain}
        else:
            return None
        return self._parse(self._get("/person", params), p)

    def lookup_linkedin(self, ref: LinkedInRef):
        return self._parse(self._get("/person", {"linkedinUrl": ref.url}))

    def company_by_domain(self, domain):
        d = (self._get("/company", {"domain": domain}).get("data") or {})
        if not d:
            return None
        return Company(id=str(d.get("id", "")), name=d.get("name", ""), domain=domain, industry=d.get("mainIndustry", "") or "",
                       employees=(d.get("employees") or {}).get("max") if isinstance(d.get("employees"), dict) else None,
                       country=(d.get("location") or {}).get("country", ""), provider="lusha")
