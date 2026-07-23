import { unzipSync } from "fflate";
import type { DrawingAnchor } from "@wac/shared";

/**
 * Browser-side xlsx drawing extraction (plan Stage 2): walk the workbook zip
 * for drawingN.xml anchors (oneCellAnchor/twoCellAnchor from-cells) and the
 * xl/media payloads they reference. SheetJS cannot read drawings, so this is
 * a small fflate + DOMParser lane beside the cell extraction.
 */

export interface XlsxImageExtract {
  /** One entry per placed image, in drawing order. */
  anchors: DrawingAnchor[];
  /** imageId (zip path) → raw bytes, for every referenced media file. */
  media: Map<string, Uint8Array>;
  warnings: string[];
}

const dec = new TextDecoder();

function parseXml(bytes: Uint8Array): Document {
  return new DOMParser().parseFromString(dec.decode(bytes), "application/xml");
}

/** Relationship id → target path from a .rels document. */
function relTargets(doc: Document): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of Array.from(doc.getElementsByTagName("Relationship"))) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) out.set(id, target);
  }
  return out;
}

/** Resolve a rels target ("../media/image1.png", "/xl/foo") under a base dir. */
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

function firstByLocalName(el: Element | Document, name: string): Element | null {
  return el.getElementsByTagNameNS("*", name).item(0);
}

export async function extractXlsxImages(file: File): Promise<XlsxImageExtract> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Only the structural parts + media — the (large) sheet XMLs stay zipped.
  const zip = unzipSync(bytes, {
    filter: (f) =>
      f.name === "xl/workbook.xml" ||
      f.name === "xl/_rels/workbook.xml.rels" ||
      f.name.startsWith("xl/worksheets/_rels/") ||
      f.name.startsWith("xl/drawings/") ||
      f.name.startsWith("xl/media/"),
  });

  const anchors: DrawingAnchor[] = [];
  const media = new Map<string, Uint8Array>();
  const warnings: string[] = [];

  const workbook = zip["xl/workbook.xml"];
  const workbookRels = zip["xl/_rels/workbook.xml.rels"];
  if (!workbook || !workbookRels) return { anchors, media, warnings };

  const wbRels = relTargets(parseXml(workbookRels));
  const sheets = Array.from(
    parseXml(workbook).getElementsByTagNameNS("*", "sheet"),
  );

  for (const sheet of sheets) {
    const sheetName = sheet.getAttribute("name");
    // Qualified-name lookup first; namespace-aware fallback in case a writer
    // used a different prefix for the relationships namespace.
    const rid =
      sheet.getAttribute("r:id") ??
      sheet.getAttributeNS(
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        "id",
      );
    if (!sheetName || !rid) continue;
    const wsTarget = wbRels.get(rid);
    if (!wsTarget) continue;
    const wsPath = resolveTarget("xl", wsTarget);
    const wsBase = wsPath.split("/").pop()!;
    const wsRelsBytes = zip[`xl/worksheets/_rels/${wsBase}.rels`];
    if (!wsRelsBytes) continue;

    const wsRelsDoc = parseXml(wsRelsBytes);
    let drawingPath: string | null = null;
    for (const rel of Array.from(wsRelsDoc.getElementsByTagName("Relationship"))) {
      if ((rel.getAttribute("Type") ?? "").endsWith("/drawing")) {
        drawingPath = resolveTarget("xl/worksheets", rel.getAttribute("Target") ?? "");
        break;
      }
    }
    if (!drawingPath || !zip[drawingPath]) continue;

    const drawBase = drawingPath.split("/").pop()!;
    const drawRelsBytes = zip[`xl/drawings/_rels/${drawBase}.rels`];
    const drawRels = drawRelsBytes ? relTargets(parseXml(drawRelsBytes)) : new Map<string, string>();
    const drawDoc = parseXml(zip[drawingPath]!);

    const anchorEls = [
      ...Array.from(drawDoc.getElementsByTagNameNS("*", "twoCellAnchor")),
      ...Array.from(drawDoc.getElementsByTagNameNS("*", "oneCellAnchor")),
    ];
    for (const anchorEl of anchorEls) {
      const from = firstByLocalName(anchorEl, "from");
      if (!from) continue;
      const row = parseInt(firstByLocalName(from, "row")?.textContent ?? "", 10);
      const col = parseInt(firstByLocalName(from, "col")?.textContent ?? "", 10);
      if (Number.isNaN(row) || Number.isNaN(col)) continue;
      const blip = firstByLocalName(anchorEl, "blip");
      const embed =
        blip?.getAttribute("r:embed") ??
        blip?.getAttributeNS(
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
          "embed",
        );
      if (!embed) continue;
      const target = drawRels.get(embed);
      if (!target) continue;
      const imageId = resolveTarget("xl/drawings", target);
      const payload = zip[imageId];
      if (!payload) {
        warnings.push(`image "${imageId}" referenced by ${sheetName} is missing from the workbook`);
        continue;
      }
      media.set(imageId, payload);
      anchors.push({ sheet: sheetName, row, col, imageId });
    }
  }

  return { anchors, media, warnings };
}
