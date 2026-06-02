import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import type { HubspotCampaign } from "@wac/shared";

interface VocabResp {
  vocab: { source: string[]; medium: string[]; content: string[] };
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

  return { vocab, campaigns, loading, err, refresh };
}

export async function addContentValue(value: string) {
  await api("/api/vocab", {
    method: "POST",
    body: JSON.stringify({ type: "content", value }),
  });
}
