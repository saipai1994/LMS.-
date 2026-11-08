"""Fictional dataset so the whole pipeline runs without paid keys.

Everything here is invented: companies, people, signals. Email domains use the reserved
`.example` TLD and phones use the 555-01xx fictional range, so none of it can reach a real
person. Never treat demo output as real leads.
"""
from __future__ import annotations
import random
import re
from datetime import date, timedelta
from typing import Optional

from ..linkedin import LinkedInRef
from ..models import Company, Person, Signal
from ..playbooks import Playbook
from .base import Provider

FIRST = ["Aarav", "Priya", "Marcus", "Elena", "Tomasz", "Fatima", "Chen", "Sofia", "Rahul", "Anna",
         "Kwame", "Lucia", "Omar", "Ingrid", "Diego", "Mei", "Jonas", "Nadia", "Vikram", "Hannah"]
LAST = ["Sharma", "Okafor", "Lindqvist", "Moreau", "Kowalski", "Haddad", "Wei", "Rossi", "Nair",
        "Berg", "Mensah", "Duarte", "Rahman", "Dahl", "Ortega", "Tanaka", "Keller", "Farouk"]
PREFIX = ["Northwind", "Bluepeak", "Crestline", "Ironbridge", "Silverleaf", "Harborview", "Meridian",
          "Quarry", "Redwood", "Summit", "Tidewater", "Vantage", "Westgate", "Zenith", "Alder"]

GRC_INDUSTRIES = [("Banking", "Bank", (2500, 40000)), ("Insurance", "Assurance", (1500, 20000)),
                  ("Pharmaceuticals", "Pharma", (1200, 15000)), ("Energy & Utilities", "Energy", (2000, 25000)),
                  ("Payments", "Payments", (800, 6000)), ("Asset Management", "Capital", (600, 5000))]
ERP_INDUSTRIES = [("Manufacturing", "Industries", (40, 600)), ("Wholesale Distribution", "Trading", (25, 300)),
                  ("Retail & E-commerce", "Retail", (20, 400)), ("Logistics", "Logistics", (50, 700)),
                  ("Food Manufacturing", "Foods", (30, 450)), ("Construction", "Builders", (30, 500))]
COUNTRIES = [("India", "Mumbai"), ("India", "Pune"), ("United Arab Emirates", "Dubai"),
             ("United Kingdom", "London"), ("Germany", "Frankfurt"), ("Singapore", "Singapore"),
             ("United States", "Chicago"), ("Saudi Arabia", "Riyadh")]

GRC_TECH = [["RSA Archer", "IBM Db2", "SharePoint"], ["MetricStream", "Excel"], ["ServiceNow GRC"],
            ["Excel", "SharePoint", "IBM Cloud Pak"], ["Workiva", "Red Hat OpenShift"], ["IBM OpenPages", "IBM Cognos"], []]
ERP_TECH = [["Tally", "Excel"], ["QuickBooks", "Shopify"], ["Zoho Books", "WhatsApp Business"], ["Excel"],
            ["Sage 50", "WooCommerce"], ["Odoo", "PostgreSQL"], ["SAP Business One"], []]

GRC_SIGNALS = [
    ("hiring", "Hiring: Head of Operational Risk", "Role mentions GRC platform selection and RCSA automation"),
    ("hiring", "Hiring: GRC Systems Manager", "Experience with RSA Archer or OpenPages preferred"),
    ("hiring", "Hiring: Third Party Risk Manager", "Build TPRM programme on a new platform"),
    ("regulatory", "Subject to DORA from January", "ICT risk register and incident reporting required"),
    ("regulatory", "Regulator consent order on risk controls", "Remediation plan due within 12 months"),
    ("leadership_change", "New Chief Risk Officer appointed", "Previously led GRC transformation elsewhere"),
    ("leadership_change", "New Head of Internal Audit joined", ""),
    ("tech_change", "Contract renewal for legacy GRC tooling approaching", "Archer renewal window within two quarters"),
    ("news", "Annual report cites enterprise risk programme overhaul", ""),
]
ERP_SIGNALS = [
    ("hiring", "Hiring: ERP Implementation Lead", "Evaluating Odoo, NetSuite, Business One"),
    ("hiring", "Hiring: Operations Manager (inventory)", "Own stock accuracy across two warehouses"),
    ("hiring", "Hiring: Finance Controller", "Move off Tally to integrated ERP"),
    ("funding", "Raised growth round", "Expansion to new warehouses and a second country"),
    ("regulatory", "E-invoicing mandate applies to the company", "GST/e-invoicing or Peppol compliance needed"),
    ("tech_change", "Opened second warehouse / new plant", "Multi-site inventory now managed in Excel"),
    ("leadership_change", "New COO appointed", "Mandate: digitise operations"),
    ("news", "Launched online store", "Orders arriving from three channels"),
]


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


