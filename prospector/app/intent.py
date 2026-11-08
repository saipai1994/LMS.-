"""Explainable fit + intent scoring. No black box: every point has a reason string."""
from __future__ import annotations
import math
import re
from datetime import date, datetime
from typing import Iterable, Optional

from .models import Company, Person, Scored, Signal
from .playbooks import Playbook

HALF_LIFE_DAYS = 45.0
INTENT_SATURATION = 60.0  # raw points at which intent reaches ~63


def _age_days(iso: str, today: date) -> int:
    try:
        return max(0, (today - datetime.fromisoformat(iso).date()).days)
    except ValueError:
        return 365


def _has(haystack: Iterable[str], needles: list[str]) -> list[str]:
    hs = [h.lower() for h in haystack]
    return [n for n in needles if any(n in h for h in hs)]


def score_fit(pb: Playbook, c: Company, countries: list[str]) -> tuple[int, list[str], list[str]]:
    pts, why, flags = 0, [], []
    ind = c.industry.lower()
    if any(i in ind for i in pb.industries):
        pts += 40
        why.append(f"Industry '{c.industry}' is a core {pb.id} segment")
    if c.employees:
        if pb.emp_min <= c.employees <= pb.emp_max:
            pts += 25
            why.append(f"{c.employees:,} employees is in the sweet spot ({pb.emp_min:,}-{pb.emp_max:,})")
        elif pb.emp_min / 2 <= c.employees <= pb.emp_max * 2:
            pts += 10
            why.append(f"{c.employees:,} employees is near the target range")
    if countries and c.country.lower() in [x.lower() for x in countries]:
        pts += 10
        why.append(f"In target geography ({c.country})")
    owned = _has(c.tech, pb.owned_tech)
    if owned:
        flags.append(f"Already uses {owned[0]} - treat as expansion, not new logo")
        pts = max(0, pts - 30)
    displace = _has(c.tech, pb.displace_tech)
    if displace:
        pts += 20
        why.append("Runs replaceable tooling: " + ", ".join(displace))
    adj = _has(c.tech, pb.adjacent_tech)
    if adj:
        pts += 5
        why.append("Compatible stack: " + ", ".join(adj))
    return min(100, pts), why, flags


def signal_points(pb: Playbook, s: Signal, today: date) -> tuple[float, Optional[str]]:
    base = pb.signal_weights.get(s.type, 0)
    if not base:
        return 0.0, None
    text = f"{s.title} {s.detail}".lower()
    kw = pb.hiring_keywords if s.type == "hiring" else pb.regulatory_keywords if s.type == "regulatory" else []
    if kw:
        hits = [k for k in kw if re.search(r"\b" + re.escape(k), text)]
        strength = 1.0 if hits else 0.25
    else:
        strength = 1.0
    if s.type == "tech_change":
        tech_kw = pb.displace_tech + pb.hiring_keywords
        strength = 1.0 if any(k in text for k in tech_kw) else 0.4
    decay = 0.5 ** (_age_days(s.date, today) / HALF_LIFE_DAYS)
    pts = base * strength * decay
    if pts < 1:
        return 0.0, None
    age = _age_days(s.date, today)
    label = s.type.replace('_', ' ').title()
    title = s.title if s.title.lower().startswith(label.lower()) else f"{label}: {s.title}"
    return pts, f"{title} ({age}d ago, +{pts:.0f})"


def score_intent(pb: Playbook, signals: list[Signal], today: Optional[date] = None) -> tuple[int, list[str]]:
    today = today or date.today()
    raw, why = 0.0, []
    for s in sorted(signals, key=lambda s: s.date, reverse=True):
        pts, reason = signal_points(pb, s, today)
        raw += pts
        if reason:
            why.append(reason)
    intent = round(100 * (1 - math.exp(-raw / INTENT_SATURATION)))
    return intent, why


def stage(intent: int, fit: int) -> str:
    if fit < 30:
        return "Poor fit"
    if intent >= 65:
        return "Hot - active buying signals"
    if intent >= 35:
        return "Warming - nurture + monitor"
    return "Cold - fit only, no trigger yet"


def score_company(pb: Playbook, c: Company, signals: list[Signal],
                  countries: Optional[list[str]] = None, today: Optional[date] = None) -> Scored:
    fit, fit_why, flags = score_fit(pb, c, countries or [])
    intent, intent_why = score_intent(pb, signals, today)
    total = round(0.4 * fit + 0.6 * intent)
    return Scored(fit=fit, intent=intent, total=total, stage=stage(intent, fit),
                  reasons=intent_why + fit_why, flags=flags)


def classify_person(pb: Playbook, p: Person) -> Person:
    """Attach buying-committee role from the title. Unmatched titles get priority 0."""
    for persona in sorted(pb.personas, key=lambda x: -x.priority):
        if re.search(persona.pattern, p.title, re.I):
            return p.model_copy(update={"persona": persona.key, "persona_label": persona.label,
                                        "priority": persona.priority})
    return p.model_copy(update={"persona": "", "persona_label": "", "priority": 0})


def rank_people(pb: Playbook, people: list[Person], keep_unmatched: bool = False) -> list[Person]:
    ranked = [classify_person(pb, p) for p in people]
    if not keep_unmatched:
        ranked = [p for p in ranked if p.priority > 0]
    return sorted(ranked, key=lambda p: -p.priority)
