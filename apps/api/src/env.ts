export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  HUBSPOT_TOKEN?: string;
  // Sales Layer PIM (Phase 2), legacy Connector API (api.saleslayer.com).
  // Auth is sha256(connectorId + secretKey + time + unique). When unset
  // (dev / pre-launch) the products cache simply isn't refreshed.
  SALES_LAYER_CONNECTOR_ID?: string;
  SALES_LAYER_SECRET_KEY?: string;
  // The user originally pasted the secret here; accepted as a fallback for
  // SALES_LAYER_SECRET_KEY so existing .dev.vars keep working.
  SALES_LAYER_API_KEY?: string;
  // Optional overrides.
  SALES_LAYER_API_HOST?: string; // default api.saleslayer.com
  SALES_LAYER_API_VERSION?: string; // default 1.18
  // Source unit for raw Sales Layer fixture dimensions: "mm" | "cm" | "in".
  // WAC's catalog publishes inches, so the adapter defaults to "in".
  SALES_LAYER_DIMENSION_UNIT?: string;
  SHORT_LINK_HOST: string;
  SHORT_LINKS: KVNamespace;
  ASSETS_BUCKET: R2Bucket;
  ASSETS: Fetcher;
}
