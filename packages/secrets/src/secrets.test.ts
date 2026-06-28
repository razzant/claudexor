import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretStore, resolveSecret } from "./index.js";

let prev: string | undefined;
let prevBackend: string | undefined;

beforeEach(() => {
  prev = process.env.CLAUDEXOR_CONFIG_DIR;
  prevBackend = process.env.CLAUDEXOR_SECRETS_BACKEND;
  process.env.CLAUDEXOR_CONFIG_DIR = mkdtempSync(join(tmpdir(), "claudexor-secrets-"));
});

afterEach(() => {
  if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
  else process.env.CLAUDEXOR_CONFIG_DIR = prev;
  if (prevBackend === undefined) delete process.env.CLAUDEXOR_SECRETS_BACKEND;
  else process.env.CLAUDEXOR_SECRETS_BACKEND = prevBackend;
  delete process.env.MY_API_KEY;
});

describe("SecretStore backend resolution", () => {
  it("CLAUDEXOR_SECRETS_BACKEND=file forces the file backend for an auto store (sandbox-safe)", () => {
    process.env.CLAUDEXOR_SECRETS_BACKEND = "file";
    expect(new SecretStore("auto").resolvedBackend()).toBe("file");
    // An explicit constructor backend still wins over the env override.
    expect(new SecretStore("keychain").resolvedBackend()).toBe("keychain");
  });

  it("fails loudly on an invalid CLAUDEXOR_SECRETS_BACKEND value (no silent Keychain fallback)", () => {
    process.env.CLAUDEXOR_SECRETS_BACKEND = "fil";
    expect(() => new SecretStore("auto").resolvedBackend()).toThrow(/CLAUDEXOR_SECRETS_BACKEND must be file\|keychain\|auto/);
  });
});

describe("SecretStore (file backend)", () => {
  it("round-trips set/get/delete and writes a 0600 file", () => {
    const store = new SecretStore("file");
    expect(store.set("OPENAI_API_KEY", "sk-test-123")).toBe("file");
    expect(store.get("OPENAI_API_KEY")).toBe("sk-test-123");

    const mode = statSync(join(process.env.CLAUDEXOR_CONFIG_DIR as string, "secrets.json")).mode & 0o777;
    expect(mode).toBe(0o600);

    store.delete("OPENAI_API_KEY");
    expect(store.get("OPENAI_API_KEY")).toBeNull();
  });

  it("fails loudly on malformed file storage instead of treating it as empty", () => {
    writeFileSync(join(process.env.CLAUDEXOR_CONFIG_DIR as string, "secrets.json"), "{not-json");
    const store = new SecretStore("file");
    expect(() => store.list()).toThrow(/invalid Claudexor secret store/);
    expect(() => store.set("OPENAI_API_KEY", "sk-test-123")).toThrow(/invalid Claudexor secret store/);
  });
});

describe("resolveSecret precedence", () => {
  it("env var beats helper beats store", () => {
    const store = new SecretStore("file");
    store.set("KEY", "from-store");

    expect(resolveSecret("KEY", { store })).toBe("from-store");
    expect(resolveSecret("KEY", { store, helperCommand: "printf helper-value" })).toBe("helper-value");

    process.env.MY_API_KEY = "from-env";
    expect(resolveSecret("KEY", { store, envVar: "MY_API_KEY", helperCommand: "printf helper-value" })).toBe(
      "from-env",
    );
  });
});
