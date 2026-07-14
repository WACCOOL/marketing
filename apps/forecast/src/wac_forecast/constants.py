"""Mirrors of @wac/shared constants (packages/shared/src/hubspot/dealStage.ts,
dealRollups.ts). Keep in sync — the M1 parity fixture test guards the math,
these ids guard the plumbing."""

UNIVERSAL_PIPELINE_ID = "723098519"

DEAL_STAGE_IDS = {
    "prequal": "1054295849",
    "planning": "1054295850",
    "db": "1054295851",
    "bidding": "1054295852",
    "awarded": "1240424232",
    "closedWon": "1054295854",
    "closedLost": "1054295855",
}

STAGE_LABELS = {
    "1054295849": "Pre-Qualified",
    "1054295850": "Planning",
    "1054295851": "Design & Budgeting",
    "1054295852": "Bidding & Negotiating",
    "1240424232": "Awarded",
    "1054295854": "Closed Won",
    "1054295855": "Closed Lost",
}

# Primary company association (deal→company). Specifier-label associations
# must never receive sales attribution (see pickRollupCompanyId in @wac/shared).
PRIMARY_COMPANY_TYPE_ID = 5

# dealRollups.ts PIPELINE_FRESH_DAYS — also the win-prob label window.
PIPELINE_FRESH_DAYS = 180
