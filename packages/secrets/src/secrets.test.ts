import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const durability = vi.hoisted(() => ({
  observeDirectoryFsync: vi.fn<(path: string) => void>(),
}));

vi.mock("@claudexor/util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@claudexor/util")>();
  return {
    ...actual,
    fsyncDirectory: (path: string, platform?: NodeJS.Platform) => {
      durability.observeDirectoryFsync(path);
      actual.fsyncDirectory(path, platform);
    },
  };
});

import { SecretStore, isManagedSecretName, resolveSecret } from "./index.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

let prev: string | undefined;

beforeEach(() => {
  durability.observeDirectoryFsync.mockReset();
  prev = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = reapMk(join(tmpdir(), "claudexor-secrets-"));
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
  it("delegates post-rename directory durability to the common owner", () => {
    const dir = process.env.CLAUDEXOR_CONFIG_DIR as string;
    durability.observeDirectoryFsync.mockImplementationOnce((flushedDir) => {
      expect(flushedDir).toBe(dir);
      expect(JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8"))).toEqual({
        KEY: "from-store",
      });
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    new SecretStore().set("KEY", "from-store");

    expect(durability.observeDirectoryFsync).toHaveBeenCalledOnce();
  });

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
