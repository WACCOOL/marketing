import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

/** Marketing custom content — the authoring layer that feeds Thom's knowledge. */
export type ContentScope = "public" | "internal";
export type ContentStatus = "draft" | "published";

export interface ContentListItem {
  id: string;
  title: string;
  brand: string | null;
  scope: ContentScope;
  doc_subtype: string | null;
  status: ContentStatus;
  updated_at: string;
}

export interface ContentDetail extends ContentListItem {
  body: string;
}

export interface ContentInput {
  title: string;
  brand: string | null;
  scope: ContentScope;
  doc_subtype: string | null;
  body: string;
  status: ContentStatus;
}

export function useThomContent() {
  const [items, setItems] = useState<ContentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const { items } = await api<{ items: ContentListItem[] }>("/api/thom-content");
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

export async function getContent(id: string): Promise<ContentDetail> {
  const { item } = await api<{ item: ContentDetail }>(`/api/thom-content/${id}`);
  return item;
}

export async function createContent(input: ContentInput): Promise<string> {
  const { id } = await api<{ id: string }>("/api/thom-content", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return id;
}

export async function updateContent(id: string, input: ContentInput): Promise<void> {
  await api(`/api/thom-content/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function deleteContent(id: string): Promise<void> {
  await api(`/api/thom-content/${id}`, { method: "DELETE" });
}
