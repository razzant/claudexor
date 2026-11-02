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

const gitIn = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe", encoding: "utf8" }).trim();
/** What Git stores for `content` at `path`, through that path's attributes and filters. */
const blobOf = (root: string, path: string, content: string) =>
  execFileSync("git", ["-C", root, "hash-object", "--stdin", `--path=${path}`], {
    input: content,
    encoding: "utf8",
  }).trim();
/** The tree a scratch index records for what the directory holds now, as the
 * engine's own snapshot does: the index and HEAD do not move. */
const treeNow = (root: string) => {
  const env = { ...process.env, GIT_INDEX_FILE: join(root, ".git", "scratch-index") };
  execFileSync("git", ["-C", root, "read-tree", "HEAD"], { env });
  execFileSync("git", ["-C", root, "add", "-A"], { env });
  return execFileSync("git", ["-C", root, "write-tree"], { env, encoding: "utf8" }).trim();
};
/** Every delivered file is the blob its packet names, byte for byte, and the manifest
 * states that same object's figures. */
const sameSource = (root: string, packet: RawContextPacket) => {
  for (const file of packet.readable_files) {
    const stored = execFileSync("git", ["-C", root, "cat-file", "blob", file.blob_oid]);
    expect(Buffer.from(file.content).equals(stored), file.path).toBe(true);
    expect(
      packet.file_manifest.find((entry) => entry.path === file.path),
      file.path,
    ).toMatchObject({ disposition: "full", bytes: stored.length, hash: file.content_hash });
  }
};

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
      ["NEW.md", "NEW.md (missing or unreadable)"],
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
    const tree = gitIn(root, "rev-parse", "HEAD^{tree}");
    const packet = await size!(capacity({ contextWindow: 1_000_000 }), tree);
    expect(packet.readable_files.map((file) => file.path)).toEqual(["BIG.md", "README.md"]);
    expect(packet.budget?.basis).toBe("model_context_window");
    // A request whose window is unknown is sized under the labelled assumption.
    expect((await size!(null, tree)).budget?.basis).toBe("assumed_ceiling");
    expect(rawContextSizer("workspace", envelope)).toBeNull();
    // Isolation is refused when the sizer is made, before anything is dispatched.
    expect(() => rawContextSizer("git_patch_envelope", { ...envelope, repo_root: root })).toThrow(
      "raw_patch_requires_isolation",
    );
  });

  it("describes the exact candidate tree while keeping the run's delivery base (#551)", async () => {
    const root = repo({ "a.txt": "one\n", "gone.txt": "bye\n", "README.md": "# repo\n" });
    const base = gitIn(root, "rev-parse", "HEAD");
    // What an earlier round leaves: an edit, a deletion and a new file, uncommitted.
    writeFileSync(join(root, "a.txt"), "two\n");
    rmSync(join(root, "gone.txt"));
    writeFileSync(join(root, "new.txt"), "fresh\n");
    const scratchIndex = join(root, ".git", "scratch-index");
    const env = { ...process.env, GIT_INDEX_FILE: scratchIndex };
    execFileSync("git", ["-C", root, "read-tree", "HEAD"], { env });
    execFileSync("git", ["-C", root, "add", "-A"], { env });
    const tree = execFileSync("git", ["-C", root, "write-tree"], { env, encoding: "utf8" }).trim();

    const packet = await buildRawContextPacket(root, base, { candidateTree: tree });
    expect(packet.base_commit_sha).toBe(base);
    expect(packet.base_tree_sha).toBe(tree);
    expect(readable(packet)).toEqual(["a.txt", "new.txt", "README.md"]);
    const identity = (path: string) => gitIn(root, "rev-parse", `${tree}:${path}`);
    for (const file of packet.readable_files) expect(file.blob_oid).toBe(identity(file.path));
    expect(packet.readable_files.find((file) => file.path === "a.txt")?.content).toBe("two\n");
    expect(packet.file_manifest.map((entry) => entry.path)).not.toContain("gone.txt");

    sameSource(root, packet);

    // Without a candidate tree the packet describes the base itself, as a first round does.
    const first = await buildRawContextPacket(root, base);
    expect(first.base_tree_sha).toBe(gitIn(root, "rev-parse", `${base}^{tree}`));
    sameSource(root, first);
  });

  it("a base packet carries the base's own content, whatever the directory holds now", async () => {
    const root = repo({ "a.txt": "one\n", "b.txt": "same\n", "README.md": "# repo\n" });
    writeFileSync(join(root, "a.txt"), "dirty\n");
    const packet = await buildRawContextPacket(root, "HEAD");
    sameSource(root, packet);
    expect(readable(packet)).toEqual(["a.txt", "b.txt", "README.md"]);
    expect(packet.readable_files.find((file) => file.path === "a.txt")?.content).toBe("one\n");
    // A mandatory file is delivered complete, as its tree stores it.
    const pinned = await buildRawContextPacket(root, "HEAD", { mandatory: ["a.txt"] });
    expect(pinned.readable_files.find((file) => file.path === "a.txt")?.content).toBe("one\n");
  });

  it("a line ending Git converts on checkout arrives as the tree stores it: the form a patch applies to", async () => {
    const root = repo({ ".gitattributes": "*.txt text eol=crlf\n", "a.txt": "one\r\n" });
    // Stored normalized, held with the CRLF the attributes ask for.
    expect(gitIn(root, "cat-file", "-p", "HEAD:a.txt")).toBe("one");
    const packet = await buildRawContextPacket(root, "HEAD");
    expect(packet.readable_files.find((file) => file.path === "a.txt")?.content).toBe("one\n");
    sameSource(root, packet);
    // Applied as the engine applies a raw patch: to the tree through a scratch index,
    // and to the CRLF file, which Git converts. A patch of the CRLF bytes fails the first.
    const env = { ...process.env, GIT_INDEX_FILE: join(root, ".git", "scratch-index") };
    execFileSync("git", ["-C", root, "read-tree", "HEAD"], { env });
    const applies = (from: string, to: string, cached: boolean) => {
      const diff = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
      const flags = cached ? ["--cached", "--whitespace=nowarn"] : ["--whitespace=nowarn"];
      try {
        execFileSync("git", ["-C", root, "apply", ...flags, "--check", "-"], {
          env,
          input: diff,
          stdio: "pipe",
        });
        return true;
      } catch {
        return false;
      }
    };
    expect([applies("one", "two", true), applies("one", "two", false)]).toEqual([true, true]);
    expect(applies("one\r", "two\r", true)).toBe(false);
  });

  it("a retained candidate tree carries its own content, never bytes written after it was read", async () => {
    const root = repo({ "a.txt": "one\n", "README.md": "# repo\n" });
    const base = gitIn(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "a.txt"), "two\n");
    writeFileSync(join(root, "new.txt"), "fresh\n");
    const tree = treeNow(root);
    // The directory moves after the tree was read.
    writeFileSync(join(root, "a.txt"), "three\n");
    writeFileSync(join(root, "new.txt"), "changed\n");
    const packet = await buildRawContextPacket(root, base, { candidateTree: tree });
    expect(packet.base_tree_sha).toBe(tree);
    sameSource(root, packet);
    const content = (of: RawContextPacket, path: string) =>
      of.readable_files.find((file) => file.path === path)?.content;
    expect([content(packet, "a.txt"), content(packet, "new.txt")]).toEqual(["two\n", "fresh\n"]);
    // Read again, the tree of what it holds now carries that.
    const now = await buildRawContextPacket(root, base, { candidateTree: treeNow(root) });
    sameSource(root, now);
    expect([content(now, "a.txt"), content(now, "new.txt")]).toEqual(["three\n", "changed\n"]);
  });

  it("no second look at the directory decides content: a filter that stores any bytes as the tree's blob licenses none", async () => {
    // A clean filter that ignores its input stores every version of a.txt as "two\n",
    // so a check that hashes the file again through Git would accept any bytes.
    const root = repo({ "README.md": "# repo\n" });
    gitIn(root, "config", "filter.fixed.clean", "cat >/dev/null; echo two");
    writeFileSync(join(root, ".gitattributes"), "a.txt filter=fixed\n");
    writeFileSync(join(root, "a.txt"), "two\n");
    const tree = treeNow(root);
    writeFileSync(join(root, "a.txt"), "evil\n");
    expect(blobOf(root, "a.txt", "evil\n")).toBe(gitIn(root, "rev-parse", `${tree}:a.txt`));
    const packet = await buildRawContextPacket(root, gitIn(root, "rev-parse", "HEAD"), {
      candidateTree: tree,
    });
    expect(packet.readable_files.find((file) => file.path === "a.txt")?.content).toBe("two\n");
    sameSource(root, packet);
  });

  it("reads a batch of blobs byte-exactly: empty, shared, multibyte and header-like content", async () => {
    const files = {
      "README.md": "# repo\n",
      "empty.txt": "",
      "same-a.txt": "shared\n",
      "same-b.txt": "shared\n",
      "stored-crlf.txt": "one\r\ntwo\r\n",
      "wide.txt": "\u0416\u{1f600}\n",
      "header-like.txt": `${"0".repeat(40)} blob 3\nabc\n\n`,
    };
    const root = repo(files);
    const packet = await buildRawContextPacket(root, "HEAD");
    sameSource(root, packet);
    expect(
      Object.fromEntries(packet.readable_files.map((file) => [file.path, file.content])),
    ).toEqual(files);
  });

  it("fails loudly, delivering nothing, when the repository does not hold a blob its tree names", async () => {
    const root = repo({ "README.md": "# repo\n", "a.txt": "one\n" });
    const oid = gitIn(root, "rev-parse", "HEAD:a.txt");
    rmSync(join(root, ".git", "objects", oid.slice(0, 2), oid.slice(2)), { force: true });
    await expect(buildRawContextPacket(root, "HEAD")).rejects.toThrow(
      `git cat-file answered no blob: ${oid} missing`,
    );
  });

  it("a blob that is not UTF-8 text is left out, never sent with replaced bytes, and refused when mandatory", async () => {
    // Valid UTF-8 that merely contains U+FFFD is ordinary text.
    const root = repo({ "README.md": "# repo\n", "ok.txt": "caf\u00e9 \ufffd\n" });
    writeFileSync(join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    gitIn(root, "add", "latin1.txt");
    gitIn(root, "commit", "-q", "-m", "latin-1");
    const packet = await buildRawContextPacket(root, "HEAD");
    sameSource(root, packet);
    expect(readable(packet)).toEqual(["ok.txt", "README.md"]);
    expect(packet.omissions.find((item) => item.path === "latin1.txt")?.reason).toBe(
      "not UTF-8 text",
    );
    expect(packet.file_manifest.find((entry) => entry.path === "latin1.txt")).toEqual({
      path: "latin1.txt",
      disposition: "omitted",
      bytes: 5,
      reason: "not UTF-8 text",
    });
    await expect(
      buildRawContextPacket(root, "HEAD", { mandatory: ["latin1.txt"] }),
    ).rejects.toMatchObject({
      code: "raw_context_mandatory_unavailable",
      message: expect.stringContaining("latin1.txt (not UTF-8 text)"),
    });
  });
});
