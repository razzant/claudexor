import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
});
