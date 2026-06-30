/**
 * National-account domain mirror + lookup for the lead-ownership webhook.
 *
 * A contact whose email domain belongs to a National Account always routes to
 * Sara Kruid. HubSpot marks the company with the `national_account` (bool)
 * property, but the webhook only knows the contact's email — so we mirror every
 * national-account company's primary domain into Supabase (`national_account_domains`,
 * migration 0034) and match on the email domain.
 *
 * {@link syncNationalAccountDomains} refreshes the mirror (full-replace snapshot);
 * {@link isNationalAccountDomain} is the per-request lookup.
 */
import type { Env } from "./env.js";
import { serviceSupabase } from "./supabase.js";
import { hs, PATHS } from "./hubspotPush.js";

/** The HubSpot company boolean that marks a National Account. */
export const NATIONAL_ACCOUNT_PROP = "national_account";

/**
 * Normalize a domain/website/email-domain to its bare registrable host:
 * `"https://www.Ferguson.com/contact"` → `"ferguson.com"`. Returns "" when there's
 * nothing host-like. Unlike `domainCore`, this KEEPS the TLD — email domains carry
 * it, so matching must too.
 */
export function normalizeDomain(raw: string | null | undefined): string {
  let h = (raw ?? "").trim().toLowerCase();
  if (!h) return "";
  h = h.replace(/^[a-z]+:\/\//, ""); // scheme
  h = h.replace(/^.*@/, ""); // if an email slipped in, keep the domain
  h = h.replace(/[/?#].*$/, ""); // path / query / fragment
  h = h.replace(/^www\./, ""); // leading www.
  h = h.replace(/\.+$/, ""); // trailing dots
  // A valid host has at least one dot and only host-legal chars.
  return /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(h) ? h : "";
}

/** The normalized domain portion of an email address ("" if none). */
export function emailDomain(email: string | null | undefined): string {
  const at = (email ?? "").lastIndexOf("@");
  return at >= 0 ? normalizeDomain((email as string).slice(at + 1)) : "";
}

interface NationalAccountMatch {
  match: boolean;
  companyId?: string;
  companyName?: string;
}

/**
 * Is this domain a National Account? Looks the normalized domain up in
 * `national_account_domains`. Fail-soft: returns no-match on any error.
 */
export async function isNationalAccountDomain(
  env: Env,
  rawDomain: string | null | undefined,
): Promise<NationalAccountMatch> {
  const domain = normalizeDomain(rawDomain);
  if (!domain) return { match: false };
  const sb = serviceSupabase(env);
  const { data, error } = await sb
    .from("national_account_domains")
    .select("company_id, company_name")
    .eq("domain", domain)
    .maybeSingle();
  if (error || !data) return { match: false };
  return { match: true, companyId: data.company_id, companyName: data.company_name ?? undefined };
}

interface SyncResult {
  scanned: number;
  domains: number;
  written: number;
  pruned: number;
}

/**
 * Refresh the national-account domain mirror from HubSpot. Searches companies with
 * `national_account = true`, normalizes each primary domain, upserts the snapshot,
 * then prunes rows from earlier runs (full replace). One rep code per domain wins
 * (first company seen for a domain).
 */
export async function syncNationalAccountDomains(env: Env, signal: AbortSignal): Promise<SyncResult> {
  const token = env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN not configured");
  const sb = serviceSupabase(env);
  const startedAt = new Date().toISOString();

  const rows = new Map<string, { domain: string; company_id: string; company_name: string | null }>();
  let scanned = 0;
  let after: string | undefined;
  for (let page = 0; page < 200; page++) {
    const res = await hs(
      token,
      "POST",
      PATHS.companySearch,
      {
        filterGroups: [
          { filters: [{ propertyName: NATIONAL_ACCOUNT_PROP, operator: "EQ", value: "true" }] },
        ],
        properties: ["domain", "website", "name"],
        limit: 100,
        ...(after ? { after } : {}),
      },
      signal,
    );
    if (!res.ok) {
      throw new Error(`company search ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
    }
    for (const co of res.data?.results ?? []) {
      scanned++;
      const id = String(co.id ?? "");
      const props = (co.properties ?? {}) as Record<string, string | null>;
      const domain = normalizeDomain(props.domain) || normalizeDomain(props.website);
      if (!id || !domain || rows.has(domain)) continue;
      rows.set(domain, { domain, company_id: id, company_name: props.name ?? null });
    }
    after = res.data?.paging?.next?.after;
    if (!after) break;
  }

  let written = 0;
  const all = [...rows.values()];
  for (let i = 0; i < all.length; i += 500) {
    const chunk = all.slice(i, i + 500).map((r) => ({ ...r, synced_at: startedAt }));
    const { error } = await sb.from("national_account_domains").upsert(chunk, { onConflict: "domain" });
    if (error) throw new Error(`national_account_domains upsert failed: ${error.message}`);
    written += chunk.length;
  }

  // Prune rows not refreshed by this run (companies that lost the flag / changed domain).
  const { error: pruneErr, count } = await sb
    .from("national_account_domains")
    .delete({ count: "exact" })
    .lt("synced_at", startedAt);
  if (pruneErr) throw new Error(`national_account_domains prune failed: ${pruneErr.message}`);

  return { scanned, domains: rows.size, written, pruned: count ?? 0 };
}
