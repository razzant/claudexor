import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RawContextRefusalError, type RawRequestCapacity } from "@claudexor/core";
import type { RawContextPacket, WorkspaceEnvelope } from "@claudexor/schema";
import {
  RAW_CONTEXT_ASSUMED_CEILING_TOKENS,
  buildRawContextPacket,
  rawContextSizer,
} from "./raw-context.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A committed repository; `untracked` files exist only in the worktree. */
function repo(files: Record<string, string>, untracked: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "claudexor-raw-context-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe", encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  git("add", ".");
  git("commit", "-q", "-m", "base");
  for (const [path, content] of Object.entries(untracked)) writeFileSync(join(root, path), content);
  return root;
}

const capacity = (overrides: Partial<RawRequestCapacity> = {}): RawRequestCapacity => ({
  model: "vendor/m",
  contextWindow: 100_000,
  outputAllowance: 2_000,
  outputAllowanceSource: "catalog",
  framingTokens: 500,
  ...overrides,
});
const tokens = (packet: RawContextPacket) => Math.ceil(JSON.stringify(packet).length / 4);
const readable = (packet: RawContextPacket) => packet.readable_files.map((file) => file.path);
// A 270 KB file: above the ordinary 256 KiB per-file limit (the #147 counterexample).
const BIG = `${"x".repeat(99)}\n`.repeat(2_700);

describe("raw context packet honours ProjectConfig.context (#147)", () => {
  it("delivers a committed 270 KB mandatory file complete; an ordinary one is omitted as oversized", async () => {
    const root = repo({ "BIG.md": BIG, "README.md": "# repo\n" });
    const ordinary = await buildRawContextPacket(root, "HEAD");
    expect(readable(ordinary)).toEqual(["README.md"]);
    expect(ordinary.omissions).toContainEqual(
      expect.objectContaining({ path: "BIG.md", reason: "> 262144 bytes" }),
    );
    const packet = await buildRawContextPacket(root, "HEAD", { mandatory: ["BIG.md"] });
    expect(packet.readable_files.find((file) => file.path === "BIG.md")?.content).toBe(BIG);
    expect(packet.budget).toMatchObject({
      basis: "assumed_ceiling",
      model: null,
      selection_limit_tokens: RAW_CONTEXT_ASSUMED_CEILING_TOKENS,
      mandatory_paths: ["BIG.md"],
    });
  });

  it("refuses a missing or an uncommitted mandatory file before anything is sent", async () => {
    const root = repo({ "README.md": "# repo\n", ".env": "TOKEN=1\n" }, { "NEW.md": "new\n" });
    for (const [mandatory, cause] of [
      ["GONE.md", "GONE.md (missing or unreadable)"],
      ["NEW.md", "NEW.md (missing base-tree evidence)"],
    ] as const) {
      await expect(
        buildRawContextPacket(root, "HEAD", { mandatory: [mandatory] }),
        mandatory,
      ).rejects.toMatchObject({
        code: "raw_context_mandatory_unavailable",
        category: "project",
        retryable: false,
        message: expect.stringContaining(cause),
      });
    }
  });

  it("delivers a credential-named mandatory file exactly, like any project file (INV-146)", async () => {
    const root = repo({ "README.md": "# repo\n", ".env": "TOKEN=1\n" });
    const packet = await buildRawContextPacket(root, "HEAD", { mandatory: [".env"] });
    expect(packet.readable_files.find((file) => file.path === ".env")?.content).toBe("TOKEN=1\n");
  });

  it("honours include and exclude for optional files", async () => {
    const root = repo({ "a.ts": "a\n", "b.ts": "b\n", "notes.md": "n\n" });
    const packet = await buildRawContextPacket(root, "HEAD", {
      include: ["*.ts"],
      exclude: ["b.ts"],
    });
    expect(readable(packet)).toEqual(["a.ts"]);
  });

  it("refuses mandatory content that cannot fit a KNOWN window, naming files, sizes and the window", async () => {
    const root = repo({ "BIG.md": BIG, "README.md": "# repo\n" });
    const build = buildRawContextPacket(root, "HEAD", {
      mandatory: ["BIG.md"],
      capacity: capacity({ contextWindow: 50_000 }),
    });
    await expect(build).rejects.toMatchObject({
      code: "raw_context_exceeds_window",
      category: "validation",
    });
    await expect(build).rejects.toThrow(
      /cannot fit its 50000-token context window: the packet needs ~\d+ tokens with every optional file omitted \(mandatory: BIG\.md \(~\d+ tokens\)\), the request framing ~500 and the output allowance 2000 \(estimates, chars\/4\)/,
    );
  });

  it("carries the refusal's sizes typed: every mandatory file largest first, figures that add up", async () => {
    const MID = `${"m".repeat(99)}\n`.repeat(1_200);
    const root = repo({ "BIG.md": BIG, "A-MID.md": MID, "z.md": "small\n", "README.md": "# r\n" });
    const refusal = await buildRawContextPacket(root, "HEAD", {
      mandatory: ["z.md", "BIG.md", "A-MID.md"],
      capacity: capacity({ contextWindow: 50_000 }),
    }).then(
      () => null,
      (err: unknown) => err,
    );
    if (!(refusal instanceof RawContextRefusalError)) throw new Error("expected a refusal");
    const shortfall = refusal.rawContextShortfall!;
    expect(shortfall).toMatchObject({
      model: "vendor/m",
      context_window: 50_000,
      framing_tokens: 500,
      output_allowance_tokens: 2_000,
    });
    expect(shortfall.mandatory_files.map((file) => file.path)).toEqual([
      "BIG.md",
      "A-MID.md",
      "z.md",
    ]);
    const sum = shortfall.mandatory_files.reduce((total, file) => total + file.estimated_tokens, 0);
    // The files are part of the packet; the remainder is the manifest and metadata.
    expect(sum).toBeLessThanOrEqual(shortfall.packet_tokens);
    expect(
      shortfall.packet_tokens + shortfall.framing_tokens + shortfall.output_allowance_tokens,
    ).toBeGreaterThan(shortfall.context_window);
    // The message is unchanged and states the same figures.
    for (const file of shortfall.mandatory_files)
      expect(refusal.message).toContain(`${file.path} (~${file.estimated_tokens} tokens)`);
    expect(refusal.message).toContain(`needs ~${shortfall.packet_tokens} tokens`);
  });
});

