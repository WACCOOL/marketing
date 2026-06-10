import type { PptChart, PptSlide, PptTable } from "@wac/shared";

/**
 * SlidePreview: a real 16:9 mini-render of a slide's content, used both as
 * the filmstrip thumbnail (`size="thumb"`) and as the live preview above the
 * editor form (`size="full"`). The canvas is white regardless of app theme —
 * exported slides are white — and every text size inside is an em multiple of
 * a container-query base font (see .ppt-preview-canvas in styles.css), so the
 * same markup scales from a ~200px thumb to the full-width preview. All text
 * is clamped/ellipsized so long content never breaks the 16:9 frame; detail
 * like chart category labels and field placeholders only renders at "full".
 */

type Size = "thumb" | "full";

export function SlidePreview({ slide, size }: { slide: PptSlide; size: Size }) {
  const canvas = ["ppt-preview-canvas"];
  if (slide.layout === "title") canvas.push("center");
  if (slide.layout === "section") canvas.push("dark", "bottom");
  if (slide.layout === "image_full") canvas.push("bleed");
  return (
    <div className={`ppt-preview ${size}`}>
      <div className={canvas.join(" ")}>
        <SlideContent slide={slide} size={size} />
      </div>
    </div>
  );
}

function SlideContent({ slide, size }: { slide: PptSlide; size: Size }) {
  const f = slide.fields;
  const full = size === "full";
  switch (slide.layout) {
    case "title":
      return (
        <>
          <PvText
            className="ppt-pv-title-xl ppt-pv-clamp-2"
            text={f.title}
            placeholder="Title"
          />
          <PvText
            className="ppt-pv-subtitle ppt-pv-clamp-2"
            text={f.subtitle}
            placeholder={full ? "Subtitle" : undefined}
          />
        </>
      );
    case "section":
      return (
        <>
          <PvText
            className="ppt-pv-title-xl ppt-pv-clamp-2"
            text={f.title}
            placeholder="Section"
          />
          <PvText className="ppt-pv-subtitle ppt-pv-clamp-1" text={f.subtitle} />
        </>
      );
    case "title_content":
      return (
        <>
          <PvText
            className="ppt-pv-title ppt-pv-clamp-1"
            text={f.title}
            placeholder="Title"
          />
          <PvText
            className={`ppt-pv-body ${
              (f.bullets?.length ?? 0) > 0 ? "ppt-pv-clamp-3" : "ppt-pv-clamp-6"
            }`}
            text={f.body}
          />
          <PvLines lines={f.bullets} max={6} />
        </>
      );
    case "title_content_image":
      return (
        <>
          <PvText
            className="ppt-pv-title ppt-pv-clamp-1"
            text={f.title}
            placeholder="Title"
          />
          <div className="ppt-pv-cols">
            <div className="ppt-pv-col">
              <PvText className="ppt-pv-body ppt-pv-clamp-3" text={f.body} />
              <PvLines lines={f.bullets} max={5} />
            </div>
            <div className="ppt-pv-imgbox">
              <PvImageBox
                url={f.images?.[0]?.url}
                label={full ? "No image" : undefined}
              />
            </div>
          </div>
        </>
      );
    case "two_column":
      return (
        <>
          <PvText
            className="ppt-pv-title ppt-pv-clamp-1"
            text={f.title}
            placeholder="Title"
          />
          <div className="ppt-pv-cols">
            <div className="ppt-pv-col">
              <PvText
                className="ppt-pv-body ppt-pv-clamp-6"
                text={f.body}
                placeholder={full ? "Left column" : undefined}
              />
            </div>
            <div className="ppt-pv-col">
              <PvText
                className="ppt-pv-body ppt-pv-clamp-6"
                text={f.body2}
                placeholder={full ? "Right column" : undefined}
              />
            </div>
          </div>
        </>
      );
    case "image_full":
      return (
        <PvImageBox
          url={f.images?.[0]?.url}
          label={full ? "No image" : undefined}
        />
      );
    case "image_caption": {
      const images = (f.images ?? []).slice(0, 4);
      return (
        <div className="ppt-pv-cols">
          <div className="ppt-pv-col">
            <PvText
              className="ppt-pv-title ppt-pv-clamp-2"
              text={f.title}
              placeholder="Title"
            />
            <PvText
              className="ppt-pv-caption ppt-pv-clamp-4"
              text={images[0]?.caption}
              placeholder={full ? "Caption" : undefined}
            />
          </div>
          <div className={`ppt-pv-imggrid${images.length > 1 ? " multi" : ""}`}>
            {images.length > 0 ? (
              images.map((img, i) => (
                <img key={i} className="ppt-pv-img" src={img.url} alt="" />
              ))
            ) : (
              <PvImageBox label={full ? "No image" : undefined} />
            )}
          </div>
        </div>
      );
    }
    case "agenda":
      return (
        <>
          <PvText
            className="ppt-pv-title ppt-pv-clamp-1"
            text={f.title}
            placeholder="Agenda"
          />
          <PvLines lines={f.bullets} numbered max={7} />
        </>
      );
    case "quote":
      return (
        <>
          <div className="ppt-pv-quotewrap">
            <div className="ppt-pv-quote ppt-pv-clamp-4">
              {f.quote?.text.trim() ? (
                `“${f.quote.text.trim()}”`
              ) : (
                <span className="ppt-pv-ph">{"“Quote”"}</span>
              )}
            </div>
          </div>
          {f.quote?.attribution?.trim() && (
            <div className="ppt-pv-attr ppt-pv-clamp-1">
              — {f.quote.attribution.trim()}
            </div>
          )}
        </>
      );
    case "chart":
      return (
        <>
          <PvText
            className="ppt-pv-title ppt-pv-clamp-1"
            text={f.title}
            placeholder="Chart"
          />
          <PvChart chart={f.chart} size={size} />
        </>
      );
    case "diagram": {
      const items = (f.items ?? []).map((t) => t.trim()).filter(Boolean);
      return (
        <>
          <PvText
            className="ppt-pv-title ppt-pv-clamp-1"
            text={f.title}
            placeholder="Diagram"
          />
          {items.length > 0 ? (
            <div
              className="ppt-pv-diagram"
              style={{
                gridTemplateColumns: `repeat(${Math.min(3, items.length)}, 1fr)`,
              }}
            >
              {items.map((t, i) => (
                <div key={i}>
                  <span className="ppt-pv-clamp-2">{t}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="ppt-pv-empty">No boxes yet</div>
          )}
        </>
      );
    }
    case "process": {
      const items = (f.items ?? []).map((t) => t.trim()).filter(Boolean);
      return (
        <>
          <PvText
            className="ppt-pv-title ppt-pv-clamp-1"
            text={f.title}
            placeholder="Process"
          />
          {items.length > 0 ? (
            <div className="ppt-pv-process">
              {items.map((t, i) => (
                <div key={i}>
                  <span className="ppt-pv-clamp-2">{t}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="ppt-pv-empty">No steps yet</div>
          )}
        </>
      );
    }
    case "video": {
      const url = f.video?.url.trim() ?? "";
      const fileName = url ? url.split("/").pop()?.split("?")[0] || url : "";
      return (
        <>
          <PvText
            className="ppt-pv-title ppt-pv-clamp-1"
            text={f.title}
            placeholder="Video"
          />
          <div className="ppt-pv-videobox">
            <div className="ppt-pv-play" />
            {fileName && <div className="ppt-pv-videourl">{fileName}</div>}
          </div>
          <PvText className="ppt-pv-caption ppt-pv-clamp-1" text={f.video?.caption} />
        </>
      );
    }
    case "table":
      return (
        <>
          <PvText
            className="ppt-pv-title ppt-pv-clamp-1"
            text={f.title}
            placeholder="Table"
          />
          <PvTable table={f.table} />
        </>
      );
  }
}

/** Clamped text line; falls back to a muted placeholder when provided. */
function PvText(props: {
  className: string;
  text?: string;
  placeholder?: string;
}) {
  const text = props.text?.trim();
  if (!text && !props.placeholder) return null;
  return (
    <div className={text ? props.className : `${props.className} ppt-pv-ph`}>
      {text || props.placeholder}
    </div>
  );
}

/** Bullet (•) or numbered (1.) list, one ellipsized line per item. */
function PvLines(props: { lines?: string[]; numbered?: boolean; max: number }) {
  const lines = (props.lines ?? []).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const shown = lines.slice(0, props.max);
  return (
    <div className="ppt-pv-lines">
      {shown.map((l, i) => (
        <div key={i} className="ppt-pv-line">
          {props.numbered ? `${i + 1}.` : "•"} {l}
        </div>
      ))}
      {lines.length > shown.length && (
        <div className="ppt-pv-line ppt-pv-ph">
          +{lines.length - shown.length} more
        </div>
      )}
    </div>
  );
}

/** Cover image, or a muted placeholder block when no url is set. */
function PvImageBox(props: { url?: string; label?: string }) {
  return props.url ? (
    <img className="ppt-pv-img" src={props.url} alt="" />
  ) : (
    <div className="ppt-pv-imgph">{props.label}</div>
  );
}

// ---------------------------------------------------------------------------
// Mini table.
// ---------------------------------------------------------------------------

function PvTable({ table }: { table?: PptTable }) {
  if (!table || table.headers.length === 0) {
    return <div className="ppt-pv-empty">No table data</div>;
  }
  const rows = table.rows.slice(0, 4);
  return (
    <div className="ppt-pv-tablewrap">
      <table className="ppt-pv-table">
        <thead>
          <tr>
            {table.headers.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {table.headers.map((_, c) => (
                <td key={c}>{row[c] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.rows.length > rows.length && (
        <div className="ppt-pv-ph ppt-pv-more">
          +{table.rows.length - rows.length} more rows
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mini chart: inline SVG scaled from the slide's real chart data. Series are
// var(--accent) at stepped opacities; category labels render only at "full".
// ---------------------------------------------------------------------------

const SERIES_OPACITY = [0.92, 0.62, 0.42, 0.28, 0.75, 0.5];

function opacityFor(i: number): number {
  return SERIES_OPACITY[i % SERIES_OPACITY.length] ?? 0.9;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s;
}

/** Largest non-negative value across all series (≥1 so bars never divide by 0). */
function chartMax(chart: PptChart): number {
  return Math.max(
    1,
    ...chart.series.flatMap((s) => s.values.map((v) => Math.max(0, v))),
  );
}

/** How many label characters fit per category before neighbours collide. */
function labelLen(n: number): number {
  return Math.max(3, Math.floor(48 / n));
}

function PvChart({ chart, size }: { chart?: PptChart; size: Size }) {
  const pieTotal =
    chart?.series[0]?.values.reduce((a, b) => a + Math.max(0, b), 0) ?? 0;
  if (
    !chart ||
    chart.categories.length === 0 ||
    chart.series.length === 0 ||
    (chart.chartType === "pie" && pieTotal <= 0)
  ) {
    return <div className="ppt-pv-empty">No chart data</div>;
  }
  const full = size === "full";
  return (
    <div className="ppt-pv-chart">
      <svg viewBox="0 0 100 58" preserveAspectRatio="xMidYMid meet">
        {chart.chartType === "column" && <PvColumns chart={chart} full={full} />}
        {chart.chartType === "bar" && <PvBars chart={chart} full={full} />}
        {chart.chartType === "line" && <PvLineChart chart={chart} full={full} />}
        {chart.chartType === "pie" && <PvPie chart={chart} full={full} />}
      </svg>
    </div>
  );
}

function PvColumns({ chart, full }: { chart: PptChart; full: boolean }) {
  const max = chartMax(chart);
  const n = chart.categories.length;
  const group = 100 / n;
  const barW = (group * 0.72) / chart.series.length;
  return (
    <>
      {chart.categories.map((c, ci) => (
        <g key={ci}>
          {chart.series.map((s, si) => {
            const h = (Math.max(0, s.values[ci] ?? 0) / max) * 48;
            return (
              <rect
                key={si}
                className="ppt-pv-fill"
                x={ci * group + group * 0.14 + si * barW}
                y={52 - h}
                width={Math.max(barW - 0.5, 0.4)}
                height={h}
                opacity={opacityFor(si)}
              />
            );
          })}
          {full && (
            <text x={ci * group + group / 2} y={57} textAnchor="middle">
              {clip(c, labelLen(n))}
            </text>
          )}
        </g>
      ))}
      <line className="ppt-pv-axis" x1={0} y1={52} x2={100} y2={52} />
    </>
  );
}

function PvBars({ chart, full }: { chart: PptChart; full: boolean }) {
  const max = chartMax(chart);
  const n = chart.categories.length;
  const inset = full ? 22 : 0; // label gutter at full size
  const rowH = 50 / n;
  const barH = (rowH * 0.7) / chart.series.length;
  return (
    <>
      {chart.categories.map((c, ci) => (
        <g key={ci}>
          {chart.series.map((s, si) => (
            <rect
              key={si}
              className="ppt-pv-fill"
              x={inset}
              y={2 + ci * rowH + rowH * 0.15 + si * barH}
              width={(Math.max(0, s.values[ci] ?? 0) / max) * (99 - inset)}
              height={Math.max(barH - 0.4, 0.4)}
              opacity={opacityFor(si)}
            />
          ))}
          {full && (
            <text x={inset - 2} y={2 + ci * rowH + rowH / 2 + 1.2} textAnchor="end">
              {clip(c, 10)}
            </text>
          )}
        </g>
      ))}
      <line className="ppt-pv-axis" x1={inset} y1={2} x2={inset} y2={52} />
    </>
  );
}

function PvLineChart({ chart, full }: { chart: PptChart; full: boolean }) {
  const max = chartMax(chart);
  const n = chart.categories.length;
  const step = 100 / n;
  const px = (ci: number) => step * (ci + 0.5);
  const py = (v: number) => 52 - (Math.max(0, v) / max) * 46;
  return (
    <>
      {chart.series.map((s, si) => (
        <g key={si} opacity={opacityFor(si)}>
          <polyline
            className="ppt-pv-stroke"
            points={chart.categories
              .map((_, ci) => `${px(ci)},${py(s.values[ci] ?? 0)}`)
              .join(" ")}
          />
          {chart.categories.map((_, ci) => (
            <circle
              key={ci}
              className="ppt-pv-fill"
              cx={px(ci)}
              cy={py(s.values[ci] ?? 0)}
              r={1}
            />
          ))}
        </g>
      ))}
      {full &&
        chart.categories.map((c, ci) => (
          <text key={ci} x={px(ci)} y={57} textAnchor="middle">
            {clip(c, labelLen(n))}
          </text>
        ))}
      <line className="ppt-pv-axis" x1={0} y1={52} x2={100} y2={52} />
    </>
  );
}

function PvPie({ chart, full }: { chart: PptChart; full: boolean }) {
  const values = (chart.series[0]?.values ?? []).map((v) => Math.max(0, v));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const cx = full ? 30 : 50; // leave room for the legend at full size
  const cy = 29;
  const r = 25;
  let angle = -Math.PI / 2;
  const slices = values.map((v, i) => {
    const a0 = angle;
    angle += (v / total) * Math.PI * 2;
    return { i, a0, a1: angle, frac: v / total };
  });
  return (
    <>
      {slices.map((s) =>
        s.frac <= 0 ? null : s.frac >= 0.999 ? (
          <circle
            key={s.i}
            className="ppt-pv-slice"
            cx={cx}
            cy={cy}
            r={r}
            opacity={opacityFor(s.i)}
          />
        ) : (
          <path
            key={s.i}
            className="ppt-pv-slice"
            d={arcPath(cx, cy, r, s.a0, s.a1)}
            opacity={opacityFor(s.i)}
          />
        ),
      )}
      {full &&
        chart.categories.slice(0, 6).map((c, i) => (
          <g key={i}>
            <rect
              className="ppt-pv-fill"
              x={62}
              y={6 + i * 7.5}
              width={4}
              height={4}
              opacity={opacityFor(i)}
            />
            <text x={68} y={9.6 + i * 7.5}>
              {clip(c, 14)}
            </text>
          </g>
        ))}
    </>
  );
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}
