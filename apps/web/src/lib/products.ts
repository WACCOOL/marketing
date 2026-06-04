import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import type { Product } from "@wac/shared";

interface ProductsResp {
  products: Product[];
  total: number;
}

/**
 * Search the local Sales Layer product cache. Debounced search-as-you-type lives
 * in the consuming component; this hook just owns the request lifecycle so it can
 * be reused by both the Products browser page and the Phase 2 fixture picker.
 */
export function useProducts(initialQuery = "") {
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState(initialQuery);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const search = useCallback(async (q: string, brand?: string) => {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (brand && brand.trim()) params.set("brand", brand.trim());
      const qs = params.toString();
      const res = await api<ProductsResp>(
        "/api/products" + (qs ? `?${qs}` : ""),
      );
      setProducts(res.products);
      setTotal(res.total);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void search(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { products, total, query, setQuery, search, loading, err };
}

export async function syncProducts(): Promise<{ ok: boolean; started: boolean }> {
  return api("/api/products/sync", { method: "POST" });
}

/** Distinct brand names for the picker facet. */
export async function fetchProductBrands(): Promise<string[]> {
  const res = await api<{ brands: string[] }>("/api/products/brands");
  return res.brands;
}

export function formatDimensions(d: Product["dimensions_mm"]): string {
  if (!d) return "—";
  const parts: string[] = [];
  if (d.width) parts.push(`W ${d.width}`);
  if (d.height) parts.push(`H ${d.height}`);
  if (d.depth) parts.push(`D ${d.depth}`);
  if (d.diameter) parts.push(`⌀ ${d.diameter}`);
  if (d.length) parts.push(`L ${d.length}`);
  return parts.length ? `${parts.join(" × ")} mm` : "—";
}

function formatErr(e: unknown): string {
  if (typeof e === "object" && e && "error" in e) {
    return String((e as { error: unknown }).error);
  }
  return e instanceof Error ? e.message : String(e);
}
