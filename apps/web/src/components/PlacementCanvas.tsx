import { useEffect, useRef, useState } from "react";
import type { AppImageAnchor, AppImageWidthBasis } from "@wac/shared";
import {
  anchorToTopLeft,
  computeCutoutPixelSize,
} from "../lib/appimageScale.js";
import { hasUsableDimension, looksOpaque } from "../lib/appimageDraft.js";
import type { FixtureDraft } from "../lib/appimageDraft.js";
import type { SceneSelection } from "./SceneInput.js";

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
  const dragging = useRef<string | null>(null);

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
          if (!dragging.current) return;
          const pct = pointerToPct(e.clientX, e.clientY);
          if (pct) onChangeFixture(dragging.current, pct);
        }}
        onPointerUp={(e) => {
          if (dragging.current) {
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
          return (
            <div
              key={f.id}
              className={"fixture-overlay" + (isSel ? " selected" : "")}
              style={{
                left: `${(pos.left / scene.naturalWidth) * 100}%`,
                top: `${(pos.top / scene.naturalHeight) * 100}%`,
                width: `${(size.width / scene.naturalWidth) * 100}%`,
                height: `${(size.height / scene.naturalHeight) * 100}%`,
              }}
              onPointerDown={(e) => {
                onSelect(f.id);
                dragging.current = f.id;
                (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                e.preventDefault();
              }}
            >
              <img src={f.cutoutUrl} alt={f.name} draggable={false} />
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

function FixtureControls({
  fixture,
  onChange,
  onRemove,
  onAddArray,
}: {
  fixture: FixtureDraft;
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
        <div className="alert warn">
          This cutout looks like a JPEG, which can't have a transparent
          background — generation may reject it. Choose a PNG/WebP cutout below
          if one is available.
        </div>
      )}

      <div>
        <label>Cutout image (must be transparent)</label>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          {fixture.imageOptions.map((url) => (
            <button
              key={url}
              type="button"
              className={
                "cutout-option" + (url === fixture.cutoutUrl ? " selected" : "")
              }
              onClick={() => onChange({ cutoutUrl: url })}
              title={looksOpaque(url) ? "Likely opaque (JPEG)" : url}
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
