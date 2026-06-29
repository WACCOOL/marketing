import * as XLSX from "xlsx";
import { matchesAnyWildcard, parseAnnuityGrid, type AnnuityAccount, type AnnuitySheet } from "@wac/shared";

/**
 * Annuity-sync — drive HubSpot from the "Annuity Pipeline" workbook on SharePoint.
 *
 * The sheet ("Annuities and Associations") lists national-account end users, each
 * with SAP-style name wildcards, a HubSpot company record id, an opportunity name,
 * and one monthly-$ column per year ("2026 Annuity", "2027 Annuity", …). From it
 * this CLI performs two idempotent, re-runnable tasks:
 *
 *   1. associate — for every deal in the Universal Pipeline whose name matches one
 *      of a company's wildcards, label the company↔deal association "National
 *      Account" (the label is created on first run if missing).
 *
 *   2. annuity — for each company and each POPULATED year column, upsert 12 monthly
 *      deals (Jan–Dec of that year) into the National Accounts Annuity Pipeline,
 *      owned by Sara Kruid, with amount = the monthly figure, estimated onsite date
 *      = the last day of the month, associated to the company. Re-running syncs:
 *      changed amounts are patched, new year columns create new deals, no dupes.
 *
 * Env: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, ANNUITY_SHEET_URL, HUBSPOT_TOKEN.
 * Flags: --dry-run, --limit <n> (companies), --task=associate|annuity|all (default all).
 */

const GRAPH = "https://graph.microsoft.com/v1.0";
const HS = "https://api.hubapi.com";
const BATCH = 100;
const SEARCH_PAGE = 200; // HubSpot search max page size
const INTER_BATCH_MS = 250;

const UNIVERSAL_PIPELINE_ID = "723098519";
const ANNUITY_PIPELINE_NAME = "National Accounts Annuities";
const NATIONAL_ACCOUNT_LABEL = "National Account";
const ONSITE_PROP_LABEL = "Estimated Onsite Date";
const OWNER_NAME = "Sara Kruid";
const DEAL_TO_COMPANY = 5; // HUBSPOT_DEFINED deal→company (unlabeled primary) association type
const SHEET_NAME = "Annuities and Associations";
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.error(`[annuity-sync] ${m}`);

