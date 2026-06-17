import { useEffect, useMemo, useState } from "react";
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

// The builder form survives navigating away and back (and a reload) within the
// session, so a half-built UTM isn't lost by visiting another tab. Cleared on a
// successful save (the UTM is "complete") or via the Reset button.
const DRAFT_KEY = "wac-utm-builder-draft";
const DEFAULT_DESTINATION = "https://waclighting.com/";

interface BuilderDraft {
  name: string;
  destination: string;
  project: string;
  vanitySlug: string;
  campaign: HubspotCampaign | null;
  source: string;
  medium: string;
  content: string;
  newContent: string;
}

function loadDraft(): Partial<BuilderDraft> {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Partial<BuilderDraft>) : {};
  } catch {
    return {};
  }
}

export function Builder() {
  const {
    vocab,
    sourceMediums,
    campaigns,
    refresh,
    loading: vocabLoading,
    err: vocabErr,
  } = useVocab();

  const initial = useMemo(loadDraft, []);

  const [name, setName] = useState(initial.name ?? "");
  const [destination, setDestination] = useState(
    initial.destination ?? DEFAULT_DESTINATION,
  );
  const [project, setProject] = useState(initial.project ?? "");
  const [vanitySlug, setVanitySlug] = useState(initial.vanitySlug ?? "");
  const [campaign, setCampaign] = useState<HubspotCampaign | null>(
    initial.campaign ?? null,
  );
  const [source, setSource] = useState(initial.source ?? "");
  const [medium, setMedium] = useState(initial.medium ?? "");
  const [content, setContent] = useState(initial.content ?? "");
  const [newContent, setNewContent] = useState(initial.newContent ?? "");
  const [precomputed, setPrecomputed] = useState<{
    svg: string;
    pngBase64: string;
  } | null>(null);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SingleQrResp | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Persist the draft on every field change so it's there when the user returns.
  useEffect(() => {
    const draft: BuilderDraft = {
      name,
      destination,
      project,
      vanitySlug,
      campaign,
      source,
      medium,
      content,
      newContent,
    };
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* sessionStorage unavailable — drafts just won't persist */
    }
  }, [name, destination, project, vanitySlug, campaign, source, medium, content, newContent]);

  // The mediums offered for the chosen source. A source with no explicit mapping
  // is unconstrained, so it gets the full vocab; with no source picked yet there
  // are no medium options at all (the field stays disabled).
  const allowedMediums = useMemo(() => {
    if (!source) return [];
    const mapped = sourceMediums[source];
    return mapped && mapped.length > 0 ? mapped : vocab.medium;
  }, [source, sourceMediums, vocab.medium]);

  // A typed custom-content value takes precedence over the dropdown and is used
  // directly for the UTM without being added to the content list.
  const customContent = newContent.trim();
  const usingCustomContent = customContent.length > 0;
  const effectiveContent = usingCustomContent ? customContent : content;

  const { taggedUrl, fieldsErr } = useMemo(() => {
    if (!campaign || !source || !medium) {
      return { taggedUrl: null, fieldsErr: null };
    }
    try {
      const fields = UtmFieldsSchema.parse({
        source,
        medium,
        campaign: encodeCampaignValue(campaign),
        content: effectiveContent || undefined,
      });
      const url = buildTaggedUrl(destination, fields);
      return { taggedUrl: url, fieldsErr: null };
    } catch (e) {
      return {
        taggedUrl: null,
        fieldsErr: e instanceof Error ? e.message : String(e),
      };
    }
  }, [destination, source, medium, campaign, effectiveContent]);

  const auditWarnings = useMemo(
    () => (taggedUrl ? auditTaggedUrl(taggedUrl) : []),
    [taggedUrl],
  );

  function onSourceChange(next: string) {
    setSource(next);
    // Keep medium consistent with the new source: drop it if it's no longer
    // offered, and auto-pick when there's exactly one valid option.
    const mapped = sourceMediums[next];
    const allowed = mapped && mapped.length > 0 ? mapped : vocab.medium;
    if (allowed.length === 1) {
      setMedium(allowed[0]!);
    } else if (medium && !allowed.includes(medium)) {
      setMedium("");
    }
  }

  function onReset() {
    setName("");
    setDestination(DEFAULT_DESTINATION);
    setProject("");
    setVanitySlug("");
    setCampaign(null);
    setSource("");
    setMedium("");
    setContent("");
    setNewContent("");
    setPrecomputed(null);
    setResult(null);
    setErr(null);
    try {
      sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
  }

  async function onAddContent() {
    const value = customContent.toLowerCase();
    if (!value) return;
    try {
      await addContentValue(value);
      setContent(value);
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
            content: effectiveContent || undefined,
          },
          vanitySlug: vanitySlug || undefined,
          project: project || undefined,
          precomputed: precomputed ?? undefined,
        }),
      });
      setResult(res);
      // The UTM is complete — drop the saved draft so a later visit starts clean.
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch {
        /* ignore */
      }
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  const shortHost = import.meta.env.VITE_SHORT_LINK_HOST ?? "https://gowac.cc";

  return (
    <div className="col" style={{ gap: 20 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2>UTM Builder</h2>
          <div className="muted">
            Build one tagged URL + editable short link + QR. The QR encodes the
            short link, so you can change the destination later without
            reprinting.
          </div>
        </div>
        <button className="secondary" onClick={onReset} title="Clear all fields">
          Reset
        </button>
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
            <select
              value={source}
              onChange={(e) => onSourceChange(e.target.value)}
            >
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
            <select
              value={medium}
              onChange={(e) => setMedium(e.target.value)}
              disabled={!source}
            >
              <option value="">{source ? "— pick —" : "— pick a source first —"}</option>
              {allowedMediums.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            {source && allowedMediums.length === 0 && (
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                No mediums configured yet.
              </div>
            )}
          </div>
        </div>
        <div className="grid-2">
          <div>
            <label>Content</label>
            <select
              value={usingCustomContent ? "__custom__" : content}
              onChange={(e) => setContent(e.target.value)}
              disabled={usingCustomContent}
            >
              {usingCustomContent ? (
                <option value="__custom__">custom</option>
              ) : (
                <>
                  <option value="">— none —</option>
                  {vocab.content.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </>
              )}
            </select>
          </div>
          <div>
            <label>…or use / add a content value</label>
            <div className="row">
              <input
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder="e.g. new_landing"
              />
              <button
                className="secondary"
                onClick={onAddContent}
                disabled={!customContent || vocabLoading}
                title="Optional — save this value to the reusable content list"
                style={{ whiteSpace: "nowrap" }}
              >
                Add to Content List
              </button>
            </div>
            {usingCustomContent && (
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                Using <code>{customContent.toLowerCase()}</code> for this UTM.
                Adding to the list is optional.
              </div>
            )}
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
