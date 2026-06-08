import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretStore, resolveSecret } from "./index.js";

let prev: string | undefined;

beforeEach(() => {
  prev = process.env.CLAUDEX_CONFIG_DIR;
  process.env.CLAUDEX_CONFIG_DIR = mkdtempSync(join(tmpdir(), "claudex-secrets-"));
});

afterEach(() => {
  if (prev === undefined) delete process.env.CLAUDEX_CONFIG_DIR;
  else process.env.CLAUDEX_CONFIG_DIR = prev;
  delete process.env.MY_API_KEY;
});

describe("SecretStore (file backend)", () => {
  it("round-trips set/get/delete and writes a 0600 file", () => {
    const store = new SecretStore("file");
    expect(store.set("OPENAI_API_KEY", "sk-test-123")).toBe("file");
    expect(store.get("OPENAI_API_KEY")).toBe("sk-test-123");

    const mode = statSync(join(process.env.CLAUDEX_CONFIG_DIR as string, "secrets.json")).mode & 0o777;
    expect(mode).toBe(0o600);

    store.delete("OPENAI_API_KEY");
    expect(store.get("OPENAI_API_KEY")).toBeNull();
  });

  it("fails loudly on malformed file storage instead of treating it as empty", () => {
    writeFileSync(join(process.env.CLAUDEX_CONFIG_DIR as string, "secrets.json"), "{not-json");
    const store = new SecretStore("file");
    expect(() => store.list()).toThrow(/invalid Claudex secret store/);
    expect(() => store.set("OPENAI_API_KEY", "sk-test-123")).toThrow(/invalid Claudex secret store/);
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
