# sales-sync

Pushes per-account sales onto HubSpot Companies daily (9 AM ET, `.github/workflows/sales-sync.yml`). See the header of [`src/index.ts`](src/index.ts) for sources, precedence, and env vars.

The source workbooks are Excel PivotTables over a Power BI dataset. **They only contain fresh numbers after their pivots are refreshed and saved** — the sync reads the file as-is. The sync checks each file's OneDrive `lastModifiedDateTime` and fails the run (red workflow → GitHub failure email) if a file hasn't been saved within `SALES_STALE_HOURS` (default 30).

## Scheduled refresh (Power Automate + Office Script)

One-time setup so nobody has to open Excel every morning. Repeat the flow step for each source workbook (`YTD.xlsx`, `WAC Sales.xlsx`, `Schonbek Sales.xlsx`).

### 1. Create the Office Script (once)

1. Open any of the workbooks in **Excel for the web**.
2. **Automate** tab → **New Script**, replace the body with:

   ```ts
   function main(workbook: ExcelScript.Workbook) {
     workbook.refreshAllPivotTables();
   }
   ```

3. Rename it `Refresh Sales Pivots` and **Save script**. (Scripts are saved to your OneDrive and reusable across workbooks.)
4. Sanity check: click **Run** and confirm the pivot numbers update. If Excel for the web can't refresh the Power BI connection here, the scheduled flow won't work either — see the fallback below.

### 2. Create the scheduled flow

1. Go to [make.powerautomate.com](https://make.powerautomate.com) → **Create** → **Scheduled cloud flow**.
2. Name: `Refresh sales workbooks`; repeat **every 1 day** at **7:45 AM** (America/New_York) — comfortably before the 9 AM ET sync.
3. Add an action per workbook: **Excel Online (Business) → Run script**:
   - Location / Document Library / File: browse to the workbook (OneDrive).
   - Script: `Refresh Sales Pivots`.
4. Save, then **Test → Manually** and confirm each workbook's *Modified* timestamp in OneDrive updates and the numbers change.

"Run script" saves the workbook as part of the run, which bumps `lastModifiedDateTime` — exactly what the sync's staleness check watches. If the flow breaks (auth expiry, moved file), the sync goes red the next morning rather than silently pushing stale numbers.

### Fallback: query the dataset directly

If Excel for the web can't refresh these pivots (some tenants/connection types don't support it), skip the workbook entirely: a scheduled Power Automate flow with **Power BI → Run a query against a dataset** (DAX returning account, sales, PYTD) → **Create CSV table** → save to OneDrive, and point the sync at that CSV instead (needs a small CSV-ingest addition in `src/index.ts`).

## Handy commands

```bash
# Structure dump of the SALES_YTD_URL workbook (no HubSpot writes)
gh workflow run sales-sync.yml -f inspect=true

# Full dry run (download + parse + sample metrics, no writes)
gh workflow run sales-sync.yml -f dry_run=true
```
