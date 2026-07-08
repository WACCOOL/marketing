import type { ShowroomOrder } from "./parse.js";

/**
 * Showroom order -> HubSpot deal property mapping. Every synced deal is a
 * Closed Won deal in the Universal Pipeline owned by Kalin Scott (the deals
 * record real showroom orders already placed, not opportunities).
 */

export const SHOWROOM_PIPELINE_ID = "723098519"; // Universal Pipeline
export const SHOWROOM_CLOSED_WON_STAGE_ID = "1054295854"; // Closed Won
export const SHOWROOM_OWNER_ID = "77005662"; // Kalin Scott

/** Unique dedupe-key property driving the batch upsert (hasUniqueValue). */
export const SHOWROOM_ORDER_KEY_PROP = "showroom_order_key";

/**
 * Custom deal properties this sync owns. All plain strings — the form's
 * dropdowns already constrain the values, so enum upkeep buys nothing.
 * Created idempotently by ensureShowroomDealProperties (apps/api).
 */
export const SHOWROOM_DEAL_PROPERTY_DEFS: {
  name: string;
  label: string;
  hasUniqueValue?: boolean;
}[] = [
  { name: SHOWROOM_ORDER_KEY_PROP, label: "Showroom Order Key", hasUniqueValue: true },
  { name: "showroom_agency", label: "Showroom Rep Agency" },
  { name: "showroom_sales_rep", label: "Showroom Sales Rep" },
  { name: "showroom_submitted_by", label: "Showroom Submitted By" },
  { name: "showroom_order_source", label: "Showroom Order Source" },
  { name: "showroom_trade_show", label: "Showroom Trade Show" },
  { name: "showroom_designer", label: "Showroom Designer" },
  { name: "showroom_brand", label: "Showroom Brand" },
];

/** "Metro Lighting — Schonbek PO 1734133" (blank PO -> the submission date). */
export function showroomDealName(order: ShowroomOrder): string {
  const parts: string[] = [];
  if (order.accountName) parts.push(order.accountName);
  const tail = order.po
    ? `PO ${order.po}`
    : order.timestampMs
      ? new Date(order.timestampMs).toISOString().slice(0, 10)
      : "order";
  parts.push([order.brand, tail].filter(Boolean).join(" "));
  return parts.join(" — ");
}

/** Full property payload for the deal batch upsert. Blank values are omitted. */
export function showroomDealProperties(order: ShowroomOrder): Record<string, string> {
  const props: Record<string, string> = {
    [SHOWROOM_ORDER_KEY_PROP]: order.orderKey,
    dealname: showroomDealName(order),
    pipeline: SHOWROOM_PIPELINE_ID,
    dealstage: SHOWROOM_CLOSED_WON_STAGE_ID,
    hubspot_owner_id: SHOWROOM_OWNER_ID,
    showroom_agency: order.agencyName,
  };
  if (order.amount !== null) props.amount = String(order.amount);
  // closedate AND createdate both anchor to the form-submission timestamp: the
  // deal records an order already placed, so its real-world creation IS the
  // submission moment. Deals accept createdate on create and update (see
  // deriveCreateDate), so the every-run upsert also repairs backfilled orders
  // whose createdate was stamped at first-sync time — months after their
  // closedate, which read as negative days-to-close.
  if (order.timestampMs !== null) {
    props.closedate = String(order.timestampMs);
    props.createdate = String(order.timestampMs);
  }
  if (order.po) props.po_number = order.po;
  if (order.accountNumber) props.account_number = order.accountNumber;
  if (order.salesRep) props.showroom_sales_rep = order.salesRep;
  if (order.submittedBy) props.showroom_submitted_by = order.submittedBy;
  if (order.orderSource) props.showroom_order_source = order.orderSource;
  if (order.tradeShow) props.showroom_trade_show = order.tradeShow;
  if (order.designer) props.showroom_designer = order.designer;
  if (order.brand) props.showroom_brand = order.brand;
  return props;
}
