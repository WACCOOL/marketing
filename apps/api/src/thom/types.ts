/** Structured, UI-renderable pieces the agent emits alongside its prose. */

export interface KeySpec {
  label: string;
  value: string;
}

export interface DocDownload {
  label: string;
  url: string;
  doc_type: string;
}

/** A product card — image + key specs + PDP link + document downloads. */
export interface ProductCard {
  sku: string;
  name: string | null;
  brand: string | null;
  image_url: string | null;
  key_specs: KeySpec[];
  pdp_url: string | null;
  downloads: DocDownload[];
}

/** A source citation back to the spec sheet / manual a claim came from. */
export interface Citation {
  document_id: string;
  title: string | null;
  doc_type: string;
  page: number | null;
  url: string | null;
}

export interface ThomUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  model: string;
}
