/**
 * Held preparation maintenance (#694 r17): inspection after an unproven stop or
 * crash, and explicit release of one resource.
 *
 * The crash sweep's known roots supply thread directories (including hidden
 * and purged threads), envelopes, object stores, delegated execution envelopes
 * and the one-shot namespace. Selectors are addresses, not credentials: `locate`
 * resolves them again under current roots, by the discovery rule. Below a runtime
 * root, links, `.` and `..` are refused; the record must be a regular file.
 *
 * Inspection only reads. Release compares the digest and records consent only
 * when needed, under the owner's serialization: thread chain without queued or
 * running turns (read-only and before-run included), envelope turn or prune lock.
 * A saved ordinary basis needs no new consent. Stop, cost and dispatch facts stay.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createAsyncProcessIdentityReader,
  executeWin32ProcessTimesAsync,
  preparationQuiet,
  type ProcessIdentity,
} from "@claudexor/core";
import type {
  ControlHeldPreparations,
  ControlPreparationReleaseReceipt,
  ControlPreparationReleaseRequest,
  HeldPreparation,
} from "@claudexor/schema";
import {
  boundOperatorRelease,
  confirmEnvelopeRelease,
  confirmStagingRelease,
  confirmThreadRelease,
  envelopeGeneration,
  envelopePreparationRefusal,
  hasPreparationChild,
  holdFactsOf,
  objectStorePath,
  parseThreadPreparation,
  recordDigest,
  releaseDecision,
  stagingGeneration,
  stagingRead,
  stagingPreparationRefusal,
  threadCleanupContinuation,
  threadGeneration,
  type ConfirmationOutcome,
  type EnvelopeOwnerRecord,
  type OperatorReleaseBasis,
  type PreparationHeldFacts,
  type PreparationQuietRead,
  type StagingOwnerRecord,
  type ThreadPreparationRecord,
} from "@claudexor/workspace";
import { findActiveThreadRun } from "@claudexor/control-api";
import { oneShotRuntimeDir, ownedProjectRuntimeDir, projectRuntimeDir } from "@claudexor/util";

/** A safe path segment: never `.` or `..`. */
const SEGMENT = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;
const STAGING = /^tmp_claudexor-[0-9a-f-]{36}$/;

const CONFIRMATION =
  "Confirming states that you checked that the stopped preparation's processes and their children have ended. Only when proof or a saved cleanup basis does not already permit release is a new confirmation recorded at the resource, never as a proof. Release touches only the selected resource; the run's recorded stop (termination_unconfirmed stays), costs and dispatch facts stay unchanged. A process a read measures alive, an unreadable record, a queued or running turn of the thread and a live creator still refuse.";

type Selector =
  | { k: "thread"; root: string; id: string }
  | { k: "envelope"; root: string | null; task: string; attempt: string }
  | { k: "staging"; root: string; name: string };

export interface HeldPreparationDeps {
  /** Project and execution roots the command store knows (as the crash sweep reads them). */
  roots: () => { projects: () => readonly string[]; execution: () => readonly string[] };
  /** Durable product command records (state and thread id). */
  jobs: () => ReadonlyArray<{ state: string; params?: unknown }>;
  /** The release criterion with the scope index (`daemonPreparationQuiet`). */
  quiet?: PreparationQuietRead;
  /** The recorded writer's birth reader at this boundary; default: Windows' opt-in reader. */
  readWriter?: ((pid: number) => Promise<ProcessIdentity>) | null;
}

/** The thread's own mutation chain, held by the control API's server. */
export type ThreadSerializer = <T>(threadId: string, work: () => Promise<T>) => Promise<T>;

/** What the service answers; the control API adds the durable operation's id. */
export type PreparationReleaseAnswer = Omit<
  ControlPreparationReleaseReceipt,
  "operation_id" | "replayed"
>;