// ── Microsoft Graph (app-only, sharing-URL download — same as sales-sync) ────
async function graphToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: env("MS_CLIENT_ID"),
    client_secret: env("MS_CLIENT_SECRET"),
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const r = await fetch(`https://login.microsoftonline.com/${env("MS_TENANT_ID")}/oauth2/v2.0/token`, {
    method: "POST",
    body,
  });
  if (!r.ok) throw new Error(`graph token ${r.status}: ${await r.text()}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

/** Encode a sharing URL into the Graph /shares token (u!<base64url>). */
function shareId(url: string): string {
  return "u!" + Buffer.from(url).toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
}

async function downloadSharedFile(token: string, url: string): Promise<Uint8Array> {
  const content = await fetch(`${GRAPH}/shares/${shareId(url)}/driveItem/content`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!content.ok) throw new Error(`graph download ${content.status}: ${(await content.text()).slice(0, 200)}`);
  return new Uint8Array(await content.arrayBuffer());
}

// ── HubSpot (fetch + 429/5xx backoff) ────────────────────────────────────────
async function hs<T>(token: string, path: string, init?: RequestInit): Promise<T> {
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

/** Page every deal in a pipeline, ordered by hs_object_id, GT-windowing past the
 *  10k search ceiling (no `after` cursor). Yields { id, properties }. */
async function* iterPipelineDeals(
  token: string,
  pipelineId: string,
  properties: string[],
): AsyncGenerator<{ id: string; properties: Record<string, string> }> {
  let lastId = "0";
  while (true) {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: "pipeline", operator: "EQ", value: pipelineId },
            { propertyName: "hs_object_id", operator: "GT", value: lastId },
          ],
        },
      ],
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
      properties,
      limit: SEARCH_PAGE,
    };
    const data = await hs<{ results: { id: string; properties: Record<string, string> }[] }>(
      token,
      "/crm/v3/objects/deals/search",
      { method: "POST", body: JSON.stringify(body) },
    );
    if (!data.results.length) break;
    for (const d of data.results) yield d;
    lastId = data.results[data.results.length - 1]!.id;
    if (data.results.length < SEARCH_PAGE) break;
    await sleep(INTER_BATCH_MS);
  }
}

// ── Sheet parsing ────────────────────────────────────────────────────────────
// Row mapping + year-column detection live in @wac/shared (parseAnnuityGrid) so
// the Worker's real-time labeling interprets the sheet identically.
function parseSheet(bytes: Uint8Array): AnnuitySheet {
  const wb = XLSX.read(bytes, { type: "array" });
  const sheet = wb.Sheets[SHEET_NAME] ?? wb.Sheets[wb.SheetNames[0]!];
  if (!sheet) throw new Error("workbook has no sheets");
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
  return parseAnnuityGrid(grid);
}

// ── Prerequisite resolution (fail loudly) ────────────────────────────────────
async function resolveAnnuityPipeline(token: string): Promise<{ pipelineId: string; stageId: string; stageLabel: string }> {
  const data = await hs<{ results: { id: string; label: string; stages: { id: string; label: string; metadata?: Record<string, string> }[] }[] }>(
    token,
    "/crm/v3/pipelines/deals",
  );
  const p = data.results.find((x) => x.label.trim().toLowerCase() === ANNUITY_PIPELINE_NAME.toLowerCase());
  if (!p) throw new Error(`pipeline "${ANNUITY_PIPELINE_NAME}" not found; have: ${data.results.map((x) => x.label).join(", ")}`);
  const open = p.stages.find((s) => String(s.metadata?.isClosed) !== "true");
  if (!open) throw new Error(`pipeline "${p.label}" has no open stage`);
  return { pipelineId: p.id, stageId: open.id, stageLabel: open.label };
}

async function resolveOnsiteProp(token: string): Promise<string> {
  const data = await hs<{ results: { name: string; label: string; type: string }[] }>(
    token,
    "/crm/v3/properties/deals?archived=false",
  );
  const matches = data.results.filter((p) => p.label.trim().toLowerCase() === ONSITE_PROP_LABEL.toLowerCase());
  if (matches.length === 0) throw new Error(`no deal property labeled "${ONSITE_PROP_LABEL}"`);
  // Prefer the canonical estimated_onsite_date over original_estimated_onsite_date.
  const pick = matches.find((m) => !m.name.startsWith("original_")) ?? matches[0]!;
  if (pick.type !== "date" && pick.type !== "datetime") {
    log(`WARN: onsite property "${pick.name}" has type ${pick.type}, expected date`);
  }
  return pick.name;
}

async function resolveOwnerId(token: string, name: string): Promise<string> {
  const matches: { id: string; email?: string }[] = [];
  let after: string | undefined;
  do {
    const q = after ? `?limit=100&after=${after}` : "?limit=100";
    const data = await hs<{ results: { id: string; firstName?: string; lastName?: string; email?: string }[]; paging?: { next?: { after: string } } }>(
      token,
      `/crm/v3/owners${q}`,
    );
    for (const o of data.results) {
      const full = `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim().toLowerCase();
      if (full === name.toLowerCase()) matches.push({ id: o.id, email: o.email });
    }
    after = data.paging?.next?.after;
  } while (after);
  if (matches.length === 0) throw new Error(`HubSpot owner "${name}" not found`);
  if (matches.length > 1) throw new Error(`HubSpot owner "${name}" is ambiguous: ${matches.map((m) => `${m.id} <${m.email ?? "?"}>`).join(", ")}`);
  return matches[0]!.id;
}

/** Resolve (or create) the "National Account" company↔deal label typeId. In
 *  dry-run, never creates — returns null when absent and reports "would create". */
async function resolveNationalAccountLabel(token: string, dryRun: boolean): Promise<{ typeId: number | null; created: boolean }> {
  const find = async () => {
    const data = await hs<{ results: { category: string; typeId: number; label?: string }[] }>(
      token,
      "/crm/v4/associations/companies/0-3/labels",
    );
    return data.results.find((l) => (l.label ?? "").trim().toLowerCase() === NATIONAL_ACCOUNT_LABEL.toLowerCase());
  };
  let found = await find();
  if (found) return { typeId: found.typeId, created: false };
  if (dryRun) return { typeId: null, created: false };
  await hs(token, "/crm/v4/associations/definitions/companies/0-3/labels", {
    method: "POST",
    body: JSON.stringify({ label: NATIONAL_ACCOUNT_LABEL, name: "national_account" }),
  });
  found = await find();
  if (!found) throw new Error(`created "${NATIONAL_ACCOUNT_LABEL}" label but could not resolve its typeId`);
  return { typeId: found.typeId, created: true };
}

