/**
 * PII redaction for ZenDesk INTERNAL tickets, applied BEFORE any chunk/embed so
 * only redacted text ever reaches kb_chunks (the sole body-at-rest for tickets;
 * kb_documents keeps a pointer row with NO body). Pure + deterministic so the
 * redaction is exhaustively unit-testable without hitting ZenDesk.
 *
 * Design: allow-by-default. We remove ONLY the enumerated PII patterns and leave
 * product/support substance intact — SKUs, dimensions, part numbers, wattage,
 * CCT, and photometrics all SURVIVE, because Thom answers support questions from
 * ticket resolutions and those facts are the answer. What we strip:
 *   - email addresses            -> [email]
 *   - phone numbers (NANP + intl)-> [phone]
 *   - requester / CC / author display names (passed in) -> [name]
 *   - trailing signature blocks (after a "--" delimiter or a "Regards,"-style
 *     sign-off) — where personal contact details cluster.
 *
 * Order matters: signatures are trimmed first (so their emails/phones/names go
 * with them), then emails, then phones, then names.
 */

/** RFC-ish email — deliberately liberal on the local part, strict on the TLD. */
const EMAIL_RE = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi;

/**
 * Phone candidate: an optional leading "+", then 8+ chars of digits and the
 * usual phone separators, bounded so it can't sit inside an alphanumeric token
 * (a SKU / part number always has an adjacent letter, so the (?<![A-Za-z0-9])
 * / (?![A-Za-z0-9]) fences exclude it). A trailing extension is folded in. The
 * digit-count gate (10..15) is what actually keeps dimensions ("3-1/2", "24
 * 1/2") and short measurements from being mistaken for phone numbers.
 */
const PHONE_RE =
  /(?<![A-Za-z0-9])(\+?\d[\d\s().\-]{7,}\d)((?:\s*(?:ext|x|extension)\.?\s*\d{1,6})?)(?![A-Za-z0-9])/gi;

/** Common e-mail sign-offs that introduce a signature block. */
const SIGNOFF_RE =
  /^\s*(thanks|thank you|thanks so much|many thanks|regards|best regards|kind regards|warm regards|best|sincerely|cheers|respectfully|talk soon|all the best)[,.!]?\s*$/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip a trailing signature block. Two heuristics, whichever cuts earlier:
 *   1) a standalone "--" delimiter line (the RFC-2646 sig marker), or
 *   2) a sign-off line ("Thanks,", "Regards," …) that appears in the LATTER
 *      half of the text (so a "Thanks!" mid-conversation isn't treated as a
 *      signature) with only a few short lines after it.
 * Everything from the cut line onward is dropped.
 */
export function stripSignature(text: string): string {
  const lines = text.split("\n");
  let cut = -1;

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*--\s*$/.test(lines[i]!)) {
      cut = i;
      break;
    }
  }

  // Sign-off heuristic: only consider one in the back half of the message, with
  // a short tail after it (name + contact lines), so it reads as a closing.
  if (cut === -1) {
    const half = Math.floor(lines.length / 2);
    for (let i = Math.max(1, half); i < lines.length; i++) {
      if (SIGNOFF_RE.test(lines[i]!) && lines.length - i <= 8) {
        cut = i;
        break;
      }
    }
  }

  if (cut === -1) return text;
  return lines.slice(0, cut).join("\n").replace(/\s+$/, "");
}

function redactEmails(text: string): string {
  return text.replace(EMAIL_RE, "[email]");
}

function redactPhones(text: string): string {
  return text.replace(PHONE_RE, (match, phone: string) => {
    const digits = phone.replace(/\D/g, "");
    // NANP is 10 (or 11 with country code); allow up to 15 for E.164 intl.
    // Fewer than 10 digits is almost always a dimension / measurement / code.
    return digits.length >= 10 && digits.length <= 15 ? "[phone]" : match;
  });
}

/**
 * Replace known display names (requester / CC / comment authors) with [name].
 * Case-insensitive, word-boundary. Full names are replaced first, then their
 * individual tokens — but only tokens of length >= 3, so initials and very
 * short/common fragments don't over-redact product prose. Names shorter than 3
 * chars are skipped entirely.
 */
function redactNames(text: string, names: string[]): string {
  // Build the replacement set: whole names + their >=3-char tokens, de-duped,
  // longest first so "John Smith" is consumed before "John".
  const terms = new Set<string>();
  for (const raw of names) {
    const name = (raw ?? "").trim();
    if (name.length < 3 || !/[A-Za-z]/.test(name)) continue;
    terms.add(name);
    for (const tok of name.split(/\s+/)) {
      const t = tok.trim();
      if (t.length >= 3 && /[A-Za-z]/.test(t)) terms.add(t);
    }
  }
  const ordered = [...terms].sort((a, b) => b.length - a.length);
  let out = text;
  for (const term of ordered) {
    // \b won't anchor around names with punctuation, but our tokens are word-ish.
    const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, "gi");
    out = out.replace(re, "[name]");
  }
  return out;
}

/**
 * Redact a ticket's concatenated text. `names` are the display names gathered
 * from the ticket requester + comment authors + CCs (the ZenDesk users array).
 * Returns text safe to chunk/embed: enumerated PII removed, product/spec
 * substance preserved.
 */
export function redactTicketText(text: string, names: string[] = []): string {
  if (!text) return "";
  let out = stripSignature(text);
  out = redactEmails(out);
  out = redactPhones(out);
  out = redactNames(out, names);
  return out;
}
