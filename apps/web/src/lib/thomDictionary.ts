import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

/** Thom dictionary — protected terms the public copy normalizer must never
 *  rewrite ("My WAC" must never become "My WAC Group"). */
export interface DictionaryTerm {
  id: string;
  term: string;
  note: string | null;
  updated_at: string;
}

export function useThomDictionary() {
  const [items, setItems] = useState<DictionaryTerm[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const { items } = await api<{ items: DictionaryTerm[] }>("/api/thom-dictionary");
      setItems(items);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { items, loading, err, refresh };
}

export async function addTerm(term: string, note: string | null): Promise<DictionaryTerm> {
  const { item } = await api<{ item: DictionaryTerm }>("/api/thom-dictionary", {
    method: "POST",
    body: JSON.stringify({ term, note }),
  });
  return item;
}

export async function removeTerm(id: string): Promise<void> {
  await api(`/api/thom-dictionary/${id}`, { method: "DELETE" });
}