// ── Task 1: tag existing Universal-Pipeline deals ────────────────────────────
async function taskAssociate(token: string, rows: AnnuityAccount[], labelTypeId: number | null, dryRun: boolean): Promise<void> {
  const companies = rows.filter((r) => r.wildcards.length > 0);
  const nameById = new Map(companies.map((c) => [c.companyId, c.endUser || c.opportunityName]));
  const matches = new Map<string, { dealId: string; dealname: string }[]>(); // companyId → matched deals

  let scanned = 0;
  for await (const d of iterPipelineDeals(token, UNIVERSAL_PIPELINE_ID, ["dealname"])) {
    scanned++;
    if (scanned % 2000 === 0) log(`  …scanned ${scanned} Universal-Pipeline deals`);
    const dealname = d.properties.dealname ?? "";
    if (!dealname) continue;
    const lower = dealname.toLowerCase();
    for (const c of companies) {
      if (matchesAnyWildcard(lower, c.wildcards)) {
        const arr = matches.get(c.companyId) ?? [];
        arr.push({ dealId: d.id, dealname });
        matches.set(c.companyId, arr);
      }
    }
  }

  const totalMatches = [...matches.values()].reduce((n, a) => n + a.length, 0);
  log(`Task 1: scanned ${scanned} deals, ${totalMatches} match(es) across ${matches.size} compan(ies).`);
  for (const [companyId, ms] of matches) {
    log(`  ${nameById.get(companyId)} (company ${companyId}): ${ms.length} deal(s)`);
    for (const m of ms) log(`      ${m.dealId}  ${m.dealname}`);
  }

  if (dryRun) {
    log(`Task 1: DRY RUN — would create ${totalMatches} "National Account" association(s).`);
    return;
  }
  if (labelTypeId == null) {
    log(`Task 1: SKIP — "${NATIONAL_ACCOUNT_LABEL}" label unavailable.`);
    return;
  }

  const inputs = [...matches.entries()].flatMap(([companyId, ms]) =>
    ms.map((m) => ({
      from: { id: companyId },
      to: { id: m.dealId },
      types: [{ associationCategory: "USER_DEFINED", associationTypeId: labelTypeId }],
    })),
  );
  for (let i = 0; i < inputs.length; i += BATCH) {
    await hs(token, "/crm/v4/associations/companies/0-3/batch/create", {
      method: "POST",
      body: JSON.stringify({ inputs: inputs.slice(i, i + BATCH) }),
    });
    if (i + BATCH < inputs.length) await sleep(INTER_BATCH_MS);
  }
  log(`Task 1: created/ensured ${inputs.length} "National Account" association(s).`);
}

// ── Task 2: per-year monthly annuity deals ───────────────────────────────────
/** Last day of a month as a `YYYY-MM-DD` string — the form a HubSpot `date`
 *  property is written and read back as (the API returns date props as ISO date
 *  strings, NOT epoch ms). */
function lastDayISO(year: number, monthIndex: number): string {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).toISOString().slice(0, 10);
}

interface AnnuityCtx {
  pipelineId: string;
  stageId: string;
  onsiteProp: string;
  ownerId: string;
}

async function loadAnnuityDeals(token: string, pipelineId: string, onsiteProp: string): Promise<Map<string, { id: string; amount?: string; owner?: string; onsite?: string }>> {
  const map = new Map<string, { id: string; amount?: string; owner?: string; onsite?: string }>();
  for await (const d of iterPipelineDeals(token, pipelineId, ["dealname", "amount", "hubspot_owner_id", onsiteProp])) {
    const name = d.properties.dealname ?? "";
    if (name) map.set(name, { id: d.id, amount: d.properties.amount, owner: d.properties.hubspot_owner_id, onsite: d.properties[onsiteProp] });
  }
  return map;
}

