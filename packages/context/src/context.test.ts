import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskContract } from "@claudexor/schema";
import { discoverAgentsFiles, loadAgentsInstructions } from "./agents.js";
import { buildScopeAtlas } from "./atlas.js";
import { assertMandatoryContext, buildContextPack } from "./contextpack.js";
import { incrementRound, preflightEvidence, readRound, writeEvidencePacket } from "./evidence.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "claudexor-ctx-"));
}

describe("ScopeAtlas", () => {
  it("classifies every path and omits over budget (no silent truncation)", async () => {
    const repo = tmp();
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n".repeat(5));
    writeFileSync(join(repo, "src", "b.ts"), "export const b = 2;\n".repeat(5));
    writeFileSync(join(repo, ".env"), "SECRET=1\n");
    writeFileSync(join(repo, "logo.png"), "binarybytes");
    writeFileSync(join(repo, "pnpm-lock.yaml"), "lock\n");

    const res = await buildScopeAtlas(repo, { tokenLimit: 5 });
    const byPath = Object.fromEntries(res.atlas.map((e) => [e.path, e.disposition]));
    expect(byPath[".env"]).toBe("sensitive");
    expect(byPath["logo.png"]).toBe("binary");
    expect(byPath["pnpm-lock.yaml"]).toBe("manifest_only");
    expect(res.atlas.length).toBe(5); // every file accounted for
    expect(res.omitted.length).toBeGreaterThanOrEqual(1); // budget forced omission
  });
});

describe("AGENTS.md discovery", () => {
  it("loads nested files root-first so the closest wins", () => {
    const repo = tmp();
    mkdirSync(join(repo, "pkg"));
    writeFileSync(join(repo, "AGENTS.md"), "ROOT RULES");
    writeFileSync(join(repo, "pkg", "AGENTS.md"), "PKG RULES");
    const docs = discoverAgentsFiles(repo, join(repo, "pkg"));
    expect(docs.map((d) => d.content)).toEqual(["ROOT RULES", "PKG RULES"]);
    const { text } = loadAgentsInstructions(repo, join(repo, "pkg"));
    expect(text.indexOf("ROOT RULES")).toBeLessThan(text.indexOf("PKG RULES"));
  });
});

describe("ContextPack", () => {
  it("produces a hashable pack accounting for files", async () => {
    const repo = tmp();
    writeFileSync(join(repo, "x.ts"), "export const x = 1;\n");
    const contract = TaskContract.parse({
      schema_version: 2,
      task_id: "t",
      created_at: "2026-01-01T00:00:00Z",
      repo: { root: repo, base_ref: "HEAD" },
      mode: { kind: "agent" },
      user_intent: { raw: "x" },
    });
    const pack = await buildContextPack(repo, contract, { tokenLimit: 100_000 });
    expect(pack.hash).toMatch(/^sha256:/);
    expect(pack.atlas.length).toBeGreaterThanOrEqual(1);
  });

  it("uses public repo docs, not local AGENTS.md, as default mandatory context", async () => {
    const repo = tmp();
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "README.md"), "# test\n");
    writeFileSync(join(repo, "docs", "ARCHITECTURE.md"), "# arch\n");
    writeFileSync(join(repo, "AGENTS.md"), "# local only\n");
    const contract = TaskContract.parse({
      schema_version: 2,
      task_id: "t",
      created_at: "2026-01-01T00:00:00Z",
      repo: { root: repo, base_ref: "HEAD" },
      mode: { kind: "agent" },
      user_intent: { raw: "x" },
    });
    const pack = await buildContextPack(repo, contract, { tokenLimit: 100_000 });
    const mandatoryPaths = pack.files.mandatory.map((f) => f.path);
    expect(mandatoryPaths).toHaveLength(2);
    expect(mandatoryPaths).toEqual(expect.arrayContaining(["README.md", "docs/ARCHITECTURE.md"]));
    expect(mandatoryPaths).not.toContain("AGENTS.md");
    expect(pack.instructions.some((p) => p.endsWith("AGENTS.md"))).toBe(true);
  });
});

