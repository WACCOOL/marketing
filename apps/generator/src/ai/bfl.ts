/**
 * Black Forest Labs adapter — FLUX.1 Fill (masked inpainting), Phase 2d.
 *
 * FLUX.1 Fill accepts ONLY image + mask + prompt (plus sampling knobs). It has
 * no reference-image parameter, which is fine for Option C: the deterministic
 * composite has already placed the real fixture, the mask's black core preserves
 * those pixels, and Fill only paints integrated lighting/shadow/glow in the
 * white halo from the prompt.
 *
 * BFL is async: the submit call returns `{ id, polling_url }`. We MUST poll the
 * returned `polling_url` (not a hand-built URL). The delivery `result.sample`
 * URL expires (~10 min) and has no CORS, so we download it immediately and
 * return the bytes as a Buffer.
 */

import { fetchWithTimeout, type InpaintAdapter, type InpaintRequest } from "./adapter.js";

const DEFAULT_BASE_URL = "https://api.bfl.ai";
const DEFAULT_FILL_PATH = "/v1/flux-pro-1.0-fill";

const SUBMIT_TIMEOUT_MS = 15_000;
const POLL_REQUEST_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 20_000;
/** Total wall-clock budget for one inpaint (submit + polling + download). */
const TOTAL_BUDGET_MS = 60_000;
const POLL_INTERVAL_MS = 1_500;

export interface BflConfig {
  apiKey: string;
  /** Override the API host (tests / future regions). */
  baseUrl?: string;
  /** Override the model path (e.g. a newer Fill variant). */
  fillPath?: string;
}

interface SubmitResponse {
  id?: string;
  polling_url?: string;
}

interface PollResponse {
  status?: string;
  result?: { sample?: string } | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function makeBflAdapter(config: BflConfig): InpaintAdapter {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fillPath = config.fillPath ?? DEFAULT_FILL_PATH;
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "x-key": config.apiKey,
  };

  async function submit(req: InpaintRequest): Promise<string> {
    const body: Record<string, unknown> = {
      image: req.image.toString("base64"),
      mask: req.mask.toString("base64"),
      prompt: req.prompt,
      output_format: "png",
    };
    if (req.steps !== undefined) body.steps = req.steps;
    if (req.guidance !== undefined) body.guidance = req.guidance;
    if (req.seed !== undefined) body.seed = req.seed;

    const res = await fetchWithTimeout(
      "BFL Fill submit",
      `${baseUrl}${fillPath}`,
      { method: "POST", headers, body: JSON.stringify(body) },
      SUBMIT_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new Error(
        `BFL Fill submit failed ${res.status}: ${await res.text().catch(() => "")}`,
      );
    }
    const data = (await res.json()) as SubmitResponse;
    if (!data.polling_url) {
      throw new Error("BFL Fill submit returned no polling_url");
    }
    return data.polling_url;
  }

  async function pollForSample(pollingUrl: string, deadline: number): Promise<string> {
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`BFL Fill polling exceeded ${TOTAL_BUDGET_MS}ms budget`);
      }

      const res = await fetchWithTimeout(
        "BFL Fill poll",
        pollingUrl,
        { method: "GET", headers },
        POLL_REQUEST_TIMEOUT_MS,
      );
      if (!res.ok) {
        throw new Error(
          `BFL Fill poll failed ${res.status}: ${await res.text().catch(() => "")}`,
        );
      }
      const data = (await res.json()) as PollResponse;
      const status = data.status ?? "";

      if (status === "Ready") {
        const sample = data.result?.sample;
        if (!sample) throw new Error("BFL Fill ready but no result.sample URL");
        return sample;
      }
      if (status === "Pending" || status === "Queued" || status === "Processing") {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      // Any other status (Error, *Moderated, Task not found, ...) is terminal.
      throw new Error(`BFL Fill did not succeed (status: ${status || "unknown"})`);
    }
  }

  async function download(sampleUrl: string): Promise<Buffer> {
    // The delivery URL is short-lived (~10 min) and CORS-less — fetch it now.
    const res = await fetchWithTimeout(
      "BFL Fill download",
      sampleUrl,
      { method: "GET" },
      DOWNLOAD_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new Error(`BFL Fill result download failed ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  return {
    provider: "bfl-flux1-fill",
    async inpaint(req: InpaintRequest): Promise<Buffer> {
      const deadline = Date.now() + TOTAL_BUDGET_MS;
      const pollingUrl = await submit(req);
      const sampleUrl = await pollForSample(pollingUrl, deadline);
      return download(sampleUrl);
    },
  };
}