async function taskAnnuity(token: string, rows: AnnuityAccount[], ctx: AnnuityCtx, dryRun: boolean): Promise<void> {
  const { pipelineId, stageId, onsiteProp, ownerId } = ctx;
  const existing = await loadAnnuityDeals(token, pipelineId, onsiteProp);

  const toCreate: { properties: Record<string, string>; associations: unknown[] }[] = [];
  const toUpdate: { id: string; properties: Record<string, string> }[] = [];
  let unchanged = 0;
  let skippedNoYear = 0;
  const perYear = new Map<number, { create: number; update: number }>();
  const bump = (year: number, k: "create" | "update") => {
    const e = perYear.get(year) ?? { create: 0, update: 0 };
    e[k]++;
    perYear.set(year, e);
  };

  for (const r of rows) {
    const yearEntries = Object.entries(r.annualByYear);
    if (yearEntries.length === 0) {
      skippedNoYear++;
      continue;
    }
    if (!r.opportunityName) {
      log(`  WARN: company ${r.companyId} (${r.endUser}) has no Opportunity Name — skipping its annuity deals.`);
      continue;
    }
    for (const [yStr, monthly] of yearEntries) {
      const year = Number(yStr);
      for (let m = 0; m < 12; m++) {
        const dealname = `${r.opportunityName} - ${MONTHS[m]} ${year}`;
        const onsite = lastDayISO(year, m);
        const amount = String(monthly);
        const ex = existing.get(dealname);
        if (ex) {
          const props: Record<string, string> = {};
          if (Number(ex.amount) !== monthly) props.amount = amount;
          if ((ex.owner ?? "") !== ownerId) props.hubspot_owner_id = ownerId;
          if ((ex.onsite ?? "") !== onsite) props[onsiteProp] = onsite;
          if (Object.keys(props).length) {
            toUpdate.push({ id: ex.id, properties: props });
            bump(year, "update");
          } else {
            unchanged++;
          }
        } else {
          toCreate.push({
            properties: {
              dealname,
              amount,
              hubspot_owner_id: ownerId,
              pipeline: pipelineId,
              dealstage: stageId,
              [onsiteProp]: onsite,
            },
            associations: [
              { to: { id: r.companyId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: DEAL_TO_COMPANY }] },
            ],
          });
          bump(year, "create");
        }
      }
    }
  }

  log(
    `Task 2: ${toCreate.length} to create, ${toUpdate.length} to update, ${unchanged} unchanged, ` +
      `${skippedNoYear} compan(ies) with no populated year.`,
  );
  for (const [year, e] of [...perYear.entries()].sort((a, b) => a[0] - b[0])) {
    log(`  ${year}: create ${e.create}, update ${e.update}`);
  }

  if (dryRun) {
    log("Task 2: DRY RUN — sample of planned creates:");
    for (const c of toCreate.slice(0, 3)) {
      log(`    ${c.properties.dealname}  $${c.properties.amount}  onsite=${c.properties[onsiteProp]}`);
    }
    return;
  }

  for (let i = 0; i < toCreate.length; i += BATCH) {
    await hs(token, "/crm/v3/objects/deals/batch/create", {
      method: "POST",
      body: JSON.stringify({ inputs: toCreate.slice(i, i + BATCH) }),
    });
    if (i + BATCH < toCreate.length) await sleep(INTER_BATCH_MS);
  }
  for (let i = 0; i < toUpdate.length; i += BATCH) {
    await hs(token, "/crm/v3/objects/deals/batch/update", {
      method: "POST",
      body: JSON.stringify({ inputs: toUpdate.slice(i, i + BATCH) }),
    });
    if (i + BATCH < toUpdate.length) await sleep(INTER_BATCH_MS);
  }
  log(`Task 2: created ${toCreate.length}, updated ${toUpdate.length} annuity deal(s).`);
}

// ── main ─────────────────────────────────────────────────────────────────────
interface Args {
  dryRun: boolean;
  limit?: number;
  task: "associate" | "annuity" | "all";
}
function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, task: "all" };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === "--dry-run") a.dryRun = true;
    else if (k === "--limit") a.limit = Number(argv[++i]);
    else if (k.startsWith("--limit=")) a.limit = Number(k.slice("--limit=".length));
    else if (k.startsWith("--task=")) a.task = k.slice("--task=".length) as Args["task"];
    else if (k === "--task") a.task = argv[++i] as Args["task"];
    else throw new Error(`unknown arg: ${k}`);
  }
  if (!["associate", "annuity", "all"].includes(a.task)) throw new Error(`--task must be associate|annuity|all`);
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const token = env("HUBSPOT_TOKEN");
  const sheetUrl = env("ANNUITY_SHEET_URL");
  const doAssoc = args.task === "all" || args.task === "associate";
  const doAnnuity = args.task === "all" || args.task === "annuity";

  const gtoken = await graphToken();
  const bytes = await downloadSharedFile(gtoken, sheetUrl);
  let { accounts: rows, years } = parseSheet(bytes);
  log(`Loaded ${bytes.length} bytes; ${rows.length} compan(ies); year columns = [${years.join(", ")}]${args.dryRun ? " (DRY RUN)" : ""}.`);
  if (args.limit != null) {
    rows = rows.slice(0, args.limit);
    log(`--limit ${args.limit}: processing ${rows.length} compan(ies).`);
  }

  if (doAssoc) {
    const label = await resolveNationalAccountLabel(token, args.dryRun);
    if (label.created) log(`Created "${NATIONAL_ACCOUNT_LABEL}" company↔deal association label (typeId ${label.typeId}).`);
    else if (label.typeId == null) log(`"${NATIONAL_ACCOUNT_LABEL}" label does not exist — would create it on a live run.`);
    else log(`Resolved "${NATIONAL_ACCOUNT_LABEL}" label typeId ${label.typeId}.`);
    await taskAssociate(token, rows, label.typeId, args.dryRun);
  }

  if (doAnnuity) {
    const [{ pipelineId, stageId, stageLabel }, onsiteProp, ownerId] = await Promise.all([
      resolveAnnuityPipeline(token),
      resolveOnsiteProp(token),
      resolveOwnerId(token, OWNER_NAME),
    ]);
    log(`Annuity pipeline ${pipelineId} (open stage "${stageLabel}" = ${stageId}); onsite prop "${onsiteProp}"; owner ${OWNER_NAME} = ${ownerId}.`);
    await taskAnnuity(token, rows, { pipelineId, stageId, onsiteProp, ownerId }, args.dryRun);
  }

  log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