export function heldPreparationServices(deps: HeldPreparationDeps) {
  const quiet: PreparationQuietRead = deps.quiet ?? ((facts) => preparationQuiet(facts));
  const readWriter =
    deps.readWriter !== undefined
      ? deps.readWriter
      : process.platform === "win32"
        ? createAsyncProcessIdentityReader({ runWin32Reader: executeWin32ProcessTimesAsync }).read
        : null;
  const activeTurn = (threadId: string): boolean =>
    findActiveThreadRun(deps.jobs(), threadId) !== undefined;
  return {
    heldPreparations: async (): Promise<ControlHeldPreparations> => {
      const errors: string[] = [];
      const found = discover(deps.roots(), errors);
      const jobs = deps.jobs();
      const preparations: HeldPreparation[] = [];
      for (const item of found) {
        const held = await inspect(
          item,
          quiet,
          (id) => findActiveThreadRun(jobs, id) !== undefined,
        );
        if (held) preparations.push(held);
      }
      return { preparations, roots: found.roots, confirmation: CONFIRMATION, errors };
    },
    releasePreparation: async (
      request: ControlPreparationReleaseRequest,
      serializeThread: ThreadSerializer,
    ): Promise<PreparationReleaseAnswer> => {
      const selector = resolve(request.selector, deps.roots());
      const where = located(selector);
      const input = { digest: request.digest, readWriter, quiet };
      let outcome: ConfirmationOutcome;
      if (selector.k === "thread") {
        outcome = await serializeThread(selector.id, async () =>
          activeTurn(selector.id)
            ? { outcome: "refused", reasons: ["a turn of this thread is queued or running"] }
            : confirmThreadRelease(selector.root, where.path, input),
        );
      } else if (selector.k === "envelope") {
        outcome = await confirmEnvelopeRelease(where.path, input);
      } else {
        outcome = await confirmStagingRelease(objectStorePath(selector.root), selector.name, input);
      }
      return receipt(request.selector, selector.k, where.path, outcome);
    },
  };
}

interface Found {
  selector: Selector;
  path: string;
  record: string;
  root: string;
}

/**
 * Where a selector's resource and record are, by the one rule discovery and
 * resolution share: every directory from the runtime root down to the resource
 * exists as a plain directory (`ownedProjectRuntimeDir` refuses a link at any
 * component), and the record is a regular file. `absent`: no record there.
 */
function locate(
  selector: Selector,
):
  | { status: "ok"; path: string; record: string }
  | { status: "absent" }
  | { status: "refused"; reason: string } {
  // The paths keep the producers' own spelling (the records name it); the walk
  // below checks the canonical components without following any link.
  const path = pathOf(selector);
  const dir = selector.k === "thread" ? dirname(path) : path;
  try {
    if (selector.k === "thread")
      // The tree too: a link there would carry the release out of the namespace.
      ownedProjectRuntimeDir(selector.root, "threads", selector.id, "tree");
    else if (selector.k === "staging")
      ownedProjectRuntimeDir(selector.root, "git-store", "objects", selector.name);
    else if (selector.root !== null)
      ownedProjectRuntimeDir(selector.root, "workspaces", selector.task, selector.attempt);
    else
      for (const component of [
        oneShotRuntimeDir(),
        join(oneShotRuntimeDir(), "workspaces"),
        join(oneShotRuntimeDir(), "workspaces", selector.task),
      ])
        if (lstatSync(component, { throwIfNoEntry: false })?.isSymbolicLink())
          return { status: "refused", reason: `${component} is a link; it is not followed` };
  } catch (error) {
    return { status: "refused", reason: error instanceof Error ? error.message : String(error) };
  }
  const own = lstatSync(dir, { throwIfNoEntry: false });
  if (!own) return { status: "absent" };
  if (!own.isDirectory())
    return { status: "refused", reason: `${dir} is not a plain directory; it is not followed` };
  const record = join(dir, selector.k === "thread" ? "preparation.json" : "owner.json");
  const file = lstatSync(record, { throwIfNoEntry: false });
  if (!file) return { status: "absent" };
  if (!file.isFile()) return { status: "refused", reason: `${record} is not a regular file` };
  return { status: "ok", path, record };
}

/** The resource a resolved selector names: refused (409) when it is not a plain one. */
function located(selector: Selector): { path: string } {
  const where = locate(selector);
  if (where.status === "refused")
    throw Object.assign(new Error(`not a held preparation this daemon releases: ${where.reason}`), {
      status: 409,
      code: "preparation_not_plain",
    });
  // Absent: the release itself answers `not_held` (nothing held is recorded there).
  return { path: pathOf(selector) };
}

function pathOf(selector: Selector): string {
  if (selector.k === "thread")
    return join(projectRuntimeDir(selector.root), "threads", selector.id, "tree");
  if (selector.k === "staging")
    return join(objectStorePath(selector.root), "objects", selector.name);
  const runtime = selector.root === null ? oneShotRuntimeDir() : projectRuntimeDir(selector.root);
  return join(runtime, "workspaces", selector.task, selector.attempt);
}

/** Every record of a held preparation under the known roots (a directory scan);
 * a candidate `locate` refuses is disclosed in `errors`, never listed. */
