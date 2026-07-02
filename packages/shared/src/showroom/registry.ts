/**
 * Registry of the rep-agency "PO Showroom Orders" Google Sheets (one per
 * agency, each a Google Forms responses sheet) synced to HubSpot deals by the
 * Worker (apps/api/src/showroomOrders.ts). Adding an agency = add an entry
 * here AND share the sheet with the sync service account (Viewer) — the
 * Google Cloud service account whose key lives in the GOOGLE_SA_KEY secret.
 */

export interface ShowroomSheet {
  /**
   * Short stable slug identifying the agency. It is baked into every deal's
   * `showroom_order_key` dedupe key, so changing it after rows have synced
   * would re-create all of that agency's deals — NEVER rename once live.
   */
  agencyKey: string;
  /** Display name, written to the `showroom_agency` deal property. */
  agencyName: string;
  /** The Google Sheets document id (from the sheet URL). */
  spreadsheetId: string;
  /** Tab holding the form responses. Defaults to "Form Responses 1". */
  tab?: string;
}

export const SHOWROOM_DEFAULT_TAB = "Form Responses 1";

export const SHOWROOM_SHEETS: ShowroomSheet[] = [
  {
    agencyKey: "williams",
    agencyName: "Williams Lighting Supply",
    spreadsheetId: "1UJOHYNLEOC1aZY9Wc9Z9vL0ElST6s95x6TuwQ9H08BA",
  },
  // Remaining agencies land here as Davis supplies the sheet URLs.
];
