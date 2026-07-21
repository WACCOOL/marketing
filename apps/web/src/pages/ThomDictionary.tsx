import { useState } from "react";
import { DEFAULT_PROTECTED_TERMS } from "@wac/shared/thom/protectedTerms";
import { addTerm, removeTerm, useThomDictionary } from "../lib/thomDictionary.js";

/**
 * Dictionary — protected names for Thom's public copy normalizer.
 *
 * The public bubble rewrites any bare "WAC" to "WAC Group" (copy rule). Names
 * that legitimately contain "WAC" — brands, product lines, the My WAC app —
 * must survive that rewrite. Terms added here take effect on the live bot
 * within ~5 minutes (the public agent caches the list), no deploy needed.
 */
export function ThomDictionary() {
  const { items, loading, err, refresh } = useThomDictionary();
  const [term, setTerm] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  async function submit() {
    const t = term.trim();
    if (!t) return;
    setBusy(true);
    setActionErr(null);
    try {
      await addTerm(t, note.trim() || null);
      setTerm("");
      setNote("");
      await refresh();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, t: string) {
    if (!window.confirm(`Remove "${t}" from the dictionary?`)) return;
    setBusy(true);
    setActionErr(null);
    try {
      await removeTerm(id);
      await refresh();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h1>Dictionary</h1>
        <div className="muted">
          Names Thom must never rewrite. The public bot upgrades any bare
          &ldquo;WAC&rdquo; to &ldquo;WAC Group&rdquo;; terms listed here are
          protected from that rewrite (for example &ldquo;My WAC&rdquo; stays
          &ldquo;My WAC&rdquo;, never &ldquo;My WAC Group&rdquo;). Changes go
          live within about 5 minutes.
        </div>
      </div>

      {err && <div className="alert error">Load failed: {err}</div>}
      {actionErr && <div className="alert error">{actionErr}</div>}

      <div className="card col" style={{ gap: 14 }}>
        <strong>Add a protected term</strong>
        <div className="grid-2">
          <label>
            Term
            <input
              value={term}
              placeholder={'e.g. "My WAC" or "WAC Home"'}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
          </label>
          <label>
            Note (optional)
            <input
              value={note}
              placeholder="What is it? Shown only here."
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
          </label>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button onClick={() => void submit()} disabled={busy || !term.trim()}>
            Add term
          </button>
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          A term must contain &ldquo;WAC&rdquo; (matching is case-insensitive;
          Thom restores the exact casing you enter here).
        </div>
      </div>

      <div className="card col" style={{ gap: 10 }}>
        <strong>Dictionary terms</strong>
        {loading ? (
          <div className="muted">Loading…</div>
        ) : items.length === 0 ? (
          <div className="muted">No custom terms yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Term</th>
                <th>Note</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td><strong>{it.term}</strong></td>
                  <td className="muted">{it.note ?? ""}</td>
                  <td>
                    <button
                      className="secondary"
                      onClick={() => void remove(it.id, it.term)}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card col" style={{ gap: 8 }}>
        <strong>Always protected (built in)</strong>
        <div className="muted" style={{ fontSize: 12 }}>
          These core names are protected in code and cannot be removed:
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {DEFAULT_PROTECTED_TERMS.map((t) => (
            <span key={t} className="tag">{t}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
