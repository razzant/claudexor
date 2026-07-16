import { describe, expect, it } from "vitest";
import {
  assertNoInlineSecretValues,
  containsSecretLikeToken,
  hashJson,
  newId,
  redactSecrets,
  sha256,
  stableStringify,
  userConfigDir,
} from "./index.js";

describe("assertNoInlineSecretValues schema-awareness (W8/G7)", () => {
  const secret = "sk-or-v1-" + "c".repeat(40);

  it("rejects a secret-like VALUE anywhere, including inside outputSchema", () => {
    expect(() => assertNoInlineSecretValues({ prompt: `use ${secret}` })).toThrow();
    // A secret hidden in a schema const/default/enum literal is still caught.
    expect(() =>
      assertNoInlineSecretValues({
        outputSchema: { type: "object", properties: { k: { const: secret } } },
      }),
    ).toThrow();
  });

  it("rejects secret-NAMED keys OUTSIDE a schema (env/token/password)", () => {
    expect(() => assertNoInlineSecretValues({ env: { X: "1" } })).toThrow();
    expect(() => assertNoInlineSecretValues({ api_key: "whatever" })).toThrow();
  });

  it("ALLOWS legitimate schema property names token/password/env (field names, not secrets)", () => {
    expect(() =>
      assertNoInlineSecretValues({
        outputSchema: {
          type: "object",
          properties: {
            token: { type: "string" },
            password: { type: "string" },
            env: { type: "string" },
          },
          required: ["token"],
        },
      }),
    ).not.toThrow();
  });
});

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

  it("redacts Cursor keys, OpenRouter keys, Bearer tokens and JWTs (v0.9 hygiene)", () => {
    const cursor = "key_" + "b".repeat(40);
    const openrouter = "sk-or-v1-" + "c".repeat(40);
    const jwt = "eyJ" + "a".repeat(20) + "." + "b".repeat(20) + "." + "c".repeat(20);
    expect(redactSecrets(cursor)).toBe("[redacted]");
    expect(redactSecrets(openrouter)).toBe("[redacted]");
    expect(redactSecrets(jwt)).toBe("[redacted]");
    expect(redactSecrets("Authorization: Bearer " + "d".repeat(40))).toContain("[redacted]");
    expect(containsSecretLikeToken(cursor)).toBe(true);
    expect(containsSecretLikeToken(jwt)).toBe(true);
    // Length-gated: ordinary prose must not be redacted.
    expect(containsSecretLikeToken("Bearer of good news")).toBe(false);
    expect(containsSecretLikeToken("the key_ to success")).toBe(false);
  });

  it("redacts PEM blocks, Google ya29 tokens, npm tokens, and xoxe/xoxc Slack classes", () => {
    // Assembled at runtime so the raw source never contains a contiguous
    // PEM header (the CI secret scan greps tracked files for that literal).
    const dashes = "-----";
    const pem = `${dashes}BEGIN OPENSSH PRIVATE KEY${dashes}\nabc\ndef\n${dashes}END OPENSSH PRIVATE KEY${dashes}`;
    expect(redactSecrets(`before ${pem} after`)).toBe("before [redacted] after");
    expect(redactSecrets("ya29." + "e".repeat(30))).toBe("[redacted]");
    expect(redactSecrets("npm_" + "f".repeat(30))).toBe("[redacted]");
    expect(redactSecrets("xoxe-" + "g1-".repeat(8))).toContain("[redacted]");
    expect(redactSecrets("xoxc-" + "h".repeat(20))).toBe("[redacted]");
    // Prose stays untouched.
    expect(containsSecretLikeToken("the npm_ prefix and ya29 are token families")).toBe(false);
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

  it("uses an empty v2 namespace without probing the legacy root", () => {
    const config = process.env.CLAUDEXOR_CONFIG_DIR;
    try {
      delete process.env.CLAUDEXOR_CONFIG_DIR;
      expect(userConfigDir()).toMatch(/\.claudexor\/v2$/);
    } finally {
      if (config === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = config;
    }
  });
});
