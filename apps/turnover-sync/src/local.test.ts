import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listLocal, toLocalFile } from "./local.js";

describe("toLocalFile", () => {
  it("classifies canonical turnover names with brand and orderKey", () => {
    const f = toLocalFile("/x/TURNOVER-20240331-20240331000000.csv", 10, 1);
    expect(f.kind).toBe("turnover");
    expect(f.brand).toBe("WAC");
    expect(f.orderKey).toBe("20240331000000");
    expect(f.name).toBe("TURNOVER-20240331-20240331000000.csv");
    expect(f.absPath).toBe("/x/TURNOVER-20240331-20240331000000.csv");
  });

  it("classifies SCH-prefixed names as Schonbek", () => {
    const f = toLocalFile("/x/SCH-TURNOVER-20260101-20260101120000.csv", 10, 1);
    expect(f.kind).toBe("turnover");
    expect(f.brand).toBe("SCH");
  });

  it("marks non-matching names unknown and falls back to mtime ordering", () => {
    const f = toLocalFile("/x/TURNOVER-202401.csv", 10, 1234);
    expect(f.kind).toBe("unknown");
    expect(f.orderKey).toBe("1234");
  });
});

describe("listLocal", () => {
  it("lists a directory oldest-first by filename timestamp, skipping subdirs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "turnover-local-"));
    await writeFile(join(dir, "TURNOVER-20250630-20250630000000.csv"), "b");
    await writeFile(join(dir, "TURNOVER-20240331-20240331000000.csv"), "a");
    await mkdir(join(dir, "OK"));
    const files = await listLocal(dir);
    expect(files.map((f) => f.name)).toEqual([
      "TURNOVER-20240331-20240331000000.csv",
      "TURNOVER-20250630-20250630000000.csv",
    ]);
    expect(files.every((f) => f.kind === "turnover")).toBe(true);
  });

  it("accepts a single file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "turnover-local-"));
    const p = join(dir, "TURNOVER-20241231-20241231000000.csv");
    await writeFile(p, "x");
    const files = await listLocal(p);
    expect(files).toHaveLength(1);
    expect(files[0]!.absPath).toBe(p);
  });
});
