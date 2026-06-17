import { useState } from "react";
import { addVocabValue, setSourceMedium, useVocab } from "../lib/vocab.js";

/**
 * Admin-only "Sources & Mediums" tab. Lets admins extend the UTM source/medium
 * vocab and configure which mediums the builder offers for each source. A source
 * with no mediums checked is unconstrained — the builder offers the full list.
 */
export function VocabAdmin() {
  const { vocab, sourceMediums, refresh, loading, err } = useVocab();

  const [newSource, setNewSource] = useState("");
  const [newMedium, setNewMedium] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  function errMsg(e: unknown): string {
    if (typeof e === "object" && e && "error" in e) {
      return String((e as { error: unknown }).error);
    }
    return e instanceof Error ? e.message : String(e);
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setActionErr(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setActionErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function onAddSource() {
    const value = newSource.trim().toLowerCase();
    if (!value) return;
    await run(async () => {
      await addVocabValue("source", value);
      setNewSource("");
    });
  }

  async function onAddMedium() {
    const value = newMedium.trim().toLowerCase();
    if (!value) return;
    await run(async () => {
      await addVocabValue("medium", value);
      setNewMedium("");
    });
  }

  function toggle(source: string, medium: string, enabled: boolean) {
    void run(() => setSourceMedium(source, medium, enabled));
  }

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2>Sources &amp; Mediums</h2>
        <div className="muted">
          Extend the UTM source / medium vocabulary and set which mediums the
          builder offers for each source. A source with no mediums checked is
          unconstrained — the builder offers the full medium list.
        </div>
      </div>

      {err && <div className="alert error">Vocab load failed: {err}</div>}
      {actionErr && <div className="alert error">{actionErr}</div>}

      <div className="grid-2">
        <div className="card col">
          <div>
            <label>Add a source</label>
            <div className="row">
              <input
                value={newSource}
                onChange={(e) => setNewSource(e.target.value)}
                placeholder="e.g. webinar"
                onKeyDown={(e) => e.key === "Enter" && onAddSource()}
              />
              <button
                className="secondary"
                onClick={onAddSource}
                disabled={busy || !newSource.trim()}
                style={{ whiteSpace: "nowrap" }}
              >
                Add Source
              </button>
            </div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
              {vocab.source.length} sources
            </div>
            <div>
              {vocab.source.map((s) => (
                <span key={s} className="tag">
                  {s}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="card col">
          <div>
            <label>Add a medium</label>
            <div className="row">
              <input
                value={newMedium}
                onChange={(e) => setNewMedium(e.target.value)}
                placeholder="e.g. webinar_invite"
                onKeyDown={(e) => e.key === "Enter" && onAddMedium()}
              />
              <button
                className="secondary"
                onClick={onAddMedium}
                disabled={busy || !newMedium.trim()}
                style={{ whiteSpace: "nowrap" }}
              >
                Add Medium
              </button>
            </div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
              {vocab.medium.length} mediums
            </div>
            <div>
              {vocab.medium.map((m) => (
                <span key={m} className="tag">
                  {m}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="card col">
        <div>
          <label>Source → Medium mapping</label>
          <div className="muted" style={{ fontSize: 12 }}>
            Check the mediums each source should offer in the builder. Leave a
            row empty to allow every medium.
          </div>
        </div>
        {loading ? (
          <div className="muted">
            <span className="spinner" /> Loading…
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  {vocab.medium.map((m) => (
                    <th key={m} style={{ textAlign: "center" }}>
                      {m}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {vocab.source.map((s) => {
                  const allowed = sourceMediums[s] ?? [];
                  const unconstrained = allowed.length === 0;
                  return (
                    <tr key={s}>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {s}
                        {unconstrained && (
                          <span className="muted" style={{ fontSize: 11 }}>
                            {" "}
                            (all)
                          </span>
                        )}
                      </td>
                      {vocab.medium.map((m) => {
                        const checked = allowed.includes(m);
                        return (
                          <td key={m} style={{ textAlign: "center" }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={busy}
                              onChange={(e) => toggle(s, m, e.target.checked)}
                              style={{ width: 16, height: 16, margin: 0, cursor: "pointer" }}
                              aria-label={`${s} → ${m}`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