describe("assertMandatoryContext (uniform preflight)", () => {
  it("is a no-op when no mandatory files are configured (fresh repo never gated)", () => {
    expect(() => assertMandatoryContext(tmp(), [])).not.toThrow();
  });

  it("passes when every explicitly-configured mandatory file exists", () => {
    const repo = tmp();
    writeFileSync(join(repo, "README.md"), "# r\n");
    expect(() => assertMandatoryContext(repo, ["README.md"])).not.toThrow();
  });

  it("fails closed when an explicitly-configured mandatory file is missing", () => {
    expect(() => assertMandatoryContext(tmp(), ["README.md", "docs/ARCHITECTURE.md"])).toThrow(
      /mandatory context missing\/unreadable/,
    );
  });

  it("rejects a mandatory path that escapes the repo (absolute or ..)", () => {
    const repo = tmp();
    expect(() => assertMandatoryContext(repo, ["../escape.md"])).toThrow(/escapes the repo/);
    expect(() => assertMandatoryContext(repo, ["/etc/hosts"])).toThrow(/escapes the repo/);
  });
});

describe("evidence packet", () => {
  it("writes mandatory files, preflight passes, round increments", () => {
    const dir = join(tmp(), ".adversarial-review");
    writeEvidencePacket(dir, { userIntent: "do X", diff: "diff --git a b\n" });
    expect(preflightEvidence(dir).ok).toBe(true);
    expect(readFileSync(join(dir, "DIFF_SUMMARY.md"), "utf8")).toContain("Digest: sha256:");
    expect(readRound(dir)).toBe(0);
    expect(incrementRound(dir)).toBe(1);
    expect(readRound(dir)).toBe(1);
  });

  it("preflight fails closed when a mandatory file is missing", () => {
    const dir = join(tmp(), "empty-review");
    const pf = preflightEvidence(dir);
    expect(pf.ok).toBe(false);
    expect(pf.missing).toContain("USER_INTENT.md");
  });

  it("treats generated diff summary as mandatory evidence", () => {
    const dir = join(tmp(), ".adversarial-review");
    writeEvidencePacket(dir, { userIntent: "do X", diff: "diff --git a b\n" });
    rmSync(join(dir, "DIFF_SUMMARY.md"));
    const pf = preflightEvidence(dir);
    expect(pf.ok).toBe(false);
    expect(pf.missing).toContain("DIFF_SUMMARY.md");
  });

  it("refuses to persist raw patch evidence when the diff contains secret-like tokens", () => {
    const dir = join(tmp(), ".adversarial-review");
    const fakeKey = "sk-" + "abcdefghijklmnopqrstuvwxyz";
    expect(() =>
      writeEvidencePacket(dir, {
        userIntent: "do X",
        diff: `diff --git a/.env b/.env\n@@ -1 +1 @@\n-OLD=1\n+OPENAI_API_KEY=${fakeKey}\n`,
      }),
    ).toThrow(/refusing to persist raw DIFF\.patch/);
    expect(existsSync(join(dir, "DIFF.patch"))).toBe(false);
    expect(existsSync(join(dir, "DIFF_SUMMARY.md"))).toBe(false);
  });

  it("redacts secret-like tokens from prose evidence packet files", () => {
    const dir = join(tmp(), ".adversarial-review");
    const fakeKey = "sk-" + "abcdefghijklmnopqrstuvwxyz";
    writeEvidencePacket(dir, {
      userIntent: `Use ${fakeKey} in the repro`,
      forbiddenFindings: `Do not ignore ${fakeKey}`,
      planAccepted: `## Plan\nCheck ${fakeKey}`,
      diff: "diff --git a/x b/x\n",
      filesToReadWhole: [`docs/${fakeKey}.md`],
      tests: `TOKEN=${fakeKey} pnpm test`,
      decidedTradeoffs: `Accepted ${fakeKey}`,
      runtime: `stdout ${fakeKey}`,
    });

    for (const file of [
      "USER_INTENT.md",
      "FORBIDDEN_FINDINGS.md",
      "PLAN_ACCEPTED.md",
      "FILES_TO_READ_WHOLE.txt",
      "TESTS.txt",
      "DECIDED_TRADEOFFS.md",
      "RUNTIME.md",
    ]) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text).not.toContain(fakeKey);
      expect(text).toContain("[redacted]");
    }
  });

  it("reports raw patch stats in the redacted diff summary", () => {
    const dir = join(tmp(), ".adversarial-review");
    const diff = `diff --git a/config.example b/config.example\n@@ -1 +1 @@\n-OLD=1\n+TOKEN=example-value\n`;
    writeEvidencePacket(dir, { userIntent: "do X", diff });

    const summary = readFileSync(join(dir, "DIFF_SUMMARY.md"), "utf8");
    expect(summary).toContain(`- Patch bytes: ${Buffer.byteLength(diff, "utf8")}`);
    expect(summary).toContain(`- Patch lines: ${diff.split(/\r?\n/).length}`);
    expect(summary).toContain("config.example -> config.example");
  });

  it("summarizes git diff headers with spaces and b substrings in paths", () => {
    const dir = join(tmp(), ".adversarial-review");
    writeEvidencePacket(dir, {
      userIntent: "do X",
      diff: [
        'diff --git "a/src/a b/file name.ts" "b/src/a b/file name.ts"',
        "diff --git a/src/bright.ts b/src/bright.ts",
        "",
      ].join("\n"),
    });
    const summary = readFileSync(join(dir, "DIFF_SUMMARY.md"), "utf8");
    expect(summary).toContain("src/a b/file name.ts -> src/a b/file name.ts");
    expect(summary).toContain("src/bright.ts -> src/bright.ts");
  });
});

