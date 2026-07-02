import { describe, expect, it } from "vitest";
import { buildServiceAccountAssertion } from "./googleSheets.js";

/** Export a generated private key as the PEM PKCS#8 block a real SA key file holds. */
async function toPem(privateKey: CryptoKey): Promise<string> {
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer);
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

describe("buildServiceAccountAssertion", () => {
  it("produces a JWT with the right claims and a signature the public key verifies", async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const iat = 1_750_000_000;
    const jwt = await buildServiceAccountAssertion(
      { client_email: "sync@test-project.iam.gserviceaccount.com", private_key: await toPem(pair.privateKey) },
      iat,
    );

    const [h, c, s] = jwt.split(".");
    expect(h && c && s).toBeTruthy();
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h!)));
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(c!)));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims).toEqual({
      iss: "sync@test-project.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    });

    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pair.publicKey,
      b64urlToBytes(s!).buffer as ArrayBuffer,
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(valid).toBe(true);
  });
});
