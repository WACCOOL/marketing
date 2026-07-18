import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * SECURITY BOUNDARY GUARD.
 *
 * The public Worker's whole safety story is "it cannot hold the dangerous
 * credentials." This test fails the build if a service-role key, any HubSpot
 * token, or a service Supabase client ever creeps into apps/thom-bot/src — so a
 * future edit can't quietly re-open the boundary.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function srcFiles(): { name: string; text: string }[] {
  return readdirSync(SRC_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((name) => ({ name, text: readFileSync(join(SRC_DIR, name), "utf8") }));
}

/** Strip line + block comments so a *documented* mention of a forbidden name
 *  (e.g. "DELIBERATELY ABSENT: SUPABASE_SERVICE_ROLE_KEY") doesn't trip the
 *  guard — only real code references count. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FORBIDDEN = [/SUPABASE_SERVICE_ROLE_KEY/, /HUBSPOT_/, /serviceSupabase/, /service[_-]?role/i];

describe("public env boundary", () => {
  it("no source file references service-role or HubSpot credentials (outside comments)", () => {
    for (const { name, text } of srcFiles()) {
      const code = stripComments(text);
      for (const pat of FORBIDDEN) {
        expect(code, `${name} must not reference ${pat}`).not.toMatch(pat);
      }
    }
  });

  it("PublicEnv (env.ts) declares no service-role / hubspot binding", () => {
    const envSrc = stripComments(readFileSync(join(SRC_DIR, "env.ts"), "utf8"));
    expect(envSrc).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(envSrc).not.toMatch(/HUBSPOT/);
    // It DOES carry the anon key (positive control that the grep is meaningful).
    expect(envSrc).toMatch(/SUPABASE_ANON_KEY/);
  });

  it("supabase.ts builds only an anon client (no service client)", () => {
    const sb = stripComments(readFileSync(join(SRC_DIR, "supabase.ts"), "utf8"));
    expect(sb).toMatch(/SUPABASE_ANON_KEY/);
    expect(sb).not.toMatch(/SERVICE_ROLE/);
  });
});
