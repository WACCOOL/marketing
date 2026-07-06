/** HubSpot helpers shared by the workbook sync and the --deal-rollups mode. */

const HS = "https://api.hubapi.com";
export const BATCH = 100;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch + 429/5xx backoff (same idiom as annuity-sync / territory-sync). */
export async function hs<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${HS}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(10_000, 500 * 2 ** attempt));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`HubSpot ${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? (JSON.parse(text) as T) : ({} as T);
  }
}

/** Company property names that already exist in the portal. */
export async function existingCompanyProperties(token: string): Promise<Set<string>> {
  const r = await hs<{ results: { name: string }[] }>(token, "/crm/v3/properties/companies");
  return new Set(r.results.map((p) => p.name));
}

export async function ensureProperties(token: string, defs: { name: string; label: string }[]): Promise<void> {
  const have = await existingCompanyProperties(token);
  for (const d of defs) {
    if (have.has(d.name)) continue;
    await hs(token, "/crm/v3/properties/companies", {
      method: "POST",
      body: JSON.stringify({ name: d.name, label: d.label, type: "number", fieldType: "number", groupName: "companyinformation" }),
    });
    console.log(`[sales-sync] created company property ${d.name}`);
  }
}

export async function updateCompanies(token: string, byId: Map<string, Record<string, number>>): Promise<number> {
  const inputs = [...byId.entries()].map(([id, properties]) => ({ id, properties }));
  let ok = 0;
  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH);
    const r = await hs<{ results?: unknown[] }>(token, "/crm/v3/objects/companies/batch/update", {
      method: "POST",
      body: JSON.stringify({ inputs: batch }),
    });
    ok += r.results?.length ?? batch.length;
  }
  return ok;
}
