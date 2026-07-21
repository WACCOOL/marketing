import { useRef, useState } from "react";
import { errorMessage } from "../lib/api.js";
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
import {
  deleteUploadDoc,
  openUploadPdf,
  reingestDoc,
  setUploadDocScope,
  uploadDoc,
  useThomUploads,
  type UploadDocItem,
  type UploadScope,
} from "../lib/thomUploads.js";
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

      <DocumentsSection isAdmin={isAdmin} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Documents — admin-uploaded education PDFs (lighting-expert plan, Prong C.4)
// ---------------------------------------------------------------------------

/** C.4 review-gate wording — shown before any flip (or direct upload) to public. */
const REVIEW_GATE_PROMPT =
  "Public review gate:\n\n" +
  "I have checked this document for third-party brand names, and the content " +
  "is verified public-domain or government material safe for the public chat " +
  "bubble.\n\nOK = checked for third-party brand names; content verified.";

function DocumentsSection({ isAdmin }: { isAdmin: boolean }) {
  const { items, loading, err, refresh } = useThomUploads();

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [brand, setBrand] = useState("");
  const [scope, setScope] = useState<UploadScope>("internal");
  const [forceVision, setForceVision] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submitUpload() {
    if (!file) {
      setActionErr("Choose a .pdf file to upload.");
      return;
    }
    if (!title.trim()) {
      setActionErr("Title is required.");
      return;
    }
    // Uploading straight to Public passes through the same review gate as the
    // scope flip — the API rejects it without the confirmation.
    let confirmed = false;
    if (scope === "public") {
      confirmed = window.confirm(REVIEW_GATE_PROMPT);
      if (!confirmed) return;
    }
    setBusy(true);
    setActionErr(null);
    setNotice(null);
    try {
      const res = await uploadDoc({
        file,
        title: title.trim(),
        brand: brand.trim() || null,
        scope,
        forceVision,
        confirmed,
      });
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      setTitle("");
      setBrand("");
      setScope("internal");
      setForceVision(false);
      setNotice(
        `Uploaded. It will be indexed by the nightly ingest (11:00 UTC).` +
          (res.warning ? ` Note: ${res.warning}` : ""),
      );
      await refresh();
    } catch (e) {
      setActionErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setActionErr(null);
    setNotice(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setActionErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function flipScope(doc: UploadDocItem) {
    if (doc.scope === "internal") {
      if (!window.confirm(REVIEW_GATE_PROMPT)) return;
      void run(() => setUploadDocScope(doc.id, "public", true));
    } else {
      void run(() => setUploadDocScope(doc.id, "internal", false));
    }
  }

  function removeDoc(doc: UploadDocItem) {
    if (
      !window.confirm(
        `Delete "${doc.title ?? "this document"}"? This removes it from Thom's knowledge base and deletes the stored PDF.`,
      )
    ) {
      return;
    }
    void run(() => deleteUploadDoc(doc.id));
  }

  function statusCell(doc: UploadDocItem) {
    if (doc.status === "pending_extract") {
      return (
        <>
          <span className="tag">pending</span>
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            indexed by the nightly ingest (11:00 UTC)
          </div>
        </>
      );
    }
    if (doc.status === "failed") {
      return (
        <>
          <span className="tag">failed</span>
          {doc.last_error && (
            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{doc.last_error}</div>
          )}
        </>
      );
    }
    return (
      <>
        <span className="tag">{doc.status}</span>
        {doc.truncated && (
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            truncated: {doc.last_error}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="col" style={{ gap: 14 }}>
      <div>
        <h2>Documents</h2>
        <div className="muted">
          Upload education PDFs (energy codes, design guides, lighting
          fundamentals) into Thom's knowledge base. Uploads are indexed by the
          nightly ingest with real page numbers, so Thom can cite
          "document, p.N".
        </div>
      </div>

      {err && <div className="alert error">Load failed: {err}</div>}
      {actionErr && <div className="alert error">{actionErr}</div>}
      {notice && <div className="alert good">{notice}</div>}

      <div className="card col" style={{ gap: 12 }}>
        <strong>Upload a PDF</strong>
        <div className="grid-2">
          <div>
            <label>File (.pdf, max 30 MB)</label>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div>
            <label>Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder='e.g. "CA Title 24 Part 6 (2025)"'
            />
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              For standards and codes, include the edition or year in the title
              so citations are unambiguous.
            </div>
          </div>
        </div>
        <div className="grid-2">
          <div>
            <label>Brand (optional)</label>
            <select value={brand} onChange={(e) => setBrand(e.target.value)}>
              <option value="">— none / all brands —</option>
              {BRANDS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Visibility</label>
            <select value={scope} onChange={(e) => setScope(e.target.value as UploadScope)}>
              <option value="internal">Internal only (default)</option>
              <option value="public">Public — also usable by the public bubble</option>
            </select>
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Licensed or purchased documents (IES, ASHRAE, ICC) must stay
              Internal. Public is only for public-domain/government documents.
            </div>
          </div>
        </div>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={forceVision}
              onChange={(e) => setForceVision(e.target.checked)}
            />
            Force vision extraction (scanned or table-heavy PDF; capped at 100 pages)
          </label>
          <button onClick={submitUpload} disabled={busy || !file || !title.trim()}>
            {busy ? <span className="spinner" /> : null} Upload
          </button>
        </div>
      </div>

      <div className="card col">
        <div className="muted" style={{ fontSize: 11 }}>
          {items.length} {items.length === 1 ? "document" : "documents"}
        </div>
        {loading ? (
          <div className="muted">
            <span className="spinner" /> Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="muted">No documents yet. Upload a PDF to grow Thom's education library.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Brand</th>
                  <th>Visibility</th>
                  <th>Status</th>
                  <th>Chunks</th>
                  <th>Uploaded</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((doc) => (
                  <tr key={doc.id}>
                    <td>{doc.title ?? <span className="muted">—</span>}</td>
                    <td>{doc.brand ?? <span className="muted">—</span>}</td>
                    <td>
                      <span className="tag">{doc.scope}</span>
                    </td>
                    <td>{statusCell(doc)}</td>
                    <td>{doc.chunk_count || <span className="muted">—</span>}</td>
                    <td className="muted" style={{ whiteSpace: "nowrap", fontSize: 12 }}>
                      {new Date(doc.created_at).toLocaleDateString()}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button
                        className="secondary"
                        onClick={() => void openUploadPdf(doc.id).catch((e) => setActionErr(errorMessage(e)))}
                        disabled={busy}
                      >
                        PDF
                      </button>
                      <button
                        className="secondary"
                        onClick={() => void run(() => reingestDoc(doc.id))}
                        disabled={busy}
                        style={{ marginLeft: 6 }}
                      >
                        Re-ingest
                      </button>
                      <button
                        className="secondary"
                        onClick={() => flipScope(doc)}
                        disabled={busy}
                        style={{ marginLeft: 6 }}
                      >
                        {doc.scope === "internal" ? "Make public" : "Make internal"}
                      </button>
                      {isAdmin && (
                        <button
                          className="secondary"
                          onClick={() => removeDoc(doc)}
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
