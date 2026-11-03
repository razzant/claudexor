import type { RawRequestCapacity } from "@claudexor/core";
import { RawContextRefusalError, runCapture, runCaptureRaw } from "@claudexor/core";
import {
  RawContextPacket,
  type ImplementationTransport,
  type OmissionEntry,
  type RawContextFile,
  type ScopeAtlasEntry,
  type WorkspaceEnvelope,
} from "@claudexor/schema";
import { hashJson, sha256 } from "@claudexor/util";
import { buildScopeAtlas } from "./atlas.js";

/** Optional-content ceiling when no model window is known (#147): an
 * assumption carried over from the scope atlas, never a fact about a model. */
export const RAW_CONTEXT_ASSUMED_CEILING_TOKENS = 200_000;
const TOKEN_BUDGET_REASON = "token budget exceeded";
/** Same length as a real `sha256:<hex>` packet hash, for self-measurement. */
const HASH_PLACEHOLDER = `sha256:${"0".repeat(64)}`;

interface GitEntry {
  mode: string;
  oid: string;
}

/** What the production packet must honour: the project's `ProjectConfig.context`. */
export interface RawContextOptions {
  mandatory_files?: readonly string[];
  include?: readonly string[];
  exclude?: readonly string[];
}

/** Builds one request's packet for the capacity of the request it rides (null =
 * no window known) and the tree the engine's snapshot of the candidate just read
 * at that dispatch (#551). */
export type RawContextSizer = (
  capacity: RawRequestCapacity | null,
  candidateTree: string,
) => Promise<RawContextPacket>;

/**
 * The packet builder of an envelope whose transport inlines a RawContextPacket,
 * or null for any other transport. Isolation is checked here, before anything
 * is dispatched; each dispatch then builds its own packet for the capacity its
 * catalog read gives (#147).
 */
export function rawContextSizer(
  transport: ImplementationTransport,
  envelope: WorkspaceEnvelope,
  options: RawContextOptions = {},
): RawContextSizer | null {
  if (transport !== "git_patch_envelope") return null;
  if (envelope.worktree_path === envelope.repo_root)
    throw new Error(
      "raw_patch_requires_isolation: raw patch producers require an isolated envelope",
    );
  return (capacity, candidateTree) =>
    buildRawContextPacket(envelope.worktree_path, envelope.base_sha ?? "HEAD", {
      mandatory: [...(options.mandatory_files ?? [])],
      include: [...(options.include ?? [])],
      exclude: [...(options.exclude ?? [])],
      capacity,
      candidateTree,
    });
}

async function gitOutput(repo: string, args: string[]): Promise<string> {
  const result = await runCapture("git", ["-C", repo, ...args], {
    timeoutMs: 30_000,
    windowsConsole: "none",
  });
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Every path of one exact tree with its identity; a mode decides what is readable. */
async function treeEntries(repo: string, tree: string): Promise<Map<string, GitEntry>> {
  const output = await gitOutput(repo, ["ls-tree", "-r", "-z", tree]);
  const entries = new Map<string, GitEntry>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, , oid] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (mode && oid && path) entries.set(path, { mode, oid });
  }
  return entries;
}

/** Why a delivered path's blob is left out: as text, its bytes would not survive. */
const NOT_UTF8_TEXT = "not UTF-8 text";

/**
 * The exact bytes of each blob, read from the repository's object store in one
 * batch (`git cat-file --batch`): the tree's own content, never a later version on
 * disk, in the repository form a patch applies to (the form `git diff` shows).
 */
