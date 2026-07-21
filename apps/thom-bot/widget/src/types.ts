/**
 * The widget renders the SAME structured cards + citations the internal chat UI
 * does. Rather than redeclare them, we re-export the canonical types from the
 * shared Thom brain (packages/shared/src/thom/types.ts). The RENDER logic is
 * reimplemented here as pure DOM builders (see cards.ts) — we do NOT import the
 * React app.
 */
export type {
  Card,
  Citation,
  ProductCard,
  FamilyCard,
  PhotometricsCard,
  LayoutCard,
  LayoutBomLine,
  KeySpec,
  DocDownload,
  FamilyMember,
} from "@wac/shared/thom";

/** One turn in the running transcript (mirrors the internal ThomChat `Turn`). */
export interface Turn {
  role: "user" | "assistant";
  text: string;
  cards?: import("@wac/shared/thom").Card[];
  citations?: import("@wac/shared/thom").Citation[];
  error?: boolean;
  /** Client-minted uuid per assistant turn — the rating key for feedback
   *  (there is no server message id on the public surface). Persists with the
   *  turn so votes survive widget reopen within the session. */
  turnId?: string;
  /** The vote already cast on this turn, if any (1 = up, -1 = down). */
  feedback?: 1 | -1;
}
