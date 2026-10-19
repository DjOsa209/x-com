import { describe, it, expect } from "vitest";
import { seal, unseal } from "../server/config.ts";
describe("encrypted provider secrets", () => {
  it("round-trips credentials without storing plaintext", () => {
    const text = JSON.stringify({ password: "a-key-with-sensitive-data" });
    const a = seal(text),
      b = seal(text);
    expect(a).not.toContain("sensitive");
    expect(a).not.toBe(b);
    expect(unseal(a)).toBe(text);
  });
  it("rejects tampered ciphertext", () => {
    const b = Buffer.from(seal("secret"), "base64");
    b[15] ^= 1;
    expect(() => unseal(b.toString("base64"))).toThrow();
  });
});
