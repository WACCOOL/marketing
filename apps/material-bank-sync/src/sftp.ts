import SftpClient from "ssh2-sftp-client";

/**
 * SFTP access to Material Bank's drop server. STRICTLY READ-ONLY — this module
 * never writes, moves, or deletes anything on the server. Exactly-once
 * processing is tracked on our side (data_ingestions, source="material-bank").
 *
 * Env: MB_SFTP_HOST, MB_SFTP_PORT (default 22), MB_SFTP_USER, MB_SFTP_PASSWORD,
 *      MB_SFTP_PATH (directory to scan; default "/Outbound").
 *
 * Layout (from the retired Make.com scenario): XML order files land flat under
 * /Outbound/, ISO-8859-1 encoded.
 */

export interface InboundFile {
  /** Path relative to the scan root. */
  path: string;
  name: string;
  size: number;
  /** Server mtime, ms epoch. */
  modifiedAt: number;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}

export function scanRoot(): string {
  return env("MB_SFTP_PATH", "/Outbound").replace(/\/+$/, "");
}

export async function connect(): Promise<SftpClient> {
  const client = new SftpClient();
  await client.connect({
    host: env("MB_SFTP_HOST"),
    port: Number(env("MB_SFTP_PORT", "22")),
    username: env("MB_SFTP_USER"),
    password: env("MB_SFTP_PASSWORD"),
    readyTimeout: 30_000,
  });
  return client;
}

/** List the scan root's XML files, oldest-first by server mtime. */
export async function listInbound(client: SftpClient): Promise<InboundFile[]> {
  const entries = await client.list(scanRoot());
  return entries
    .filter((e) => e.type === "-" && /\.xml$/i.test(e.name))
    .map((e) => ({ path: e.name, name: e.name, size: e.size, modifiedAt: e.modifyTime }))
    .sort((a, b) => a.modifiedAt - b.modifiedAt);
}

export async function download(client: SftpClient, relPath: string): Promise<Buffer> {
  const buf = await client.get(`${scanRoot()}/${relPath}`);
  if (!Buffer.isBuffer(buf)) throw new Error(`sftp get ${relPath}: expected Buffer`);
  return buf;
}
