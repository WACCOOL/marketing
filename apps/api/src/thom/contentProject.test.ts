import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import {
  buildChunkRows,
  buildKbDocumentPayload,
  projectMarketingContent,
  sha256Hex,
  type MarketingContentRow,
} from "./contentProject.js";

const row = (over: Partial<MarketingContentRow> = {}): MarketingContentRow => ({
  id: "row-1",
  title: "AiSpire overview",
  brand: "AiSpire",
  scope: "internal",
  body: "AiSpire is our trimless architectural line.",
  status: "published",
  ...over,
});

// --- pure helpers -----------------------------------------------------------

describe("sha256Hex", () => {
  it("is stable for the same input", async () => {
    expect(await sha256Hex("hello")).toBe(await sha256Hex("hello"));
  });
  it("changes when the input changes", async () => {
    expect(await sha256Hex("hello")).not.toBe(await sha256Hex("hello!"));
  });
  it("returns a 64-char hex digest", async () => {
    expect(await sha256Hex("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildKbDocumentPayload", () => {
  it("keys on marketing_admin + row id, marketing doc_type, no url", () => {
    const p = buildKbDocumentPayload(row(), "abc", "pending_extract");
    expect(p).toMatchObject({
      source_system: "marketing_admin",
      external_id: "row-1",
      doc_type: "marketing",
      scope: "internal",
      brand: "AiSpire",
      title: "AiSpire overview",
      url: null,
      content_hash: "abc",
      status: "pending_extract",
    });
  });
});

describe("buildChunkRows", () => {
  it("denormalizes scope/doc_type/brand and pairs each chunk with its vector", () => {
    const rows = buildChunkRows(
      "doc-9",
      row({ scope: "public", brand: null }),
      [
        { index: 0, content: "a" },
        { index: 1, content: "b" },
      ],
      ["[1]", "[2]"],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      document_id: "doc-9",
      scope: "public",
      doc_type: "marketing",
      brand: null,
      chunk_index: 0,
      page: null,
      content: "a",
      embedding: "[1]",
    });
    expect(rows[1]).toMatchObject({ chunk_index: 1, content: "b", embedding: "[2]" });
  });
});

// --- projection with a mock Supabase + env.AI -------------------------------

interface MockOpts {
  existing?: { id?: string; content_hash: string; status: string } | null;
  docId?: string;
  embedThrows?: boolean;
}

interface Recorder {
  chunkInserts: unknown[][];
  chunkDeletes: number;
  docUpdates: Record<string, unknown>[];
  upsertStatus: string | null;
}

function makeSb(opts: MockOpts): { sb: SupabaseClient; rec: Recorder } {
  const rec: Recorder = { chunkInserts: [], chunkDeletes: 0, docUpdates: [], upsertStatus: null };

  function builder(table: string) {
    let op: string | null = null;
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      upsert: (payload: { status?: string }) => {
        op = "upsert";
        rec.upsertStatus = payload?.status ?? null;
        return b;
      },
      insert: (rows: unknown[]) => {
        if (table === "kb_chunks") rec.chunkInserts.push(rows);
        op = "insert";
        return b;
      },
      update: (vals: Record<string, unknown>) => {
        if (table === "kb_documents") rec.docUpdates.push(vals);
        op = "update";
        return b;
      },
      delete: () => {
        if (table === "kb_chunks") rec.chunkDeletes++;
        op = "delete";
        return b;
      },
      maybeSingle: () => {
        if (table === "kb_documents") {
          return Promise.resolve({ data: opts.existing ?? null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      single: () => {
        if (table === "kb_documents" && op === "upsert") {
          return Promise.resolve({ data: { id: opts.docId ?? "doc-1" }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      // terminal awaits (delete/insert/update chains)
      then: (resolve: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(resolve),
    };
    return b;
  }

  return { sb: { from: builder } as unknown as SupabaseClient, rec };
}

function makeEnv(embedThrows = false): Env {
  return {
    AI: {
      run: async (_m: string, i: { text: string[] }) => {
        if (embedThrows) throw new Error("Workers AI down");
        return { data: i.text.map(() => new Array(1024).fill(0.01)) };
      },
    },
  } as unknown as Env;
}

describe("projectMarketingContent", () => {
  it("draft: removes chunks and parks the doc as superseded (never active)", async () => {
    const { sb, rec } = makeSb({});
    const res = await projectMarketingContent(makeEnv(), sb, row({ status: "draft" }));
    expect(res.status).toBe("superseded");
    expect(rec.upsertStatus).toBe("superseded");
    expect(rec.chunkDeletes).toBe(1);
    expect(rec.chunkInserts).toHaveLength(0);
  });

  it("published + new: embeds, inserts chunks, flips status to active", async () => {
    const { sb, rec } = makeSb({ existing: null });
    const res = await projectMarketingContent(makeEnv(), sb, row());
    expect(res.status).toBe("active");
    expect(res.chunks).toBeGreaterThan(0);
    expect(rec.chunkInserts).toHaveLength(1);
    expect(rec.docUpdates.some((u) => u.status === "active")).toBe(true);
  });

  it("published + unchanged + already active: no re-embed", async () => {
    const r = row();
    const hash = await sha256Hex(r.body);
    const { sb, rec } = makeSb({ existing: { content_hash: hash, status: "active" } });
    const res = await projectMarketingContent(makeEnv(), sb, r);
    expect(res).toEqual({ status: "active", chunks: 0 });
    expect(rec.chunkInserts).toHaveLength(0);
    // Upsert kept it active rather than knocking it back to pending.
    expect(rec.upsertStatus).toBe("active");
  });

  it("published + forced: re-embeds even when unchanged", async () => {
    const r = row();
    const hash = await sha256Hex(r.body);
    const { sb, rec } = makeSb({ existing: { content_hash: hash, status: "active" } });
    const res = await projectMarketingContent(makeEnv(), sb, r, true);
    expect(res.status).toBe("active");
    expect(rec.chunkInserts).toHaveLength(1);
  });

  it("inline embed failure: leaves the doc pending_extract and does NOT throw", async () => {
    const { sb, rec } = makeSb({ existing: null });
    const res = await projectMarketingContent(makeEnv(true), sb, row());
    expect(res.status).toBe("pending_extract");
    expect(rec.chunkInserts).toHaveLength(0);
    // The upsert already parked it pending for the docs-ingest fallback.
    expect(rec.upsertStatus).toBe("pending_extract");
  });
});
