import { PutObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * R2 store for crawled pages (S3-compatible API, same env shape as
 * apps/fixture-sync). OPTIONAL: when the R2_* vars are absent the crawl still
 * runs — Step B then re-fetches the live URL instead of reading the cache.
 *
 * Two objects per captured page, keyed by content hash so an unchanged page
 * re-uses its objects: web/{siteKey}/{sha}.html (raw bytes, debugging +
 * reprocessing) and web/{siteKey}/{sha}.txt (the extracted chunkable text
 * Step B actually consumes — kb_documents.r2_key points here).
 */

export interface WebStore {
  putPage(siteKey: string, sha: string, html: string, text: string): Promise<string>;
  getText(key: string): Promise<string | null>;
}

export function webStoreFromEnv(env: NodeJS.ProcessEnv): WebStore | null {
  const endpoint = env.R2_ENDPOINT;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const bucket = env.R2_BUCKET;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return null;
  const s3 = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
  return {
    async putPage(siteKey, sha, html, text) {
      const base = `web/${siteKey}/${sha}`;
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: `${base}.html`, Body: html, ContentType: "text/html; charset=utf-8",
      }));
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: `${base}.txt`, Body: text, ContentType: "text/plain; charset=utf-8",
      }));
      return `${base}.txt`;
    },
    async getText(key) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return (await r.Body?.transformToString()) ?? null;
      } catch {
        return null;
      }
    },
  };
}
