"""Product playbooks: who to target, which buying signals matter, which titles decide.

Edit these to tune the engine - they are plain data. Weights are 0-100 points
contributed by one signal at full strength and zero age.
"""
from __future__ import annotations
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Persona:
    key: str
    label: str
    pattern: str          # regex on job title (case-insensitive)
    priority: int         # higher = contact first


@dataclass(frozen=True)
class Playbook:
    id: str
    name: str
    pitch: str
    industries: list[str]                 # target industries (lowercase substrings)
    emp_min: int
    emp_max: int
    industry_keywords: list[str]          # sent to providers as keyword tags
    hiring_keywords: list[str]            # job titles/skills that signal the project
    displace_tech: list[str]              # competitors / legacy tools -> replacement play
    adjacent_tech: list[str]              # stack that fits the product
    owned_tech: list[str]                 # already a customer -> flag, don't cold-pitch
    regulatory_keywords: list[str]
    signal_weights: dict[str, int]
    personas: list[Persona] = field(default_factory=list)


OPENPAGES = Playbook(
    id="openpages",
    name="IBM OpenPages (GRC / risk / compliance)",
    pitch="Integrated governance, risk & compliance on one platform: operational risk, "
          "regulatory compliance, internal audit, model risk, third-party risk.",
    industries=["bank", "financial", "insurance", "capital markets", "pharma", "healthcare",
                "energy", "utilities", "telecom", "government", "asset management", "payments"],
    emp_min=1000, emp_max=500000,
    industry_keywords=["governance risk compliance", "operational risk", "regulatory compliance",
                       "internal audit", "model risk"],
    hiring_keywords=["grc", "operational risk", "compliance", "internal audit", "risk manager",
                     "model risk", "third party risk", "tprm", "sox", "regulatory reporting",
                     "archer", "openpages", "servicenow grc", "metricstream"],
    displace_tech=["rsa archer", "archer", "metricstream", "servicenow grc", "logicgate",
                   "workiva", "excel", "sharepoint"],
    adjacent_tech=["ibm cloud pak", "ibm db2", "ibm watson", "red hat openshift", "ibm cognos",
                   "ibm qradar", "ibm maximo"],
    owned_tech=["ibm openpages", "openpages"],
    regulatory_keywords=["dora", "basel", "sox", "gdpr", "mifid", "solvency", "ccar", "rbi",
                         "sebi", "irdai", "fine", "enforcement", "consent order", "audit finding"],
    signal_weights={"hiring": 28, "regulatory": 30, "leadership_change": 22,
                    "tech_change": 20, "funding": 8, "news": 8},
    personas=[
        Persona("economic_buyer", "Economic buyer", r"chief risk|\bcro\b|chief compliance|\bcco\b|chief audit|chief (financial|operating) officer|\bcfo\b|\bcoo\b", 100),
        Persona("champion", "Champion / program owner", r"head of (operational )?risk|head of compliance|head of (internal )?audit|head of grc|(vp|vice president|director).*(risk|compliance|audit|grc)|grc (lead|manager|head)", 85),
        Persona("technical", "Technical evaluator", r"\bciso\b|chief information security|head of (it )?(risk|security|governance)|enterprise architect|(cio|chief information officer)", 60),
        Persona("influencer", "Influencer", r"(senior )?(risk|compliance|audit|grc) (manager|analyst|officer)", 35),
    ],
)

ODOO = Playbook(
    id="odoo",
    name="Odoo ERP (implementation & services)",
    pitch="All-in-one ERP for growing SMEs: accounting, inventory, manufacturing, sales/CRM, "
          "e-commerce, HR - replacing spreadsheets, Tally/QuickBooks and disconnected tools.",
    industries=["manufactur", "distribut", "wholesale", "retail", "e-commerce", "logistics",
                "construction", "food", "textile", "trading", "professional services", "electronics"],
    emp_min=15, emp_max=800,
    industry_keywords=["erp", "inventory management", "manufacturing", "distribution"],
    hiring_keywords=["erp", "odoo", "sap business one", "netsuite", "accountant", "supply chain",
                     "inventory", "operations manager", "it manager", "digital transformation",
                     "business analyst", "procurement"],
    displace_tech=["tally", "quickbooks", "zoho books", "sage 50", "xero", "excel", "busy",
                   "sap business one", "microsoft dynamics nav", "unleashed", "fishbowl"],
    adjacent_tech=["shopify", "woocommerce", "magento", "amazon seller", "python", "postgresql",
                   "whatsapp business", "razorpay", "stripe"],
    owned_tech=["odoo"],
    regulatory_keywords=["e-invoicing", "gst", "vat", "einvoice", "peppol", "zatca", "e-way bill"],
    signal_weights={"hiring": 25, "regulatory": 20, "leadership_change": 15,
                    "tech_change": 28, "funding": 25, "news": 10},
    personas=[
        Persona("economic_buyer", "Economic buyer", r"\bceo\b|founder|managing director|\bmd\b|owner|proprietor|president|general manager", 100),
        Persona("champion", "Champion / process owner", r"\bcoo\b|chief operating|head of operations|operations (manager|director|head)|\bcfo\b|finance (head|director|manager)|controller", 90),
        Persona("technical", "Technical evaluator", r"\bcio\b|\bcto\b|it (manager|head|director)|head of it|head of technology|digital transformation", 65),
        Persona("influencer", "Influencer", r"supply chain|procurement|inventory|accounts? (manager|head)|head of sales", 35),
    ],
)

PLAYBOOKS: dict[str, Playbook] = {p.id: p for p in (OPENPAGES, ODOO)}
