import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { open } from "node:fs/promises";
import { parse as yamlParse } from "yaml";
import { RunResumable, SessionCapsule } from "@claudexor/schema";
import type { WalkedEntry } from "./thread-export-walk.js";

export interface SessionObservation {
  harness: string | null;
  nativeSessionId: string;
  source:
    | "attempt_event"
    | "run_event"
    | "reviewer_stream"
    | "session_capsule"
    | "run_resumable"
    | "thread_session";
  runId: string | null;
  attemptId: string | null;
  profileId: string | null;
  cwd: string | null;
  /** Where to look for the harness when the record itself does not name it. */
  context: string | null;
}

const MARKER = Buffer.from('"native_session_id"');
/** The longest line a reader holds and decodes; a longer one is counted, never read. */
export const MAX_LINE_BYTES = 8 << 20;

/**
 * Every complete line of a file, holding at most one bounded line. With a
 * marker, only lines containing it are delivered; with none, every non-empty
 * line is. A line over the bound is never held or decoded: it is counted when it
 * holds the marker (with none, always), so no caller mistakes it for absent.
 * Stop ends the read before its next chunk, with the signal's reason.
 */
async function readLines(
  path: string,
  marker: Buffer | null,
  onLine: (line: Buffer) => void,
  signal?: AbortSignal,
): Promise<{ oversized: number }> {
  signal?.throwIfAborted();
  const handle = await open(path, "r");
  const overlap = marker ? marker.length - 1 : 0;
  let oversized = 0;
  let carry: Buffer[] = [];
  let held = 0;
  // The current line passed the bound; whether it held the marker so far, and
  // the tail of what was seen, so a marker split across reads is still found.
  let over = false;
  let marked = false;
  let edge = Buffer.alloc(0);
  const scan = (part: Buffer): void => {
    if (marked) return;
    const probe = edge.length ? Buffer.concat([edge, part]) : part;
    marked = marker === null || probe.includes(marker);
    edge = Buffer.from(probe.subarray(Math.max(0, probe.length - overlap)));
  };
  const append = (part: Buffer): void => {
    if (part.length === 0) return;
    if (!over && held + part.length <= MAX_LINE_BYTES) {
      carry.push(part);
      held += part.length;
      return;
    }
    if (!over) {
      over = true;
      for (const piece of carry) scan(piece);
      carry = [];
      held = 0;
    }
    scan(part);
  };
  const end = (): void => {
    if (over) {
      if (marked) oversized += 1;
    } else if (held > 0) {
      const line = carry.length === 1 ? carry[0]! : Buffer.concat(carry, held);
      if (marker === null || line.includes(marker)) onLine(line);
    }
    carry = [];
    held = 0;
    over = false;
    marked = false;
    edge = Buffer.alloc(0);
  };
  try {
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      highWaterMark: 1 << 18,
    })) {
      signal?.throwIfAborted();
      const bytes = chunk as Buffer;
      let start = 0;
      for (let at = bytes.indexOf(0x0a); at >= 0; at = bytes.indexOf(0x0a, start)) {
        append(bytes.subarray(start, at));
        end();
        start = at + 1;
      }
      // Only a remainder outlives this chunk; a complete line is consumed above.
      if (start < bytes.length) append(Buffer.from(bytes.subarray(start)));
    }
    end();
  } finally {
    await handle.close();
  }
  return { oversized };
}

/** Every whole-string value of a parsed record: quoted paths inside prose stay prose. */
function eachString(value: unknown, visit: (text: string) => void): void {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const item of value) eachString(item, visit);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) eachString(item, visit);
}

/**
 * The store-relative `/` paths a whole value names inside these store spellings,
 * by the host platform's path rules. On Windows either separator and any letter
 * case name the same store; elsewhere only `<root>/` does, since a backslash is
 * part of a name there. Lexical: nothing is resolved or opened.
 */
function storeReferencesOf(
  roots: readonly string[],
  platform: NodeJS.Platform,
): (value: string) => string[] {
  const windows = platform === "win32";
  const fold = (text: string) => (windows ? text.replaceAll("\\", "/").toLowerCase() : text);
  const prefixes = roots.map((root) => `${windows ? fold(root).replace(/\/+$/, "") : root}/`);
  return (value) =>
    prefixes
      .filter((prefix) => fold(value.slice(0, prefix.length)) === prefix)
      .map((prefix) => {
        const rest = value.slice(prefix.length);
        return windows ? rest.replaceAll("\\", "/") : rest;
      });
}

/**
 * What one session's own transcript says of itself: every vendor version it
 * records, and every value naming a path inside this store. Nothing it names is
 * opened, so a reference only says the export must already carry that entry.
 * Every row is read: one that is not a UTF-8 JSON record, or is over the line
 * bound, is counted, because what it names cannot be checked.
 */
