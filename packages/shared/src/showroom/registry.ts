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

// All 21 live sheets verified readable by the service account 2026-07-02;
// names come from each spreadsheet's title ("<Agency>: PO Showroom Orders").
export const SHOWROOM_SHEETS: ShowroomSheet[] = [
  { agencyKey: "all-the-best", agencyName: "All The Best", spreadsheetId: "1_1nRdZGoL7IvVg40u9ZLDbIB_ZD8Eo2KcLIR3-CI-Ls" },
  { agencyKey: "anderson", agencyName: "Anderson", spreadsheetId: "1h2ZMdDPCz_Z8KpnHTm9oNbq87-itvrvgxjDeE8XjvTE" },
  { agencyKey: "carlos-leon", agencyName: "Carlos Leon", spreadsheetId: "1moScsx6NONyf-Nvm2pusDLIwHLRz1otYwVT7NgICiiY" },
  { agencyKey: "decor", agencyName: "Decor Lighting", spreadsheetId: "1BZFlU5zINwKnyrg4ycRtRW0BceiR6kO_7MUdt6GScVc" },
  { agencyKey: "dunn", agencyName: "Dunn", spreadsheetId: "1zh_GZtPIIuEZEAQsbZdNUQ6TzhkEryksleyx63kwfMA" },
  { agencyKey: "enlightening", agencyName: "Enlightening", spreadsheetId: "1sk_sJfnDPhSTqyr-9nfyHFLIxUBmkYStu6sk_JSvTHc" },
  { agencyKey: "fletcher", agencyName: "Fletcher", spreadsheetId: "16Kc49-eppGVepbhGGmckWdrkoiGjHl0sXgOqDGw3vH8" },
  { agencyKey: "gillen-brienza", agencyName: "Gillen & Brienza", spreadsheetId: "1-il9Lzg8I-o_qn4O9a8mg6Si2tlhoWnfO3ybODbvQRY" },
  { agencyKey: "glassman", agencyName: "Glassman", spreadsheetId: "1ywtodl9Kwpm95k0rfAGqaEsmNzaDdKicUgC1nmIojLo" },
  { agencyKey: "gray-electrical", agencyName: "Gray Electrical", spreadsheetId: "1i_Yk7sbDldxAmQFsz8c__KqocxoSeTNXjTs3TfL9lJs" },
  { agencyKey: "jensen", agencyName: "Jensen Lighting", spreadsheetId: "16gViIDf9QkRdr-nbUL2HvLTbdYx3BlL3HImNBb_cvw8" },
  { agencyKey: "jim", agencyName: "JIM", spreadsheetId: "1KG9QUtwVod_N2IKdOPATuF6IuLqw1aLnYK9Cj90cUxg" },
  { agencyKey: "ktr", agencyName: "KTR", spreadsheetId: "1DKn_nTBM_QNXLgjGz4d9zs2Z6iCsbJU-fYXYjPTTwoM" },
  { agencyKey: "laidco", agencyName: "Laidco", spreadsheetId: "1xF2grxalopXl1kVkSyHb9vsmhJT_oxDlSbPjtv4iiXc" },
  { agencyKey: "pacific-light-force", agencyName: "Pacific Light Force", spreadsheetId: "15APus4HpMbqR-QCX5HSZio2xOGfXNFUGch3j-f8eu4I" },
  { agencyKey: "ridgeway", agencyName: "Ridgeway", spreadsheetId: "1vbY4BhDutbrrDmzHyZCfR83V5FamEZKKn8xykAGpx3E" },
  { agencyKey: "ripple", agencyName: "Ripple Associates", spreadsheetId: "1SC_UsHHL29UPAXoKx2tsT4MR_QAmxk2yc9g3lhPSgm0" },
  { agencyKey: "southern-glow", agencyName: "Southern Glow", spreadsheetId: "1v6mCa6gHmAhHb0j47FsB7ijAEMv7NX22YfJ9Hdy1RpM" },
  { agencyKey: "t-and-t", agencyName: "T&T", spreadsheetId: "13k1uO8PQwcAbTGe93e9knmA6O6ap5-BHxKeIXIWR9Ug" },
  { agencyKey: "walker-willis", agencyName: "Walker & Willis", spreadsheetId: "153hEr7eKO7f99dIjfW7cOSsNitZCvBh-TOikKlyKsYk" },
  { agencyKey: "williams", agencyName: "Williams Lighting Supply", spreadsheetId: "1UJOHYNLEOC1aZY9Wc9Z9vL0ElST6s95x6TuwQ9H08BA" },
];
