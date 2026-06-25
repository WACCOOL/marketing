/**
 * Push rep codes to the HubSpot "Rep Code" custom object (objectTypeId
 * 2-41537429, unique property `rep_code`). All target properties already exist;
 * we only WRITE values (no schema changes):
 *   zips        -> zip_codes (multi-line text, newline-joined)
 *   district    -> region (enumeration; mapped via the option label)
 *   sales code  -> sales_district_code (number)
 *   AMT code    -> amt_rep_code (number)
 *   ISR         -> hubspot_owner_id (record owner; name -> owner id)
 *   RSM/TSM     -> territory__regional_manager (owner-reference; name -> owner id)
 * Names/labels that don't resolve are left unset and reported (the source data
 * or HubSpot users/options can be reconciled, then re-run).
 */

const OBJECT_TYPE = "2-41537429";
const BASE = "https://api.hubapi.com";
const BATCH = 100;

export interface OwnerResolver {
  /** Resolve a "First Last" name to a HubSpot owner id, or undefined. */
  resolveOwner(name: string): string | undefined;
}

/**
 * Build a name->owner-id resolver from all HubSpot owners: exact "first last",
 * then a surname + first-initial fallback (nickname/legal-name mismatches like
 * Eddie->Edward, Joey->Joseph) applied only when the surname is unambiguous.
 */
export async function buildOwnerResolver(token: string): Promise<OwnerResolver> {
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  const ownerByName = new Map<string, string>();
  const ownerBySurname = new Map<string, { id: string; firstInitial: string }[]>();
  let after: string | undefined;
  do {
    const res = await fetch(`${BASE}/crm/v3/owners?limit=100${after ? `&after=${after}` : ""}`, { headers });
    if (!res.ok) throw new Error(`hubspot GET /crm/v3/owners -> ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      results: { id: string; firstName?: string; lastName?: string }[];
      paging?: { next?: { after?: string } };
    };
    for (const o of data.results) {
      const first = (o.firstName ?? "").trim().toLowerCase();
      const last = (o.lastName ?? "").trim().toLowerCase();
      const full = `${first} ${last}`.trim();
      if (full) ownerByName.set(full, o.id);
      if (last) {
        const arr = ownerBySurname.get(last) ?? [];
        arr.push({ id: o.id, firstInitial: first[0] ?? "" });
        ownerBySurname.set(last, arr);
      }
    }
    after = data.paging?.next?.after;
  } while (after);

  return {
    resolveOwner(name: string): string | undefined {
      const lower = name.trim().toLowerCase();
      const exact = ownerByName.get(lower);
      if (exact) return exact;
      const parts = lower.split(/\s+/);
      const last = parts[parts.length - 1] ?? "";
      const firstInitial = parts[0]?.[0] ?? "";
      const cands = (ownerBySurname.get(last) ?? []).filter((c) => c.firstInitial === firstInitial);
      return cands.length === 1 ? cands[0]!.id : undefined;
    },
  };
}

export interface RepForPush {
  repCode: string;
  district: string | null;
  rsmTsm: string | null;
  salesDistrictCode: string | null;
  isr: string | null;
  amtRepCode: string | null;
  zips: string[];
}

interface HubspotResult {
  pushed: number;
  unmatched: { region: string[]; isr: string[]; rsm: string[] };
}

export async function syncRepCodesToHubspot(opts: {
  token: string;
  reps: RepForPush[];
  dryRun: boolean;
}): Promise<HubspotResult> {
  const { token, reps, dryRun } = opts;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json",
  };

  async function hget<T>(path: string): Promise<T> {
    const res = await fetch(`${BASE}${path}`, { headers });
    if (!res.ok) throw new Error(`hubspot GET ${path} -> ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  // Owner resolution: exact "first last", surname + first-initial fallback
  // (nickname/legal-name mismatches), unambiguous-only. Shared with the
  // inside-sales reconciliation.
  const { resolveOwner } = await buildOwnerResolver(token);

  // region option label -> internal value.
  const reg = await hget<{ options: { label: string; value: string }[] }>(
    `/crm/v3/properties/${OBJECT_TYPE}/region`,
  );
  const regionByLabel = new Map(reg.options.map((o) => [o.label, o.value]));

  // HubSpot splits the MF showroom regions into "<base> Fan" / "<base> Luminere".
  // Our District values carry no Fan/Luminere suffix, so: a district naming
  // "Fan" maps to the Fan variant; anything else maps to the Luminere variant.
  function resolveRegion(district: string): string | undefined {
    const exact = regionByLabel.get(district);
    if (exact) return exact;
    const variant = /fan/i.test(district) ? "Fan" : "Luminere";
    return regionByLabel.get(`${district} ${variant}`);
  }

  const unmatched = {
    region: new Set<string>(),
    isr: new Set<string>(),
    rsm: new Set<string>(),
  };

  const inputs = reps.map((r) => {
    const properties: Record<string, string> = { rep_code: r.repCode };
    if (r.zips.length) properties.zip_codes = r.zips.join("\n");
    if (r.salesDistrictCode) properties.sales_district_code = r.salesDistrictCode;
    if (r.amtRepCode) properties.amt_rep_code = r.amtRepCode;
    if (r.district) {
      const v = resolveRegion(r.district);
      if (v) properties.region = v;
      else unmatched.region.add(r.district);
    }
    if (r.isr) {
      const id = resolveOwner(r.isr);
      if (id) properties.hubspot_owner_id = id;
      else unmatched.isr.add(r.isr);
    }
    if (r.rsmTsm) {
      const id = resolveOwner(r.rsmTsm);
      if (id) properties.territory__regional_manager = id;
      else unmatched.rsm.add(r.rsmTsm);
    }
    return { idProperty: "rep_code", id: r.repCode, properties };
  });

  console.log(
    `[hubspot] ${inputs.length} rep codes prepared. unmatched ` +
      `region=${[...unmatched.region].length} isr=${[...unmatched.isr].length} ` +
      `rsm=${[...unmatched.rsm].length}`,
  );
  if (unmatched.region.size) console.log(`  region not an option: ${[...unmatched.region]}`);
  if (unmatched.isr.size) console.log(`  ISR not a HubSpot owner: ${[...unmatched.isr]}`);
  if (unmatched.rsm.size) console.log(`  RSM/TSM not a HubSpot owner: ${[...unmatched.rsm]}`);

  if (dryRun) {
    console.log("[hubspot] --dry-run: sample input:", JSON.stringify(inputs[0]));
    return { pushed: 0, unmatched: toArrays(unmatched) };
  }

  let pushed = 0;
  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH);
    const res = await fetch(`${BASE}/crm/v3/objects/${OBJECT_TYPE}/batch/upsert`, {
      method: "POST",
      headers,
      body: JSON.stringify({ inputs: batch }),
    });
    if (!res.ok) {
      throw new Error(`hubspot batch upsert ${res.status}: ${await res.text()}`);
    }
    const j = (await res.json()) as { status: string; results?: unknown[] };
    pushed += j.results?.length ?? 0;
    console.log(`[hubspot] batch ${i / BATCH + 1}: ${j.status}, ${j.results?.length ?? 0} upserted`);
  }
  console.log(`[hubspot] done: ${pushed} rep codes upserted`);
  return { pushed, unmatched: toArrays(unmatched) };
}

function toArrays(u: { region: Set<string>; isr: Set<string>; rsm: Set<string> }) {
  return { region: [...u.region], isr: [...u.isr], rsm: [...u.rsm] };
}
