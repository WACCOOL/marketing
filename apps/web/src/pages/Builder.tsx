import { useMemo, useState } from "react";
import {
  UtmFieldsSchema,
  auditTaggedUrl,
  buildTaggedUrl,
  encodeCampaignValue,
  type HubspotCampaign,
} from "@wac/shared";
import { addContentValue, useVocab } from "../lib/vocab.js";
import { QrPreview } from "../components/QrPreview.js";
import { api } from "../lib/api.js";

interface SingleQrResp {
  assetId: string;
  slug: string;
  shortUrl: string;
  taggedUrl: string;
}

export function Builder() {
  const { vocab, campaigns, refresh, loading: vocabLoading, err: vocabErr } = useVocab();

  const [name, setName] = useState("");
  const [destination, setDestination] = useState("https://waclighting.com/");
  const [project, setProject] = useState("");
  const [vanitySlug, setVanitySlug] = useState("");
  const [campaign, setCampaign] = useState<HubspotCampaign | null>(null);
  const [source, setSource] = useState("");
  const [medium, setMedium] = useState("");
  const [content, setContent] = useState("");
  const [newContent, setNewContent] = useState("");
  const [precomputed, setPrecomputed] = useState<{
    svg: string;
    pngBase64: string;
  } | null>(null);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SingleQrResp | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const { taggedUrl, fieldsErr } = useMemo(() => {
    if (!campaign || !source || !medium) {
      return { taggedUrl: null, fieldsErr: null };
    }
    try {
      const fields = UtmFieldsSchema.parse({
        source,
        medium,
        campaign: encodeCampaignValue(campaign),
        content: content || undefined,
      });
      const url = buildTaggedUrl(destination, fields);
      return { taggedUrl: url, fieldsErr: null };
    } catch (e) {
      return {
        taggedUrl: null,
        fieldsErr: e instanceof Error ? e.message : String(e),
      };
    }
  }, [destination, source, medium, campaign, content]);

  const auditWarnings = useMemo(
    () => (taggedUrl ? auditTaggedUrl(taggedUrl) : []),
    [taggedUrl],
  );

  async function onAddContent() {
    if (!newContent) return;
    try {
      await addContentValue(newContent);
      setContent(newContent);
      setNewContent("");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function onGenerate() {
    if (!campaign || !taggedUrl) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const res = await api<SingleQrResp>("/api/qr/single", {
        method: "POST",
        body: JSON.stringify({
          name: name || `${campaign.name} - ${source} - ${medium}`,
          destination,
          fields: {
            source,
            medium,
            campaign: encodeCampaignValue(campaign),
            content: content || undefined,
          },
          vanitySlug: vanitySlug || undefined,
          project: project || undefined,
          precomputed: precomputed ?? undefined,
        }),
      });
      setResult(res);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  const shortHost = import.meta.env.VITE_SHORT_LINK_HOST ?? "https://gowac.cc";

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2>UTM Builder</h2>
        <div className="muted">
          Build one tagged URL + editable short link + QR. The QR encodes the
          short link, so you can change the destination later without
          reprinting.
        </div>
      </div>

      {vocabErr && <div className="alert error">Vocab load failed: {vocabErr}</div>}

      <div className="card col">
        <div className="grid-2">
          <div>
            <label>QR / asset name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="HD Expo postcard"
            />
          </div>
          <div>
            <label>Project (optional)</label>
            <input
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="HD Expo 2026"
            />
          </div>
        </div>
        <div>
          <label>Destination URL</label>
          <input
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="https://waclighting.com/..."
          />
        </div>
        <div className="grid-3">
          <div>
            <label>Campaign (HubSpot)</label>
            <select
              value={campaign ? encodeCampaignValue(campaign) : ""}
              onChange={(e) => {
                const v = e.target.value;
                setCampaign(
                  campaigns.find((c) => encodeCampaignValue(c) === v) ?? null,
                );
              }}
            >
              <option value="">— pick a campaign —</option>
              {campaigns.map((c) => (
                <option key={encodeCampaignValue(c)} value={encodeCampaignValue(c)}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Source</label>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">— pick —</option>
              {vocab.source.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Medium</label>
            <select value={medium} onChange={(e) => setMedium(e.target.value)}>
              <option value="">— pick —</option>
              {vocab.medium.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid-2">
          <div>
            <label>Content</label>
            <select value={content} onChange={(e) => setContent(e.target.value)}>
              <option value="">— none —</option>
              {vocab.content.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>…or add a new content value</label>
            <div className="row">
              <input
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder="e.g. new_landing"
              />
              <button
                className="secondary"
                onClick={onAddContent}
                disabled={!newContent || vocabLoading}
              >
                Add
              </button>
            </div>
          </div>
        </div>
        <div className="grid-2">
          <div>
            <label>Vanity slug (optional)</label>
            <input
              value={vanitySlug}
              onChange={(e) => setVanitySlug(e.target.value)}
              placeholder="hd-expo"
            />
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Final URL: <code>{shortHost}/{vanitySlug || "auto"}</code>
            </div>
          </div>
        </div>
      </div>

      {fieldsErr && <div className="alert error">{fieldsErr}</div>}

      {taggedUrl && (
        <div className="card col">
          <div>
            <label>Tagged URL preview</label>
            <div className="preview">{taggedUrl}</div>
          </div>
          {auditWarnings.length > 0 && (
            <div className="alert warn">
              <strong>Audit warnings:</strong>
              <ul>
                {auditWarnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <label>QR preview (encodes the short link once generated)</label>
            <div className="row" style={{ gap: 24, alignItems: "flex-start" }}>
              <QrPreview
                data={result?.shortUrl ?? taggedUrl}
                onReady={setPrecomputed}
              />
              <div className="col" style={{ flex: 1 }}>
                <button onClick={onGenerate} disabled={busy || !taggedUrl}>
                  {busy ? <span className="spinner" /> : null}
                  Generate & save
                </button>
                {result && (
                  <div className="alert good">
                    Saved!{" "}
                    <a href={result.shortUrl} target="_blank" rel="noreferrer">
                      {result.shortUrl}
                    </a>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {err && <div className="alert error">{err}</div>}
    </div>
  );
}

function formatErr(e: unknown): string {
  if (typeof e === "object" && e && "error" in e) {
    return String((e as { error: unknown }).error);
  }
  return e instanceof Error ? e.message : String(e);
}
