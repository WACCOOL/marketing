"""HubSpot extraction: deals, line items, companies, deal→company associations.

Pagination is the same GT-window-on-hs_object_id idiom as
apps/sales-sync/src/dealRollups.ts (no 10k search cap). Line items join to
deals WITHOUT association calls: `quote_product_name` is the SAP upsert key
`<quote>-<item>` (see apps/api/src/hubspotPush.ts / netValueBackfill.ts), so
`sap_quote_number` is recoverable by splitting on the last hyphen.
"""

from __future__ import annotations

import time
from typing import Any, Iterator

import httpx
import pandas as pd

from ..config import CONFIG

HS = "https://api.hubapi.com"
SEARCH_PAGE = 200
ASSOC_BATCH = 500
INTER_BATCH_S = 0.25
UNIVERSAL_PIPELINE_ID = "723098519"

DEAL_PROPS = [
    "sap_quote_number", "account_number", "pipeline", "dealstage", "dealname",
    "amount", "max_amount", "sap_net_value",
    "createdate", "closedate", "quote_creation_date", "quote_conversion_date",
    "quote_last_changed_date", "valid_to",
    "project_type", "opportunity_type", "quote_type", "stage_of_project",
    "status_of_quote", "closed_lost_category",
    "sales_group", "sales_group_name", "quoted_by",
    "state", "project_location", "customization", "technical_type",
    "price_list", "doc__currency", "conversion_rate",
    "specifier_type_1", "specifier_type_category_1", "specifier_account_number_1",
    "specifier_type_2", "specifier_type_category_2", "specifier_account_number_2",
    "specifier_type_3", "specifier_type_category_3", "specifier_account_number_3",
    "specifier_type_4", "specifier_type_category_4", "specifier_account_number_4",
    "specifier_type_5", "specifier_type_category_5", "specifier_account_number_5",
]

LINE_ITEM_PROPS = [
    # SAP unit_price is stored on the standard `price` property (hubspotPush.ts
    # maps unit_price -> price; net_value = round2(quantity × unit_price)).
    "quote_product_name", "quote_line", "net_value", "quantity", "price",
    "hs_discount_percentage", "zprc", "commission",
    "business_unit", "product_group_description", "product_line_description",
    "hs_sku", "material_description", "plant", "customization_level",
    "rejection_code", "rejection_date", "rejection_reason",
    "quote_conversion_date", "sales_order_date", "fixture_production_time",
]

COMPANY_PROPS = [
    "account_number_", "name", "sap_company_name", "parent_customer",
    "company_type", "company_sub_type", "project_focus", "product_focus",
    "national_account", "lifecyclestage", "status",
    "sales_rep_code", "rep_business_name", "inside_sales_rep",
    "buying_group", "buying_group_description", "industry_key",
    "price_group", "price_group_description", "price_list", "program_level",
    "risk_category", "risk_category_description", "terms_of_payment_code",
    "product_brand", "corporate_group", "sales_org", "sales_office",
    "city", "state", "zip", "country",
    "ytd_sales", "previous_year_sales", "prior_ytd_sales", "ytd_sales_yoy_pct",
    "ytd_won_deals", "ytd_prior_year_won_deals", "prior_year_won_deals",
    "projected_sales_quote_visibility",
]


