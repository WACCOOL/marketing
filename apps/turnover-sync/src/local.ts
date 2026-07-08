import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { classify, type InboundFile } from "./sftp.js";

/**
 * Local-file ingress (--local) for backfills: build the same InboundFile work
 * list the SFTP scan produces, from a directory (or single file) on disk.
 * Filenames must match the canonical SFTP patterns
 * (TURNOVER-YYYYMMDD-YYYYMMDDHHMMSS.csv etc.) so classification, brand, and
 * oldest-first ordering behave identically — and the exactly-once
 * data_ingestions gate applies to these names the same way it does to files
 * that arrived over SFTP.
 */

export interface LocalFile extends InboundFile {
  /** Absolute path on disk (`path`/`name` mirror the SFTP shape). */
  absPath: string;
}

export function toLocalFile(absPath: string, size: number, modifiedAt: number): LocalFile {
  const name = basename(absPath);
  const { kind, timestamp } = classify(name);
  return {
    path: name,
    name,
    size,
    modifiedAt,
    kind,
    brand: /^SCH/i.test(name) ? "SCH" : "WAC",
    orderKey: timestamp ?? String(modifiedAt),
    absPath,
  };
}

/** List a local file or directory (non-recursive), classified and sorted
 * oldest-first by embedded filename timestamp — mirrors listInbound. */
export async function listLocal(target: string): Promise<LocalFile[]> {
  const root = await stat(target);
  const paths = root.isDirectory() ? (await readdir(target)).map((n) => join(target, n)) : [target];
  const out: LocalFile[] = [];
  for (const p of paths) {
    const s = await stat(p);
    if (!s.isFile()) continue;
    out.push(toLocalFile(p, s.size, s.mtimeMs));
  }
  out.sort((a, b) => a.orderKey.localeCompare(b.orderKey));
  return out;
}
