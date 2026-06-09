import { useEffect, useState } from "react";
import { fixtureThumbUrl } from "../lib/appshot.js";

/**
 * Picker thumbnail with a cheap still-image fallback chain so you always see what
 * you're about to pick:
 *
 *   1. Sales Layer image   (fixture-level; instant, but identical across scenes)
 *   2. Pre-baked thumbnail  (the GLB render cached at fixture-add time, served from
 *                            /api/appshot/thumb-file/{key}.png — the actual form)
 *   3. Placeholder glyph    (nothing available yet)
 *
 * Both sources are plain <img>s — no WebGL on the picker page. The 3D form preview
 * is rendered once, offline (see apps/fixture-sync), so browsing a long grid stays
 * cheap and never exhausts the browser's WebGL context budget.
 */
export interface FixtureThumbProps {
  fixtureKey: string;
  /** Sales Layer image (highest priority when present). */
  imageUrl?: string | null;
  /** Fixed square px size. Omit to fill the parent (e.g. a product-card thumb). */
  size?: number;
}

/** The image/placeholder fills the square frame, regardless of size mode. */
const contentStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  height: "100%",
  objectFit: "contain",
};

/**
 * A square white box; the image is a normal-flow child centered inside it.
 *
 * In fill mode the frame is SQUARE via `aspect-ratio: 1/1` (height tracks the
 * card width) — so a square product/baked image fills it with no white letterbox
 * top or bottom. This is the same construction as the Library `.product-thumb`,
 * which renders correctly in Safari; it's safe here now that the grid is no
 * longer the `overflow:auto` scroll container (that scroll-on-grid context was
 * what collapsed aspect-ratio to zero height in WebKit — the scroll now lives on
 * a plain wrapper). A fixed `size` keeps an explicit square for the small
 * scene-picker tiles.
 */
function ThumbFrame({
  size,
  children,
}: {
  size?: number;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        width: size ?? "100%",
        ...(size ? { height: size } : { aspectRatio: "1 / 1" }),
        flex: "0 0 auto",
        borderRadius: size ? 6 : 0,
        overflow: "hidden",
        background: "#fff",
        display: "grid",
        placeItems: "center",
      }}
    >
      {children}
    </div>
  );
}

export function FixtureThumb({ fixtureKey, imageUrl, size }: FixtureThumbProps) {
  // Candidate still-image sources in priority order. onError advances the index;
  // exhausting them shows the placeholder glyph.
  const candidates = [imageUrl, fixtureThumbUrl(fixtureKey)].filter(
    Boolean,
  ) as string[];
  const [idx, setIdx] = useState(0);

  // Reset the chain whenever the fixture/source changes.
  useEffect(() => {
    setIdx(0);
  }, [fixtureKey, imageUrl]);

  return (
    <ThumbFrame size={size}>
      {candidates[idx] ? (
        <img
          src={candidates[idx]}
          alt=""
          loading="lazy"
          style={contentStyle}
          onError={() => setIdx((i) => i + 1)}
        />
      ) : (
        <PlaceholderGlyph size={size} />
      )}
    </ThumbFrame>
  );
}

function PlaceholderGlyph({ size }: { size?: number }) {
  const glyph = size ? Math.round(size * 0.5) : 40;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "#eef1f5",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#9aa4b2",
      }}
      aria-hidden
    >
      <svg
        width={glyph}
        height={glyph}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 18h6" />
        <path d="M10 22h4" />
        <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V18h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />
      </svg>
    </div>
  );
}
