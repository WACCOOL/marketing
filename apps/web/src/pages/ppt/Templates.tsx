import { useEffect, useRef, useState } from "react";
import { PPT_LAYOUTS } from "@wac/shared";
import { api } from "../../lib/api.js";
import {
  apiForm,
  describeTemplateLayout,
  formatErr,
  listPptTemplates,
  PPT_LAYOUT_LABELS,
  type PptIntrospection,
  type PptTemplate,
} from "./lib.js";

/**
 * Admin management of .pptx deck templates: upload a branded template, then map
 * the 7 canonical deck layouts onto the template's own slide layouts so the
 * generator knows which layout to clone for each slide. Introspection (layout
 * names + placeholder types) comes back with every upload and on demand via
 * "Refresh layouts".
 */

const MAX_TEMPLATE_BYTES = 30 * 1024 * 1024;

export function PptTemplates() {
  const [templates, setTemplates] = useState<PptTemplate[]>([]);
  const [introspections, setIntrospections] = useState<
    Record<string, PptIntrospection>
  >({});
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Upload form
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function load() {
    setErr(null);
    try {
      setTemplates(await listPptTemplates());
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function rememberIntrospection(id: string, intro: PptIntrospection) {
    setIntrospections((prev) => ({ ...prev, [id]: intro }));
  }

  async function upload() {
    if (!file) {
      setErr("Choose a .pptx file to upload.");
      return;
    }
    if (file.size > MAX_TEMPLATE_BYTES) {
      setErr("Template exceeds the 30 MB limit.");
      return;
    }
    setUploading(true);
    setErr(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("name", name.trim() || file.name.replace(/\.pptx$/i, ""));
      if (brand.trim()) form.set("brand", brand.trim());
      const res = await apiForm<{
        template: PptTemplate;
        introspection: PptIntrospection;
      }>("/api/ppt/templates", form);
      rememberIntrospection(res.template.id, res.introspection);
      setName("");
      setBrand("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      setNotice(`Uploaded "${res.template.name}". Map its layouts below.`);
      await load();
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2>PPT Templates</h2>
        <div className="muted">
          Upload branded .pptx templates and map each canonical deck layout to
          one of the template's slide layouts. Fonts, colors, and positions
          always come from the template — decks only carry content.
        </div>
      </div>

      {err && <div className="alert error">{err}</div>}
      {notice && <div className="alert good">{notice}</div>}

      <div className="card col" style={{ gap: 10 }}>
        <h3 style={{ margin: 0 }}>Upload template</h3>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            ref={fileRef}
            type="file"
            accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            style={{ flex: 1, minWidth: 220 }}
          />
          <input
            placeholder="Template name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ flex: 1, minWidth: 180 }}
          />
          <input
            placeholder="Brand (optional)"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            style={{ width: 160 }}
          />
          <button onClick={() => void upload()} disabled={uploading}>
            {uploading ? <span className="spinner" /> : null}
            Upload
          </button>
        </div>
      </div>

      {loading && (
        <div className="muted">
          <span className="spinner" /> Loading templates…
        </div>
      )}
      {!loading && templates.length === 0 && (
        <div className="muted">No templates yet. Upload one above.</div>
      )}

      {templates.map((t) => (
        <TemplateCard
          key={t.id}
          template={t}
          introspection={introspections[t.id] ?? null}
          onIntrospection={(intro) => rememberIntrospection(t.id, intro)}
          onChanged={() => void load()}
          onError={setErr}
        />
      ))}
    </div>
  );
}

function TemplateCard(props: {
  template: PptTemplate;
  introspection: PptIntrospection | null;
  onIntrospection: (intro: PptIntrospection) => void;
  onChanged: () => void;
  onError: (msg: string | null) => void;
}) {
  const { template, introspection } = props;
  const [mapping, setMapping] = useState<Record<string, string>>(
    () => ({ ...template.layout_map }),
  );
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const reuploadRef = useRef<HTMLInputElement>(null);

  // When introspection arrives with a suggestedMap, prefill any canonical
  // layouts the admin hasn't mapped yet so the current mapping is visible.
  useEffect(() => {
    if (!introspection?.suggestedMap) return;
    setMapping((prev) => {
      const next = { ...prev };
      for (const [canonical, layoutName] of Object.entries(
        introspection.suggestedMap!,
      )) {
        if (!next[canonical]) next[canonical] = layoutName;
      }
      return next;
    });
  }, [introspection]);

  async function refreshLayouts() {
    setBusy(true);
    props.onError(null);
    try {
      const res = await api<{ introspection: PptIntrospection }>(
        `/api/ppt/templates/${template.id}/introspect`,
        { method: "POST" },
      );
      props.onIntrospection(res.introspection);
    } catch (e) {
      props.onError(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveMapping() {
    setBusy(true);
    setSaved(false);
    props.onError(null);
    try {
      // Drop unmapped ("") entries so the stored map only has real targets.
      const layout_map: Record<string, string> = {};
      for (const [k, v] of Object.entries(mapping)) {
        if (v) layout_map[k] = v;
      }
      await api(`/api/ppt/templates/${template.id}`, {
        method: "PATCH",
        body: JSON.stringify({ layout_map }),
      });
      setSaved(true);
      props.onChanged();
    } catch (e) {
      props.onError(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function reupload(file: File) {
    setBusy(true);
    props.onError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await apiForm<{
        template: PptTemplate;
        introspection: PptIntrospection;
      }>(`/api/ppt/templates/${template.id}/file`, form);
      props.onIntrospection(res.introspection);
      props.onChanged();
    } catch (e) {
      props.onError(formatErr(e));
    } finally {
      setBusy(false);
      if (reuploadRef.current) reuploadRef.current.value = "";
    }
  }

  const layouts = introspection?.ok ? introspection.layouts ?? [] : [];

  return (
    <div className="card col" style={{ gap: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <strong>{template.name}</strong>
          <div className="muted" style={{ fontSize: 12 }}>
            {[
              template.brand,
              `v${template.version}`,
              `updated ${new Date(template.updated_at).toLocaleString()}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="secondary"
            onClick={() => void refreshLayouts()}
            disabled={busy}
          >
            {busy ? <span className="spinner" /> : null}
            Refresh layouts
          </button>
          <button
            className="secondary"
            onClick={() => reuploadRef.current?.click()}
            disabled={busy}
          >
            Re-upload .pptx
          </button>
          <input
            ref={reuploadRef}
            type="file"
            accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void reupload(f);
            }}
          />
        </div>
      </div>

      {introspection && !introspection.ok && (
        <div className="alert error">
          Could not read this template
          {introspection.error ? `: ${introspection.error.message}` : "."}
        </div>
      )}

      {!introspection && (
        <div className="muted" style={{ fontSize: 13 }}>
          Click "Refresh layouts" to load this template's slide layouts and
          edit the mapping.
        </div>
      )}

      {layouts.length > 0 && (
        <>
          <table>
            <thead>
              <tr>
                <th style={{ width: 180 }}>Deck layout</th>
                <th>Template layout</th>
              </tr>
            </thead>
            <tbody>
              {PPT_LAYOUTS.map((canonical) => (
                <tr key={canonical}>
                  <td>{PPT_LAYOUT_LABELS[canonical]}</td>
                  <td>
                    <select
                      value={mapping[canonical] ?? ""}
                      onChange={(e) => {
                        setSaved(false);
                        setMapping((prev) => ({
                          ...prev,
                          [canonical]: e.target.value,
                        }));
                      }}
                    >
                      <option value="">(not mapped)</option>
                      {layouts.map((l) => (
                        <option key={l.index} value={l.name}>
                          {describeTemplateLayout(l)}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ gap: 8 }}>
            <button onClick={() => void saveMapping()} disabled={busy}>
              {busy ? <span className="spinner" /> : null}
              Save mapping
            </button>
            {saved && <span className="muted">Saved.</span>}
          </div>
        </>
      )}
    </div>
  );
}
