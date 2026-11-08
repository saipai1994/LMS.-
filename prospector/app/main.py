from __future__ import annotations
import csv
import io
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from . import config
from .cache import Cache
from .engine import Engine, get_playbook
from .linkedin import BadLinkedInUrl
from .models import ExportRequest, LookupRequest, LookupResult, RevealRequest, SearchRequest
from .playbooks import PLAYBOOKS
from .providers import build_providers

STATIC = Path(__file__).parent / "static"


def create_app(engine: Engine | None = None) -> FastAPI:
    app = FastAPI(title="Prospector", version="0.1.0")
    eng = engine or Engine(build_providers(), Cache(config.CACHE_DB))

    @app.get("/api/meta")
    def meta():
        return {"providers": [p.name for p in eng.providers],
                "demo_only": [p.name for p in eng.providers] == ["demo"],
                "playbooks": [{"id": p.id, "name": p.name, "pitch": p.pitch, "industries": p.industries,
                               "emp_min": p.emp_min, "emp_max": p.emp_max} for p in PLAYBOOKS.values()]}

    @app.post("/api/search")
    def search(req: SearchRequest):
        try:
            get_playbook(req.playbook)
        except KeyError as e:
            raise HTTPException(404, str(e))
        leads, warnings = eng.search(req)
        return {"leads": [l.model_dump() for l in leads], "warnings": warnings}

    @app.post("/api/reveal")
    def reveal(req: RevealRequest):
        warnings: list[str] = []
        p = eng.reveal(req.person, warnings)
        if req.playbook:
            from . import intent
            p = intent.classify_person(get_playbook(req.playbook), p)
        return {"person": p.model_dump(), "warnings": warnings}

    @app.post("/api/lookup", response_model=LookupResult)
    def lookup(req: LookupRequest):
        try:
            return eng.lookup(req.url, req.playbook)
        except BadLinkedInUrl as e:
            raise HTTPException(422, str(e))
        except KeyError as e:
            raise HTTPException(404, str(e))

    @app.post("/api/export.csv")
    def export(req: ExportRequest):
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["company", "domain", "industry", "country", "employees", "total_score", "fit", "intent", "stage",
                    "top_reasons", "contact", "title", "role", "email", "email_status", "phone", "linkedin"])
        for l in req.leads:
            c, s = l.company, l.score
            base = [c.name, c.domain, c.industry, c.country, c.employees or "", s.total, s.fit, s.intent, s.stage,
                    " | ".join(s.reasons[:3])]
            for p in (l.people or [None]):
                w.writerow(base + ([p.name, p.title, p.persona_label, p.email, p.email_status, p.phone, p.linkedin_url]
                                   if p else [""] * 7))
        return Response(buf.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": "attachment; filename=leads.csv"})

    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/")
    def index():
        return FileResponse(STATIC / "index.html")

    return app


app = create_app()
