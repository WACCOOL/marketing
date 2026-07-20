import { describe, expect, it } from "vitest";
import { composeTools } from "./agent.js";
import { WEB_DOC_TYPES, dispatch, type ThomToolExtension } from "./tools.js";
import type { ClaudeTool } from "./transport.js";
import type { ThomEnv } from "./env.js";
import type { ToolContext } from "./types.js";

const env = (over: Partial<ThomEnv> = {}): ThomEnv => over as ThomEnv;

// A stand-in for the internal-only HubSpot CRM tool set + dispatch. The public
// surface must NEVER advertise or execute any of these.
const crmTool = (name: string): ClaudeTool => ({
  name,
  description: `crm tool ${name}`,
  input_schema: { type: "object", properties: {} },
});
const hubspotExtension: ThomToolExtension = {
  tools: [crmTool("crm_search_companies"), crmTool("crm_top_deals")],
  owns: (name) => name.startsWith("crm_"),
  dispatch: async () => ({ content: "CRM RAN — should never happen on public", cards: [], citations: [] }),
};

describe("composeTools('public')", () => {
  it("never advertises a crm_* tool even when a hubspot extension set is passed", () => {
    const tools = composeTools("public", env(), hubspotExtension.tools);
    expect(tools.some((t) => t.name.startsWith("crm_"))).toBe(false);
    // The public allowlist IS present (retrieval + plan_layout).
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "search_products",
        "get_product",
        "get_related_products",
        "get_family",
        "search_docs",
        "plan_layout",
      ]),
    );
  });

  it("internal DOES advertise the injected extension tools (baseline)", () => {
    const tools = composeTools("internal", env(), hubspotExtension.tools);
    expect(tools.some((t) => t.name === "crm_search_companies")).toBe(true);
  });
});

describe("dispatch on the public surface (defense-in-depth)", () => {
  const ctx = { env: env(), sb: {} } as unknown as ToolContext;

  it("hard-rejects a crm_* tool name — and never calls the extension dispatch", async () => {
    const out = await dispatch(ctx, "crm_top_deals", {}, { surface: "public", extension: hubspotExtension });
    expect(out.content).toContain("not available on this surface");
    expect(out.content).not.toContain("CRM RAN");
    expect(out.cards).toEqual([]);
    expect(out.citations).toEqual([]);
  });

  it("hard-rejects an unknown tool name", async () => {
    const out = await dispatch(ctx, "definitely_not_a_tool", {}, { surface: "public" });
    expect(out.content).toContain("not available on this surface");
  });
});

describe("search_docs scope by surface", () => {
  /** Fake ctx: env.AI.run returns a 1024-d vector so embedQuery succeeds; sb.rpc
   *  captures the args so we can assert the scope + doc_types passed to kb_search. */
  function makeCtx(): { ctx: ToolContext; rpcArgs: () => Record<string, unknown> } {
    let captured: Record<string, unknown> = {};
    const sb = {
      rpc(_fn: string, params: Record<string, unknown>) {
        captured = params;
        return Promise.resolve({ data: [], error: null });
      },
    };
    const aiEnv = env({
      AI: {
        run: async (_m: string, i: { text: string[] }) => ({
          data: i.text.map(() => new Array(1024).fill(0.01)),
        }),
      } as unknown as ThomEnv["AI"],
    });
    return {
      ctx: { env: aiEnv, sb: sb as unknown as ToolContext["sb"] },
      rpcArgs: () => captured,
    };
  }

  it("public passes scope_filter='public' and EXCLUDES zendesk_ticket", async () => {
    const { ctx, rpcArgs } = makeCtx();
    await dispatch(ctx, "search_docs", { query: "cutout size" }, { surface: "public" });
    const args = rpcArgs();
    expect(args.scope_filter).toBe("public");
    expect(args.doc_types).toEqual([
      "spec_sheet",
      "manual",
      "marketing",
      "zendesk_article",
      ...WEB_DOC_TYPES,
    ]);
    expect(args.doc_types).not.toContain("zendesk_ticket");
  });

  it("internal passes scope_filter=null and INCLUDES zendesk_ticket (unchanged)", async () => {
    const { ctx, rpcArgs } = makeCtx();
    await dispatch(ctx, "search_docs", { query: "cutout size" }, { surface: "internal" });
    const args = rpcArgs();
    expect(args.scope_filter).toBeNull();
    expect(args.doc_types).toEqual([
      "spec_sheet",
      "manual",
      "marketing",
      "zendesk_article",
      "zendesk_ticket",
      ...WEB_DOC_TYPES,
    ]);
  });
});
