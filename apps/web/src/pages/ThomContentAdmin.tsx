import { useState } from "react";
import {
  createContent,
  deleteContent,
  getContent,
  updateContent,
  useThomContent,
  type ContentInput,
  type ContentScope,
  type ContentStatus,
} from "../lib/thomContent.js";
import { useAuth } from "../lib/auth.js";

/**
 * Thom Knowledge — marketing authors curated overviews / positioning / FAQs
 * that become a first-class Thom retrieval source. Each publish is chunked +
 * embedded into the shared knowledge base on save. Internal/admin only.
 */

const BRANDS = ["WAC Lighting", "Modern Forms", "Schonbek", "AiSpire"];

const EMPTY: ContentInput = {
  title: "",
  brand: null,
  scope: "internal",
  doc_subtype: "",
  body: "",
  status: "draft",
};

export function ThomContentAdmin() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { items, loading, err, refresh } = useThomContent();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ContentInput>(EMPTY);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  function errMsg(e: unknown): string {
    if (typeof e === "object" && e && "error" in e) {
      return String((e as { error: unknown }).error);
    }
    return e instanceof Error ? e.message : String(e);
  }

  function startNew() {
    setEditingId(null);
    setForm(EMPTY);
    setActionErr(null);
    setOpen(true);
  }

  async function startEdit(id: string) {
    setActionErr(null);
    setBusy(true);
    try {
      const doc = await getContent(id);
      setForm({
        title: doc.title,
        brand: doc.brand,
        scope: doc.scope,
        doc_subtype: doc.doc_subtype ?? "",
        body: doc.body,
        status: doc.status,
      });
      setEditingId(id);
      setOpen(true);
    } catch (e) {
      setActionErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  function closeForm() {
    setOpen(false);
    setEditingId(null);
    setForm(EMPTY);
  }

  async function save() {
    if (!form.title.trim() || !form.body.trim()) {
      setActionErr("Title and body are required.");
      return;
    }
    setBusy(true);
    setActionErr(null);
    try {
      const payload: ContentInput = {
        ...form,
        title: form.title.trim(),
        brand: form.brand?.trim() ? form.brand.trim() : null,
        doc_subtype: form.doc_subtype?.trim() ? form.doc_subtype.trim() : null,
      };
      if (editingId) await updateContent(editingId, payload);
      else await createContent(payload);
      await refresh();
      closeForm();
    } catch (e) {
      setActionErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this knowledge entry? This removes it from Thom's knowledge base.")) {
      return;
    }
    setBusy(true);
    setActionErr(null);
    try {
      await deleteContent(id);
      await refresh();
      if (editingId === id) closeForm();
    } catch (e) {
      setActionErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 20 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2>Thom Knowledge</h2>
          <div className="muted">
            Author curated product / brand / system overviews, positioning, and
            FAQs. Publishing an entry adds it to Thom's knowledge base — it's
            chunked, embedded, and retrieved alongside spec sheets and manuals.
            Drafts are saved but not retrievable.
          </div>
        </div>
        {!open && (
          <button onClick={startNew} disabled={busy} style={{ whiteSpace: "nowrap" }}>
            New Entry
          </button>
        )}
      </div>

      {err && <div className="alert error">Load failed: {err}</div>}
      {actionErr && <div className="alert error">{actionErr}</div>}

      {open && (
        <div className="card col" style={{ gap: 14 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>{editingId ? "Edit entry" : "New entry"}</strong>
            <button className="secondary" onClick={closeForm} disabled={busy}>
              Cancel
            </button>
          </div>

          <div className="grid-2">
            <div>
              <label>Title</label>
              <input
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="e.g. AiSpire brand overview"
              />
            </div>
            <div>
              <label>Brand (optional)</label>
              <select
                value={form.brand ?? ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, brand: e.target.value || null }))
                }
              >
                <option value="">— none / all brands —</option>
                {BRANDS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid-2">
            <div>
              <label>Type (optional)</label>
              <input
                value={form.doc_subtype ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, doc_subtype: e.target.value }))}
                placeholder="e.g. overview, positioning, faq"
              />
            </div>
            <div>
              <label>Visibility</label>
              <select
                value={form.scope}
                onChange={(e) =>
                  setForm((f) => ({ ...f, scope: e.target.value as ContentScope }))
                }
              >
                <option value="internal">Internal only (default)</option>
                <option value="public">Public — also usable by the public bubble</option>
              </select>
              {form.scope === "public" && (
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  Public content is retrievable by the anon public chat bubble.
                  Only choose this for content safe to expose on the open web.
                </div>
              )}
            </div>
          </div>

          <div>
            <label>Body (markdown)</label>
            <textarea
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              rows={16}
              placeholder="Write the overview / positioning / FAQ in markdown…"
              style={{ width: "100%", fontFamily: "var(--font-mono, monospace)", fontSize: 13 }}
            />
          </div>

          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <label>Status</label>
              <select
                value={form.status}
                onChange={(e) =>
                  setForm((f) => ({ ...f, status: e.target.value as ContentStatus }))
                }
              >
                <option value="draft">Draft (not retrievable)</option>
                <option value="published">Published (in Thom's knowledge)</option>
              </select>
            </div>
            <button onClick={save} disabled={busy || !form.title.trim() || !form.body.trim()}>
              {busy ? <span className="spinner" /> : null} Save
            </button>
          </div>
        </div>
      )}

      <div className="card col">
        <div className="muted" style={{ fontSize: 11 }}>
          {items.length} {items.length === 1 ? "entry" : "entries"}
        </div>
        {loading ? (
          <div className="muted">
            <span className="spinner" /> Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="muted">No entries yet. Create one to start Thom's curated knowledge.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Brand</th>
                  <th>Type</th>
                  <th>Visibility</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td>{it.title}</td>
                    <td>{it.brand ?? <span className="muted">—</span>}</td>
                    <td>{it.doc_subtype ?? <span className="muted">—</span>}</td>
                    <td>
                      <span className="tag">{it.scope}</span>
                    </td>
                    <td>
                      <span className="tag">{it.status}</span>
                    </td>
                    <td className="muted" style={{ whiteSpace: "nowrap", fontSize: 12 }}>
                      {new Date(it.updated_at).toLocaleDateString()}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button className="secondary" onClick={() => startEdit(it.id)} disabled={busy}>
                        Edit
                      </button>
                      {isAdmin && (
                        <button
                          className="secondary"
                          onClick={() => remove(it.id)}
                          disabled={busy}
                          style={{ marginLeft: 6 }}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
