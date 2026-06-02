import type { HubspotCampaign } from "@wac/shared";
import type { Env } from "./env.js";
import { serviceSupabase } from "./supabase.js";

/**
 * Campaign adapter. The rest of the API only knows about `list()` and never
 * cares whether the data came from the seeded cache or a live HubSpot pull.
 *
 * - If HUBSPOT_TOKEN is unset (dev / pre-launch), the seeded
 *   `hubspot_campaigns` table is used directly.
 * - If HUBSPOT_TOKEN is set, we read from the same cache table but refresh it
 *   from HubSpot's Marketing Campaigns API on a stale-while-revalidate basis.
 *   This keeps the dropdown's load instant (single Postgres read) while
 *   reflecting HubSpot edits within a few minutes.
 */
export interface CampaignAdapter {
  list(): Promise<HubspotCampaign[]>;
}

const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const HUBSPOT_CAMPAIGNS_URL = "https://api.hubapi.com/marketing/v3/campaigns";

export function makeCampaignAdapter(env: Env): CampaignAdapter {
  return {
    async list() {
      const admin = serviceSupabase(env);

      // Best-effort live refresh, fully behind a try/catch so a HubSpot blip
      // never breaks the dropdown.
      if (env.HUBSPOT_TOKEN) {
        try {
          await refreshIfStale(env);
        } catch (e) {
          console.error("HubSpot refresh failed", e);
        }
      }

      const { data, error } = await admin
        .from("hubspot_campaigns")
        .select("hubspot_id, slug, name")
        .order("name", { ascending: true });
      if (error) throw new Error(`hubspot_campaigns read failed: ${error.message}`);
      return (data ?? []) as HubspotCampaign[];
    },
  };
}

async function refreshIfStale(env: Env): Promise<void> {
  const admin = serviceSupabase(env);
  const { data: newest } = await admin
    .from("hubspot_campaigns")
    .select("synced_at")
    .order("synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const newestTs = newest
    ? Date.parse((newest as { synced_at: string }).synced_at)
    : 0;
  if (Date.now() - newestTs < REFRESH_INTERVAL_MS) return;

  const campaigns = await fetchHubspotCampaigns(env.HUBSPOT_TOKEN!);
  if (campaigns.length === 0) return;

  // Upsert in batch; existing rows get refreshed synced_at.
  const { error } = await admin
    .from("hubspot_campaigns")
    .upsert(
      campaigns.map((c) => ({ ...c, synced_at: new Date().toISOString() })),
      { onConflict: "hubspot_id,slug" },
    );
  if (error) throw new Error(`hubspot_campaigns upsert failed: ${error.message}`);
}

interface HubspotApiCampaign {
  id: string;
  properties?: Record<string, string | null>;
}

interface HubspotListResp {
  results: HubspotApiCampaign[];
  paging?: { next?: { after?: string } };
}

async function fetchHubspotCampaigns(token: string): Promise<HubspotCampaign[]> {
  const out: HubspotCampaign[] = [];
  let after: string | undefined;

  // Paginate through all campaigns. HubSpot caps page size at 100.
  for (let page = 0; page < 50; page++) {
    const url = new URL(HUBSPOT_CAMPAIGNS_URL);
    url.searchParams.set("limit", "100");
    url.searchParams.set("properties", "hs_name");
    if (after) url.searchParams.set("after", after);

    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`HubSpot ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as HubspotListResp;

    for (const c of body.results) {
      const name =
        c.properties?.hs_name ?? c.properties?.name ?? "(unnamed campaign)";
      out.push({
        hubspot_id: c.id,
        slug: slugify(name),
        name,
      });
    }

    after = body.paging?.next?.after;
    if (!after) break;
  }
  return out;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "campaign";
}
