import { join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import {
  ensureDir,
  listDir,
  projectRuntimeDir,
  readTextSafe,
  writeJson,
  writeText,
} from "@claudexor/util";

export interface RunPaths {
  runId: string;
  root: string;
  contextDir: string;
  attemptsDir: string;
  reviewsDir: string;
  findingsDir: string;
  arbitrationDir: string;
  finalDir: string;
  eventsPath: string;
}

/**
 * Files-first artifact store. Runtime artifacts live in the per-user external
 * project namespace; `<repo>/.claudexor/` is always user-owned versioned config.
 * Nothing here is a database; projections can be rebuilt from durable state.
 */
export class ArtifactStore {
  readonly claudexorDir: string;

  constructor(
    public readonly repoRoot: string,
    options: { claudexorDir?: string } = {},
  ) {
    this.claudexorDir = options.claudexorDir ?? projectRuntimeDir(repoRoot);
  }

  runsDir(): string {
    return join(this.claudexorDir, "runs");
  }

  workspacesDir(): string {
    return join(this.claudexorDir, "workspaces");
  }

  runPaths(runId: string): RunPaths {
    // Id-shape fence at the single owner of run-dir layout: a runId is one
    // path SEGMENT, never a path. This blocks `../`-style ids from escaping
    // `.claudexor/runs` for every caller (HTTP surfaces already resolve ids
    // via registry lookup — this is the defense-in-depth floor beneath them,
    // the same reasoning as the envelope-id validation in dispose()).
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
      throw new Error(
        `invalid run id '${runId}': a run id is a single path segment ([A-Za-z0-9._-], no separators)`,
      );
    }
    const root = join(this.runsDir(), runId);
    return {
      runId,
      root,
      contextDir: join(root, "context"),
      attemptsDir: join(root, "attempts"),
      reviewsDir: join(root, "reviews"),
      findingsDir: join(root, "findings"),
      arbitrationDir: join(root, "arbitration"),
      finalDir: join(root, "final"),
      eventsPath: join(root, "events.jsonl"),
    };
  }

  /** Create the on-disk layout for a new run and return its paths. */
  createRun(runId: string): RunPaths {
    const paths = this.runPaths(runId);
    for (const dir of [
      paths.root,
      paths.contextDir,
      paths.attemptsDir,
      paths.reviewsDir,
      paths.findingsDir,
      paths.arbitrationDir,
      paths.finalDir,
    ]) {
      ensureDir(dir);
    }
    return paths;
  }

  writeYaml(path: string, value: unknown): void {
    writeText(path, yamlStringify(value));
  }

  writeJson(path: string, value: unknown): void {
    writeJson(path, value);
  }

  writeText(path: string, text: string): void {
    writeText(path, text);
  }

  readYaml<T = unknown>(path: string): T | null {
    const text = readTextSafe(path);
    if (text === null) return null;
    try {
      return yamlParse(text) as T;
    } catch {
      return null;
    }
  }

  /** List existing run ids (most-recent ordering is the caller's concern). */
  listRuns(): string[] {
    return listDir(this.runsDir());
  }
}
