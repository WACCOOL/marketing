// =============================================================================
// PERMANENT PUBLIC-BOUNDARY GUARD for the public Thom bot.
//
// The public Thom worker reads Supabase as the ANON role (anon key, no JWT).
// This test pins the exact catalog surface anon may read and — just as
// importantly — the internal surface it must NOT. Run it AFTER applying
// supabase/migrations/0052_thom_public_catalog.sql against the target DB.
//
// It needs a LIVE database with 0052 applied, so it SKIPS cleanly when
// SUPABASE_URL + SUPABASE_ANON_KEY are absent (CI / local without creds stays
// green) and RUNS + enforces when they are present.
//
//   Run against a live DB:
//     SUPABASE_URL=... SUPABASE_ANON_KEY=... pnpm --filter @wac/api test anonBoundary
//
// If any assertion here fails, the public/internal boundary has regressed —
// treat it as a security incident, not a flaky test.
// =============================================================================
import { describe, it, expect } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const HAVE_CREDS = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// A throwaway 1024-dim query vector (matches @cf/baai/bge-m3 / the kb_chunks +
// products embedding dimension). Value is irrelevant — we assert on access, not
// ranking.
const QUERY_EMBEDDING = Array.from({ length: 1024 }, () => 0.01);

// An ANON client: anon key, NO Authorization header — exactly the public bot.
function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL as string, SUPABASE_ANON_KEY as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

describe.skipIf(!HAVE_CREDS)("Thom public anon boundary (0052)", () => {
  const sb = HAVE_CREDS ? anonClient() : (null as unknown as SupabaseClient);

  // ---------------------------------------------------------------------------
  // Anon CAN read the public catalog.
  // ---------------------------------------------------------------------------
  it("reads the products whitelist columns", async () => {
    const { data, error } = await sb
      .from("products")
      .select(
        "id,sku,name,brand,category,family,is_accessory,dimensions_mm,primary_image_url,image_urls,ies_url,variants",
      )
      .limit(5);
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    // Catalog is populated in every real environment 0052 is applied against.
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it("runs product_semantic_search", async () => {
    const { data, error } = await sb.rpc("product_semantic_search", {
      query_embedding: QUERY_EMBEDDING,
      query_text: "downlight",
      match_count: 5,
    });
    // The boundary property is: no permission error for anon. (Row count depends
    // on the products.embedding backfill, so we don't require > 0 here.)
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });

  it("runs kb_search scoped to public and returns NO zendesk_ticket rows", async () => {
    const { data, error } = await sb.rpc("kb_search", {
      query_embedding: QUERY_EMBEDDING,
      query_text: "warranty",
      scope_filter: "public",
      match_count: 8,
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as { doc_type: string }[];
    // Zendesk tickets are internal; they must never surface on the public scope.
    expect(rows.some((r) => r.doc_type === "zendesk_ticket")).toBe(false);
  });

  it("reads pdp_urls", async () => {
    const { error } = await sb.from("pdp_urls").select("sku,brand,url").limit(1);
    expect(error).toBeNull();
  });

  it("reads track_systems and track_components", async () => {
    const sys = await sb.from("track_systems").select("key,label").limit(1);
    expect(sys.error).toBeNull();
    const comp = await sb
      .from("track_components")
      .select("id,system_key,role,sku")
      .limit(1);
    expect(comp.error).toBeNull();
  });

  it("reads product_accessories (0061: open read, service-role writes)", async () => {
    const { error } = await sb
      .from("product_accessories")
      .select("product_sku,related_sku,related_product_sku,kind,label")
      .limit(1);
    expect(error).toBeNull();
  });

  it("reads product_photometrics and ies_metrics", async () => {
    const pp = await sb
      .from("product_photometrics")
      .select("id,product_sku,ies_url")
      .limit(1);
    expect(pp.error).toBeNull();
    const ies = await sb.from("ies_metrics").select("id,content_hash").limit(1);
    expect(ies.error).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Anon CANNOT read the sensitive/internal surface.
  // ---------------------------------------------------------------------------

  // A column-level grant means selecting a non-whitelisted products column is a
  // hard permission error (Postgres 42501 "permission denied for column"), not
  // an empty result. Assert the error for each excluded column.
  for (const col of ["raw_json", "sl_id", "variant_search"]) {
    it(`is denied the products.${col} column`, async () => {
      const { data, error } = await sb.from("products").select(col).limit(1);
      expect(error).not.toBeNull();
      expect(data).toBeNull();
    });
  }

  it("cannot read pricing", async () => {
    // is_admin() RLS: anon gets an empty set (or an outright denial). Either way
    // no pricing row may reach anon.
    const { data, error } = await sb.from("pricing").select("sku,price").limit(1);
    expect(error !== null || (data ?? []).length === 0).toBe(true);
  });

  it("cannot read internal-scoped kb_chunks", async () => {
    const { data, error } = await sb
      .from("kb_chunks")
      .select("id,scope")
      .eq("scope", "internal")
      .limit(1);
    // RLS filters internal rows out for anon → empty (no error).
    expect(error !== null || (data ?? []).length === 0).toBe(true);
  });

  it("cannot read CRM / orders or Thom conversation history", async () => {
    for (const table of [
      "open_orders",
      "thom_conversations",
      "thom_messages",
    ]) {
      const { data, error } = await sb.from(table).select("*").limit(1);
      expect(
        error !== null || (data ?? []).length === 0,
        `anon must not read ${table}`,
      ).toBe(true);
    }
  });

  it("cannot read OR write thom_feedback (0062: admin select, service write)", async () => {
    // Select: RLS admin-only → anon gets nothing (empty set or denial).
    const read = await sb.from("thom_feedback").select("*").limit(1);
    expect(
      read.error !== null || (read.data ?? []).length === 0,
      "anon must not read thom_feedback",
    ).toBe(true);

    // Insert: there is NO insert policy at all — anon must be denied. The
    // public worker never touches this table directly; it rides the
    // shared-secret log bridge.
    const write = await sb.from("thom_feedback").insert({
      surface: "public",
      dedup_key: `probe:anon-boundary:${Date.now()}`,
      rating: 1,
      question_text: "anon boundary probe",
      answer_text: "anon boundary probe",
    });
    expect(write.error, "anon must not insert into thom_feedback").not.toBeNull();
  });
});
