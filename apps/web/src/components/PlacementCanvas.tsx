import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type {
  AppImageAnchor,
  AppImagePerspective,
  AppImageWidthBasis,
} from "@wac/shared";
import {
  anchorToTopLeft,
  computeCutoutPixelSize,
} from "../lib/appimageScale.js";
import { hasUsableDimension, looksOpaque } from "../lib/appimageDraft.js";
import type { FixtureDraft } from "../lib/appimageDraft.js";
import {
  autoSuggestPerspective,
  IDENTITY_PERSPECTIVE,
  isIdentityPerspective,
  keystoneToPerspective,
  perspectiveToKeystone,
  perspectiveToMatrix3d,
} from "../lib/perspective.js";
import { suggestPerspective } from "../lib/scenes.js";
import type { SceneSelection } from "./SceneInput.js";

/** The four perspective corners and their base position as 0/1 fractions. */
const CORNERS: {
  key: keyof AppImagePerspective;
  fx: 0 | 1;
  fy: 0 | 1;
}[] = [
  { key: "topLeft", fx: 0, fy: 0 },
  { key: "topRight", fx: 1, fy: 0 },
  { key: "bottomRight", fx: 1, fy: 1 },
  { key: "bottomLeft", fx: 0, fy: 1 },
];

function clampOffset(n: number): number {
  return Math.min(0.6, Math.max(-0.6, n));
}

