import SftpClient from "ssh2-sftp-client";

/**
 * SFTP access to the SAP drop server (ExaVault). STRICTLY READ-ONLY — this
 * module never writes, moves, or deletes anything on the server. Exactly-once
 * processing is tracked on our side (data_ingestions), not by moving files.
 *
 * Env: SFTP_HOST, SFTP_PORT (default 22), SFTP_USER, SFTP_PASSWORD,
 *      SFTP_INBOUND_PATH (root to scan; default "/Enable").
 *
 * Observed layout under /Enable (2026-07-07):
 *   Imports/CUSTOMERS-20260707153827.csv          — customer master (has parent col)
 *   Imports/PARENTS-20260707153825.csv            — parents reference
 *   Imports/PRODUCTS-20260707153527.csv           — product master
 *   Integrations/Inbound/TURNOVER-20260707-20260707153838.csv — invoiced-order lines
 *   Integrations/OK/, OK/                         — processed-file archives (theirs)
 * Schonbek will add an "SCH" prefix to its filenames. Files arrive ad hoc
 * (on updates), not on a fixed schedule.
 */

export type FileKind = "turnover" | "customers" | "parents" | "products" | "unknown";

export interface InboundFile {
  /** Path relative to the scan root, e.g. "Integrations/Inbound/TURNOVER-….csv". */
  path: string;
  name: string;
  size: number;
  /** Server mtime, ms epoch. */
  modifiedAt: number;
  kind: FileKind;
  /** "SCH" prefix → Schonbek, else WAC. */
  brand: "WAC" | "SCH";
  /** Timestamp embedded in the filename (yyyymmddhhmmss), for stable ordering;
   * falls back to mtime when the name carries none. */
  orderKey: string;
}

// Observed: WAC TURNOVER-YYYYMMDD-YYYYMMDDHHMMSS.csv; Schonbek uses a full
// range start, SCH_TURNOVER-YYYYMMDDHHMMSS-YYYYMMDDHHMMSS.csv (2026-07-09) —
// hence \d{8,14} for the first segment. CUSTOMERS/PARENTS/PRODUCTS-
// YYYYMMDDHHMMSS.csv for both brands.
const SCH = "(SCH[-_]?)?";
const KIND_RES: [FileKind, RegExp][] = [
  ["turnover", new RegExp(`^${SCH}TURNOVER-(\\d{8,14})-(\\d{14})\\.csv$`, "i")],
  ["customers", new RegExp(`^${SCH}CUSTOMERS?-(\\d{14})\\.csv$`, "i")],
  ["parents", new RegExp(`^${SCH}PARENTS?-(\\d{14})\\.csv$`, "i")],
  ["products", new RegExp(`^${SCH}PRODUCTS?-(\\d{14})\\.csv$`, "i")],
];

export function classify(name: string): { kind: FileKind; timestamp: string | null } {
  for (const [kind, re] of KIND_RES) {
    const m = re.exec(name);
    // The last capture group is always the yyyymmddhhmmss timestamp.
    if (m) return { kind, timestamp: m[m.length - 1] ?? null };
  }
  return { kind: "unknown", timestamp: null };
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}

export function scanRoot(): string {
  return env("SFTP_INBOUND_PATH", "/Enable").replace(/\/+$/, "");
}

export async function connect(): Promise<SftpClient> {
  const client = new SftpClient();
  await client.connect({
    host: env("SFTP_HOST"),
    port: Number(env("SFTP_PORT", "22")),
    username: env("SFTP_USER"),
    password: env("SFTP_PASSWORD"),
    readyTimeout: 30_000,
  });
  return client;
}

const MAX_DEPTH = 4;

// The server keeps its own processed-file archives ("OK" folders) — skip them
// so we never re-ingest something their integration already moved aside.
function skipDir(name: string): boolean {
  return /^ok$/i.test(name);
}

/** Recursively list the scan root (depth-limited, skipping OK/ archives),
 * classified and sorted oldest-first by embedded filename timestamp (falling
 * back to server mtime). */
export async function listInbound(client: SftpClient): Promise<InboundFile[]> {
  const root = scanRoot();
  const out: InboundFile[] = [];

  async function walk(rel: string, depth: number): Promise<void> {
    const abs = rel ? `${root}/${rel}` : root;
    const entries = await client.list(abs);
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.type === "d") {
        if (depth < MAX_DEPTH && !skipDir(e.name)) await walk(relPath, depth + 1);
        continue;
      }
      if (e.type !== "-") continue;
      const { kind, timestamp } = classify(e.name);
      out.push({
        path: relPath,
        name: e.name,
        size: e.size,
        modifiedAt: e.modifyTime,
        kind,
        brand: /^SCH/i.test(e.name) ? "SCH" : "WAC",
        orderKey: timestamp ?? String(e.modifyTime),
      });
    }
  }

  await walk("", 0);
  out.sort((a, b) => a.orderKey.localeCompare(b.orderKey));
  return out;
}

export async function download(client: SftpClient, relPath: string): Promise<Buffer> {
  const buf = await client.get(`${scanRoot()}/${relPath}`);
  if (!Buffer.isBuffer(buf)) throw new Error(`sftp get ${relPath}: expected Buffer`);
  return buf;
}
