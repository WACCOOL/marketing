# sales-sync

Pushes per-account sales onto HubSpot Companies daily (9 AM ET, `.github/workflows/sales-sync.yml`). See the header of [`src/index.ts`](src/index.ts) for sources, precedence, and env vars.

The sync reads its source files as-is from OneDrive via Graph and checks each file's `lastModifiedDateTime` — a file older than `SALES_STALE_HOURS` (default 30) is skipped and the run fails (red workflow → GitHub failure email), so stale numbers are never silently pushed as fresh.

## Primary source: the dataset-query CSV (`sales-ytd.csv`)

A scheduled Power Automate flow queries the Power BI **dataset directly** and writes a flat CSV to OneDrive — no Excel, no pivot refresh, no "Enable Content" prompt anywhere in the chain. The file's timestamp moves only when the query actually ran, so the staleness check is trustworthy.

Flow (owner: Davis; runs daily ~7:45 AM ET):

1. **Recurrence** — every 1 day, 7:45 AM, time zone America/New_York.
2. **Power BI → Run a query against a dataset** — Workspace: *My Workspace*, Dataset: custom value `94fe91ca-581a-4bad-80a2-96e5cc6a6b05` (the WAC Sales semantic model; reachable via the my-org route because Davis has Build permission on it, even though it lives in another workspace). Query:

   ```dax
   EVALUATE
   VAR CurYear = YEAR(TODAY())
   RETURN
   ADDCOLUMNS(
       VALUES('Customer'[Account]),
       "ytd",        CALCULATE([Sales], 'Calendar'[Year] = CurYear),
       "pytd",       CALCULATE([Sales PYTD], 'Calendar'[Year] = CurYear),
       "prior_full", CALCULATE([Sales], 'Calendar'[Year] = CurYear - 1)
   )
   ```

   `[Sales]` / `[Sales PYTD]` are the dataset's own measures — the same ones the old Excel pivots displayed, in the same year context, so the numbers are definitionally identical (PYTD = prior year through the same calendar date).
3. **Create CSV table** — From: the query's *First table rows*.
4. **OneDrive for Business → Update file** — overwrite `sales-ytd.csv` with the CSV output.

The sync's `SALES_YTD_URL` secret points at that CSV's sharing URL. `parseYtdFlat` (in `@wac/shared`) matches columns by header name (`account`, `ytd`, `pytd`, `prior_full`; DAX-style `Customer[Account]` / `[ytd]` headers work too). Blank cells are real $0 (dormant accounts get explicit zeros). The CSV covers every account — including purely-named ones like `THAI MING` that the pivot parser could never distinguish from group labels.

## Legacy sources: the Excel pivot workbooks

`SALES_WAC_URL` / `SALES_SCHONBEK_URL` point at PivotTable workbooks over the same dataset. They only update when a *human* opens them in Excel and clicks **Enable Content** (the tenant re-prompts every open — this is why scheduled/scripted refresh is impossible: Office Scripts' `refreshAllPivotTables()` silently no-ops while content is blocked, and a headless Power Automate run can never click the prompt).

They remain configured only as a fallback for accounts the CSV might not cover; in practice the CSV is a superset. If a pivot workbook goes >30 h without a save it fails the run — **unset its secret** rather than babysitting it once the CSV path is confirmed stable.

## Handy commands

```bash
# Structure dump of the SALES_YTD_URL file (no HubSpot writes)
gh workflow run sales-sync.yml -f inspect=true
# ...or of any candidate file
gh workflow run sales-sync.yml -f inspect=true -f inspect_url="<sharing url>"

# Full dry run (download + parse + resolve accounts, print match rate; no writes)
gh workflow run sales-sync.yml -f dry_run=true
```
