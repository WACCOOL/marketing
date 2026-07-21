/**
 * The public Thom chat widget controller (framework-free).
 *
 * Wires together: the start-of-chat warning banner, the streaming transcript
 * (markdown prose + product/family/layout cards + citation chips), the composer,
 * Turnstile → session-token minting, and session-only localStorage history. It
 * talks exclusively to same-origin /api/* (served by the same Worker), so there
 * is no CORS and no auth beyond the Turnstile-minted session token.
 */
import { showFeedbackRow } from "@wac/shared/thom/feedback";
import { el, svgEl } from "./dom.js";
import { renderCard, renderCitations } from "./cards.js";
import { renderMarkdown } from "./markdown.js";
import { chatStream } from "./stream.js";
import { fetchConfig } from "./config.js";
import { renderChallenge, mintSession } from "./turnstile.js";
import {
  clearHistory,
  clearSessionToken,
  getSessionId,
  loadHistory,
  loadSessionToken,
  randomId,
  saveHistory,
  saveSessionToken,
  toRequestHistory,
} from "./session.js";
import type { Card, Citation, Turn } from "./types.js";

/** EXACT required disclaimer copy. Do not edit without product sign-off. */
export const WARNING_COPY =
  "Thom is an AI assistant and can make mistakes. Answers, including specs, " +
  "compatibility, and availability, aren't guaranteed. Please confirm anything " +
  "important with WAC Group or your sales rep before you rely on it.";

/** Feedback disclosure (F4): rendered STATICALLY whenever the thumbs row
 *  renders — visible before either vote is cast, never tooltip-only (mobile
 *  has no hover). Wording AND placement are Davis sign-off items, same bar as
 *  WARNING_COPY. Do not edit without product sign-off. */
export const FEEDBACK_DISCLOSURE_COPY =
  "Sending feedback shares this question and Thom's answer with WAC Group " +
  "so we can improve Thom.";

const EXAMPLES = [
  "I need a warm-dim 3-inch downlight for a damp bathroom.",
  "What low-voltage landscape path lights do you have?",
  "Recommend a Schonbek crystal chandelier for a two-story foyer.",
];

/** Post a message up to the host page (embed.js listens). */
function postToParent(msg: Record<string, unknown>): void {
  try {
    window.parent?.postMessage({ source: "thom-widget", ...msg }, "*");
  } catch {
    /* not embedded / blocked — ignore */
  }
}

export class ThomWidget {
  private root: HTMLElement;
  private siteKey: string;
  private sessionId: string;
  private turnstileSiteKey = "";
  private sessionToken: string | null = null;
  private turns: Turn[] = [];
  private busy = false;
  private abort: AbortController | null = null;
  // Feedback (thumbs) — dark unless /api/config advertises it.
  private feedbackEnabled = false;
  /** turnId whose thumbs-down reason box is open, if any. */
  private reasonOpenFor: string | null = null;
  /** Transient per-turn "Couldn't send feedback" notes (never persisted). */
  private feedbackNotes = new Map<string, string>();
  private outerCloseBound: ((e: MouseEvent) => void) | null = null;

