#!/usr/bin/env node
/**
 * Quality + cost gate for the cloud render-worker.
 *
 * Sends a render job to a running worker (local OR the Modal URL), times it,
 * estimates the GPU cost, saves the output PNG, and — if you pass the CG team's
 * reference image — reports a pixel diff and writes a visual difference map. Use
 * it to confirm the Modal L40S/OptiX output matches the studio's render.st
 * output before cutover.
 *
 * Run from the package dir so `sharp` resolves:
 *   cd apps/render-worker
 *   node scripts/benchmark.mjs \
 *     --url https://<workspace>--wac-render-worker-worker.modal.run \
 *     --endpoint /composite \
 *     --job ./scripts/sample-job.json \
 *     --out /tmp/cloud.png \
 *     --ref /path/to/renderst-reference.png \
 *     --diff /tmp/diff.png
 *
 * The job JSON is the same body the endpoint already accepts (modelUrl, sku,
 * pose, samples, width/height, highQuality, etc. — see src/server.ts). For a
 * faithful parity test, point modelUrl at the CG team's reference .blend and use
 * their settings (1000 spp, 4000x4000, highQuality: true).
 */
import http from "node:http";
import https from "node:https";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

// L40S on Modal, per-second (≈ $1.95/hr) — for a rough cost estimate.
const L40S_USD_PER_SEC = 0.000542;
const MAX_REDIRECTS = 50;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** POST/GET with no response timeout, following Modal's 303 redirects. */
function request(urlStr, { method = "GET", headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const followFrom = (current, m, b) => {
      let url;
      try {
        url = new URL(current);
      } catch {
        return reject(new Error(`invalid url ${current}`));
      }
      const mod = url.protocol === "https:" ? https : http;
      const req = mod.request(url, { method: m, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            const next = new URL(res.headers.location, current).toString();
            const isPreserve = status === 307 || status === 308;
            return resolve({ redirect: next, m: isPreserve ? m : "GET", b: isPreserve ? b : undefined });
          }
          resolve({ status, buffer: Buffer.concat(chunks) });
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      if (b) req.write(b);
      req.end();
    };

    (async () => {
      let cur = urlStr;
      let m = method;
      let b = body;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const out = await new Promise((res, rej) => {
          const orig = followFrom(cur, m, b);
          orig.then(res, rej);
        });
        if (out.redirect) {
          cur = out.redirect;
          m = out.m;
          b = out.b;
          continue;
        }
        return resolve(out);
      }
      reject(new Error(`exceeded ${MAX_REDIRECTS} redirects`));
    })().catch(reject);
  });
}

/** Mean / max absolute per-channel difference between two images (0..255). */
async function diff(aPath, bPath, outPath) {
  const meta = await sharp(aPath).metadata();
  const w = meta.width ?? 1024;
  const h = meta.height ?? 1024;
  const toRaw = (p) =>
    sharp(p).resize(w, h, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const [a, b] = await Promise.all([toRaw(aPath), toRaw(bPath)]);
  const out = Buffer.alloc(a.length);
  let sum = 0;
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    out[i] = d;
    sum += d;
    if (d > max) max = d;
  }
  const mean = sum / a.length;
  if (outPath) {
    await sharp(out, { raw: { width: w, height: h, channels: 3 } }).png().toFile(outPath);
  }
  return { mean, max, meanPct: (mean / 255) * 100, maxPct: (max / 255) * 100 };
}

async function main() {
  const url = arg("url");
  if (!url) throw new Error("missing --url <worker base url>");
  const endpoint = arg("endpoint", "/composite");
  const jobPath = arg("job");
  if (!jobPath) throw new Error("missing --job <path to job.json>");
  const outPath = arg("out", "/tmp/cloud-render.png");
  const refPath = arg("ref");
  const diffPath = arg("diff", refPath ? "/tmp/cloud-diff.png" : undefined);

  const jobBody = readFileSync(jobPath, "utf8");
  const target = `${url.replace(/\/$/, "")}${endpoint}`;
  console.log(`POST ${target}`);

  const t0 = Date.now();
  const res = await request(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: jobBody,
  });
  const elapsedSec = (Date.now() - t0) / 1000;

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`worker returned ${res.status}: ${res.buffer.toString("utf8").slice(0, 500)}`);
  }

  // /render-fixture returns raw PNG; /composite returns a base64 JSON manifest.
  if (endpoint.includes("render-fixture")) {
    writeFileSync(outPath, res.buffer);
  } else {
    const body = JSON.parse(res.buffer.toString("utf8"));
    if (!body.ok || !body.png) throw new Error(`no image in response: ${body.error ?? "unknown"}`);
    writeFileSync(outPath, Buffer.from(body.png, "base64"));
  }

  const meta = await sharp(outPath).metadata();
  console.log(`\nRender OK`);
  console.log(`  output:   ${outPath} (${meta.width}x${meta.height})`);
  console.log(`  time:     ${elapsedSec.toFixed(1)}s`);
  console.log(`  est cost: $${(elapsedSec * L40S_USD_PER_SEC).toFixed(3)} (L40S @ $1.95/hr)`);

  if (refPath) {
    const d = await diff(outPath, refPath, diffPath);
    console.log(`\nParity vs ${refPath}`);
    console.log(`  mean diff: ${d.mean.toFixed(2)}/255 (${d.meanPct.toFixed(2)}%)`);
    console.log(`  max  diff: ${d.max.toFixed(0)}/255 (${d.maxPct.toFixed(1)}%)`);
    if (diffPath) console.log(`  diff map:  ${diffPath}`);
    console.log(
      d.meanPct < 1
        ? "  -> PASS: near-identical (expected on same card/backend/version)."
        : "  -> REVIEW: inspect the diff map; check denoiser/view-transform/samples.",
    );
  }
}

main().catch((e) => {
  console.error(`benchmark failed: ${e.message}`);
  process.exit(1);
});
