import { describe, expect, it } from "vitest";
import { containsSecretLikeToken, hashJson, newId, redactSecrets, sha256, stableStringify, userConfigDir } from "./index.js";

describe("util", () => {
  it("hashes JSON stably regardless of key order", () => {
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("sha256 has the expected prefix", () => {
    expect(sha256("x")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("newId is unique and prefixed", () => {
    const a = newId("run");
    const b = newId("run");
    expect(a).not.toBe(b);
    expect(a.startsWith("run-")).toBe(true);
  });

  it("redacts obvious secret tokens", () => {
    const redacted = redactSecrets("token ghp_" + "a".repeat(36) + " end");
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain("ghp_aaaa");
    expect(containsSecretLikeToken("token ghp_" + "a".repeat(36))).toBe(true);
    expect(containsSecretLikeToken("ordinary prompt")).toBe(false);
  });

  it("rejects unsafe CLAUDEXOR_CONFIG_DIR overrides", () => {
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    try {
      process.env.CLAUDEXOR_CONFIG_DIR = "/";
      expect(() => userConfigDir()).toThrow(/safe absolute path/);
      process.env.CLAUDEXOR_CONFIG_DIR = "relative";
      expect(() => userConfigDir()).toThrow(/safe absolute path/);
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    }
  });
});