  private listEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendEl!: HTMLButtonElement;
  private challengeEl!: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.siteKey = new URLSearchParams(location.search).get("site_key") ?? "";
    this.sessionId = getSessionId(this.siteKey);
    this.turns = loadHistory(this.siteKey, this.sessionId);
    // Reuse a still-valid session from a previous visit, so a returning visitor
    // is not re-challenged. null when absent/expired → challenge on first send.
    this.sessionToken = loadSessionToken(this.siteKey);
  }

  async mount(): Promise<void> {
    this.buildChrome();
    this.renderTurns();
    postToParent({ type: "thom:ready" });
    const cfg = await fetchConfig();
    this.turnstileSiteKey = cfg.turnstileSiteKey;
    if (cfg.feedbackEnabled !== this.feedbackEnabled) {
      this.feedbackEnabled = cfg.feedbackEnabled;
      this.renderTurns(); // reopened transcripts gain their thumbs rows
    }
    // Only warm a session up front if we already have a stored token (instant,
    // no challenge). A brand-new visitor is challenged on their first send, not
    // on page load.
    if (this.turnstileSiteKey && this.sessionToken) void this.ensureSession().catch(() => {});
  }

  // --- chrome ---------------------------------------------------------------

  private buildChrome(): void {
    const header = el("header", { class: "thom-head" }, [
      el("div", { class: "thom-brand" }, [
        el("span", { class: "thom-logo", "aria-hidden": "true" }, [
          svgEl(
            "svg",
            {
              viewBox: "0 0 24 24",
              width: 20,
              height: 20,
              fill: "none",
              stroke: "currentColor",
              "stroke-width": 2,
              "stroke-linecap": "round",
              "stroke-linejoin": "round",
            },
            [
              svgEl("path", { d: "M12 8V4H8" }),
              svgEl("rect", { width: 16, height: 12, x: 4, y: 8, rx: 2 }),
              svgEl("path", { d: "M2 14h2" }),
              svgEl("path", { d: "M20 14h2" }),
              svgEl("path", { d: "M15 13v2" }),
              svgEl("path", { d: "M9 13v2" }),
            ],
          ),
        ]),
        el("div", {}, [
          el("strong", { text: "Thom" }),
          el("span", { class: "thom-muted thom-brand-sub", text: "WAC Group assistant" }),
        ]),
      ]),
      el("div", { class: "thom-head-actions" }, [
        this.button("New chat", "thom-btn-ghost", () => this.newChat()),
        this.iconButton("✕", "Close chat", () => postToParent({ type: "thom:close" })),
      ]),
    ]);

    this.listEl = el("div", { class: "thom-scroll", role: "log", "aria-live": "polite" });

    this.inputEl = el("textarea", {
      class: "thom-input",
      rows: 1,
      placeholder: "Ask about a product, spec, or recommendation…",
      "aria-label": "Message Thom",
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send(this.inputEl.value);
      }
    });
    this.sendEl = this.button("Send", "thom-btn-primary thom-send", () => void this.send(this.inputEl.value));
    this.sendEl.setAttribute("aria-label", "Send message");

    const composer = el("div", { class: "thom-composer" }, [this.inputEl, this.sendEl]);

    this.challengeEl = el("div", { class: "thom-challenge", hidden: true });

    this.root.replaceChildren(el("div", { class: "thom-widget" }, [header, this.listEl, this.challengeEl, composer]));
  }

  private button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", { class: `thom-btn ${cls}`, type: "button", text: label });
    b.addEventListener("click", onClick);
    return b;
  }

  private iconButton(glyph: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", { class: "thom-btn thom-btn-icon", type: "button", "aria-label": label, title: label, text: glyph });
    b.addEventListener("click", onClick);
    return b;
  }

  // --- rendering ------------------------------------------------------------

  private warningBanner(): HTMLElement {
    return el("div", { class: "thom-warning", role: "note" }, [WARNING_COPY]);
  }

  private renderTurns(): void {
    const nodes: (Node | null)[] = [this.warningBanner()];
    if (this.turns.length === 0) {
      nodes.push(
        el("div", { class: "thom-empty" }, [
          el("h2", { text: "Ask Thom anything about WAC Group products" }),
          el("p", { class: "thom-muted", text: "Specs, spec sheets, install manuals, lighting design, or a competitor match." }),
          el(
            "div",
            { class: "thom-examples" },
            EXAMPLES.map((ex) => {
              const b = el("button", { class: "thom-example", type: "button", text: ex });
              b.addEventListener("click", () => void this.send(ex));
              return b;
            }),
          ),
        ]),
      );
    } else {
      for (let i = 0; i < this.turns.length; i++) {
        const turn = this.turns[i];
        if (!turn) continue;
        const streaming = this.busy && i === this.turns.length - 1 && turn.role === "assistant";
        nodes.push(this.turnView(turn, streaming));
      }
    }
    this.listEl.replaceChildren(...nodes.filter(Boolean) as Node[]);
    this.scrollToBottom();
  }

  /** The lucide "bot" mark used in the header, at an arbitrary size. */
  private robotIcon(size: number): SVGElement {
    return svgEl(
      "svg",
      {
        viewBox: "0 0 24 24",
        width: size,
        height: size,
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 2,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
      [
        svgEl("path", { d: "M12 8V4H8" }),
        svgEl("rect", { width: 16, height: 12, x: 4, y: 8, rx: 2 }),
        svgEl("path", { d: "M2 14h2" }),
        svgEl("path", { d: "M20 14h2" }),
        svgEl("path", { d: "M15 13v2" }),
        svgEl("path", { d: "M9 13v2" }),
      ],
    );
  }

  /** Pre-first-token placeholder: the robot with a scanning beam and a
   *  "Searching…" label. The whole tool phase happens before the first text
   *  delta (the prompt forbids narrating searches), so this is exactly the
   *  window where Thom is out reading the catalog/docs. */
  private searchingView(): HTMLElement {
    return el("div", { class: "thom-turn assistant" }, [
      el("div", { class: "thom-bubble thom-searching", role: "status", "aria-label": "Searching" }, [
        el("span", { class: "thom-scan", "aria-hidden": "true" }, [this.robotIcon(28)]),
        el("span", { class: "thom-searching-label", text: "Searching…" }),
      ]),
    ]);
  }

  private turnView(turn: Turn, streaming: boolean): HTMLElement {
    if (turn.role === "assistant" && streaming && !turn.text) {
      return this.searchingView();
    }
    const bubble = el("div", { class: `thom-bubble${turn.error ? " thom-error" : ""}` });
    if (turn.role === "assistant") {
      const md = el("div", { class: "thom-text thom-md" });
      md.innerHTML = renderMarkdown(turn.text); // pre-sanitized in markdown.ts
      bubble.appendChild(md);
    } else {
      bubble.appendChild(el("div", { class: "thom-text", text: turn.text }));
    }
    if (turn.cards) for (const c of turn.cards) bubble.appendChild(renderCard(c));
    if (turn.citations && turn.citations.length) bubble.appendChild(renderCitations(turn.citations));
    // Thumbs row: completed, non-error assistant turns with a rating key,
    // only when the dark-launch flag is on.
    if (
      this.feedbackEnabled &&
      showFeedbackRow({ role: turn.role, error: turn.error, id: turn.turnId, streaming })
    ) {
      bubble.appendChild(this.feedbackView(turn));
    }
    return el("div", { class: `thom-turn ${turn.role}` }, [bubble]);
  }

  // --- feedback (thumbs) ------------------------------------------------------

  /** lucide "thumbs-up" outline; drawn flipped for thumbs-down. */
  private thumbIcon(down: boolean): SVGElement {
    const svg = svgEl(
      "svg",
      {
        viewBox: "0 0 24 24",
        width: 14,
        height: 14,
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 2,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        class: down ? "thom-thumb-flip" : undefined,
      },
      [
        svgEl("path", { d: "M7 10v12" }),
        svgEl("path", {
          d: "M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z",
        }),
      ],
    );
    return svg;
  }

  /** The thumbs row + STATIC disclosure line (F4) + optional reason box. */
  private feedbackView(turn: Turn): HTMLElement {
    const turnId = turn.turnId as string;
    const up = el("button", {
      class: `thom-btn thom-feedback-btn${turn.feedback === 1 ? " selected" : ""}`,
      type: "button",
      "aria-label": "Good answer",
      title: "Good answer",
      "aria-pressed": turn.feedback === 1 ? "true" : "false",
    }, [this.thumbIcon(false)]);
    up.addEventListener("click", () => {
      if (turn.feedback === 1) return; // one vote per answer; change-of-mind only
      this.closeReasonBox();
      void this.submitFeedback(turnId, 1);
    });
    const down = el("button", {
      class: `thom-btn thom-feedback-btn${turn.feedback === -1 ? " selected" : ""}`,
      type: "button",
      "aria-label": "Bad answer",
      title: "Bad answer",
      "aria-pressed": turn.feedback === -1 ? "true" : "false",
    }, [this.thumbIcon(true)]);
    down.addEventListener("click", () => {
      if (turn.feedback === -1) return;
      this.openReasonBox(turnId);
    });

    const note = this.feedbackNotes.get(turnId);
    const children: (Node | null)[] = [
      el("div", { class: "thom-feedback-row" }, [up, down]),
      // Disclosure renders STATICALLY with the thumbs (F4) — before either
      // vote is cast, never tooltip-only.
      el("div", { class: "thom-muted thom-feedback-disclosure", text: FEEDBACK_DISCLOSURE_COPY }),
      note ? el("div", { class: "thom-muted thom-feedback-note", text: note }) : null,
    ];

    if (this.reasonOpenFor === turnId) {
      const textarea = el("textarea", {
        class: "thom-input thom-feedback-textarea",
        rows: 2,
        maxlength: 1000,
        placeholder: "What went wrong? (optional)",
        "aria-label": "Feedback reason",
      });
      const send = this.button("Send", "thom-btn-primary", () => {
        void this.submitFeedback(turnId, -1, textarea.value.trim() || undefined);
      });
      const skip = this.button("Skip", "thom-btn-ghost", () => {
        void this.submitFeedback(turnId, -1);
      });
      children.push(
        el("div", { class: "thom-feedback-reason" }, [
          textarea,
          el("div", { class: "thom-feedback-reason-actions" }, [send, skip]),
        ]),
      );
    }

    return el("div", { class: "thom-feedback" }, children);
  }

  private openReasonBox(turnId: string): void {
    this.reasonOpenFor = turnId;
    this.renderTurns();
    // Close on outer click (anywhere outside the reason box).
    if (!this.outerCloseBound) {
      this.outerCloseBound = (e: MouseEvent) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest(".thom-feedback-reason") || target?.closest(".thom-feedback-btn")) return;
        this.closeReasonBox();
        this.renderTurns();
      };
      document.addEventListener("mousedown", this.outerCloseBound, true);
    }
  }

  private closeReasonBox(): void {
    this.reasonOpenFor = null;
    if (this.outerCloseBound) {
      document.removeEventListener("mousedown", this.outerCloseBound, true);
      this.outerCloseBound = null;
    }
  }

  /** POST the vote. Both snapshots are PROBES: when the log bridge matches the
   *  logged turn, the stored snapshot comes from the DB rows (F3). */
  private async submitFeedback(turnId: string, rating: 1 | -1, reason?: string): Promise<void> {
    this.closeReasonBox();
    this.feedbackNotes.delete(turnId);
    const idx = this.turns.findIndex((t) => t.turnId === turnId);
    const turn = idx >= 0 ? this.turns[idx] : undefined;
    if (!turn) return;
    // question = nearest preceding user turn's text; answer = this turn's text.
    let question = "";
    for (let i = idx - 1; i >= 0; i--) {
      const t = this.turns[i];
      if (t && t.role === "user" && t.text) {
        question = t.text;
        break;
      }
    }

    const post = async (session: string): Promise<Response> =>
      fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Thom-Session": session },
        body: JSON.stringify({ session, turnId, rating, reason, question, answer: turn.text }),
      });

    try {
      let session = await this.ensureSession();
      let res = await post(session);
      if (res.status === 401) {
        // Expired session — drop it and re-challenge once (mirrors runStream).
        this.sessionToken = null;
        clearSessionToken(this.siteKey);
        session = await this.ensureSession();
        res = await post(session);
      }
      if (!res.ok) throw new Error(`feedback failed (${res.status})`);
      this.turns[idx] = { ...turn, feedback: rating };
      this.persist();
    } catch {
      // Quiet inline note — never an error bubble.
      this.feedbackNotes.set(turnId, "Couldn't send feedback. Please try again.");
    }
    this.renderTurns();
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => this.listEl.scrollTo({ top: this.listEl.scrollHeight, behavior: "smooth" }));
  }

  // --- session / turnstile --------------------------------------------------

  /** Ensure we hold a valid session token, minting one via Turnstile if needed. */
  private async ensureSession(): Promise<string> {
    if (this.sessionToken) return this.sessionToken;
    const stored = loadSessionToken(this.siteKey);
    if (stored) {
      this.sessionToken = stored;
      return stored;
    }
    if (!this.turnstileSiteKey) throw new Error("Thom isn't configured yet.");
    this.challengeEl.hidden = false;
    try {
      const token = await renderChallenge(this.challengeEl, this.turnstileSiteKey);
      const { session, exp } = await mintSession(token, this.turnstileSiteKey);
      this.sessionToken = session;
      saveSessionToken(this.siteKey, session, exp);
      return session;
    } finally {
      this.challengeEl.hidden = true;
    }
  }

  // --- actions --------------------------------------------------------------

  private persist(): void {
    saveHistory(this.siteKey, this.sessionId, this.turns);
  }

  newChat(): void {
    this.abort?.abort();
    this.abort = null;
    this.busy = false;
    this.closeReasonBox();
    this.feedbackNotes.clear();
    this.turns = [];
    clearHistory(this.siteKey, this.sessionId);
    this.inputEl.value = "";
    this.renderTurns();
  }

  async send(text: string): Promise<void> {
    const message = text.trim();
    if (!message || this.busy) return;
    this.inputEl.value = "";
    this.busy = true;
    this.setComposerEnabled(false);

    // Bounded history from PRIOR turns (before we push the new pair). The
    // assistant turn mints its feedback key here (persisted with the turn).
    const history = toRequestHistory(this.turns);
    this.turns.push(
      { role: "user", text: message },
      { role: "assistant", text: "", turnId: randomId() },
    );
    this.renderTurns();

    let session: string;
    try {
      session = await this.ensureSession();
    } catch (e) {
      this.failLastAssistant(e instanceof Error ? e.message : String(e));
      return;
    }

    await this.runStream({ message, session, history }, /* allowRechallenge */ true);
  }

  private async runStream(
    req: { message: string; session: string; history: { role: "user" | "assistant"; content: string }[] },
    allowRechallenge: boolean,
  ): Promise<void> {
    const controller = new AbortController();
    this.abort = controller;
    let rechallenge = false;

    await chatStream(
      req,
      {
        onDelta: (delta) => this.updateLastAssistant((t) => ({ ...t, text: t.text + delta })),
        onCards: (cards: Card[]) => this.updateLastAssistant((t) => ({ ...t, cards })),
        onCitations: (citations: Citation[]) => this.updateLastAssistant((t) => ({ ...t, citations })),
        onDone: () => {
          this.busy = false;
          this.abort = null;
          this.setComposerEnabled(true);
          this.persist();
        },
        onError: (err) => {
          // Expired / invalid session → drop it and re-challenge once.
          if (err.status === 401 && allowRechallenge) {
            rechallenge = true;
            return;
          }
          this.failLastAssistant(this.errorText(err));
        },
      },
      controller.signal,
    );

    if (rechallenge) {
      // Stored token was rejected (expired / IP changed) — drop it and re-verify.
      this.sessionToken = null;
      clearSessionToken(this.siteKey);
      try {
        const session = await this.ensureSession();
        await this.runStream({ ...req, session }, /* allowRechallenge */ false);
      } catch (e) {
        this.failLastAssistant(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    // Stream ended without done/error (dropped) — clear busy defensively.
    if (this.busy) {
      this.busy = false;
      this.abort = null;
      this.setComposerEnabled(true);
      this.persist();
    }
  }

  private errorText(err: { status?: number; error: string }): string {
    if (err.status === 503) return "Thom isn't available right now. Please try again later.";
    if (err.status === 429) return err.error || "You've hit the usage limit for now. Please try again in a bit.";
    if (err.status === 403) return "This chat isn't available on this site.";
    return `Sorry, something went wrong (${err.error || "unknown error"}).`;
  }

  private updateLastAssistant(fn: (t: Turn) => Turn): void {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i];
      if (t && t.role === "assistant") {
        this.turns[i] = fn(t);
        break;
      }
    }
    this.renderTurns();
  }

  private failLastAssistant(text: string): void {
    this.updateLastAssistant(() => ({ role: "assistant", text, error: true }));
    this.busy = false;
    this.abort = null;
    this.setComposerEnabled(true);
    this.persist();
  }

  private setComposerEnabled(on: boolean): void {
    this.inputEl.disabled = !on;
    this.sendEl.disabled = !on;
    if (on) this.inputEl.focus();
  }
}
