/**
 * Descriptions — default voice profiles (seeded by migrations 0072 + 0073;
 * 0073 adds WAC Architectural · Core alongside the new WAC slots).
 *
 * One tab per brand+collection. The `prompt` default follows the Catalog Copy
 * Prompts docx (75-word catalog copy structure) with the anti-formulaic
 * clause as a HARD RULE; `voice_guidance` is a short per-brand paragraph
 * clearly marked as a seeded default. These constants back the "Reset to
 * default" action, and the migrations seed the SAME text — keep the SQL seeds
 * in sync with this file (voiceDefaults.test.ts enforces it).
 *
 * Copy style: no em dashes; the company is always "WAC Group", never "WAC".
 */

export interface DescVoiceDefault {
  brand: string;
  collection: string;
  prompt: string;
  voice_guidance: string;
}

/** Shared hard rule against formulaic output — verbatim in every prompt. */
export const ANTI_FORMULAIC_RULE =
  "HARD RULE: capture the same kinds of information for every product, but never the same shape: vary the opening, sentence order, and rhythm from product to product. Do not start two descriptions the same way.";

const BASE_PROMPT = [
  "Write 75-word marketing catalog copy for this product, based on the product fact sheet provided.",
  "Describe the design details a shopper can see, and weave in the specific product facts supplied (LED color temperature, finishes, sizes, materials, features). Never invent specifications; only use the attributes provided.",
  "Plain text only: no markdown, no headings, no exclamation marks, no hype words. No em dashes. When referring to the company, always write WAC Group, never WAC alone.",
  ANTI_FORMULAIC_RULE,
].join("\n\n");

const seeded = (text: string) => `Seeded default, refine me. ${text}`;

export const DESC_VOICE_DEFAULTS: DescVoiceDefault[] = [
  {
    brand: "WAC Lighting",
    collection: "Dweled",
    prompt: BASE_PROMPT,
    voice_guidance: seeded(
      "Dweled is accessible decorative LED lighting from WAC Lighting: warm, inviting, design-forward but approachable. Lead with how the fixture lives in the home, support with the light quality and finish details. Friendly and confident, never gushing.",
    ),
  },
  {
    brand: "WAC Lighting",
    collection: "Limited",
    prompt: BASE_PROMPT,
    voice_guidance: seeded(
      "WAC Lighting Limited is elevated, limited-run decorative lighting. Precise and quietly premium: emphasize craftsmanship, materials, and the character of the light. Concrete specifics over adjectives.",
    ),
  },
  {
    brand: "WAC Architectural",
    collection: "Core",
    prompt: BASE_PROMPT,
    voice_guidance: seeded(
      "WAC Architectural is precision architectural lighting for designed spaces. Performance-minded and understated: speak to optics, light quality, and how the fixture integrates with the architecture. Clean, specification-aware sentences that still convey design intent.",
    ),
  },
  {
    brand: "Modern Forms",
    collection: "Fans",
    prompt: BASE_PROMPT,
    voice_guidance: seeded(
      "Modern Forms smart fans are sculptural, architectural, and engineered. Clean modern vocabulary: silhouette, airflow, finish, integrated LED light. Technical confidence without jargon dumps.",
    ),
  },
  {
    brand: "Modern Forms",
    collection: "Luminaires",
    prompt: BASE_PROMPT,
    voice_guidance: seeded(
      "Modern Forms luminaires are minimalist, architectural, art-adjacent. Speak to form and shadow, luminous surfaces, and how the piece anchors a modern space. Spare, assured sentences.",
    ),
  },
  {
    brand: "Schonbek",
    collection: "Beyond",
    prompt: BASE_PROMPT,
    voice_guidance: seeded(
      "Schonbek Beyond brings crystal artistry into contemporary silhouettes. Blend the heritage of Schonbek crystal with modern, livable design language: refraction, sparkle, and light as a material.",
    ),
  },
  {
    brand: "Schonbek",
    collection: "Forever",
    prompt: BASE_PROMPT,
    voice_guidance: seeded(
      "Schonbek Forever celebrates timeless crystal classics. Luxurious, heritage-rich voice: hand-set crystal, generations of craft, rooms made for occasions. Elegant, never stuffy.",
    ),
  },
  {
    brand: "Schonbek",
    collection: "Signature",
    prompt: BASE_PROMPT,
    voice_guidance: seeded(
      "Schonbek Signature is the pinnacle of luxury crystal lighting. Write with reverence for craftsmanship and heritage: precision-cut crystal, statement scale, light that performs. Rich but controlled prose.",
    ),
  },
];
