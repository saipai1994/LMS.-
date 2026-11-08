from __future__ import annotations
from typing import Optional
from pydantic import BaseModel, Field


class Signal(BaseModel):
    type: str                      # hiring | regulatory | leadership_change | funding | tech_change | news
    title: str
    detail: str = ""
    date: str                      # ISO date
    source: str = ""
    url: str = ""


class Company(BaseModel):
    id: str
    name: str
    domain: str
    industry: str = ""
    employees: Optional[int] = None
    country: str = ""
    city: str = ""
    linkedin_url: str = ""
    description: str = ""
    tech: list[str] = Field(default_factory=list)
    provider: str = ""


class Person(BaseModel):
    id: str = ""
    name: str
    title: str = ""
    company_domain: str = ""
    company_name: str = ""
    linkedin_url: str = ""
    email: str = ""
    email_status: str = ""         # verified | unverified | unknown
    phone: str = ""
    phone_type: str = ""           # mobile | direct | hq
    provider: str = ""
    sources: list[str] = Field(default_factory=list)  # providers that contributed data
    persona: str = ""              # buying-committee role from the playbook
    persona_label: str = ""
    priority: int = 0


class Scored(BaseModel):
    fit: int
    intent: int
    total: int
    stage: str
    reasons: list[str]
    flags: list[str] = Field(default_factory=list)


class Lead(BaseModel):
    company: Company
    score: Scored
    signals: list[Signal]
    people: list[Person]


class SearchRequest(BaseModel):
    playbook: str
    countries: list[str] = Field(default_factory=list)
    industries: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    min_employees: Optional[int] = None
    max_employees: Optional[int] = None
    min_score: int = 0
    limit: int = 25


class RevealRequest(BaseModel):
    playbook: str = ""
    person: Person


class LookupRequest(BaseModel):
    url: str
    playbook: str = ""


class ExportRequest(BaseModel):
    leads: list[Lead]


class LookupResult(BaseModel):
    kind: str                                  # person | company
    person: Optional[Person] = None
    company: Optional[Company] = None
    score: Optional[Scored] = None
    signals: list[Signal] = Field(default_factory=list)
    colleagues: list[Person] = Field(default_factory=list)   # other decision makers at the company
    leads: list[Lead] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