function discover(
  roots: ReturnType<HeldPreparationDeps["roots"]>,
  errors: string[],
): Found[] & { roots: number } {
  const found: Found[] = [];
  const take = (
    selector: Selector,
    root: string,
    keep: (record: string) => boolean = () => true,
  ) => {
    const where = locate(selector);
    if (where.status === "refused") errors.push(where.reason);
    else if (where.status === "ok" && keep(where.record))
      found.push({ selector, path: where.path, record: where.record, root });
  };
  const projects = known(roots.projects, "project roots", errors);
  const trees = new Set<string>();
  for (const root of projects) {
    const threads = join(projectRuntimeDir(root), "threads");
    for (const id of plainEntries(threads, errors)) {
      if (!SEGMENT.test(id)) continue;
      take({ k: "thread", root, id }, root);
      trees.add(join(threads, id, "tree"));
    }
    const staging = join(objectStorePath(root), "objects");
    for (const name of plainEntries(staging, errors))
      if (STAGING.test(name)) take({ k: "staging", root, name }, root);
  }
  const namespaces = new Set<string | null>([
    ...projects,
    ...trees,
    ...known(roots.execution, "execution roots", errors),
    null,
  ]);
  for (const root of namespaces) {
    const workspaces = join(
      root === null ? oneShotRuntimeDir() : projectRuntimeDir(root),
      "workspaces",
    );
    for (const task of plainEntries(workspaces, errors)) {
      if (!SEGMENT.test(task)) continue;
      for (const attempt of plainEntries(join(workspaces, task), errors))
        if (SEGMENT.test(attempt))
          take({ k: "envelope", root, task, attempt }, root ?? oneShotRuntimeDir(), preparing);
    }
  }
  return Object.assign(found, { roots: namespaces.size });
}

function known(read: () => readonly string[], label: string, errors?: string[]): string[] {
  try {
    return [...new Set(read())].filter((root) => existsSync(root));
  } catch (error) {
    const message = `${label} could not be read: ${error instanceof Error ? error.message : String(error)}`;
    if (!errors) throw rootsUnreadable(message);
    errors.push(message);
    return [];
  }
}

function rootsUnreadable(message: string): Error {
  return Object.assign(new Error(message), { status: 503, code: "preparation_roots_unreadable" });
}