class DemoProvider(Provider):
    name = "demo"

    def __init__(self, today: Optional[date] = None, seed: int = 7):
        self.today = today or date.today()
        self.companies: dict[str, Company] = {}
        self.people: dict[str, list[Person]] = {}
        self.sig: dict[str, list[Signal]] = {}
        self.by_slug: dict[str, Person] = {}
        self._build(seed)

    # -- generation ------------------------------------------------------
    def _build(self, seed: int) -> None:
        rnd = random.Random(seed)
        for kind, inds, techs, sigs, titles in (
            ("grc", GRC_INDUSTRIES, GRC_TECH, GRC_SIGNALS, [
                "Chief Risk Officer", "Chief Compliance Officer", "Head of Operational Risk",
                "Head of Internal Audit", "GRC Manager", "CISO", "Chief Financial Officer", "Risk Analyst"]),
            ("erp", ERP_INDUSTRIES, ERP_TECH, ERP_SIGNALS, [
                "Founder & CEO", "Managing Director", "Chief Operating Officer", "Finance Controller",
                "IT Manager", "Head of Operations", "Supply Chain Manager", "Head of Sales"]),
        ):
            for i in range(34):
                ind, suffix, (lo, hi) = rnd.choice(inds)
                country, city = rnd.choice(COUNTRIES)
                name = f"{rnd.choice(PREFIX)} {suffix} {rnd.choice(['Ltd', 'Group', 'Co', 'PLC', 'Pvt Ltd'])}"
                domain = f"{_slug(name)}-{i}.example"
                cid = f"demo-{kind}-{i}"
                c = Company(id=cid, name=name, domain=domain, industry=ind,
                            employees=rnd.randint(lo, hi), country=country, city=city,
                            linkedin_url=f"https://www.linkedin.com/company/{_slug(name)}-{i}",
                            description=f"[DEMO] Fictional {ind.lower()} company.",
                            tech=list(rnd.choice(techs)), provider=self.name)
                self.companies[cid] = c
                signals = []
                for t, title, detail in rnd.sample(sigs, rnd.randint(0, 4)):
                    d = self.today - timedelta(days=rnd.randint(2, 150))
                    signals.append(Signal(type=t, title=title, detail=detail, date=d.isoformat(),
                                          source="demo", url=""))
                self.sig[cid] = signals
                ppl = []
                for j, title in enumerate(rnd.sample(titles, rnd.randint(3, 6))):
                    fn, ln = rnd.choice(FIRST), rnd.choice(LAST)
                    slug = f"{_slug(fn + ' ' + ln)}-{i}{j}-demo"
                    p = Person(id=f"{cid}-p{j}", name=f"{fn} {ln}", title=title, company_domain=domain,
                               company_name=name, linkedin_url=f"https://www.linkedin.com/in/{slug}",
                               provider=self.name)
                    ppl.append(p)
                    self.by_slug[slug] = p
                self.people[cid] = ppl

    def _contact(self, p: Person) -> Person:
        h = sum(ord(ch) for ch in p.id) % 90
        first, last = p.name.lower().split(" ", 1)
        return p.model_copy(update={
            "email": f"{first}.{_slug(last)}@{p.company_domain}",
            "email_status": "verified" if h % 3 else "unverified",
            "phone": f"+1-555-01{h:02d}" if h % 4 else "",
            "phone_type": "mobile" if h % 4 else "",
            "provider": self.name, "sources": ["demo"],
        })

    # -- Provider API ----------------------------------------------------
    def search_companies(self, pb, *, countries, industries, keywords, min_emp, max_emp, limit):
        kind = "grc" if pb.id == "openpages" else "erp"
        out = []
        for cid, c in self.companies.items():
            if f"-{kind}-" not in cid:
                continue
            if countries and c.country.lower() not in [x.lower() for x in countries]:
                continue
            if industries and not any(i.lower() in c.industry.lower() for i in industries):
                continue
            if min_emp and (c.employees or 0) < min_emp:
                continue
            if max_emp and (c.employees or 0) > max_emp:
                continue
            if keywords and not any(k.lower() in (c.name + c.industry + " ".join(c.tech)).lower() for k in keywords):
                continue
            out.append(c)
        return out[: max(limit * 3, limit)]

    def people_at(self, pb, company, limit=10):
        return list(self.people.get(company.id, []))[:limit]

    def signals(self, company):
        return list(self.sig.get(company.id, []))

    def enrich_person(self, p):
        known = self.by_slug.get(p.linkedin_url.rsplit("/", 1)[-1]) if p.linkedin_url else None
        if known is None:
            for lst in self.people.values():
                for q in lst:
                    if q.id == p.id:
                        known = q
        return self._contact(known) if known else None

    def lookup_linkedin(self, ref: LinkedInRef):
        p = self.by_slug.get(ref.slug)
        return self._contact(p) if p else None

    def company_by_linkedin(self, ref: LinkedInRef):
        for c in self.companies.values():
            if c.linkedin_url.endswith("/" + ref.slug):
                return c
        return None

    def company_by_domain(self, domain):
        for c in self.companies.values():
            if c.domain == domain:
                return c
        return None
