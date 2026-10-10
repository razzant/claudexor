import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A directory handle whose path carries REFUSAL_MARKER answers a flush the way
 * win32 does: FlushFileBuffers rejects a read handle. Scoped to the marker so
 * every other fsync in this file stays real.
 */
const flush = vi.hoisted(() => ({
  marker: "claudexor-flush-refusal-",
  refusing: new Set<number>(),
  closed: [] as number[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: ((path: string, flags: number, mode?: number) => {
      const fd = actual.openSync(path, flags, mode);
      if (String(path).includes(flush.marker)) flush.refusing.add(fd);
      return fd;
    }) as typeof actual.openSync,
    fsyncSync: (fd: number) => {
      if (flush.refusing.has(fd)) {
        throw Object.assign(new Error("EACCES: FlushFileBuffers refused a read handle"), {
          code: "EACCES",
        });
      }
      actual.fsyncSync(fd);
    },
    fchmodSync: (fd: number, mode: number) => {
      if (flush.refusing.has(fd)) {
        throw Object.assign(new Error("EPERM: operation not permitted, fchmod"), {
          code: "EPERM",
        });
      }
      actual.fchmodSync(fd, mode);
    },
    closeSync: (fd: number) => {
      if (flush.refusing.delete(fd)) flush.closed.push(fd);
      actual.closeSync(fd);
    },
  };
});

import {
  assertNoInlineSecretValues,
  containsSecretLikeToken,
  ensureCanonicalPrivateDirectory,
  fsyncDirectory,
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

  it("rejects a real secret embedded in a schema property KEY (valuesOnly relaxes only the name heuristic)", () => {
    expect(() =>
      assertNoInlineSecretValues({
        outputSchema: {
          type: "object",
          properties: { [`leaked-${secret}`]: { type: "string" } },
        },
      }),
    ).toThrow(/secret-like/);
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

  it("uses an empty v3 namespace without probing the legacy roots", () => {
    const config = process.env.CLAUDEXOR_CONFIG_DIR;
    try {
      delete process.env.CLAUDEXOR_CONFIG_DIR;
      expect(userConfigDir()).toMatch(/\.claudexor\/v3$/);
    } finally {
      if (config === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = config;
    }
  });
});

describe("fsyncDirectory win32 tolerance", () => {
  const roots: string[] = [];
  function refusingDir(): string {
    const dir = mkdtempSync(join(tmpdir(), flush.marker));
    roots.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    flush.closed.length = 0;
  });

  it("tolerates the refused flush on win32 and still closes the handle", () => {
    const dir = refusingDir();
    expect(() => fsyncDirectory(dir, "win32")).not.toThrow();
    // The tolerance must not leak the descriptor it swallowed the error on.
    expect(flush.closed).toHaveLength(1);
  });

  it("propagates the refused flush on every platform that has the mechanism", () => {
    for (const platform of ["darwin", "linux", "freebsd"] as const) {
      const dir = refusingDir();
      expect(() => fsyncDirectory(dir, platform)).toThrow(/EACCES/);
    }
    expect(flush.closed).toHaveLength(3);
  });

  it("flushes for real when the platform does not refuse", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-flush-ok-"));
    roots.push(dir);
    expect(() => fsyncDirectory(dir, "win32")).not.toThrow();
    expect(() => fsyncDirectory(dir, "linux")).not.toThrow();
    expect(flush.closed).toHaveLength(0);
  });

  it("keeps one serving directory-flush owner beside the sealed legacy oracle", () => {
    runDirectoryFlushOwnershipCheck();
  });
});

describe("ensureCanonicalPrivateDirectory win32 chmod tolerance", () => {
  // The refusal-marker tmpdir mock above makes BOTH descriptor mutations
  // refuse the way win32 does: fchmod with EPERM (no POSIX mode bits on
  // directory handles) and fsync with EACCES. tmpdir() itself is a symlink
  // spelling on macOS, so the canonical realpath is the only parent this
  // helper accepts.
  const canonicalTmp = realpathSync.native(tmpdir());
  const roots: string[] = [];
  function ownedDir(prefix: string): string {
    const dir = mkdtempSync(join(canonicalTmp, prefix));
    roots.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    flush.closed.length = 0;
  });

  it("tolerates the refused directory chmod on win32 and still closes the handle", () => {
    const dir = ownedDir(flush.marker);
    expect(ensureCanonicalPrivateDirectory(dir, "win32")).toBe(dir);
    // The tolerance must not leak the descriptor it swallowed the errors on.
    expect(flush.closed).toHaveLength(1);
  });

  it("propagates the refused chmod on every platform that has POSIX directory modes", () => {
    for (const platform of ["darwin", "linux", "freebsd"] as const) {
      const dir = ownedDir(flush.marker);
      expect(() => ensureCanonicalPrivateDirectory(dir, platform)).toThrow(/EPERM/);
    }
    expect(flush.closed).toHaveLength(3);
  });

  it("still tightens the mode to 0o700 when the platform does not refuse", () => {
    const dir = ownedDir("claudexor-owned-chmod-");
    chmodSync(dir, 0o755);
    expect(ensureCanonicalPrivateDirectory(dir)).toBe(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // Attempt-first tolerance, same shape as the flush: the win32 parameter
    // only forgives a refusal, it never skips the attempt.
    chmodSync(dir, 0o755);
    expect(ensureCanonicalPrivateDirectory(dir, "win32")).toBe(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

function runDirectoryFlushOwnershipCheck(): void {
  // The 3.3.7 defect was one-place-only tolerance: token.ts got the win32
  // carve-out while six sibling copies kept the unguarded form, so the
  // daemon still died on Windows. Duplicating the open+fsync pair anywhere
  // else reintroduces exactly that split.
  const packages = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const owners: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (
        entry.endsWith(".ts") &&
        !entry.endsWith(".test.ts") &&
        readFileSync(path, "utf8").includes("O_DIRECTORY")
      ) {
        owners.push(path.slice(packages.length + 1));
      }
    }
  };
  walk(packages);
  // The immutable legacy oracle is test-only; every other copy is still a defect.
  expect(owners.sort()).toEqual([
    "daemon/src/store/test-support/fixtures/legacy/util/index.ts",
    "util/src/index.ts",
  ]);
}
