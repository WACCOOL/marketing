import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SHOWROOM_DEFAULT_TAB, SHOWROOM_SHEETS } from "./registry.js";
import { parseShowroomRows } from "./parse.js";
import { showroomDealProperties } from "./map.js";

/**
 * OPT-IN live validation (skipped in CI): parse every real agency sheet with
 * the service-account key and report what the sync would push. Run with:
 *   SHOWROOM_LIVE=1 pnpm --filter @wac/shared exec vitest run src/showroom/live.dryparse.test.ts
 * Requires ~/.config/wac-marketing/showroom-sync-sa.json.
 */
const LIVE = process.env.SHOWROOM_LIVE === "1";

async function saToken(): Promise<string> {
  const key = JSON.parse(
    readFileSync(`${process.env.HOME}/.config/wac-marketing/showroom-sync-sa.json`, "utf8"),
  ) as { client_email: string; private_key: string };
  const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) +
    "." +
    b64url(
      JSON.stringify({
        iss: key.client_email,
        scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    );
  const sig = createSign("RSA-SHA256").update(unsigned).sign(key.private_key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(Buffer.from(sig))}`,
    }),
  });
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("token exchange failed");
  return data.access_token;
}

describe.skipIf(!LIVE)("live dry-parse of all agency sheets", () => {
  it("parses every sheet without dropping rows unexpectedly", { timeout: 120_000 }, async () => {
    const token = await saToken();
    let totalOrders = 0;
    const allKeys = new Set<string>();
    for (const sheet of SHOWROOM_SHEETS) {
      const range = encodeURIComponent(`${sheet.tab ?? SHOWROOM_DEFAULT_TAB}!A:J`);
      const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheet.spreadsheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(res.ok, `${sheet.agencyKey} fetch failed (${res.status})`).toBe(true);
      const values = ((await res.json()) as { values?: unknown[][] }).values ?? [];
      const { orders, warnings } = parseShowroomRows(values, sheet);
      totalOrders += orders.length;

      const badAmounts = orders.filter((o) => o.amount === null);
      const noTs = orders.filter((o) => o.timestampMs === null);
      const noAcct = orders.filter((o) => !o.accountNumber);
      console.log(
        `${sheet.agencyKey.padEnd(20)} rows=${String(values.length - 1).padStart(3)} orders=${String(orders.length).padStart(3)} ` +
          `badAmount=${badAmounts.length} noTimestamp=${noTs.length} noAcct=${noAcct.length} warnings=${warnings.length}`,
      );
      for (const w of warnings) console.log(`   ⚠ ${w}`);
      for (const o of badAmounts) console.log(`   $? row ${o.row}: amount unparseable (${o.orderKey})`);

      for (const o of orders) {
        expect(allKeys.has(o.orderKey), `cross-sheet key collision: ${o.orderKey}`).toBe(false);
        allKeys.add(o.orderKey);
        const props = showroomDealProperties(o);
        expect(props.showroom_order_key).toBe(o.orderKey);
        expect(props.pipeline).toBe("723098519");
      }
      if (orders.length) {
        const sample = showroomDealProperties(orders[0]!);
        console.log(`   sample: ${sample.dealname} | $${sample.amount ?? "?"} | closedate=${sample.closedate ? new Date(Number(sample.closedate)).toISOString().slice(0, 10) : "?"} | acct=${sample.account_number ?? "-"}`);
      }
    }
    console.log(`TOTAL deals that would be upserted: ${totalOrders}`);
    expect(totalOrders).toBeGreaterThan(100);
  });
});