describe("atlas walker symlink safety (T3#7)", () => {
  it("survives a self-referencing symlink cycle and skips directory symlinks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-atlas-cycle-"));
    writeFileSync(join(dir, "real.txt"), "content\n");
    // `ln -s . loop` — the classic stack-overflow cycle.
    symlinkSync(".", join(dir, "loop"));
    // A dir symlink pointing OUTSIDE the tree must not be walked either.
    const outside = mkdtempSync(join(tmpdir(), "claudexor-atlas-outside-"));
    writeFileSync(join(outside, "secret.txt"), "outside\n");
    symlinkSync(outside, join(dir, "escape"));
    const { buildScopeAtlas } = await import("./atlas.js");
    const atlas = await buildScopeAtlas(dir);
    const paths = atlas.atlas.map((e) => e.path);
    expect(paths).toContain("real.txt");
    expect(paths.some((p) => p.includes("secret.txt"))).toBe(false);
    expect(paths.some((p) => p.startsWith("loop/"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("atlas symlink containment (R33 gate finding)", () => {
  it("a TRACKED symlink pointing outside the tree is excluded, never read into the pack", async () => {
    const { mkdtempSync, writeFileSync, symlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { buildScopeAtlas } = await import("./atlas.js");
    const outside = mkdtempSync(join(tmpdir(), "cx-outside-"));
    writeFileSync(join(outside, "host-secret.txt"), "HOST SECRET CONTENT\n");
    const repo = mkdtempSync(join(tmpdir(), "cx-symlink-"));
    const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    g(["init", "-q"]);
    writeFileSync(join(repo, "real.txt"), "in-tree content\n");
    symlinkSync(join(outside, "host-secret.txt"), join(repo, "leak.txt"));
    symlinkSync(join(repo, "real.txt"), join(repo, "alias.txt")); // in-tree symlink: fine
    g(["add", "-A"]);
    g(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "with symlinks"]);
    const res = await buildScopeAtlas(repo);
    const leak = res.atlas.find((e) => e.path === "leak.txt");
    expect(leak?.disposition).toBe("excluded");
    expect(leak?.reason).toContain("symlink resolves outside");
    // The out-of-tree content never lands anywhere in the atlas result.
    expect(JSON.stringify(res).includes("HOST SECRET CONTENT")).toBe(false);
    // The in-tree symlink still maps normally.
    const alias = res.atlas.find((e) => e.path === "alias.txt");
    expect(alias?.disposition === "excluded" ? alias?.reason ?? "" : "").not.toContain("outside");
  });
});

describe("atlas fallback-walker symlink containment", () => {
  it("a NON-git tree with an out-of-tree symlink never maps it; in-tree symlinks map", async () => {
    const { mkdtempSync, writeFileSync, symlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { buildScopeAtlas } = await import("./atlas.js");
    const outside = mkdtempSync(join(tmpdir(), "cx-w-outside-"));
    writeFileSync(join(outside, "secret.txt"), "WALKER SECRET\n");
    const root = mkdtempSync(join(tmpdir(), "cx-w-root-")); // NOT a git repo -> fallback walker
    writeFileSync(join(root, "real.txt"), "content\n");
    symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"));
    symlinkSync(join(root, "real.txt"), join(root, "alias.txt"));
    const res = await buildScopeAtlas(root);
    const paths = res.atlas.map((e) => e.path);
    expect(paths).not.toContain("leak.txt"); // walker never surfaced it
    expect(paths).toContain("alias.txt"); // in-tree symlink maps
    expect(JSON.stringify(res).includes("WALKER SECRET")).toBe(false);
  });
});
