/**
 * Pure DOM builders for the structured cards + citations Thom emits. These are a
 * faithful, framework-free reimplementation of the render logic in
 * apps/web/src/pages/ThomChat.tsx (CardView / FamilyCardView / LayoutCardView /
 * LayoutPlanSvg / citations) against the shared Card/Citation types. No React,
 * no innerHTML for model-supplied strings.
 */
import { el, svgEl, extLink } from "./dom.js";
import type {
  Card,
  Citation,
  ProductCard,
  FamilyCard,
  LayoutCard,
  PhotometricsCard,
} from "./types.js";

/** Render one card of any kind. Cards logged before the `kind` field default to
 *  the product view (matches the internal UI). */
export function renderCard(card: Card): HTMLElement {
  switch (card.kind) {
    case "layout":
      return layoutCard(card);
    case "family":
      return familyCard(card);
    case "photometrics":
      return photometricsCard(card);
    default:
      return productCard(card as ProductCard);
  }
}

function productCard(card: ProductCard): HTMLElement {
  const body = el("div", { class: "thom-card-body" }, [
    el("div", { class: "thom-card-head" }, [
      el("strong", { text: card.name ?? card.sku }),
      el("span", { class: "thom-muted" }, [card.sku + (card.brand ? ` · ${card.brand}` : "")]),
    ]),
    card.key_specs.length
      ? el(
          "ul",
          { class: "thom-specs" },
          card.key_specs.map((s) =>
            el("li", {}, [el("span", { class: "thom-muted", text: s.label }), " " + s.value]),
          ),
        )
      : null,
    el("div", { class: "thom-card-links" }, [
      card.pdp_url ? extLink(card.pdp_url, { class: "thom-chip" }, ["↗ View product"]) : null,
      ...card.downloads.map((d) => extLink(d.url, { class: "thom-chip" }, ["⭳ " + d.label])),
    ]),
  ]);
  return el("div", { class: "thom-card" }, [
    card.image_url ? el("img", { class: "thom-card-img", src: card.image_url, alt: card.name ?? card.sku, loading: "lazy" }) : null,
    body,
  ]);
}

function familyCard(card: FamilyCard): HTMLElement {
  const extra = card.member_count - card.members.length;
  const subhead = [card.brand, card.category].filter(Boolean).join(" · ");
  const members = card.members.map((m) => {
    const label: (Node | string)[] = [el("strong", { text: m.sku })];
    if (m.name) label.push(` · ${m.name}`);
    if (m.role) label.push(el("span", { class: "thom-muted", text: ` · ${m.role}` }));
    return m.pdp_url
      ? extLink(m.pdp_url, { class: "thom-family-member" }, label)
      : el("span", { class: "thom-family-member" }, label);
  });
  if (extra > 0) members.push(el("span", { class: "thom-family-more thom-muted", text: `+${extra} more` }));

  return el("div", { class: "thom-card thom-family-card" }, [
    card.image_url ? el("img", { class: "thom-card-img", src: card.image_url, alt: card.family, loading: "lazy" }) : null,
    el("div", { class: "thom-card-body" }, [
      el("div", { class: "thom-card-head" }, [
        el("strong", { text: `▧ ${card.family}` }),
        el("span", {
          class: "thom-muted",
          text: `System${subhead ? ` · ${subhead}` : ""} · ${card.member_count} component${card.member_count === 1 ? "" : "s"}`,
        }),
      ]),
      el("div", { class: "thom-family-members" }, members),
    ]),
  ]);
}

function photometricsCard(card: PhotometricsCard): HTMLElement {
  return el("div", { class: "thom-card thom-photometrics-card" }, [
    el("div", { class: "thom-card-body" }, [
      el("div", { class: "thom-card-head" }, [
        el("strong", { text: `Photometrics · ${card.sku}` }),
        card.source_filename ? el("span", { class: "thom-muted", text: card.source_filename }) : null,
      ]),
      el("p", { class: "thom-layout-note thom-muted", text: "IES-derived metrics. See the linked spec sheet for the full distribution." }),
    ]),
  ]);
}