export async function transcriptFacts(
  path: string,
  versionField: string | null,
  storeSpellings: readonly string[],
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal,
): Promise<{
  versions: Set<string>;
  storeReferences: Set<string>;
  unreadableRows: number;
  oversizedRows: number;
}> {
  const versions = new Set<string>();
  const storeReferences = new Set<string>();
  const referenced = storeReferencesOf(storeSpellings, platform);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let unreadableRows = 0;
  const { oversized } = await readLines(
    path,
    null,
    (line) => {
      let record: Record<string, unknown> | null = null;
      try {
        const decoded = decoder.decode(line);
        if (decoded.trim() === "") return;
        record = object(JSON.parse(decoded));
      } catch {
        record = null;
      }
      if (!record) {
        unreadableRows += 1;
        return;
      }
      const version = versionField ? text(record[versionField]) : null;
      if (version) versions.add(version);
      eachString(record, (value) => {
        for (const reference of referenced(value)) storeReferences.add(reference);
      });
    },
    signal,
  );
  return { versions, storeReferences, unreadableRows, oversizedRows: oversized };
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** A recorded harness start in either envelope the run tree has ever held: the
 * attempt or reviewer journal's bare event, or the run log's `harness.event`.
 * Other rows may name the key (a probe's status, a quoted tool result); they are
 * not starts. Older starts carry no profile: that stays unknown, never guessed. */
export function recordedStart(row: unknown): {
  nativeSessionId: string;
  harness: string | null;
  attemptId: string | null;
  profileId: string | null;
} | null {
  const value = object(row);
  if (!value) return null;
  const direct = value["type"] === "started" ? value : null;
  const wrapped =
    value["type"] === "harness.event" && object(value["payload"])?.["type"] === "started"
      ? object(value["payload"])
      : null;
  const event = direct ?? wrapped;
  const nativeSessionId = text(object(event?.["payload"])?.["native_session_id"]);
  if (!event || !nativeSessionId) return null;
  return {
    nativeSessionId,
    harness: text(event["harness_id"]),
    attemptId: text(event["attempt_id"]),
    profileId: text(event["credential_profile_id"]),
  };
}

function sourceOfJournal(rel: string): "attempt_event" | "run_event" | "reviewer_stream" {
  if (rel === "events.jsonl") return "run_event";
  return rel.startsWith("reviews/") ? "reviewer_stream" : "attempt_event";
}

/**
 * Every native session one run tree recorded, across all tries: event journals
 * (of which any `.jsonl` may be one), attempt capsules and the resumable record.
 * A capsule only knows the latest try, which is why the journals are read too.
 * Reports what it cannot read; the caller turns that into a named gap.
 */
export async function runSessionObservations(
  runId: string | null,
  entries: readonly WalkedEntry[],
  signal?: AbortSignal,
): Promise<{ observations: SessionObservation[]; problems: string[] }> {
  const observations: SessionObservation[] = [];
  const problems: string[] = [];
  const runHarnessByAttempt = new Map<string, string>();
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (entry.kind !== "file") continue;
    const { rel, file } = entry;
    const attemptDir = /^attempts\/([^/]+)\//.exec(rel)?.[1] ?? null;
    try {
      if (rel.endsWith(".jsonl")) {
        const source = sourceOfJournal(rel);
        const context = source === "reviewer_stream" ? dirname(file.absPath) : null;
        const { oversized } = await readLines(
          file.absPath,
          MARKER,
          (line) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(line.toString("utf8"));
            } catch {
              // Only an undecodable line that claims to be a start can hide a session.
              if (line.includes('"started"')) problems.push(`${rel}: unreadable start record`);
              return;
            }
            const start = recordedStart(parsed);
            if (!start) return;
            const attemptId = start.attemptId ?? attemptDir;
            if (start.harness && attemptId) runHarnessByAttempt.set(attemptId, start.harness);
            observations.push({
              harness: start.harness,
              nativeSessionId: start.nativeSessionId,
              source,
              runId,
              attemptId,
              profileId: start.profileId,
              cwd: null,
              context,
            });
          },
          signal,
        );
        // A start always names its native session, so a line without that key
        // holds none; a line over the bound that names one is reported, never dropped.
        if (oversized > 0)
          problems.push(
            `${rel}: ${oversized} line(s) over ${MAX_LINE_BYTES} bytes name a native session and were not read`,
          );
      } else if (basename(rel) === "session-capsule.json") {
        const capsule = SessionCapsule.parse(JSON.parse(await readFile(file.absPath, "utf8")));
        if (attemptDir) runHarnessByAttempt.set(attemptDir, capsule.harness);
        observations.push({
          harness: capsule.harness,
          nativeSessionId: capsule.nativeSessionId,
          source: "session_capsule",
          runId,
          attemptId: attemptDir,
          profileId: capsule.holderProfileId ?? null,
          cwd: capsule.cwd ?? null,
          context: null,
        });
      } else if (rel === "final/resumable.yaml") {
        const resumable = RunResumable.parse(yamlParse(await readFile(file.absPath, "utf8")));
        if (resumable.session)
          observations.push({
            harness: resumable.session.harness,
            nativeSessionId: resumable.session.nativeSessionId,
            source: "run_resumable",
            runId,
            attemptId: null,
            profileId: null,
            cwd: null,
            context: null,
          });
      }
    } catch (error) {
      // Stop is not a record the run tree failed to hold.
      signal?.throwIfAborted();
      problems.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const observation of observations) {
    observation.harness ??= observation.attemptId
      ? (runHarnessByAttempt.get(observation.attemptId) ?? null)
      : null;
    if (!observation.harness && observation.context) {
      const metadata = await readFile(`${observation.context}/metadata.json`, "utf8").catch(
        () => null,
      );
      if (metadata)
        try {
          observation.harness = text(object(JSON.parse(metadata))?.["harness_id"]);
        } catch {
          /* unattributed stays a named gap */
        }
    }
  }
  return { observations, problems };
}

/** A name owned by this exact session id: bounded so `s-1` never claims `s-10`. */
export function nameOwnedBy(name: string, nativeSessionId: string): boolean {
  for (
    let at = name.indexOf(nativeSessionId);
    at >= 0;
    at = name.indexOf(nativeSessionId, at + 1)
  ) {
    const before = name[at - 1];
    const after = name[at + nativeSessionId.length];
    if ((!before || !/[0-9A-Za-z]/.test(before)) && (!after || !/[0-9A-Za-z]/.test(after)))
      return true;
  }
  return false;
}
