import { useCallback, useEffect, useState } from "react";
import { api, apiBlob, apiForm } from "./api.js";

/**
 * Admin knowledge uploads — education PDFs feeding Thom's RAG store
 * (lighting-expert plan, Prong C). Uploads land pending; the nightly
 * docs-ingest run (11:00 UTC) indexes them.
 */

export type UploadScope = "public" | "internal";

export interface UploadDocItem {
  id: string;
  title: string | null;
  brand: string | null;
  scope: UploadScope;
  status: "pending_extract" | "active" | "failed" | string;
  last_error: string | null;
  truncated: boolean;
  chunk_count: number;
  extracted_at: string | null;
  created_at: string;
}

export function useThomUploads() {
  const [items, setItems] = useState<UploadDocItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const { items } = await api<{ items: UploadDocItem[] }>("/api/thom-uploads");
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

export interface UploadDocInput {
  file: File;
  title: string;
  brand: string | null;
  scope: UploadScope;
  forceVision: boolean;
  /** Review-gate confirmation — required by the API when scope is public. */
  confirmed: boolean;
}

export async function uploadDoc(
  input: UploadDocInput,
): Promise<{ id: string; warning: string | null }> {
  const form = new FormData();
  form.set("file", input.file);
  form.set("title", input.title);
  if (input.brand) form.set("brand", input.brand);
  form.set("scope", input.scope);
  if (input.forceVision) form.set("force_vision", "1");
  if (input.confirmed) form.set("confirmed", "true");
  return apiForm<{ id: string; warning: string | null }>("/api/thom-uploads", form);
}

export async function reingestDoc(id: string): Promise<void> {
  await api(`/api/thom-uploads/${id}/reingest`, { method: "POST" });
}

export async function deleteUploadDoc(id: string): Promise<void> {
  await api(`/api/thom-uploads/${id}`, { method: "DELETE" });
}

export async function setUploadDocScope(
  id: string,
  scope: UploadScope,
  confirmed: boolean,
): Promise<void> {
  await api(`/api/thom-uploads/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ scope, confirmed }),
  });
}

/** Open the stored PDF in a new tab (the GET is auth'd, so a plain link can't
 *  carry the bearer token — fetch the blob, then open an object URL). */
export async function openUploadPdf(id: string): Promise<void> {
  const blob = await apiBlob(`/api/thom-uploads/${id}/file`);
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener");
  // Give the new tab time to grab it before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