function layoutCard(card: LayoutCard): HTMLElement {
  const s = card.summary;
  const title = card.product.name ?? card.product.sku ?? card.product.family ?? "Layout";
  const kindLabel =
    card.layoutKind === "track" ? "Track layout" : card.layoutKind === "linear" ? "Linear layout" : "Grid layout";

  const chips: { label: string; value: string }[] = [];
  if (s.headCount > 0) chips.push({ label: "Heads", value: String(s.headCount) });
  if (s.runs != null && s.headsPerRun != null) chips.push({ label: "Layout", value: `${s.runs} run × ${s.headsPerRun}` });
  if (s.headSpacingFt != null) chips.push({ label: "Spacing", value: `${s.headSpacingFt.toFixed(1)} ft` });
  if (s.totalTrackFt != null && s.totalTrackFt > 0) chips.push({ label: "Track", value: `${s.totalTrackFt.toFixed(0)} ft` });
  if (s.avgFc > 0) chips.push({ label: "Avg", value: `${s.avgFc.toFixed(1)} fc` });
  if (s.uniformity > 0) chips.push({ label: "Avg:min", value: s.uniformity.toFixed(2) });
  if (s.totalWatts > 0) chips.push({ label: "Watts", value: `${s.totalWatts.toFixed(0)} W` });
  if (s.circuits != null) chips.push({ label: "Circuits", value: String(s.circuits) });
  if (s.transformerCount != null && s.transformerCount > 0)
    chips.push({ label: "Transformers", value: String(s.transformerCount) });

  // BOM grouped by role.
  const groups = new Map<string, LayoutCard["bom"]["lines"]>();
  for (const l of card.bom.lines) {
    const g = groups.get(l.role) ?? [];
    g.push(l);
    groups.set(l.role, g);
  }
  const bomRows: HTMLElement[] = [];
  for (const [role, lines] of groups) {
    bomRows.push(el("tr", { class: "thom-layout-bom-role" }, [el("td", { colspan: 3, text: role })]));
    for (const l of lines) {
      bomRows.push(
        el("tr", {}, [
          el("td", { class: "thom-layout-bom-sku", text: l.sku ?? "n/a" }),
          el("td", { text: l.description }),
          el("td", { class: "thom-layout-bom-qty", text: String(l.qty) }),
        ]),
      );
    }
  }

  return el("div", { class: "thom-card thom-layout-card" }, [
    el("div", { class: "thom-card-body" }, [
      el("div", { class: "thom-card-head" }, [
        el("strong", { text: `▧ ${title}` }),
        el("span", {
          class: "thom-muted",
          text: `${kindLabel} · ${card.space.lengthFt}×${card.space.widthFt} ft · ${card.space.mountingHeightFt} ft mount`,
        }),
      ]),
      chips.length
        ? el(
            "div",
            { class: "thom-layout-chips" },
            chips.map((c) => el("span", { class: "thom-layout-chip" }, [el("span", { class: "thom-muted", text: c.label }), " " + c.value])),
          )
        : null,
      card.plan ? layoutPlanSvg(card.plan, card.space) : null,
      card.bom.lines.length ? el("table", { class: "thom-layout-bom" }, [el("tbody", {}, bomRows)]) : null,
      card.warnings.length
        ? el("ul", { class: "thom-layout-warnings" }, card.warnings.map((w) => el("li", { class: "thom-muted", text: w })))
        : null,
      el("p", { class: "thom-layout-note thom-muted", text: "Estimate. Verify in AGi32 or Ventrix." }),
    ]),
  ]);
}

/** Top-down room plan (heatmap + track runs + head dots) in normalized 0..1 coords. */
function layoutPlanSvg(plan: NonNullable<LayoutCard["plan"]>, space: LayoutCard["space"]): SVGElement {
  const W = 260;
  const aspect = space.lengthFt > 0 && space.widthFt > 0 ? space.lengthFt / space.widthFt : 1;
  const H = Math.max(120, Math.min(360, W * aspect));
  const hm = plan.heatmap;
  const span = hm ? Math.max(1e-6, hm.max - hm.min) : 1;

  const kids: (SVGElement | null)[] = [];
  if (hm) {
    hm.values.forEach((row, r) =>
      row.forEach((v, c) => {
        const op = 0.06 + 0.5 * ((v - hm.min) / span);
        kids.push(
          svgEl("rect", {
            x: (c / hm.cols) * W,
            y: (r / hm.rows) * H,
            width: W / hm.cols + 0.5,
            height: H / hm.rows + 0.5,
            fill: "var(--thom-accent)",
            opacity: op,
          }),
        );
      }),
    );
  }
  kids.push(svgEl("rect", { x: 0.5, y: 0.5, width: W - 1, height: H - 1, fill: "none", stroke: "var(--thom-border)", "stroke-width": 1 }));
  plan.runs.forEach((run) =>
    kids.push(
      svgEl("line", {
        x1: run.x1 * W,
        y1: run.y1 * H,
        x2: run.x2 * W,
        y2: run.y2 * H,
        stroke: "var(--thom-text)",
        "stroke-width": 2.5,
        "stroke-linecap": "round",
        opacity: 0.5,
      }),
    ),
  );
  plan.heads.forEach((h) => kids.push(svgEl("circle", { cx: h.x * W, cy: h.y * H, r: 3.2, fill: "var(--thom-accent)" })));

  return svgEl("svg", { class: "thom-layout-svg", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Top-down layout plan" }, kids);
}

/** The citation chip row under an assistant turn. */
export function renderCitations(citations: Citation[]): HTMLElement {
  return el(
    "div",
    { class: "thom-citations" },
    citations.map((cite) =>
      extLink(cite.url ?? undefined, { class: "thom-cite", title: cite.title ?? cite.doc_type }, [
        (cite.kind === "web" ? "🌐 " : "📄 ") + (cite.title ?? cite.doc_type) + (cite.page != null ? ` p.${cite.page}` : ""),
      ]),
    ),
  );
}
