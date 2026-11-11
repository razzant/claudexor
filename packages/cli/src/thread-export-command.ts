/**
 * `claudexor thread export|retire|retirement`: the in-repo consumer of the exact
 * export and conditional retirement contract. It hashes every byte it receives,
 * and writes its receipt last, so a bundle without one was never complete. A
 * retirement is kept in its bundle before it is sent, so an unknown answer is
 * repeated as that same operation, and only bytes the bundle still holds start one.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createWriteStream,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ControlProblem,
  THREAD_EXPORT_SCHEMA_VERSION,
  ThreadExportManifest,
  ThreadExportReceipt,
  ThreadRetireRequest,
  ThreadRetirement,
} from "@claudexor/schema";
import { flagBool, flagStr, requiredStringFlagError, type ParsedArgs } from "./args.js";
import { CliError, controlProblemError, renderCliFailure, usageError } from "./cli-error.js";
import { printJson } from "./cli-io.js";
import { subcommandFlagScopeError } from "./command-scope.js";
import { controlApiFetch } from "./live.js";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";
import { connectForObservation } from "./mcp-run-wait.js";
import {
  bundleDamage,
  bundleDigests,
  confinedPath,
  flushableOpen,
  linkEntry,
  placeVerified,
  synced,
  THREAD_EXPORT_MANIFEST_FILE,
  THREAD_EXPORT_RECEIPT_FILE,
  unsynced,
  type BundleDamage,
  type DigestEntry,
} from "./thread-export-bundle.js";

/** The retirement this bundle sent or is about to send, until its outcome settles. */
const THREAD_RETIRE_REQUEST_FILE = "retire-request.json";

type Address = NonNullable<Awaited<ReturnType<typeof connectForObservation>>>["addr"];

async function connect(verb: string): Promise<Address> {
  const connection = await connectForObservation();
  if (!connection) throw daemonUnavailableError(false, `thread ${verb} does not start a daemon`);
  return connection.addr;
}

async function problemOf(response: Response, fallback: string): Promise<CliError> {
  const body: unknown = await response.json().catch(() => null);
  const problem = ControlProblem.safeParse(body);
  return controlProblemError(
    response.status,
    problem.success
      ? problem.data
      : { code: "thread_export_unavailable", message: fallback, retryable: true },
    fallback,
  );
}

/** Receive one item into its place: complete and verified, or not there at all. Its
 * bytes wait under a short name of their own, so receiving adds nothing to their name. */
async function receiveItem(
  address: Address,
  manifest: ThreadExportManifest,
  item: ThreadExportManifest["items"][number],
  root: string,
): Promise<{ sha256: string; sizeBytes: number; placedAt?: string }> {
  confinedPath(root, item.path);
  const response = await controlApiFetch(
    address,
    `/threads/${encodeURIComponent(manifest.threadId)}/export/${encodeURIComponent(manifest.exportId)}/items/${item.itemId}`,
  );
  if (!response.ok || !response.body) throw await problemOf(response, "export item read failed");
  const partial = join(root, `.partial-${randomUUID()}`);
  try {
    const hash = createHash("sha256");
    let sizeBytes = 0;
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk);
          sizeBytes += chunk.length;
          done(null, chunk);
        },
      }),
      createWriteStream(partial, { flags: "wx", mode: 0o600 }),
    );
    const sha256 = `sha256:${hash.digest("hex")}`;
    const declared = response.headers.get("etag")?.replaceAll('"', "");
    if (
      sha256 !== declared ||
      (item.sha256 !== null && sha256 !== item.sha256) ||
      (item.sizeBytes !== null && sizeBytes !== item.sizeBytes)
    )
      throw new CliError("operational", `received bytes of ${item.path} do not verify`, {
        code: "thread_export_transfer_mismatch",
        retryable: true,
      });
    const place = await placeVerified(root, item, partial, { sha256, sizeBytes });
    return { sha256, sizeBytes, ...(place === item.path ? {} : { placedAt: place }) };
  } finally {
    rmSync(partial, { force: true });
  }
}