async function blobBytes(repo: string, oids: readonly string[]): Promise<Map<string, Buffer>> {
  const wanted = [...new Set(oids)];
  const blobs = new Map<string, Buffer>();
  if (wanted.length === 0) return blobs;
  const chunks: Buffer[] = [];
  const result = await runCaptureRaw("git", ["-C", repo, "cat-file", "--batch"], {
    timeoutMs: 60_000,
    windowsConsole: "none",
    input: `${wanted.join("\n")}\n`,
    stdoutProjection: { write: (chunk) => void chunks.push(chunk), end: () => "" },
  });
  if (result.code !== 0) throw new Error(`git cat-file failed: ${result.stderr.trim()}`);
  const out = Buffer.concat(chunks);
  for (let at = 0; at < out.length;) {
    const eol = out.indexOf(0x0a, at);
    const header = out.subarray(at, eol < 0 ? out.length : eol).toString("latin1");
    const [oid, type, size] = header.split(" ");
    const start = eol + 1;
    const end = start + Number(size);
    if (eol < 0 || !oid || type !== "blob" || !/^\d+$/.test(size ?? "") || end > out.length)
      throw new Error(`git cat-file answered no blob: ${header}`);
    blobs.set(oid, out.subarray(start, end));
    at = end + 1;
  }
  for (const oid of wanted)
    if (!blobs.has(oid)) throw new Error(`git cat-file answered no blob for ${oid}`);
  return blobs;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function mandatoryRefusal(files: string[]): RawContextRefusalError {
  return new RawContextRefusalError(
    "raw_context_mandatory_unavailable",
    `raw_context_mandatory_unavailable: mandatory context cannot be delivered complete: ${files.join("; ")}. ` +
      "Provide the named paths as complete UTF-8 files in the current candidate, or adjust context.mandatory_files.",
  );
}

/**
 * Build the complete, bounded text packet consumed by raw patch producers.
 * `baseCommitSha` is the run's delivery base. The packet describes one tree,
 * `candidateTree` (default: that base's own tree), which its patch applies to:
 * its paths, blob identities and file contents all come from that tree. Each
 * delivered file is its blob's exact bytes, read from Git in one batch, in the
 * repository form a patch applies to (the form `git diff` shows), so a file whose
 * line endings or filter Git converts on checkout arrives as the tree stores it.
 * A blob that is not UTF-8 text is omitted, never sent with replaced bytes.
 * `repoRoot` is read only to choose and budget paths; the manifest states each
 * delivered file's blob figures and why any other is left out. The engine passes the
 * tree its own snapshot of the candidate just read, so a later round reads what the
 * earlier one left and new files carry their own blobs (#551). Project mandatory
 * files are delivered complete (exempt from the ordinary per-file and budget
 * omissions) or the packet is refused. With a KNOWN model
 * window the whole rendered request (framing + packet + output allowance) is
 * sized to it: optional files are dropped deterministically from the end of
 * path order, and mandatory content that still cannot fit refuses before any
 * request is sent. Without a window the assumed ceiling bounds optional file
 * contents and is labelled as an assumption. Estimates are chars/4.
 */
export async function buildRawContextPacket(
  repoRoot: string,
  baseCommitSha: string,
  options: {
    mandatory?: string[];
    include?: string[];
    exclude?: string[];
    capacity?: RawRequestCapacity | null;
    candidateTree?: string;
  } = {},
): Promise<RawContextPacket> {
  const capacity = options.capacity ?? null;
  const window = capacity?.contextWindow ?? null;
  const limit =
    capacity && window !== null ? window - capacity.outputAllowance - capacity.framingTokens : null;
  const mandatory = new Set(options.mandatory ?? []);
  const treeSha =
    options.candidateTree ??
    (await gitOutput(repoRoot, ["rev-parse", `${baseCommitSha}^{tree}`])).trim();
  const entries = await treeEntries(repoRoot, treeSha);
  const atlas = await buildScopeAtlas(repoRoot, {
    files: [...entries.keys()],
    mandatory: [...mandatory],
    include: options.include ?? [],
    exclude: options.exclude ?? [],
    tokenLimit: limit === null ? RAW_CONTEXT_ASSUMED_CEILING_TOKENS : Math.max(limit, 0),
  });
  const regular = (mode: string | undefined) => mode === "100644" || mode === "100755";
  // Content and identity are one object: each delivered path's blob in the tree.
  const blobs = await blobBytes(
    repoRoot,
    atlas.atlas.flatMap((entry) => {
      const gitEntry = entries.get(entry.path);
      return entry.disposition === "full" && gitEntry && regular(gitEntry.mode)
        ? [gitEntry.oid]
        : [];
    }),
  );
  // Every mandatory path is delivered complete or named here, with its cause.
  const unavailable = new Map<string, string>();
  const leftOut = new Map<string, string>();
  const readableFiles: RawContextFile[] = [];
  const omissions: OmissionEntry[] = [...atlas.omitted];
  const omittedPaths = new Set(omissions.map((item) => item.path));

  for (const entry of atlas.atlas) {
    if (entry.disposition !== "full") {
      if (mandatory.has(entry.path)) unavailable.set(entry.path, entry.reason ?? entry.disposition);
      if (!omittedPaths.has(entry.path)) {
        omissions.push({
          path: entry.path,
          reason: entry.reason ?? entry.disposition,
          replacement: "index",
          ...(entry.hash ? { hash: entry.hash } : {}),
        });
      }
      continue;
    }
    const gitEntry = entries.get(entry.path);
    const bytes = gitEntry && regular(gitEntry.mode) ? blobs.get(gitEntry.oid) : undefined;
    const content = bytes?.toString("utf8");
    // The delivered text must be the blob's bytes: one that is not UTF-8 text would
    // arrive with replaced bytes, so it is left out like a binary file.
    if (!gitEntry || !bytes || content === undefined || !Buffer.from(content).equals(bytes)) {
      const reason = bytes ? NOT_UTF8_TEXT : `unsupported git mode ${gitEntry?.mode}`;
      if (mandatory.has(entry.path)) unavailable.set(entry.path, reason);
      leftOut.set(entry.path, reason);
      omissions.push({ path: entry.path, reason, replacement: "index" });
      continue;
    }
    readableFiles.push({
      path: entry.path,
      mode: gitEntry.mode,
      blob_oid: gitEntry.oid,
      content_hash: sha256(content),
      content,
    });
  }
  for (const path of atlas.missingMandatory)
    if (!unavailable.has(path)) unavailable.set(path, "missing or unreadable");
  if (unavailable.size > 0)
    throw mandatoryRefusal([...unavailable].map(([path, cause]) => `${path} (${cause})`));

  readableFiles.sort((a, b) => a.path.localeCompare(b.path));
  const delivered = new Map(readableFiles.map((file) => [file.path, file]));
  const kept = readableFiles.filter((file) => mandatory.has(file.path));
  const optional = readableFiles.filter((file) => !mandatory.has(file.path));
  const dropped: RawContextFile[] = [];
  const assemble = (): RawContextPacket => {
    const files = [...kept, ...optional].sort((a, b) => a.path.localeCompare(b.path));
    const droppedPaths = new Set(dropped.map((file) => file.path));
    const manifest: ScopeAtlasEntry[] = atlas.atlas.map((entry) => {
      // The atlas read the directory; a delivered path's figures are its blob's.
      const file = delivered.get(entry.path);
      const bytes = file ? Buffer.byteLength(file.content) : entry.bytes;
      if (droppedPaths.has(entry.path))
        return { path: entry.path, disposition: "omitted", bytes, reason: "token_budget" };
      const reason = leftOut.get(entry.path);
      if (reason) return { path: entry.path, disposition: "omitted", bytes, reason };
      return file ? { ...entry, bytes, hash: file.content_hash } : entry;
    });
    const packetOmissions = [
      ...omissions,
      ...dropped.map((file) => ({
        path: file.path,
        reason: TOKEN_BUDGET_REASON,
        replacement: "index" as const,
        hash: file.content_hash,
      })),
    ].sort((a, b) => a.path.localeCompare(b.path));
    const budgetOmitted = packetOmissions.filter((item) => item.reason === TOKEN_BUDGET_REASON);
    const body = {
      schema_version: 1 as const,
      budget: {
        estimator: "chars_div_4" as const,
        basis: limit === null ? ("assumed_ceiling" as const) : ("model_context_window" as const),
        model: capacity?.model ?? null,
        context_window: window,
        output_allowance_tokens: capacity?.outputAllowance ?? null,
        framing_tokens: capacity?.framingTokens ?? null,
        selection_limit_tokens:
          limit === null ? RAW_CONTEXT_ASSUMED_CEILING_TOKENS : Math.max(limit, 1),
        estimated_packet_tokens: 0,
        omitted_for_budget: budgetOmitted.length,
        mandatory_paths: [...mandatory].sort(),
      },
      base_commit_sha: baseCommitSha,
      base_tree_sha: treeSha,
      readable_files: files,
      editable_paths: files.map((file) => file.path),
      creatable_roots: ["."],
      file_manifest: manifest,
      omissions: packetOmissions,
      evidence_refs: files.map((file) => `git:${treeSha}:${file.path}:${file.blob_oid}`),
    };
    // The estimate covers the packet exactly as the adapter embeds it; the second
    // pass absorbs the length of the figure itself.
    const measure = () =>
      estimateTokens(JSON.stringify({ ...body, packet_hash: HASH_PLACEHOLDER }));
    body.budget.estimated_packet_tokens = measure();
    body.budget.estimated_packet_tokens = measure();
    return RawContextPacket.parse({ ...body, packet_hash: hashJson(body) });
  };

  let packet = assemble();
  if (limit === null) return packet;
  while (packet.budget!.estimated_packet_tokens > limit && optional.length > 0) {
    let excess = (packet.budget!.estimated_packet_tokens - limit) * 4;
    while (excess > 0 && optional.length > 0) {
      const file = optional.pop()!;
      dropped.unshift(file);
      excess -= JSON.stringify(file).length;
    }
    packet = assemble();
  }
  if (packet.budget!.estimated_packet_tokens <= limit) return packet;
  const files = kept.map((file) => ({
    path: file.path,
    estimated_tokens: estimateTokens(JSON.stringify(file)),
  }));
  const sizes = files.map((file) => `${file.path} (~${file.estimated_tokens} tokens)`);
  throw new RawContextRefusalError(
    "raw_context_exceeds_window",
    `raw_context_exceeds_window: the raw request for "${capacity!.model}" cannot fit its ${window}-token context window: ` +
      `the packet needs ~${packet.budget!.estimated_packet_tokens} tokens with every optional file omitted` +
      (sizes.length > 0
        ? ` (mandatory: ${sizes.join(", ")})`
        : " (no mandatory files; file manifest and metadata)") +
      `, the request framing ~${capacity!.framingTokens} and the output allowance ${capacity!.outputAllowance} (estimates, chars/4). ` +
      "Choose a model with a larger window, or reduce context.mandatory_files.",
    {
      model: capacity!.model,
      context_window: window!,
      packet_tokens: packet.budget!.estimated_packet_tokens,
      framing_tokens: capacity!.framingTokens,
      output_allowance_tokens: capacity!.outputAllowance,
      // Largest first, the order a reader trims in; ties keep path order.
      mandatory_files: [...files].sort((a, b) => b.estimated_tokens - a.estimated_tokens),
    },
  );
}