const ANCHORS: AppImageAnchor[] = [
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

const BASES: AppImageWidthBasis[] = [
  "auto",
  "width",
  "height",
  "diameter",
  "length",
];

interface PlacementCanvasProps {
  scene: SceneSelection;
  pxPerMm: number | null;
  scaleAdjust: number;
  onScaleAdjustChange: (v: number) => void;
  fixtures: FixtureDraft[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChangeFixture: (id: string, patch: Partial<FixtureDraft>) => void;
  onRemoveFixture: (id: string) => void;
  onAddArray: (baseId: string, count: number, spacingPct: number) => void;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Interactive scene + fixture overlay (Phase 2e). Mirrors the server's scale +
 * anchor math so the preview matches the composited result. Everything is laid
 * out in percentages of the scene, so the box stays correct at any display size.
 * Drag a fixture to set its anchor position; the global scale slider drives
 * `scaleAdjust`.
 */
export function PlacementCanvas({
  scene,
  pxPerMm,
  scaleAdjust,
  onScaleAdjustChange,
  fixtures,
  selectedId,
  onSelect,
  onChangeFixture,
  onRemoveFixture,
  onAddArray,
}: PlacementCanvasProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [aspects, setAspects] = useState<Record<string, number>>({});
  const [canvasPx, setCanvasPx] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const dragging = useRef<string | null>(null);
  // Active perspective corner-handle drag, if any.
  const cornerDrag = useRef<{
    id: string;
    corner: keyof AppImagePerspective;
    fx: 0 | 1;
    fy: 0 | 1;
  } | null>(null);

  // Track the canvas's rendered pixel size so the perspective preview's
  // matrix3d is built in the element's real CSS-px space (correct projection).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      setCanvasPx({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setCanvasPx({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Load each unique cutout's intrinsic aspect ratio (needed to size overlays).
  useEffect(() => {
    const urls = [...new Set(fixtures.map((f) => f.cutoutUrl).filter(Boolean))];
    for (const url of urls) {
      if (aspects[url] !== undefined) continue;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () =>
        setAspects((prev) => ({
          ...prev,
          [url]: img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1,
        }));
      img.onerror = () => setAspects((prev) => ({ ...prev, [url]: 1 }));
      img.src = url;
    }
  }, [fixtures, aspects]);

  function pointerToPct(clientX: number, clientY: number) {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return {
      xPct: clamp01((clientX - rect.left) / rect.width),
      yPct: clamp01((clientY - rect.top) / rect.height),
    };
  }

  /**
   * Translate a corner-handle drag into a perspective offset for that corner.
   * The offset is a fraction of the fixture's rendered width/height, matching
   * the server warp and the matrix3d preview.
   */
  function handleCornerDrag(clientX: number, clientY: number) {
    const drag = cornerDrag.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!drag || !rect || rect.width === 0 || rect.height === 0) return;
    const f = fixtures.find((x) => x.id === drag.id);
    const aspect = f ? aspects[f.cutoutUrl] : undefined;
    if (!f || !pxPerMm || aspect === undefined) return;
    const size = computeCutoutPixelSize({
      dimensionsMm: f.dimensionsMm,
      pxPerMm,
      scaleAdjust,
      cutoutAspect: aspect,
      widthBasis: f.widthBasis,
    });
    if (!size) return;
    const pos = anchorToTopLeft(
      f.anchor,
      f.xPct,
      f.yPct,
      size,
      scene.naturalWidth,
      scene.naturalHeight,
    );
    const overlayLeft = rect.left + (pos.left / scene.naturalWidth) * rect.width;
    const overlayTop = rect.top + (pos.top / scene.naturalHeight) * rect.height;
    const renderedW = (size.width / scene.naturalWidth) * rect.width;
    const renderedH = (size.height / scene.naturalHeight) * rect.height;
    if (renderedW === 0 || renderedH === 0) return;
    const dx = clampOffset((clientX - overlayLeft) / renderedW - drag.fx);
    const dy = clampOffset((clientY - overlayTop) / renderedH - drag.fy);
    const base = f.perspective ?? IDENTITY_PERSPECTIVE;
    const next: AppImagePerspective = { ...base, [drag.corner]: { dx, dy } };
    onChangeFixture(drag.id, { perspective: next });
  }

  const selected = fixtures.find((f) => f.id === selectedId) ?? null;

  return (
    <div className="card col" style={{ gap: 14 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Placement</h3>
        <div className="muted" style={{ fontSize: 12 }}>
          Drag a fixture to reposition · use the scale slider to resize
        </div>
      </div>

      <div
        ref={canvasRef}
        className="placement-canvas"
        onPointerMove={(e) => {
          if (cornerDrag.current) {
            handleCornerDrag(e.clientX, e.clientY);
            return;
          }
          if (!dragging.current) return;
          const pct = pointerToPct(e.clientX, e.clientY);
          if (pct) onChangeFixture(dragging.current, pct);
        }}
        onPointerUp={(e) => {
          if (cornerDrag.current || dragging.current) {
            cornerDrag.current = null;
            dragging.current = null;
            (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
          }
        }}
      >
        <img src={scene.url} alt="scene" draggable={false} />

        {fixtures.map((f) => {
          const aspect = aspects[f.cutoutUrl];
          if (!pxPerMm || aspect === undefined || !hasUsableDimension(f.dimensionsMm)) {
            return null;
          }
          const size = computeCutoutPixelSize({
            dimensionsMm: f.dimensionsMm,
            pxPerMm,
            scaleAdjust,
            cutoutAspect: aspect,
            widthBasis: f.widthBasis,
          });
          if (!size) return null;
          const pos = anchorToTopLeft(
            f.anchor,
            f.xPct,
            f.yPct,
            size,
            scene.naturalWidth,
            scene.naturalHeight,
          );
          const isSel = f.id === selectedId;
          // Live perspective preview: build matrix3d in the overlay's rendered
          // px space so it matches the server's projective warp.
          let warpStyle: CSSProperties | undefined;
          if (f.perspective && !isIdentityPerspective(f.perspective) && canvasPx.w > 0) {
            const renderedW = (size.width / scene.naturalWidth) * canvasPx.w;
            const renderedH = (size.height / scene.naturalHeight) * canvasPx.h;
            warpStyle = {
              transform: perspectiveToMatrix3d(f.perspective, renderedW, renderedH),
              transformOrigin: "top left",
            };
          }
          return (
            <div
              key={f.id}
              className={"fixture-overlay" + (isSel ? " selected" : "")}
              style={{
                left: `${(pos.left / scene.naturalWidth) * 100}%`,
                top: `${(pos.top / scene.naturalHeight) * 100}%`,
                width: `${(size.width / scene.naturalWidth) * 100}%`,
                height: `${(size.height / scene.naturalHeight) * 100}%`,
                overflow: "visible",
              }}
              onPointerDown={(e) => {
                onSelect(f.id);
                dragging.current = f.id;
                (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                e.preventDefault();
              }}
            >
              <img src={f.cutoutUrl} alt={f.name} draggable={false} style={warpStyle} />
              {isSel &&
                CORNERS.map((corner) => {
                  const off = (f.perspective ?? IDENTITY_PERSPECTIVE)[corner.key];
                  return (
                    <div
                      key={corner.key}
                      className="perspective-handle"
                      style={{
                        left: `${(corner.fx + off.dx) * 100}%`,
                        top: `${(corner.fy + off.dy) * 100}%`,
                      }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        cornerDrag.current = {
                          id: f.id,
                          corner: corner.key,
                          fx: corner.fx,
                          fy: corner.fy,
                        };
                        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                        e.preventDefault();
                      }}
                      title="Drag to adjust perspective"
                    />
                  );
                })}
            </div>
          );
        })}
      </div>

      <div style={{ maxWidth: 360 }}>
        <label>Scale ({scaleAdjust.toFixed(2)}×)</label>
        <input
          type="range"
          min={0.1}
          max={3}
          step={0.05}
          value={scaleAdjust}
          onChange={(e) => onScaleAdjustChange(Number(e.target.value))}
        />
      </div>

      {!pxPerMm && (
        <div className="alert warn">
          Set the scene's real-world width to size and place fixtures.
        </div>
      )}

      {selected ? (
        <FixtureControls
          fixture={selected}
          sceneUrl={scene.url}
          onChange={(patch) => onChangeFixture(selected.id, patch)}
          onRemove={() => onRemoveFixture(selected.id)}
          onAddArray={(count, spacing) =>
            onAddArray(selected.id, count, spacing)
          }
        />
      ) : (
        fixtures.length > 0 && (
          <div className="muted" style={{ fontSize: 12 }}>
            Select a fixture above to edit its anchor, size basis, cutout image,
            or expand it into an array.
          </div>
        )
      )}
    </div>
  );
}

/**
 * Deterministic perspective correction for the selected fixture: two keystone
 * sliders (vertical/horizontal) plus an auto-suggestion and reset. Warps the
 * real cutout pixels — never re-renders the fixture — and previews live on the
 * canvas.
 */
function PerspectiveControls({
  fixture,
  sceneUrl,
  onChange,
}: {
  fixture: FixtureDraft;
  sceneUrl: string;
  onChange: (patch: Partial<FixtureDraft>) => void;
}) {
  const { vertical, horizontal } = perspectiveToKeystone(fixture.perspective);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  function apply(v: number, h: number) {
    if (Math.abs(v) < 0.005 && Math.abs(h) < 0.005) {
      onChange({ perspective: undefined });
      return;
    }
    onChange({ perspective: keystoneToPerspective(v, h) });
  }

  /**
   * Auto-fit: ask the server (Gemini vision) for the surface keystone, and fall
   * back to the positional heuristic if the call fails or isn't configured.
   */
  async function autoFit() {
    setBusy(true);
    setNote(null);
    try {
      const hint = await suggestPerspective({ sceneUrl, mount: fixture.mount });
      apply(hint.vertical, hint.horizontal);
      setNote("Fitted from the scene's surface.");
    } catch {
      onChange({ perspective: autoSuggestPerspective(fixture.yPct) });
      setNote("Used a positional estimate (vision unavailable).");
    } finally {
      setBusy(false);
    }
  }

  const active = !isIdentityPerspective(fixture.perspective);

  return (
    <div className="col" style={{ gap: 8, borderTop: "1px dashed var(--border)", paddingTop: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <label style={{ margin: 0 }}>Perspective {active ? "(on)" : ""}</label>
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void autoFit()}
            title="Estimate the surface perspective from the scene"
          >
            {busy ? <span className="spinner" /> : "Auto-fit"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!active}
            onClick={() => onChange({ perspective: undefined })}
          >
            Reset
          </button>
        </div>
      </div>
      <div className="grid-2">
        <div>
          <label>Vertical tilt ({Math.round(vertical * 100)}%)</label>
          <input
            type="range"
            min={-0.3}
            max={0.3}
            step={0.01}
            value={vertical}
            onChange={(e) => apply(Number(e.target.value), horizontal)}
          />
        </div>
        <div>
          <label>Horizontal tilt ({Math.round(horizontal * 100)}%)</label>
          <input
            type="range"
            min={-0.3}
            max={0.3}
            step={0.01}
            value={horizontal}
            onChange={(e) => apply(vertical, Number(e.target.value))}
          />
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Drag the corner handles on the canvas for a Photoshop-style free
        transform, or use Auto-fit / the sliders. Warps the real cutout to match
        the room's angle (no re-rendering).
      </div>
      {note && (
        <div className="muted" style={{ fontSize: 12 }}>
          {note}
        </div>
      )}
    </div>
  );
}

function FixtureControls({
  fixture,
  sceneUrl,
  onChange,
  onRemove,
  onAddArray,
}: {
  fixture: FixtureDraft;
  sceneUrl: string;
  onChange: (patch: Partial<FixtureDraft>) => void;
  onRemove: () => void;
  onAddArray: (count: number, spacingPct: number) => void;
}) {
  const [count, setCount] = useState(3);
  const [spacingPct, setSpacingPct] = useState(15);
  const opaque = looksOpaque(fixture.cutoutUrl);

  return (
    <div className="col" style={{ gap: 12, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>{fixture.name}</strong>
          <div className="muted product-sku">{fixture.sku}</div>
        </div>
        <button className="secondary" onClick={onRemove}>
          Remove
        </button>
      </div>

      {opaque && (
        <div className="alert">
          This image has a background — it'll be removed automatically before
          compositing. Pick a clean, front-on product shot for the best cutout.
        </div>
      )}

      <div>
        <label>Product image (background removed automatically)</label>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          {fixture.imageOptions.map((url) => (
            <button
              key={url}
              type="button"
              className={
                "cutout-option" + (url === fixture.cutoutUrl ? " selected" : "")
              }
              onClick={() => onChange({ cutoutUrl: url })}
              title={looksOpaque(url) ? "Background will be removed" : url}
            >
              <img src={url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      </div>

      <div className="grid-2">
        <div>
          <label>Anchor</label>
          <select
            value={fixture.anchor}
            onChange={(e) =>
              onChange({ anchor: e.target.value as AppImageAnchor })
            }
          >
            {ANCHORS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Size basis</label>
          <select
            value={fixture.widthBasis}
            onChange={(e) =>
              onChange({ widthBasis: e.target.value as AppImageWidthBasis })
            }
          >
            {BASES.map((b) => (
              <option
                key={b}
                value={b}
                disabled={b !== "auto" && !fixture.dimensionsMm[b]}
              >
                {b}
                {b !== "auto" && fixture.dimensionsMm[b]
                  ? ` (${fixture.dimensionsMm[b]} mm)`
                  : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      <PerspectiveControls
        fixture={fixture}
        sceneUrl={sceneUrl}
        onChange={onChange}
      />

      <div className="col" style={{ gap: 8 }}>
        <label>Array (for downlights / landscape runs)</label>
        <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
          <div style={{ width: 90 }}>
            <label>Count</label>
            <input
              type="number"
              min={2}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            />
          </div>
          <div style={{ width: 120 }}>
            <label>Spacing (% width)</label>
            <input
              type="number"
              min={1}
              max={100}
              value={spacingPct}
              onChange={(e) => setSpacingPct(Number(e.target.value))}
            />
          </div>
          <button
            className="secondary"
            onClick={() => onAddArray(count, spacingPct / 100)}
          >
            Expand into array
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          Replaces this fixture with {count} evenly spaced copies centered on its
          current position.
        </div>
      </div>
    </div>
  );
}