describe("raw context budget against the selected model's window (#147)", () => {
  // Five 4 KB optional files: about 1 000 estimated tokens of content each and
  // ~1 100 with their packet records, so a 4 000-token share fits exactly three.
  const files = Object.fromEntries(
    ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"].map((path) => [
      path,
      `${path} ${"y".repeat(4_000)}\n`,
    ]),
  );

  it("omits optional files deterministically from the end of path order and keeps the whole request inside the window", async () => {
    const root = repo(files);
    const cap = capacity({ contextWindow: 6_500, outputAllowance: 1_000, framingTokens: 1_500 });
    const packet = await buildRawContextPacket(root, "HEAD", { capacity: cap });
    expect(readable(packet)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(packet.budget).toMatchObject({
      basis: "model_context_window",
      model: "vendor/m",
      context_window: 6_500,
      output_allowance_tokens: 1_000,
      framing_tokens: 1_500,
      selection_limit_tokens: 4_000,
      omitted_for_budget: 2,
      mandatory_paths: [],
    });
    expect(packet.budget!.estimated_packet_tokens).toBe(tokens(packet));
    expect(tokens(packet) + cap.framingTokens + cap.outputAllowance).toBeLessThanOrEqual(6_500);
    for (const path of ["d.ts", "e.ts"]) {
      expect(packet.file_manifest).toContainEqual(
        expect.objectContaining({ path, disposition: "omitted", reason: "token_budget" }),
      );
      expect(packet.omissions).toContainEqual(
        expect.objectContaining({ path, reason: "token budget exceeded" }),
      );
    }
    const again = await buildRawContextPacket(root, "HEAD", { capacity: cap });
    expect(again.packet_hash).toBe(packet.packet_hash);
  });

  it("counts framing and the output allowance: more of either leaves fewer optional files", async () => {
    const root = repo(files);
    const sized = async (cap: RawRequestCapacity) =>
      readable(await buildRawContextPacket(root, "HEAD", { capacity: cap }));
    const base = { contextWindow: 6_500, outputAllowance: 1_000, framingTokens: 1_500 };
    expect(await sized(capacity(base))).toHaveLength(3);
    expect(await sized(capacity({ ...base, framingTokens: 2_600 }))).toHaveLength(2);
    expect(await sized(capacity({ ...base, outputAllowance: 2_100 }))).toHaveLength(2);
    expect(await sized(capacity({ ...base, contextWindow: 100_000 }))).toHaveLength(5);
  });

  it("keeps mandatory files whole while optional files make room for them", async () => {
    const root = repo({ ...files, "MUST.md": `must ${"z".repeat(4_000)}\n` });
    const packet = await buildRawContextPacket(root, "HEAD", {
      mandatory: ["MUST.md"],
      capacity: capacity({ contextWindow: 6_500, outputAllowance: 1_000, framingTokens: 1_500 }),
    });
    // Path order is the packet's localeCompare order; MUST.md is kept whatever its place.
    expect(readable(packet)).toEqual(["a.ts", "b.ts", "MUST.md"]);
    expect(packet.budget).toMatchObject({ omitted_for_budget: 3, mandatory_paths: ["MUST.md"] });
  });

  it("labels an UNKNOWN window as an assumed ceiling and still records the estimate", async () => {
    const root = repo(files);
    const packet = await buildRawContextPacket(root, "HEAD", {
      capacity: capacity({ contextWindow: null, outputAllowanceSource: "default" }),
    });
    expect(readable(packet)).toHaveLength(5);
    expect(packet.budget).toEqual({
      estimator: "chars_div_4",
      basis: "assumed_ceiling",
      model: "vendor/m",
      context_window: null,
      output_allowance_tokens: 2_000,
      framing_tokens: 500,
      selection_limit_tokens: RAW_CONTEXT_ASSUMED_CEILING_TOKENS,
      estimated_packet_tokens: tokens(packet),
      omitted_for_budget: 0,
      mandatory_paths: [],
    });
  });

  it("binds the project's context config to the envelope and sizes each request's packet", async () => {
    const root = repo({ "BIG.md": BIG, "README.md": "# repo\n" });
    const envelope = {
      repo_root: `${root}-project`,
      worktree_path: root,
      base_sha: "HEAD",
    } as WorkspaceEnvelope;
    const size = rawContextSizer("git_patch_envelope", envelope, {
      mandatory_files: ["BIG.md"],
      include: [],
      exclude: [],
    });
    const packet = await size!(capacity({ contextWindow: 1_000_000 }));
    expect(packet.readable_files.map((file) => file.path)).toEqual(["BIG.md", "README.md"]);
    expect(packet.budget?.basis).toBe("model_context_window");
    // A request whose window is unknown is sized under the labelled assumption.
    expect((await size!(null)).budget?.basis).toBe("assumed_ceiling");
    expect(rawContextSizer("workspace", envelope)).toBeNull();
    // Isolation is refused when the sizer is made, before anything is dispatched.
    expect(() => rawContextSizer("git_patch_envelope", { ...envelope, repo_root: root })).toThrow(
      "raw_patch_requires_isolation",
    );
  });
});