export async function exportThreadBundle(
  address: Address,
  threadId: string,
  out: string,
  expectedStoreId?: string,
): Promise<{ manifest: ThreadExportManifest; receipt: ThreadExportReceipt }> {
  const query = expectedStoreId ? `?expectedStoreId=${encodeURIComponent(expectedStoreId)}` : "";
  const response = await controlApiFetch(
    address,
    `/threads/${encodeURIComponent(threadId)}/export${query}`,
  );
  if (!response.ok) throw await problemOf(response, "thread export read failed");
  const manifest = ThreadExportManifest.parse(await response.json());
  if (manifest.threadId !== threadId)
    throw new CliError("operational", "daemon returned another thread's export", {
      code: "invalid_service_response",
    });
  const root = resolve(out);
  mkdirSync(root, { recursive: true });
  if (readdirSync(root).length > 0)
    throw usageError(`--out must name a new or empty directory: ${out}`);
  writeFileSync(join(root, THREAD_EXPORT_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  const transferred: ThreadExportReceipt["transferred"] = [];
  const digests: DigestEntry[] = [];
  for (const item of manifest.items) {
    if (item.kind === "symlink") {
      digests.push(linkEntry(item));
      continue;
    }
    if (item.kind !== "file") continue;
    const received = await receiveItem(address, manifest, item, root);
    transferred.push({ itemId: item.itemId, path: item.path, ...received });
    digests.push({
      itemId: item.itemId,
      sha256: received.sha256,
      sizeBytes: received.sizeBytes,
      plane: item.plane,
    });
  }
  const receipt = ThreadExportReceipt.parse({
    schemaVersion: THREAD_EXPORT_SCHEMA_VERSION,
    storeId: manifest.storeId,
    threadId,
    exportId: manifest.exportId,
    closureDigest: manifest.closureDigest,
    ...bundleDigests(digests),
    coverage: manifest.coverage,
    retirable: manifest.retirable,
    transferred,
  });
  writeFileSync(join(root, THREAD_EXPORT_RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`);
  return { manifest, receipt };
}

function readReceipt(dir: string): ThreadExportReceipt {
  let text: string;
  try {
    text = readFileSync(join(dir, THREAD_EXPORT_RECEIPT_FILE), "utf8");
  } catch {
    throw usageError(`no export receipt in ${dir}: its transfer did not finish`);
  }
  return ThreadExportReceipt.parse(JSON.parse(text));
}

async function retirementResponse(response: Response, threadId: string): Promise<ThreadRetirement> {
  if (!response.ok) throw await problemOf(response, "thread retirement failed");
  const parsed = ThreadRetirement.parse(await response.json());
  if (parsed.threadId !== threadId)
    throw new CliError("operational", "daemon returned another thread's retirement", {
      code: "invalid_service_response",
    });
  return parsed;
}

const EXPORT_USAGE =
  "usage: claudexor thread export <id> --out <dir> [--expected-store-id ID] [--json] | " +
  "claudexor thread retirement <id> [--operation-id ID] [--expected-store-id ID] [--json]";

export async function threadExportCommand(args: ParsedArgs, json: boolean): Promise<number> {
  try {
    const verb = args._[1];
    const threadId = args._[2];
    const error =
      subcommandFlagScopeError("thread", verb ?? "", Object.keys(args.flags)) ??
      requiredStringFlagError(
        args,
        ["out", "operation-id", "expected-store-id"].filter((flag) => flag in args.flags),
      );
    if (error || !threadId || args._.length !== 3) throw usageError(error ?? EXPORT_USAGE);
    if (verb === "export") {
      const out = flagStr(args, "out");
      if (!out) throw usageError(EXPORT_USAGE);
      const { manifest, receipt } = await exportThreadBundle(
        await connect(verb),
        threadId,
        out,
        flagStr(args, "expected-store-id"),
      );
      printJson({
        threadId,
        out: resolve(out),
        exportId: receipt.exportId,
        coverage: manifest.coverage,
        retirable: manifest.retirable,
        gaps: manifest.gaps,
        disclosures: manifest.disclosures,
        transferredItems: receipt.transferred.length,
        relocatedItems: receipt.transferred.filter((entry) => entry.placedAt).length,
      });
      // A partial bundle stays on disk and is readable; the exit says it is partial.
      return manifest.coverage === "complete" ? 0 : 1;
    }
    const query = new URLSearchParams();
    for (const [flag, name] of [
      ["operation-id", "operationId"],
      ["expected-store-id", "expectedStoreId"],
    ] as const) {
      const value = flagStr(args, flag);
      if (value) query.set(name, value);
    }
    printJson(
      await retirementResponse(
        await controlApiFetch(
          await connect("retirement"),
          `/threads/${encodeURIComponent(threadId)}/retirement?${query}`,
        ),
        threadId,
      ),
    );
    return 0;
  } catch (error) {
    return renderCliFailure(json, error, { messagePrefix: "claudexor thread:" });
  }
}

const RETIRE_USAGE =
  "usage: claudexor thread-retire <id> --export <dir> [--operation-id ID] [--json] | " +
  "claudexor thread-retire <id> --abandon --operation-id ID [--json]";

const keptPath = (dir: string) => join(dir, THREAD_RETIRE_REQUEST_FILE);
/** What binds a retirement to its export: the receipt's identities and digests. */
const BOUND = ["exportId", "closureDigest", "contentDigest", "laneDigest"] as const;

/** A kept request, and why it is not known to be durable (null once it is). */
interface Kept {
  request: ThreadRetireRequest;
  unsynced: BundleDamage | null;
}

/** `flush` failing, as the damage a failed sync is; null when it did not fail. */
function failedSync(path: string, flush: () => void): BundleDamage | null {
  try {
    flush();
    return null;
  } catch (error) {
    return unsynced(path, error);
  }
}

/** The request this bundle kept, read whole, or null when none is; one that does
 * not read whole is refused, never replaced. With `durable` it is synced here too,
 * as its writer may not have synced it yet: whatever is sent is on disk first. Its
 * identity is read before that sync, and a sync that fails is returned with it, not
 * thrown, so the caller still holds the operation it must ask the engine about. */
function keptRequest(dir: string, receipt: ThreadExportReceipt, durable = false): Kept | null {
  let fd: number;
  try {
    fd = openSync(keptPath(dir), durable ? flushableOpen() : "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let request: ThreadRetireRequest;
  let damage: BundleDamage | null = null;
  try {
    try {
      request = ThreadRetireRequest.parse(JSON.parse(readFileSync(fd, "utf8")));
    } catch {
      throw new CliError(
        "operational",
        `${keptPath(dir)} holds no whole retirement request, so nothing was sent and nothing replaced it: another invocation may still be writing it, so repeat; if it stays so, its writer stopped before sending or the file was damaged, so read any operation it names with 'claudexor thread retirement' before removing it`,
        { code: "thread_retirement_request_incomplete", retryable: true },
      );
    }
    if (BOUND.some((key) => request[key] !== receipt[key]))
      throw new CliError(
        "operational",
        `${keptPath(dir)} is not a retirement of this bundle's export; read its operation with 'claudexor thread retirement' before removing it`,
        { code: "thread_retirement_request_unreadable", retryable: false },
      );
    if (durable) damage = failedSync(keptPath(dir), () => fsyncSync(fd));
  } finally {
    closeSync(fd);
  }
  if (durable) damage ??= failedSync(dir, () => synced(dir));
  return { request, unsynced: damage };
}

/**
 * Keep this request as the bundle's one retirement request, or send the one kept
 * first. An exclusive create never replaces another; the whole request is written
 * at once and synced before anything is sent. An invocation whose create finds one
 * already kept sends that one, once it reads whole and is synced here too, or, when
 * that sync fails, only if the engine already bound it.
 */
function keepRequest(
  dir: string,
  receipt: ThreadExportReceipt,
  request: ThreadRetireRequest,
): Kept {
  try {
    synced(keptPath(dir), `${JSON.stringify(request, null, 2)}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = keptRequest(dir, receipt, true);
    if (winner) return winner;
    throw new CliError(
      "operational",
      `another retirement of ${dir} settled before this one could be kept; nothing was sent, so repeat the command`,
      { code: "thread_retirement_request_unkept", retryable: true },
    );
  }
  synced(dir);
  return { request, unsynced: null };
}

/** Only an answer that names the operation's one outcome is settled. */
const settled = (error: unknown) =>
  error instanceof CliError &&
  (error.context as { settled?: unknown } | undefined)?.settled === true;

function outcomeUnknown(operationId: string, cause: string): CliError {
  return new CliError(
    "operational",
    `retirement operation ${operationId} has no known outcome (${cause}); repeat this command to repeat that operation, or settle it with --abandon --operation-id ${operationId}`,
    { code: "thread_retirement_outcome_unknown", retryable: true, details: { operationId, cause } },
  );
}

/** One request of an operation. Every answer that is not its outcome is unknown. */
async function sendRetirement(
  address: Address,
  threadId: string,
  path: "retire" | "retire/abandon",
  body: unknown,
  operationId: string,
): Promise<ThreadRetirement> {
  let response: Response;
  let answer: unknown;
  try {
    response = await controlApiFetch(address, `/threads/${encodeURIComponent(threadId)}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw outcomeUnknown(operationId, `the request failed: ${String(cause)}`);
  }
  try {
    answer = await response.json();
  } catch (cause) {
    throw outcomeUnknown(
      operationId,
      `the HTTP ${response.status} answer was not read: ${String(cause)}`,
    );
  }
  if (response.ok) {
    const parsed = ThreadRetirement.safeParse(answer);
    const read = parsed.success && parsed.data.threadId === threadId ? parsed.data : null;
    // Only this operation's own binding settles it: an answer naming no operation,
    // or another one, never does, and a retirement settles by its acceptance.
    const bound = read?.operation?.operationId === operationId ? read.operation : null;
    if (read && bound && (path === "retire/abandon" || bound.outcome === "accepted")) return read;
    throw outcomeUnknown(
      operationId,
      `the HTTP ${response.status} answer binds no outcome to this operation`,
    );
  }
  const problem = ControlProblem.safeParse(answer);
  if (problem.success && problem.data.context?.["settled"] === true)
    throw controlProblemError(response.status, problem.data, "thread retirement refused");
  throw outcomeUnknown(
    operationId,
    `HTTP ${response.status}${problem.success ? ` ${problem.data.code}: ${problem.data.message}` : ""}`,
  );
}

/** The operation's bound outcome as the engine reads it; null binds nothing. */
async function boundOutcome(address: Address, threadId: string, operationId: string) {
  let read: ThreadRetirement;
  try {
    read = await retirementResponse(
      await controlApiFetch(
        address,
        `/threads/${encodeURIComponent(threadId)}/retirement?${new URLSearchParams({ operationId })}`,
      ),
      threadId,
    );
  } catch (cause) {
    throw outcomeUnknown(operationId, `its outcome could not be read: ${String(cause)}`);
  }
  // Only this operation's own binding counts; another operation's never does.
  return read.operation?.operationId === operationId ? read.operation : null;
}

/**
 * Retire against an exported bundle. A new decision starts only from a bundle
 * that still holds every byte it received and has made them durable, and its
 * request is kept there before it is sent, so an unknown answer is repeated as that
 * same operation. From a bundle that changed or cannot be synced since, or whose
 * kept request cannot be, only an operation the engine already bound may be
 * repeated, since its repeat evaluates nothing. A 200 or a settled refusal is the
 * operation's outcome and releases what was kept; nothing else does.
 */
export async function retireThreadBundle(
  connectTo: () => Promise<Address>,
  threadId: string,
  dir: string,
  explicitId?: string,
): Promise<ThreadRetirement> {
  const receipt = readReceipt(dir);
  if (receipt.threadId !== threadId)
    throw usageError(`the export in ${dir} belongs to thread ${receipt.threadId}`);
  const found = keptRequest(dir, receipt, true);
  const kept = found?.request ?? null;
  /** One kept operation per export until it settles: another named one refuses. */
  const pending = (held: ThreadRetireRequest): ThreadRetireRequest => {
    if (explicitId && explicitId !== held.operationId)
      throw usageError(
        `${dir} holds retirement operation ${held.operationId} with no settled outcome; repeat it without --operation-id, or settle it with --abandon --operation-id ${held.operationId}`,
        { code: "thread_retirement_operation_pending", details: { operationId: held.operationId } },
      );
    return held;
  };
  let request =
    (kept && pending(kept)) ??
    ThreadRetireRequest.parse({
      operationId: explicitId ?? `retire-${randomUUID()}`,
      ...Object.fromEntries(BOUND.map((key) => [key, receipt[key]])),
    });
  let address: Address | null = null;
  const reach = async () => (address ??= await connectTo());
  /** What cannot be made durable ends a new decision here; a named operation the engine
   * already bound is still repeated, and nothing else is sent. */
  const hold = async (damage: BundleDamage, named: boolean) => {
    const { operationId } = request;
    if (!named || !(await boundOutcome(await reach(), threadId, operationId)))
      throw new CliError(
        "operational",
        `${dir} ${damage.reason}. Nothing was sent${named ? `; operation ${operationId} is not bound, so ${damage.remedy}, or settle it with --abandon --operation-id ${operationId}` : `; ${damage.remedy}`}`,
        {
          code: damage.code,
          retryable: false,
          ...(named ? { details: { operationId } } : {}),
        },
      );
  };
  const damage = found?.unsynced ?? (await bundleDamage(dir, receipt));
  if (damage) await hold(damage, kept !== null || explicitId !== undefined);
  else if (!found) {
    const keeping = keepRequest(dir, receipt, request);
    request = pending(keeping.request);
    if (keeping.unsynced) await hold(keeping.unsynced, true);
  }
  const { operationId } = request;
  const release = () => {
    try {
      if (keptRequest(dir, receipt)?.request.operationId === operationId)
        rmSync(keptPath(dir), { force: true });
    } catch {
      // Whatever else is kept there is not this operation's to release.
    }
  };
  try {
    const outcome = await sendRetirement(await reach(), threadId, "retire", request, operationId);
    release();
    return outcome;
  } catch (error) {
    if (settled(error)) release();
    throw error;
  }
}

export async function threadRetireCommand(args: ParsedArgs, json: boolean): Promise<number> {
  try {
    const threadId = args._[1];
    const error = requiredStringFlagError(
      args,
      ["export", "operation-id"].filter((flag) => flag in args.flags),
    );
    if (error || !threadId || args._.length !== 2) throw usageError(error ?? RETIRE_USAGE);
    const operationId = flagStr(args, "operation-id");
    if (flagBool(args, "abandon")) {
      if (!operationId || flagStr(args, "export")) throw usageError(RETIRE_USAGE);
      printJson(
        await sendRetirement(
          await connect("retire"),
          threadId,
          "retire/abandon",
          { operationId },
          operationId,
        ),
      );
      return 0;
    }
    const dir = flagStr(args, "export");
    if (!dir) throw usageError(RETIRE_USAGE);
    printJson(await retireThreadBundle(() => connect("retire"), threadId, dir, operationId));
    return 0;
  } catch (error) {
    return renderCliFailure(json, error, { messagePrefix: "claudexor thread-retire:" });
  }
}