/** Entries of a plain directory; a link or an unreadable one is disclosed, not followed. */
function plainEntries(dir: string, errors: string[]): string[] {
  try {
    if (!lstatSync(dir).isDirectory()) {
      errors.push(`${dir}: not a plain directory, not searched`);
      return [];
    }
    return readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      errors.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function preparing(ownerPath: string): boolean {
  try {
    return (
      (JSON.parse(readFileSync(ownerPath, "utf8")) as EnvelopeOwnerRecord)?.preparation
        ?.preparing === true
    );
  } catch (error) {
    // An unreadable owner.json is shown: unreadable is not absent.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function inspect(
  item: Found,
  quiet: PreparationQuietRead,
  activeTurn: (threadId: string) => boolean,
): Promise<HeldPreparation | null> {
  const base = {
    selector: encode(item.selector),
    kind: item.selector.k,
    path: item.path,
    record: item.record,
    root: item.root,
    thread_id: item.selector.k === "thread" ? item.selector.id : null,
  };
  let bytes: string;
  try {
    bytes = readFileSync(item.record, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return unreadable(base, "", error);
  }
  let facts: Facts;
  try {
    facts = factsOf(item, bytes);
  } catch (error) {
    return unreadable(base, recordDigest(bytes), error);
  }
  const verdict = facts.staging
    ? await stagingRead(facts.staging, undefined, quiet)
    : await quiet(holdFactsOf(facts.marker, facts.held));
  const decision = releaseDecision(verdict, {
    operator: facts.operator,
    platformLimit: false,
    savedCleanup: facts.savedCleanup !== undefined,
  });
  const savedCleanup =
    decision.release && decision.basis === "saved_cleanup" ? facts.savedCleanup : undefined;
  const refusal =
    item.selector.k === "thread"
      ? activeTurn(item.selector.id)
        ? "a turn of this thread is queued or running"
        : hasPreparationChild(item.path)
          ? "this preparation's current child has not exited"
          : null
      : facts.envelope
        ? envelopePreparationRefusal(item.path, facts.envelope)
        : stagingPreparationRefusal(item.path, facts.staging!);
  return {
    ...base,
    digest: recordDigest(bytes),
    since: facts.held?.at ?? facts.opened ?? null,
    stop: facts.held ? { reason: facts.held.reason, groups: [...facts.held.groups] } : null,
    read: {
      status: verdict.status,
      reasons: verdict.status === "held" ? verdict.reasons : [],
      unproven: verdict.unproven ?? null,
    },
    release:
      refusal !== null
        ? "refused"
        : decision.release
          ? decision.basis === "machine_proven"
            ? "machine"
            : decision.basis === "saved_cleanup"
              ? "saved_cleanup"
              : "operator_confirmation"
          : decision.operatorMayConfirm
            ? "operator_confirmation"
            : "refused",
    refusal,
    operator_release: facts.basis ? { confirmed_at: facts.basis.confirmed_at } : null,
    cleanup_error: facts.cleanupError ?? null,
    on_release: savedCleanup ? `${savedCleanup} ${facts.onRelease}` : facts.onRelease,
  };
}

function unreadable(
  base: Omit<
    HeldPreparation,
    | "digest"
    | "since"
    | "stop"
    | "read"
    | "release"
    | "refusal"
    | "operator_release"
    | "cleanup_error"
    | "on_release"
  >,
  digest: string,
  error: unknown,
): HeldPreparation {
  const reason = `its record cannot be read: ${error instanceof Error ? error.message : String(error)}`;
  return {
    ...base,
    digest,
    since: null,
    stop: null,
    read: { status: "held", reasons: [reason], unproven: null },
    release: "refused",
    refusal: reason,
    operator_release: null,
    cleanup_error: null,
    on_release: "nothing: an unreadable record is never released or guessed",
  };
}

interface Facts {
  marker: string | null;
  held: PreparationHeldFacts | undefined;
  opened?: string;
  operator: boolean;
  basis?: OperatorReleaseBasis;
  cleanupError?: string;
  savedCleanup?: string;
  onRelease: string;
  staging?: StagingOwnerRecord;
  envelope?: EnvelopeOwnerRecord;
}

function factsOf(item: Found, bytes: string): Facts {
  const { selector } = item;
  if (selector.k === "thread") {
    // The releases' own reading, of the tree they are given: a record they refuse
    // (another tree's, as an earlier daemon spelled the config root otherwise) is
    // shown unreadable for that reason, never offered for a confirmation.
    const record = parseThreadPreparation(bytes, item.path);
    const continued = threadCleanupContinuation(record);
    return {
      marker: record.scope?.marker ?? null,
      held: record.held,
      opened: record.opened_at,
      operator: boundOperatorRelease(record.operator_release, threadGeneration(record)),
      ...(record.operator_release ? { basis: record.operator_release } : {}),
      ...(record.cleanup_error ? { cleanupError: record.cleanup_error } : {}),
      ...(continued ? { savedCleanup: continued.reason } : {}),
      onRelease: threadOnRelease(record),
    };
  }
  const parsed = JSON.parse(bytes) as unknown;
  if (selector.k === "envelope") {
    const owner = parsed as EnvelopeOwnerRecord;
    const facts = owner?.preparation;
    if (!facts) throw new Error("no preparation facts");
    return {
      marker: facts.scope_marker,
      envelope: owner,
      held: facts.held,
      ...(typeof owner.created_at === "string" ? { opened: owner.created_at } : {}),
      operator: boundOperatorRelease(facts.operator_release, envelopeGeneration(owner, facts.held)),
      ...(facts.operator_release ? { basis: facts.operator_release } : {}),
      onRelease:
        "removes this envelope base, owner.json last; a base under continuation custody is kept for its custody owner and only its hold is lifted",
    };
  }
  const record = parsed as StagingOwnerRecord;
  if (record?.schema !== 1 || !record.creator) throw new Error("not a staging owner record");
  return {
    marker: record.scope?.marker ?? null,
    held: undefined,
    operator: boundOperatorRelease(record.operator_release, stagingGeneration(record)),
    ...(record.operator_release ? { basis: record.operator_release } : {}),
    onRelease: "removes only this staging directory; the store and its objects stay",
    staging: record,
  };
}

function threadOnRelease(record: ThreadPreparationRecord): string {
  if (record.early)
    return "removes only this record (the preparation owned nothing of the thread yet); a tree, registration or branch that is there stays as it is";
  if (record.complete)
    return `removes only this record; the finished checkout at ${record.tree} is kept and handed over as made`;
  const own = [
    record.own_registration === true ? "its own worktree registration" : null,
    "the tree directory",
    record.own_branch
      ? `its own branch ${record.own_branch.name} only while still at ${record.own_branch.tip} (a branch that moved is kept)`
      : null,
  ].filter(Boolean);
  return `removes ${own.join(", ")}, then the record; nothing it did not make`;
}

function encode(selector: Selector): string {
  return `prep1.${Buffer.from(JSON.stringify(selector)).toString("base64url")}`;
}

/** A selector this daemon issued, within the roots it knows now; anything else refuses. */
function resolve(text: string, roots: ReturnType<HeldPreparationDeps["roots"]>): Selector {
  const invalid = () =>
    Object.assign(new Error("not a held preparation selector issued by this daemon"), {
      status: 400,
      code: "preparation_selector_invalid",
    });
  if (!text.startsWith("prep1.")) throw invalid();
  let selector: Selector;
  try {
    selector = JSON.parse(Buffer.from(text.slice(6), "base64url").toString("utf8")) as Selector;
  } catch {
    throw invalid();
  }
  const segmentsOk =
    selector?.k === "thread"
      ? SEGMENT.test(selector.id)
      : selector?.k === "envelope"
        ? SEGMENT.test(selector.task) && SEGMENT.test(selector.attempt)
        : selector?.k === "staging" && STAGING.test(selector.name);
  if (!segmentsOk) throw invalid();
  const projects = known(roots.projects, "project roots");
  const isThreadTree = (path: string): boolean => {
    const errors: string[] = [];
    const trees = projects.flatMap((root) => {
      const threads = join(projectRuntimeDir(root), "threads");
      return plainEntries(threads, errors)
        .filter((id) => SEGMENT.test(id))
        .map((id) => join(threads, id, "tree"));
    });
    if (errors.length) throw rootsUnreadable(errors.join("; "));
    return trees.includes(path);
  };
  const inRoots =
    selector.k === "envelope"
      ? selector.root === null ||
        projects.includes(selector.root) ||
        known(roots.execution, "execution roots").includes(selector.root) ||
        isThreadTree(selector.root)
      : projects.includes(selector.root);
  if (!inRoots)
    throw Object.assign(new Error("the selector's root is not one this daemon knows now"), {
      status: 404,
      code: "preparation_root_unknown",
    });
  return selector;
}

function receipt(
  selector: string,
  kind: Selector["k"],
  path: string,
  outcome: ConfirmationOutcome,
): PreparationReleaseAnswer {
  const note =
    "The run's recorded stop and its unconfirmed termination, its costs and its dispatch facts are unchanged; neither an operator confirmation nor a saved cleanup basis is a machine proof that what the preparation started ended.";
  const common = { selector, kind, path, note };
  const facts = {
    generation: "generation" in outcome ? (outcome.generation ?? null) : null,
    stop: "stop" in outcome ? (outcome.stop ?? null) : null,
    confirmed_at: "confirmed_at" in outcome ? (outcome.confirmed_at ?? null) : null,
  };
  if (outcome.outcome === "not_held")
    return {
      ...common,
      ...facts,
      outcome: "not_held",
      basis: null,
      continued: false,
      reasons: ["no held preparation is recorded there now"],
      cleanup_error: null,
      writer: null,
      remains:
        "nothing of a held preparation; this does not show whether an earlier request released it (a repeat with that request's Idempotency-Key answers its recorded outcome)",
    };
  if ("reasons" in outcome)
    return {
      ...common,
      ...facts,
      outcome: outcome.outcome,
      basis: null,
      continued: false,
      reasons: outcome.reasons,
      cleanup_error: null,
      writer: outcome.writer ?? null,
      remains:
        facts.confirmed_at !== null
          ? "everything: nothing was released; the confirmation recorded with the resource stays, and its next release continues it while nothing measured holds it"
          : "everything, unchanged: nothing was released",
    };
  return {
    ...common,
    ...facts,
    outcome: outcome.outcome,
    basis: outcome.basis,
    continued: outcome.continued,
    reasons: [],
    cleanup_error: outcome.cleanup_error ?? null,
    writer: outcome.writer ?? null,
    remains:
      outcome.outcome === "cleanup_failed"
        ? "the record and what could not be removed; any saved cleanup basis or confirmation stays recorded for a new request or the resource's next release to retry; the same Idempotency-Key only reads this receipt"
        : outcome.outcome === "completed"
          ? "the finished resource as made (a checkout handed over, or a base kept for its continuation custody)"
          : "nothing of this resource",
  };
}