class HubSpot:
    def __init__(self, token: str | None = None):
        self.token = token or CONFIG.hubspot_token
        if not self.token:
            raise SystemExit("HUBSPOT_TOKEN not set")
        self.client = httpx.Client(
            base_url=HS,
            headers={"authorization": f"Bearer {self.token}", "content-type": "application/json"},
            timeout=60,
        )

    def request(self, method: str, path: str, json: Any | None = None) -> Any:
        """fetch + 429/5xx backoff, same idiom as apps/sales-sync/src/hubspot.ts."""
        for attempt in range(7):
            res = self.client.request(method, path, json=json)
            if res.status_code == 429 or res.status_code >= 500:
                if attempt == 6:
                    break
                ra = res.headers.get("retry-after")
                delay = float(ra) if ra and ra.replace(".", "").isdigit() else min(10, 0.5 * 2**attempt)
                time.sleep(delay)
                continue
            if res.status_code >= 400:
                raise RuntimeError(f"HubSpot {method} {path} -> {res.status_code}: {res.text[:300]}")
            return res.json() if res.text else {}
        raise RuntimeError(f"HubSpot {method} {path} -> {res.status_code} after retries")

    def existing_properties(self, object_type: str) -> set[str]:
        r = self.request("GET", f"/crm/v3/properties/{object_type}")
        return {p["name"] for p in r["results"]}

    def iter_search(
        self,
        object_type: str,
        filters: list[dict],
        properties: list[str],
        log_every: int = 20_000,
    ) -> Iterator[dict]:
        """Page a CRM search by ascending hs_object_id (bypasses the 10k cap)."""
        last_id = "0"
        seen = 0
        while True:
            body = {
                "filterGroups": [{"filters": [*filters, {"propertyName": "hs_object_id", "operator": "GT", "value": last_id}]}],
                "sorts": [{"propertyName": "hs_object_id", "direction": "ASCENDING"}],
                "properties": properties,
                "limit": SEARCH_PAGE,
            }
            data = self.request("POST", f"/crm/v3/objects/{object_type}/search", json=body)
            results = data.get("results", [])
            if not results:
                return
            for r in results:
                yield r
            seen += len(results)
            if seen % log_every < SEARCH_PAGE:
                print(f"    …{object_type}: {seen} rows")
            last_id = results[-1]["id"]
            if len(results) < SEARCH_PAGE:
                return
            time.sleep(INTER_BATCH_S)

    # ---- entity pulls -------------------------------------------------------

    def _frame(self, rows: list[dict], props: list[str]) -> pd.DataFrame:
        recs = [{"hs_object_id": r["id"], **{p: r["properties"].get(p) for p in props}} for r in rows]
        return pd.DataFrame.from_records(recs)

    def _available(self, object_type: str, props: list[str]) -> list[str]:
        have = self.existing_properties(object_type)
        missing = [p for p in props if p not in have]
        if missing:
            print(f"    [warn] {object_type} properties not in portal (skipped): {missing}")
        return [p for p in props if p in have]

    def extract_deals(self) -> pd.DataFrame:
        props = self._available("deals", DEAL_PROPS)
        rows = list(
            self.iter_search(
                "deals",
                [
                    {"propertyName": "pipeline", "operator": "EQ", "value": UNIVERSAL_PIPELINE_ID},
                    {"propertyName": "sap_quote_number", "operator": "HAS_PROPERTY"},
                ],
                props,
            )
        )
        return self._frame(rows, props)

    def extract_line_items(self) -> pd.DataFrame:
        props = self._available("line_items", LINE_ITEM_PROPS)
        rows = list(
            self.iter_search(
                "line_items",
                [{"propertyName": "quote_product_name", "operator": "HAS_PROPERTY"}],
                props,
            )
        )
        df = self._frame(rows, props)
        # `<quote>-<item>` upsert key → parent quote number.
        key = df["quote_product_name"].astype("string")
        df["sap_quote_number"] = key.str.rsplit("-", n=1).str[0]
        return df

    def extract_companies(self) -> pd.DataFrame:
        props = self._available("companies", COMPANY_PROPS)
        # No scope filter: SAP-linked companies are identified downstream by
        # account_number_, but sales/classifier props exist on others too.
        rows = list(self.iter_search("companies", [], props))
        return self._frame(rows, props)

    def extract_deal_company_assocs(self, deal_ids: list[str]) -> pd.DataFrame:
        """v4 batch read, one row per (deal, company, typeId).

        Primary company = typeId 5 (see pickRollupCompanyId in @wac/shared);
        Specifier label associations must not receive sales attribution.
        """
        records: list[dict] = []
        for i in range(0, len(deal_ids), ASSOC_BATCH):
            chunk = deal_ids[i : i + ASSOC_BATCH]
            res = self.request(
                "POST",
                "/crm/v4/associations/deals/companies/batch/read",
                json={"inputs": [{"id": d} for d in chunk]},
            )
            for r in res.get("results", []):
                deal_id = str(r.get("from", {}).get("id", ""))
                for to in r.get("to", []):
                    for t in to.get("associationTypes", []):
                        records.append(
                            {
                                "deal_id": deal_id,
                                "company_id": str(to.get("toObjectId")),
                                "type_id": t.get("typeId"),
                                "label": t.get("label"),
                            }
                        )
            if i + ASSOC_BATCH < len(deal_ids):
                time.sleep(INTER_BATCH_S)
            if i % 20_000 < ASSOC_BATCH:
                print(f"    …assocs: {i + len(chunk)}/{len(deal_ids)} deals")
        return pd.DataFrame.from_records(records, columns=["deal_id", "company_id", "type_id", "label"])
