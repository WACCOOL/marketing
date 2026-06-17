import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import type { HubspotCampaign } from "@wac/shared";

export type VocabType = "source" | "medium" | "content";

interface VocabResp {
  vocab: { source: string[]; medium: string[]; content: string[] };
  /** source value -> the medium values offered for it. Absent/empty => all mediums. */
  sourceMediums: Record<string, string[]>;
}
interface CampaignsResp {
  campaigns: HubspotCampaign[];
}

export function useVocab() {
  const [vocab, setVocab] = useState<VocabResp["vocab"]>({
    source: [],
    medium: [],
    content: [],
  });
  const [sourceMediums, setSourceMediums] = useState<Record<string, string[]>>({});
  const [campaigns, setCampaigns] = useState<HubspotCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [v, c] = await Promise.all([
        api<VocabResp>("/api/vocab"),
        api<CampaignsResp>("/api/vocab/campaigns"),
      ]);
      setVocab(v.vocab);
      setSourceMediums(v.sourceMediums ?? {});
      setCampaigns(c.campaigns);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { vocab, sourceMediums, campaigns, loading, err, refresh };
}

/** Add a vocab value. `content` is open to everyone; source/medium are admin-only. */
export async function addVocabValue(type: VocabType, value: string) {
  await api("/api/vocab", {
    method: "POST",
    body: JSON.stringify({ type, value }),
  });
}

export async function addContentValue(value: string) {
  await addVocabValue("content", value);
}

/** Toggle whether `medium` is offered for `source` (admin only). */
export async function setSourceMedium(
  source: string,
  medium: string,
  enabled: boolean,
) {
  await api("/api/vocab/source-medium", {
    method: "POST",
    body: JSON.stringify({ source, medium, enabled }),
  });
}
