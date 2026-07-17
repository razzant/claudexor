import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretStore, isManagedSecretName, resolveSecret } from "./index.js";

let prev: string | undefined;

beforeEach(() => {
  prev = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = mkdtempSync(join(tmpdir(), "claudexor-secrets-"));
});

afterEach(() => {
  if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
  else process.env.CLAUDEXOR_CONFIG_DIR = prev;
  delete process.env.MY_API_KEY;
});

describe("SecretStore backend", () => {
  it("is unconditionally file-only", () => {
    expect(new SecretStore().resolvedBackend()).toBe("file");
  });
});

describe("SecretStore (file backend)", () => {
  it("round-trips set/get/delete and writes a 0600 file", () => {
    const store = new SecretStore();
    expect(store.set("OPENAI_API_KEY", "sk-test-123")).toBe("file");
    expect(store.get("OPENAI_API_KEY")).toBe("sk-test-123");

    const mode =
      statSync(join(process.env.CLAUDEXOR_CONFIG_DIR as string, "secrets.json")).mode & 0o777;
    expect(mode).toBe(0o600);

    store.delete("OPENAI_API_KEY");
    expect(store.get("OPENAI_API_KEY")).toBeNull();
  });

  it("fails loudly on malformed file storage instead of treating it as empty", () => {
    writeFileSync(join(process.env.CLAUDEXOR_CONFIG_DIR as string, "secrets.json"), "{not-json");
    const store = new SecretStore();
    expect(() => store.list()).toThrow(/invalid Claudexor secret store/);
    expect(() => store.set("OPENAI_API_KEY", "sk-test-123")).toThrow(
      /invalid Claudexor secret store/,
    );
  });
});

describe("resolveSecret", () => {
  it("resolves the stored value (the env/helper indirections were retired)", () => {
    const store = new SecretStore();
    store.set("KEY", "from-store");
    expect(resolveSecret("KEY", { store })).toBe("from-store");
    expect(resolveSecret("MISSING", { store })).toBeNull();
  });
});

describe("managed secret name namespacing (INV-135)", () => {
  it("accepts bare managed names and profile-suffixed variants", () => {
    expect(isManagedSecretName("claude_oauth")).toBe(true);
    expect(isManagedSecretName("claude_oauth:work")).toBe(true);
    expect(isManagedSecretName("anthropic:acc-2")).toBe(true);
    expect(isManagedSecretName("openai:b2")).toBe(true);
  });

  it("rejects unknown bases, empty suffixes, and malformed suffixes", () => {
    expect(isManagedSecretName("unknown:work")).toBe(false);
    expect(isManagedSecretName("claude_oauth:")).toBe(false);
    expect(isManagedSecretName("claude_oauth:Bad Suffix")).toBe(false);
    expect(isManagedSecretName("claude_oauth:x:y")).toBe(false);
  });
});
