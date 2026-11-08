"""Parse LinkedIn URLs. The URL is only used as a lookup key for licensed data providers;
this tool never fetches or scrapes linkedin.com."""
from __future__ import annotations
import re
from dataclasses import dataclass
from urllib.parse import unquote, urlparse


@dataclass(frozen=True)
class LinkedInRef:
    kind: str   # "person" | "company"
    slug: str
    url: str    # canonical


class BadLinkedInUrl(ValueError):
    pass


_RE = re.compile(r"^/(in|company|pub)/([^/?#]+)", re.I)


def parse(raw: str) -> LinkedInRef:
    raw = (raw or "").strip()
    if not raw:
        raise BadLinkedInUrl("Empty URL")
    if "://" not in raw:
        raw = "https://" + raw
    u = urlparse(raw)
    host = (u.hostname or "").lower()
    if host != "linkedin.com" and not host.endswith(".linkedin.com"):
        raise BadLinkedInUrl("Not a linkedin.com URL")
    m = _RE.match(u.path)
    if not m:
        raise BadLinkedInUrl("Expected a /in/<profile> or /company/<name> URL")
    kind = "company" if m.group(1).lower() == "company" else "person"
    slug = unquote(m.group(2)).strip().lower()
    path = "company" if kind == "company" else "in"
    return LinkedInRef(kind, slug, f"https://www.linkedin.com/{path}/{slug}")
