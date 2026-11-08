from __future__ import annotations
from typing import Optional

from ..linkedin import LinkedInRef
from ..models import Company, Person, Signal
from ..playbooks import Playbook


class ProviderError(RuntimeError):
    pass


class Provider:
    """Adapter over one licensed data source. Override what the source supports."""
    name = "base"

    def configured(self) -> bool:
        return True

    def search_companies(self, pb: Playbook, *, countries: list[str], industries: list[str],
                         keywords: list[str], min_emp: Optional[int], max_emp: Optional[int],
                         limit: int) -> list[Company]:
        return []

    def people_at(self, pb: Playbook, company: Company, limit: int = 10) -> list[Person]:
        """Preview of people (name/title), normally without contact data."""
        return []

    def signals(self, company: Company) -> list[Signal]:
        return []

    def enrich_person(self, p: Person) -> Optional[Person]:
        """Return the person with email/phone filled in where the source has them."""
        return None

    def lookup_linkedin(self, ref: LinkedInRef) -> Optional[Person]:
        """Person profile + contact data for a /in/ URL."""
        return None

    def company_by_linkedin(self, ref: LinkedInRef) -> Optional[Company]:
        return None

    def company_by_domain(self, domain: str) -> Optional[Company]:
        return None
