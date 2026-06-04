import { useRef, useState } from "react";

export interface CropRect {
  /** All fractions of the image (0..1). */
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CropToolProps {
  imageUrl: string;
  busy?: boolean;
  onApply: (rect: CropRect) => void;
  onCancel: () => void;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Lightweight, dependency-free crop selector. Drag anywhere on the image to draw
 * a crop rectangle (drag again to redraw). Used as a final "crop before save"
 * step — e.g. to trim above a canopy-less chandelier so its top sits at the top
 * of the frame. Emits the selection as fractions of the image.
 */
export function CropTool({ imageUrl, busy, onApply, onCancel }: CropToolProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<CropRect | null>(null);
  const drawing = useRef<{ x: number; y: number } | null>(null);

  function toFrac(clientX: number, clientY: number) {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return null;
    return {
      x: clamp01((clientX - r.left) / r.width),
      y: clamp01((clientY - r.top) / r.height),
    };
  }

  function onPointerDown(e: React.PointerEvent) {
    const p = toFrac(e.clientX, e.clientY);
    if (!p) return;
    drawing.current = p;
    setRect({ x: p.x, y: p.y, w: 0, h: 0 });
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drawing.current) return;
    const p = toFrac(e.clientX, e.clientY);
    if (!p) return;
    const start = drawing.current;
    setRect({
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      w: Math.abs(p.x - start.x),
      h: Math.abs(p.y - start.y),
    });
  }

  function onPointerUp() {
    drawing.current = null;
  }

  const valid = rect !== null && rect.w > 0.02 && rect.h > 0.02;

  return (
    <div className="col" style={{ gap: 10 }}>
      <div
        ref={boxRef}
        className="crop-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <img src={imageUrl} alt="crop" draggable={false} />
        {rect && (
          <div
            className="crop-rect"
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.w * 100}%`,
              height: `${rect.h * 100}%`,
            }}
          />
        )}
      </div>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <button disabled={!valid || busy} onClick={() => valid && onApply(rect!)}>
          {busy ? <span className="spinner" /> : null}
          Apply crop & save
        </button>
        <button className="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          Drag on the image to select the area to keep.
        </span>
      </div>
    </div>
  );
}
