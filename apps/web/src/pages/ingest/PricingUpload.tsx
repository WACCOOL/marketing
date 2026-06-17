import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getSource } from "@wac/shared";
import {
  pollIngestion,
  uploadPricingFile,
  type IngestionStatus,
} from "../../lib/ingest.js";

const XLSX_ACCEPT =
  ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLSX_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "", // some browsers report no type for .xlsx; we also accept by extension
]);

/** Admin-only manual upload for the four WAC price books (C1 / D1 / D6 / D7). */
export function PricingUpload() {
  const pricing = getSource("pricing");
  const variants = pricing?.variants ?? [];
  const maxBytes = pricing?.maxBytes ?? 20 * 1024 * 1024;

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2>Pricing Upload</h2>
        <div className="muted">
          Upload each WAC price book as an Excel file. Each upload replaces only
          that price book. Track processing on{" "}
          <Link to="/data/ingestions">Data Ingestions</Link>.
        </div>
      </div>

      <div className="grid-2" style={{ gap: 16 }}>
        {variants.map((v) => (
          <PricingSlot key={v.key} variantKey={v.key} label={v.label} maxBytes={maxBytes} />
        ))}
      </div>
    </div>
  );
}

type SlotState =
  | { kind: "idle" }
  | { kind: "uploading"; name: string }
  | { kind: "processing"; name: string; status: IngestionStatus }
  | { kind: "done"; name: string; status: IngestionStatus }
  | { kind: "error"; message: string };

function PricingSlot({
  variantKey,
  label,
  maxBytes,
}: {
  variantKey: string;
  label: string;
  maxBytes: number;
}) {
  const [state, setState] = useState<SlotState>({ kind: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = state.kind === "uploading" || state.kind === "processing";

  async function handleFile(file: File) {
    const okType =
      XLSX_TYPES.has(file.type) || file.name.toLowerCase().endsWith(".xlsx");
    if (!okType) {
      setState({ kind: "error", message: "Please choose an .xlsx file" });
      return;
    }
    if (file.size > maxBytes) {
      setState({
        kind: "error",
        message: `File is too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`,
      });
      return;
    }
    setState({ kind: "uploading", name: file.name });
    try {
      const { ingestionId } = await uploadPricingFile(variantKey, file);
      setState({ kind: "processing", name: file.name, status: "queued" });
      const final = await pollIngestion(ingestionId);
      setState({ kind: "done", name: file.name, status: final.status });
    } catch (e) {
      setState({ kind: "error", message: formatErr(e) });
    }
  }

  return (
    <div className="card col" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <strong>{label}</strong>
        <span className="muted" style={{ fontSize: 12 }}>
          price book
        </span>
      </div>

      <div
        className={`dropzone${dragOver ? " dragover" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file && !busy) void handleFile(file);
        }}
        onClick={() => !busy && inputRef.current?.click()}
        style={{ cursor: busy ? "default" : "pointer" }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={XLSX_ACCEPT}
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = "";
          }}
        />
        {busy ? (
          <span className="row" style={{ gap: 8 }}>
            <span className="spinner" />
            {state.kind === "uploading" ? "Uploading…" : "Processing…"}
          </span>
        ) : (
          <span className="muted">Drop the {label} workbook here, or click to choose</span>
        )}
      </div>

      {state.kind === "done" && <StatusLine status={state.status} name={state.name} />}
      {state.kind === "error" && <div className="alert error">{state.message}</div>}
    </div>
  );
}

function StatusLine({ status, name }: { status: IngestionStatus; name: string }) {
  if (status === "succeeded") {
    return (
      <div className="alert" style={{ borderColor: "var(--good)", color: "var(--good)" }}>
        Uploaded {name} ✓
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="alert error">
        {name} failed to process — see Data Ingestions.
      </div>
    );
  }
  return (
    <div className="muted" style={{ fontSize: 12 }}>
      {name}: {status}
    </div>
  );
}

function formatErr(e: unknown): string {
  if (typeof e === "object" && e && "error" in e) {
    return String((e as { error: unknown }).error);
  }
  return e instanceof Error ? e.message : String(e);
}
