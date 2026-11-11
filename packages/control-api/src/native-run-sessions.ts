import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as yamlParse } from "yaml";
import { RunResumable, SessionCapsule } from "@claudexor/schema";
import { readContinuationSources, runFilesExpired } from "@claudexor/workspace";

function optionalStat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function directory(path: string): boolean {
  const stat = optionalStat(path);
  if (!stat) return false;
  if (!stat.isDirectory()) throw new Error(`native references require a plain directory: ${path}`);
  return true;
}
function readOptional(path: string): string | null {
  const stat = optionalStat(path);
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`native reference is not a plain file: ${path}`);
  return readFileSync(path, "utf8");
}
function typedFile<T>(path: string, parse: (text: string) => T): T | null {
  try {
    const text = readOptional(path);
    return text === null ? null : parse(text);
  } catch (error) {
    throw new Error(`native references ${path}: ${String(error)}`, { cause: error });
  }
}

/** Explicit calls reread a producer's own files. Previously read terminal
 * ancestry is immutable; new edges are followed once, with cycle protection. */
export function collectNativeRunSessions(
  run: string,
  sessions: Map<string, Set<string>>,
  seen: Set<string>,
  ignored: ReadonlySet<string> = new Set(),
  signal?: AbortSignal,
): void {
  signal?.throwIfAborted();
  if (ignored.has(basename(run)) || !directory(run) || runFilesExpired(run)) return;
  seen.add(run);
  const add = (harness: string, id: string) => {
    const ids = sessions.get(harness) ?? new Set<string>();
    ids.add(id);
    sessions.set(harness, ids);
  };
  const final = join(run, "final");
  if (directory(final)) {
    const resumable = typedFile(join(final, "resumable.yaml"), (text) =>
      RunResumable.parse(yamlParse(text)),
    );
    if (resumable?.session) add(resumable.session.harness, resumable.session.nativeSessionId);
  }
  const attempts = join(run, "attempts");
  if (directory(attempts)) {
    for (const entry of readdirSync(attempts, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const attempt = join(attempts, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`native references cannot follow ${attempt}`);
      if (!entry.isDirectory()) continue;
      const capsule = typedFile(join(attempt, "session-capsule.json"), (text) =>
        SessionCapsule.parse(JSON.parse(text)),
      );
      if (capsule) add(capsule.harness, capsule.nativeSessionId);
    }
  }
  if (directory(join(run, "context"))) {
    // Validate the path kind before the canonical strict continuation read.
    const sourceFile = join(run, "context", "continuation.json");
    const stat = optionalStat(sourceFile);
    if (stat && !stat.isFile())
      throw new Error(`native reference is not a plain file: ${sourceFile}`);
    for (const source of readContinuationSources(run, { strict: true }))
      if (!seen.has(source.runDir))
        collectNativeRunSessions(source.runDir, sessions, seen, ignored, signal);
  }
}
