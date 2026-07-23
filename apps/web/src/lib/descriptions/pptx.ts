import { unzipSync } from "fflate";
import type { PptxSlideInput } from "@wac/shared";

/**
 * Browser-side pptx extraction (plan Stage 2): slide paragraph texts (runs
 * joined per <a:p>, entities decoded by DOMParser) plus the media images each
 * slide places, in blip order. The shared parsePptxSlides consumes the
 * paragraphs; media bytes get downscaled + uploaded separately.
 */

export interface PptxExtract {
  slides: PptxSlideInput[];
  /** imageId (zip path, e.g. "ppt/media/image9.png") → raw bytes. */
  media: Map<string, Uint8Array>;
}

const dec = new TextDecoder();
const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function resolveTarget(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = `${baseDir}/${target}`.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("/");
}

export async function extractPptxSlides(file: File): Promise<PptxExtract> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const zip = unzipSync(bytes, {
    filter: (f) =>
      SLIDE_RE.test(f.name) ||
      f.name.startsWith("ppt/slides/_rels/") ||
      f.name.startsWith("ppt/media/"),
  });

  const slideNumbers = Object.keys(zip)
    .map((name) => SLIDE_RE.exec(name)?.[1])
    .filter((n): n is string => !!n)
    .map((n) => parseInt(n, 10))
    .sort((a, b) => a - b);

  const slides: PptxSlideInput[] = [];
  const media = new Map<string, Uint8Array>();

  for (const index of slideNumbers) {
    const xmlBytes = zip[`ppt/slides/slide${index}.xml`];
    if (!xmlBytes) continue;
    const doc = new DOMParser().parseFromString(dec.decode(xmlBytes), "application/xml");

    // Paragraph texts: join the <a:t> runs inside each <a:p>.
    const paragraphs: string[] = [];
    for (const p of Array.from(doc.getElementsByTagNameNS("*", "p"))) {
      let text = "";
      for (const t of Array.from(p.getElementsByTagNameNS("*", "t"))) {
        text += t.textContent ?? "";
      }
      const trimmed = text.trim();
      if (trimmed) paragraphs.push(trimmed);
    }

    // Slide rels: rId → media path.
    const relBytes = zip[`ppt/slides/_rels/slide${index}.xml.rels`];
    const rels = new Map<string, string>();
    if (relBytes) {
      const relDoc = new DOMParser().parseFromString(dec.decode(relBytes), "application/xml");
      for (const rel of Array.from(relDoc.getElementsByTagName("Relationship"))) {
        const id = rel.getAttribute("Id");
        const target = rel.getAttribute("Target");
        if (id && target && target.includes("media/")) {
          rels.set(id, resolveTarget("ppt/slides", target));
        }
      }
    }

    // Placed images in blip (placement) order, deduplicated.
    const imageIds: string[] = [];
    for (const blip of Array.from(doc.getElementsByTagNameNS("*", "blip"))) {
      const embed = blip.getAttribute("r:embed") ?? blip.getAttributeNS(REL_NS, "embed");
      if (!embed) continue;
      const target = rels.get(embed);
      if (!target || !zip[target]) continue;
      if (!imageIds.includes(target)) {
        imageIds.push(target);
        media.set(target, zip[target]!);
      }
    }

    slides.push({ index, paragraphs, imageIds });
  }

  return { slides, media };
}
