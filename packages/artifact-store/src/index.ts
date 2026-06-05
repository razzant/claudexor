import { join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { ensureDir, listDir, readTextSafe, writeJson, writeText } from "@claudex/util";

export interface RunPaths {
  runId: string;
  root: string;
  contextDir: string;
  attemptsDir: string;
  reviewsDir: string;
  findingsDir: string;
  arbitrationDir: string;
  finalDir: string;
  harnessesDir: string;
  eventsPath: string;
  budgetPath: string;
}

/**
 * Files-first artifact store. Canonical artifacts live under
 * `<repo>/.claudex/`. Nothing here is a database; an optional SQLite index can
 * be rebuilt from these files later.
 */
export class ArtifactStore {
  readonly claudexDir: string;

  constructor(public readonly repoRoot: string) {
    this.claudexDir = join(repoRoot, ".claudex");
  }

  runsDir(): string {
    return join(this.claudexDir, "runs");
  }

  workspacesDir(): string {
    return join(this.claudexDir, "workspaces");
  }

  runPaths(runId: string): RunPaths {
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
      harnessesDir: join(root, "harnesses"),
      eventsPath: join(root, "events.jsonl"),
      budgetPath: join(root, "budget.jsonl"),
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
      paths.harnessesDir,
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
