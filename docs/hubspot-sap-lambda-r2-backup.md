# SAP → HubSpot: independent raw payload backup (Lambda → R2)

## Why

The SAP→HubSpot push runs: **SAP → AWS Lambda (thin proxy) → Worker `/api/hubspot-sync/push/{deals,companies}` → HubSpot**. The Worker captures every payload it receives — but that capture lives *on the Worker*, the same component that does the push. On 2026-06-23 a stale `main` deploy wiped the Worker's `/push` route, so the push **and** its only backup went down together; the ~40-min window of SAP events was unrecoverable (Lambda logs only runtime lines, no payload).

The fix is a backup that lives **upstream of the Worker, on storage the Lambda owns, written before the forward** — so it survives the Worker being down. We write it to the existing R2 bucket (`wac-marketing-assets`) under an isolated `raw-sap/` prefix, separate from the Worker's own `hubspot-sync/` capture prefix. R2 is a different Cloudflare service from the Worker, so wiping a Worker route never affects it.

Because the push is **idempotent** (HubSpot upsert, deduped by `idempotency_key = sha256(body)`), you can then replay an entire window blind — events that already landed dedupe, only the gap is filled. See `POST /api/hubspot-sync/replay-raw` below.

## R2 credentials (one-time)

R2 speaks the S3 API. In the Cloudflare dashboard: **R2 → Manage R2 API Tokens → Create API token**, scope **Object Read & Write** to the `wac-marketing-assets` bucket only. Note the **Access Key ID**, **Secret Access Key**, and your **Account ID** (the S3 endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).

Set these as env vars on **both** Lambdas (deals + companies):

```
R2_ACCOUNT_ID        = <cloudflare account id>
R2_ACCESS_KEY_ID     = <from the R2 API token>
R2_SECRET_ACCESS_KEY = <from the R2 API token>
R2_BUCKET            = wac-marketing-assets
```

## Lambda code (Node 18+/22)

`@aws-sdk/client-s3` is included in the Node 18+ Lambda runtimes; if your bundler tree-shakes it out, add it as a dependency. Drop this in and call `backupRawToR2(...)` **as the first thing the handler does, before the forward to the Worker.**

```js
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const crypto = require("crypto");

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Write the raw SAP payload to R2 BEFORE forwarding. Fail-open: a backup error
 * must never block the live push — but log it loudly so it gets noticed.
 *   objectType: "deals" | "companies"
 *   bodyString: the exact raw JSON string received from SAP
 */
async function backupRawToR2(objectType, bodyString) {
  try {
    const key = crypto.createHash("sha256").update(bodyString).digest("hex");
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const objectKey =
      `raw-sap/${objectType}/${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/` +
      `${p(d.getUTCDate())}/${key}.json`;
    await r2.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: objectKey,
        Body: bodyString,
        ContentType: "application/json",
      }),
    );
  } catch (err) {
    console.error("[r2-backup] FAILED — payload not backed up:", err);
  }
}
```

Handler shape:

```js
exports.handler = async (event) => {
  const bodyString = typeof event.body === "string" ? event.body : JSON.stringify(event);
  await backupRawToR2("deals", bodyString); // "companies" in the companies Lambda
  // ...then the existing forward to /api/hubspot-sync/push/{deals,companies}
};
```

Notes:
- The `sha256(body)` key leaf matches the Worker's idempotency key, so an identical re-send overwrites the same object instead of duplicating.
- Keep the backup `await`ed before the forward, but **fail-open** — never let a backup error throw out of the handler.

## Recovery: replay a window

Once a backup exists, recover any gap with one call (token-authenticated, same `SAP_SYNC_TOKEN` as `/push`):

```bash
curl -X POST "https://marketing.gowac.cc/api/hubspot-sync/replay-raw?object=deals&from=2026-06-23T18:22:47Z&to=2026-06-23T19:04:01Z" \
  -H "Authorization: Bearer $SAP_SYNC_TOKEN"
```

- `object` (optional): `deals` | `companies`; omit to replay both.
- `from`/`to` (ISO, optional): filters by R2 upload time; when `from` is given the scan is narrowed to that window's UTC day-partitions.
- `limit` (optional, default 500): cap per call; chunk large recoveries by window.
- Safe to run blind — the push dedupes on `idempotency_key`, so already-landed events are no-ops. Returns `{ scanned, replayed, skippedOutOfRange, errors, counts }`.

## Security / retention

Raw SAP payloads contain customer PII (e.g. `requested_by` emails). Add an **R2 lifecycle rule** to expire the `raw-sap/` prefix after a retention window (e.g. 30–90 days), and keep the R2 API token scoped to this one bucket. Do **not** `console.log` payloads to CloudWatch as a substitute — that leaks the same PII into logs indefinitely with no expiry.
