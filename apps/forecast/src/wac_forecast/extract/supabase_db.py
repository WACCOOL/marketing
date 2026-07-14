"""Supabase extraction: turnover_orders, open_orders, rep codes, hierarchy.

Keyset pagination on the uuid `id` PK (order by id, gt cursor) — stable under
concurrent ingestion, unlike offset ranges.
"""

from __future__ import annotations

import pandas as pd
from supabase import Client, create_client

from ..config import CONFIG

PAGE = 1000  # PostgREST default max-rows

TURNOVER_COLS = (
    "id,billing_document,material,rep_code,sold_to,billing_date,brand,"
    "quantity,discounted_sales,quotation_ref,currency"
)
OPEN_ORDER_COLS = (
    "id,so,posnr,po_date,customer_account,customer_name,sales_group,amt_rep,"
    "sales_territory,business_unit,material,order_qty,net_price,line_net_value,"
    "back_order_qty,is_open,closed_at"
)


def client() -> Client:
    CONFIG.require("supabase_url", "supabase_service_role_key")
    return create_client(CONFIG.supabase_url, CONFIG.supabase_service_role_key)


def fetch_all(
    db: Client, table: str, columns: str = "*", key: str = "id", log_every: int = 100_000
) -> pd.DataFrame:
    rows: list[dict] = []
    cursor = ""
    while True:
        q = db.table(table).select(columns).order(key).limit(PAGE)
        if cursor:
            q = q.gt(key, cursor)
        page = q.execute().data
        if not page:
            break
        rows.extend(page)
        cursor = page[-1][key]
        if len(rows) % log_every < PAGE:
            print(f"    …{table}: {len(rows)} rows")
        if len(page) < PAGE:
            break
    df = pd.DataFrame.from_records(rows)
    return df.drop(columns=["id"], errors="ignore")


def extract_turnover_orders(db: Client) -> pd.DataFrame:
    return fetch_all(db, "turnover_orders", TURNOVER_COLS)


def extract_open_orders(db: Client) -> pd.DataFrame:
    return fetch_all(db, "open_orders", OPEN_ORDER_COLS)


def extract_rep_codes(db: Client) -> pd.DataFrame:
    return fetch_all(db, "rep_codes", key="rep_code")


def extract_rep_code_zips(db: Client) -> pd.DataFrame:
    return fetch_all(db, "rep_code_zips")


def extract_company_parents(db: Client) -> pd.DataFrame:
    return fetch_all(db, "company_parents", "id,account,customer_name,parent_account,parent_name")
