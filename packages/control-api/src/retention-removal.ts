import { constants, copyFileSync, existsSync, lstatSync, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { fsyncDirectoryAsync } from "@claudexor/util";
import { treeReclaimableBytes } from "./retention-bytes.js";

/** Private preparation/recovery records, never ordinary artifact candidates. */
export const RETIRING = ".retiring";
const TOMBSTONE = "tombstone.yaml";
const REVIEW_MARKER = ".retired-by-retention.json";
type Intent = {
  version: 2;
  name: string;
  tombstone: string | null;
  dev: string;
  ino: string;
  children: string[];
};
const safeName = (name: unknown): name is string =>
  typeof name === "string" && /^[^/\\\0]+$/.test(name) && name !== "." && name !== "..";

function validateIntent(value: unknown, kind: "runs" | "reviews"): Intent {
  const intent = value as Intent | null;
  if (
    !intent ||
    intent.version !== 2 ||
    typeof intent.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(intent.name) ||
    typeof intent.dev !== "string" ||
    !/^\d+$/.test(intent.dev) ||
    typeof intent.ino !== "string" ||
    !/^\d+$/.test(intent.ino) ||
    !Array.isArray(intent.children) ||
    !intent.children.every(safeName) ||
    new Set(intent.children).size !== intent.children.length
  )
    throw new Error("invalid retirement intent");
  if (kind === "reviews") {
    if (!intent.name.startsWith("diff-") || intent.tombstone !== null)
      throw new Error("invalid review retirement intent");
  } else {
    if (typeof intent.tombstone !== "string") throw new Error("missing retirement tombstone");
    const marker = yamlParse(intent.tombstone);
    if (
      marker?.run_id !== intent.name ||
      marker?.reason !== "retention" ||
      !Number.isFinite(Date.parse(marker?.deleted_at))
    )
      throw new Error("invalid retirement tombstone");
  }
  if (intent.children.includes(intent.tombstone === null ? REVIEW_MARKER : TOMBSTONE))
    throw new Error("retirement marker is not payload");
  return intent;
}

async function durableText(path: string, text: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Preparing yields. The caller rechecks all protections immediately before
 * commit(), which publishes the small expiration marker without yielding.
 * Readers see the existing tombstone while physical cleanup proceeds. */
export class Retirement {
  readonly tree: string;
  private committed: boolean;
  private readonly parentReal: string;
  private readonly holdingIdentity;
  private readonly claimIdentity;
  private readonly marker: string;
  private readonly markerText: string;
  constructor(
    readonly parent: string,
    readonly claim: string,
    readonly intent: Intent,
  ) {
    this.tree = join(parent, intent.name);
    this.marker = join(this.tree, intent.tombstone === null ? REVIEW_MARKER : TOMBSTONE);
    this.markerText =
      intent.tombstone ?? JSON.stringify({ reason: "retention", name: intent.name });
    this.committed = existsSync(this.marker);
    this.parentReal = realpathSync(parent);
    this.holdingIdentity = lstatSync(join(parent, RETIRING));
    this.claimIdentity = lstatSync(claim);
  }
  private assertHolding(): void {
    const current = lstatSync(join(this.parent, RETIRING));
    const claim = lstatSync(this.claim);
    if (
      !current.isDirectory() ||
      current.dev !== this.holdingIdentity.dev ||
      current.ino !== this.holdingIdentity.ino ||
      realpathSync(this.parent) !== this.parentReal ||
      !claim.isDirectory() ||
      claim.dev !== this.claimIdentity.dev ||
      claim.ino !== this.claimIdentity.ino
    )
      throw new Error("retirement directory changed");
  }
  private assertSource(): void {
    const source = lstatSync(this.tree, { bigint: true });
    if (
      !source.isDirectory() ||
      source.dev.toString() !== this.intent.dev ||
      source.ino.toString() !== this.intent.ino
    )
      throw new Error("retirement target has changed; kept payload");
  }
  commit(): void {
    this.assertHolding();
    this.assertSource();
    try {
      // A tiny, exclusive file publication; never rename a whole directory.
      // File contents and the entry are flushed asynchronously BEFORE cleanup.
      copyFileSync(join(this.claim, "marker"), this.marker, constants.COPYFILE_EXCL);
    } finally {
      // Even a partial failed publication must retain its recovery evidence.
      this.committed = existsSync(this.marker);
    }
  }
  async recover(): Promise<void> {
    this.assertHolding();
    this.assertSource();
    if (
      !(await lstat(this.marker)).isFile() ||
      (await readFile(this.marker, "utf8")) !== this.markerText
    )
      throw new Error("retirement marker has changed; kept payload");
    const permitted = new Set([
      ...this.intent.children,
      this.intent.tombstone === null ? REVIEW_MARKER : TOMBSTONE,
    ]);
    if ((await readdir(this.tree)).some((name) => !permitted.has(name)))
      throw new Error("retirement target has changed; kept payload");
  }
  async reclaimableBytes(planned: Map<string, number>): Promise<number> {
    let bytes = 0;
    for (const name of this.intent.children)
      bytes += await treeReclaimableBytes(join(this.tree, name), planned);
    return bytes;
  }
  async finish(): Promise<string[]> {
    await this.recover();
    const marker = await open(this.marker, "r+");
    try {
      await marker.sync();
    } finally {
      await marker.close();
    }
    await fsyncDirectoryAsync(this.tree);
    this.assertHolding();
    this.assertSource();
    for (const name of this.intent.children)
      await rm(join(this.tree, name), { recursive: true, force: true });
    // Persist physical cleanup before dropping its recovery record. A crash
    // during these unlinks leaves the marker and intent for the next pass.
    try {
      await fsyncDirectoryAsync(this.tree);
      if (this.intent.tombstone === null) {
        await unlink(this.marker);
        await rmdir(this.tree);
        await fsyncDirectoryAsync(this.parent);
      }
      await rm(this.claim, { recursive: true, force: true });
      return [];
    } catch (error) {
      return ["retirement bookkeeping: " + String(error)];
    }
  }
  async abandon(): Promise<void> {
    if (!this.committed) await rm(this.claim, { recursive: true, force: true });
  }
  isCommitted(): boolean {
    return this.committed;
  }
  async hasPayload(): Promise<boolean> {
    for (const name of this.intent.children) {
      try {
        await lstat(join(this.tree, name));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return false;
  }
}

export async function prepareRetirement(
  parent: string,
  name: string,
  tombstone: string | null,
): Promise<Retirement> {
  const source = await lstat(join(parent, name), { bigint: true });
  if (!source.isDirectory()) throw new Error("retirement requires a plain source directory");
  const intent = validateIntent(
    {
      version: 2,
      name,
      tombstone,
      dev: source.dev.toString(),
      ino: source.ino.toString(),
      children: await readdir(join(parent, name)),
    },
    tombstone === null ? "reviews" : "runs",
  );
  const holding = join(parent, RETIRING);
  await mkdir(holding, { recursive: true, mode: 0o700 });
  if (!(await lstat(holding)).isDirectory())
    throw new Error("retirement requires a plain directory");
  const claim = await mkdtemp(join(holding, "claim-"));
  try {
    await durableText(join(claim, "intent.json"), JSON.stringify(intent));
    await writeFile(
      join(claim, "marker"),
      tombstone ?? JSON.stringify({ reason: "retention", name }),
      { mode: 0o600, flag: "wx" },
    );
    await fsyncDirectoryAsync(claim);
    await fsyncDirectoryAsync(holding);
    await fsyncDirectoryAsync(parent);
    return new Retirement(parent, claim, intent);
  } catch (error) {
    await rm(claim, { recursive: true, force: true });
    throw error;
  }
}

/** Only a published expiration marker authorizes recovery. Prepared records
 * without it are discarded without touching the original payload. */
export async function* pendingRetirements(
  parent: string,
  kind: "runs" | "reviews",
  dryRun: boolean,
  errors: string[],
  signal?: AbortSignal,
): AsyncGenerator<Retirement> {
  const holding = join(parent, RETIRING);
  let entries;
  try {
    if (!(await lstat(holding)).isDirectory())
      throw new Error("retirement requires a plain directory");
    entries = await readdir(holding, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      errors.push(holding + ": " + String(error));
    return;
  }
  for (const entry of entries) {
    if (signal?.aborted) return;
    const claim = join(holding, entry.name);
    try {
      if (!entry.isDirectory() || !entry.name.startsWith("claim-"))
        throw new Error("unrecognized retirement claim");
      const intentPath = join(claim, "intent.json");
      if (!(await lstat(intentPath)).isFile())
        throw new Error("retirement intent is not a plain file");
      const intent = validateIntent(JSON.parse(await readFile(intentPath, "utf8")), kind);
      const retirement = new Retirement(parent, claim, intent);
      if (!retirement.isCommitted()) {
        if (!dryRun) await retirement.abandon();
      } else {
        await retirement.recover();
        if (await retirement.hasPayload()) yield retirement;
        else if (!dryRun) errors.push(...(await retirement.finish()));
      }
    } catch (error) {
      errors.push(claim + ": " + String(error));
    }
  }
}
