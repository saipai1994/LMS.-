from __future__ import annotations
from .. import config
from .apollo import ApolloProvider
from .base import Provider
from .demo import DemoProvider
from .lusha import LushaProvider

_FACTORIES = {"demo": DemoProvider, "apollo": ApolloProvider, "lusha": LushaProvider}


def build_providers(names: list[str] | None = None) -> list[Provider]:
    """Providers in waterfall order. Unconfigured ones (missing key) are skipped."""
    out = []
    for n in names if names is not None else config.PROVIDERS:
        if n not in _FACTORIES:
            raise ValueError(f"Unknown provider '{n}'. Known: {', '.join(_FACTORIES)}")
        p = _FACTORIES[n]()
        if p.configured():
            out.append(p)
    return out
