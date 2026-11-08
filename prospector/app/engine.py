"""Orchestrates providers: company search -> signals -> scoring -> decision makers -> waterfall reveal."""
from __future__ import annotations
from datetime import date
from typing import Optional

from . import intent, linkedin
from .cache import Cache
from .models import Company, Lead, LookupResult, Person, SearchRequest, Signal
from .playbooks import PLAYBOOKS, Playbook
from .providers.base import Provider


def get_playbook(pid: str) -> Playbook:
    if pid not in PLAYBOOKS:
        raise KeyError(f"Unknown playbook '{pid}'. Known: {', '.join(PLAYBOOKS)}")
    return PLAYBOOKS[pid]


def merge_person(base: Person, other: Person) -> Person:
    """Fill gaps in `base` from `other`; never overwrite a verified email."""
    upd: dict = {}
    for f in ("name", "title", "company_domain", "company_name", "linkedin_url", "phone", "phone_type"):
        if not getattr(base, f) and getattr(other, f):
            upd[f] = getattr(other, f)
    if other.email and (not base.email or (other.email_status == "verified" and base.email_status != "verified")):
        upd["email"], upd["email_status"] = other.email, other.email_status
    upd["sources"] = sorted(set(base.sources) | set(other.sources) | ({other.provider} if other.provider else set()))
    return base.model_copy(update=upd)


class Engine:
    def __init__(self, providers: list[Provider], cache: Optional[Cache] = None, today: Optional[date] = None):
        self.providers = providers
        self.cache = cache
        self.today = today

    # -- helpers ---------------------------------------------------------
    def _each(self, fn, warnings: list[str]):
        for p in self.providers:
            try:
                yield p, fn(p)
            except Exception as e:  # one failing provider must not kill the search
                warnings.append(f"{p.name}: {e}")

    def _signals(self, c: Company, warnings: list[str]) -> list[Signal]:
        seen, out = set(), []
        for _, sigs in self._each(lambda p: p.signals(c), warnings):
            for s in sigs or []:
                k = (s.type, s.title.lower(), s.date)
                if k not in seen:
                    seen.add(k)
                    out.append(s)
        return out

    def _people(self, pb: Playbook, c: Company, warnings: list[str], limit: int = 6) -> list[Person]:
        found: dict[str, Person] = {}
        for _, people in self._each(lambda p: p.people_at(pb, c, 12), warnings):
            for x in people or []:
                key = x.linkedin_url or f"{x.name.lower()}|{x.title.lower()}"
                found[key] = merge_person(found[key], x) if key in found else x
        return intent.rank_people(pb, list(found.values()))[:limit]

    # -- search ----------------------------------------------------------
    def search(self, req: SearchRequest) -> tuple[list[Lead], list[str]]:
        pb = get_playbook(req.playbook)
        warnings: list[str] = []
        companies: dict[str, Company] = {}
        for _, cs in self._each(lambda p: p.search_companies(
                pb, countries=req.countries, industries=req.industries, keywords=req.keywords,
                min_emp=req.min_employees, max_emp=req.max_employees, limit=req.limit), warnings):
            for c in cs or []:
                companies.setdefault(c.domain.lower(), c)
        # cheap pre-rank on fit alone, so we only pull signals/people for plausible companies
        pre = sorted(companies.values(), key=lambda c: -intent.score_fit(pb, c, req.countries)[0])
        leads: list[Lead] = []
        for c in pre[: max(req.limit * 2, req.limit)]:
            sigs = self._signals(c, warnings)
            score = intent.score_company(pb, c, sigs, req.countries, self.today)
            if score.total < req.min_score:
                continue
            leads.append(Lead(company=c, score=score, signals=sigs, people=self._people(pb, c, warnings)))
        leads.sort(key=lambda l: -l.score.total)
        return leads[: req.limit], warnings

    # -- reveal (waterfall) ---------------------------------------------
    def reveal(self, person: Person, warnings: Optional[list[str]] = None) -> Person:
        warnings = warnings if warnings is not None else []
        key = "person:" + (person.linkedin_url or person.id or f"{person.name}|{person.company_domain}").lower()
        if self.cache and (hit := self.cache.get(key)):
            return Person(**hit)
        result = person
        for p in self.providers:
            if result.email and result.phone:
                break
            try:
                got = p.enrich_person(result)
            except Exception as e:
                warnings.append(f"{p.name}: {e}")
                continue
            if got:
                result = merge_person(result, got)
        if self.cache and (result.email or result.phone):
            self.cache.put(key, result.model_dump())
        return result

    # -- lookup by LinkedIn URL -------------------------------------------
    def lookup(self, url: str, playbook: str = "") -> LookupResult:
        ref = linkedin.parse(url)           # raises BadLinkedInUrl
        pb = get_playbook(playbook) if playbook else None
        warnings: list[str] = []
        if ref.kind == "company":
            return self._lookup_company(ref, pb, warnings)

        person: Optional[Person] = None
        for p in self.providers:
            if person and person.email and person.phone:
                break
            try:
                got = p.lookup_linkedin(ref)
            except Exception as e:
                warnings.append(f"{p.name}: {e}")
                continue
            if got:
                person = merge_person(person, got) if person else got
        if not person:
            return LookupResult(kind="person", warnings=warnings + ["No configured provider has this profile."])
        if not person.linkedin_url:
            person = person.model_copy(update={"linkedin_url": ref.url})
        if not (person.email and person.phone):
            person = self.reveal(person, warnings)

        company = None
        if person.company_domain:
            for _, c in self._each(lambda p: p.company_by_domain(person.company_domain), warnings):
                if c:
                    company = c
                    break
        res = LookupResult(kind="person", person=person, company=company, warnings=warnings)
        if pb:
            res.person = intent.classify_person(pb, person)
        if company:
            res.signals = self._signals(company, warnings)
            if pb:
                res.score = intent.score_company(pb, company, res.signals, today=self.today)
                res.colleagues = [x for x in self._people(pb, company, warnings) if x.linkedin_url != ref.url]
        return res

    def _lookup_company(self, ref, pb: Optional[Playbook], warnings: list[str]) -> LookupResult:
        company = None
        for _, c in self._each(lambda p: p.company_by_linkedin(ref), warnings):
            if c:
                company = c
                break
        if not company:
            return LookupResult(kind="company", warnings=warnings + ["No configured provider has this company."])
        res = LookupResult(kind="company", company=company, warnings=warnings)
        res.signals = self._signals(company, warnings)
        if pb:
            res.score = intent.score_company(pb, company, res.signals, today=self.today)
            res.colleagues = self._people(pb, company, warnings)
        return res
