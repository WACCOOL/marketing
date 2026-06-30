/**
 * Contact rep-code property logic (pure) — maps the Contract Master Sheet's
 * channel columns to the per-channel `rep_code_*` contact properties a HubSpot
 * workflow assigns by ZIP.
 *
 * A contact's ZIP is looked up in `rep_code_zips` (one rep code per channel);
 * each channel writes to its own property (label "Rep Code: <Channel>"). The
 * property internal names below MUST match the HubSpot contact schema exactly —
 * they're created once from this same list. A channel with no rep code for the
 * contact's ZIP clears its property (writes ""), so a ZIP change never leaves a
 * stale code behind.
 */

/**
 * The 10 Contract Master Sheet channels → contact property internal names, in
 * sheet/label order. The keys are the exact channel strings stored in
 * `rep_code_zips.channel`; the values are the `rep_code_<snake>` properties.
 */
export const CHANNEL_TO_CONTACT_PROP: Record<string, string> = {
  "WAC Showroom": "rep_code_wac_showroom",
  "WAC Spec": "rep_code_wac_spec",
  "WAC Landscape": "rep_code_wac_landscape",
  "WAC Fans": "rep_code_wac_fans",
  "MF Showroom": "rep_code_mf_showroom",
  "MF Designer": "rep_code_mf_designer",
  "MF Spec": "rep_code_mf_spec",
  Integration: "rep_code_integration",
  "Contract WAC": "rep_code_contract_wac",
  "Contract MF": "rep_code_contract_mf",
};

/** Every contact property this feature owns (stable order). */
export const CONTACT_REP_CODE_PROPS: string[] = Object.values(CHANNEL_TO_CONTACT_PROP);

/**
 * Build the full HubSpot `properties` patch for a contact from a zip lookup's
 * `byChannel` map ({@link CHANNEL_TO_CONTACT_PROP} keys → rep code). EVERY owned
 * property is included: a channel absent from `byChannel` is set to "" so a
 * previously-assigned code is cleared when the ZIP no longer covers that channel.
 * Unknown channels in `byChannel` (not in the map) are ignored — they have no
 * property to write to.
 */
export function buildContactRepCodeProps(
  byChannel: Record<string, string>,
): Record<string, string> {
  const props: Record<string, string> = {};
  for (const [channel, prop] of Object.entries(CHANNEL_TO_CONTACT_PROP)) {
    const code = byChannel[channel];
    props[prop] = typeof code === "string" ? code : "";
  }
  return props;
}
