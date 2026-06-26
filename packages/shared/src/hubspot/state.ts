/**
 * US state / Canadian province 2-letter abbreviation → full name.
 *
 * Replicates the custom-code step (`VALUE_BY_ABBR`) of the "Account # to Rep Code
 * Syncing" HubSpot workflow: the Rep Code object's `state` is a dropdown of full
 * names, while the SAP/Company `state` carries the 2-letter code. Used by the
 * SAP→HubSpot writer and the territory-sync reconcile that absorb that workflow.
 */
export const STATE_ABBR_TO_NAME: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  DC: "District of Columbia",
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  ON: "Ontario",
  PE: "Prince Edward Island",
  QC: "Quebec",
  SK: "Saskatchewan",
};

/**
 * Map a 2-letter state/province code to its full name, or null when blank or
 * unrecognized (caller leaves the target unset, matching the workflow's SKIPPED
 * behavior). Trims and upper-cases the input.
 */
export function stateAbbrToName(abbr: unknown): string | null {
  if (abbr === null || abbr === undefined) return null;
  const key = String(abbr).trim().toUpperCase();
  if (!key) return null;
  return STATE_ABBR_TO_NAME[key] ?? null;
}
