import { useState } from "react";
import { SocialChannels, encodeCampaignValue, type HubspotCampaign } from "@wac/shared";
import { useVocab } from "../lib/vocab.js";
import { api } from "../lib/api.js";

interface FanoutResp {
  parentAssetId: string;
  rows: Array<{
    channel: string;
    assetId: string;
    slug: string;
    shortUrl: string;
    taggedUrl: string;
  }>;
}

export function Social() {
  const { vocab, campaigns } = useVocab();
  const [name, setName] = useState("");
  const [destination, setDestination] = useState("https://waclighting.com/");
  const [campaign, setCampaign] = useState<HubspotCampaign | null>(null);
  const [medium, setMedium] = useState("social");
  const [content, setContent] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>(
    Object.fromEntries(SocialChannels.map((c) => [c, true])),
  );

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FanoutResp | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function onGenerate() {
    if (!campaign) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const channels = SocialChannels.filter((c) => selected[c]);
      const res = await api<FanoutResp>("/api/social/fanout", {
        method: "POST",
        body: JSON.stringify({
          name: name || `${campaign.name} - social fan-out`,
          destination,
          campaign: encodeCampaignValue(campaign),
          medium,
          content: content || undefined,
          channels,
        }),
      });
      setResult(res);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2>Social Fan-out</h2>
        <div className="muted">
          One action → one tagged link + short link + QR per social channel.
          Each row sets <code>utm_source</code> to the channel.
        </div>
      </div>

      <div className="card col">
        <div className="grid-2">
          <div>
            <label>Batch name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label>Destination URL</label>
            <input
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            />
          </div>
        </div>
        <div className="grid-3">
          <div>
            <label>Campaign</label>
            <select
              value={campaign ? encodeCampaignValue(campaign) : ""}
              onChange={(e) => {
                const v = e.target.value;
                setCampaign(
                  campaigns.find((c) => encodeCampaignValue(c) === v) ?? null,
                );
              }}
            >
              <option value="">— pick —</option>
              {campaigns.map((c) => (
                <option key={encodeCampaignValue(c)} value={encodeCampaignValue(c)}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Medium (shared)</label>
            <select value={medium} onChange={(e) => setMedium(e.target.value)}>
              {["social", "organic_social", "paid_social"].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {vocab.medium
                .filter((m) => !["social", "organic_social", "paid_social"].includes(m))
                .map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label>Content (shared, optional)</label>
            <select value={content} onChange={(e) => setContent(e.target.value)}>
              <option value="">— none —</option>
              {vocab.content.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label>Channels</label>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {SocialChannels.map((c) => (
              <label key={c} style={{ display: "inline-flex", gap: 6, marginRight: 12, textTransform: "none" }}>
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={!!selected[c]}
                  onChange={(e) =>
                    setSelected({ ...selected, [c]: e.target.checked })
                  }
                />
                {c}
              </label>
            ))}
          </div>
        </div>
        <button onClick={onGenerate} disabled={!campaign || busy}>
          {busy ? <span className="spinner" /> : null}
          Generate batch
        </button>
      </div>

      {err && <div className="alert error">{err}</div>}

      {result && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Short URL</th>
                <th>Tagged URL</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.channel}>
                  <td>{r.channel}</td>
                  <td>
                    <a href={r.shortUrl} target="_blank" rel="noreferrer">
                      {r.shortUrl}
                    </a>
                  </td>
                  <td>
                    <span className="preview" style={{ display: "block" }}>
                      {r.taggedUrl}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatErr(e: unknown): string {
  if (typeof e === "object" && e && "error" in e) {
    return String((e as { error: unknown }).error);
  }
  return e instanceof Error ? e.message : String(e);
}
