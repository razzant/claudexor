import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import {
  ConformanceReport,
  HarnessManifest,
  WorkspaceFilesManifest,
  WorkspacePreparedPayload,
  workspacePreparationSummary,
} from "@claudexor/schema";
import { WorkspaceManager, applyWorkspaceFiles } from "@claudexor/workspace";
import { directoryPreparationNotice } from "./directoryCandidate.js";
import { Orchestrator } from "./orchestrator.js";

// #563: before its executor starts, an isolated directory copy announces what it
// was prepared with (`workspace.prepared`), and the executor's prompt carries the
// same fact. Nothing copied or a selected path not found is a warning, never a
// refusal; a selected path may be a future output.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const posix = process.platform !== "win32";

interface Seen {
  prompt: string;
  /** Event types already written when the executor started (harness events by kind). */
  before: string[];
}

function author(id: string, runsDir: string, seen: Seen[]): HarnessAdapter {
  const fake = createFakeHarness("fake-implement");
  return {
    ...fake,
    id,
    async discover() {
      return HarnessManifest.parse({
        ...(await fake.discover()),
        id,
        kind: "local_cli",
        capabilities: { ...(await fake.discover()).capabilities, review: false, synthesize: false },
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["implement", "repair"],
      });
    },
    async *run(spec) {
      const [runDir] = readdirSync(runsDir).map((name) => join(runsDir, name));
      seen.push({
        prompt: spec.prompt,
        before: readFileSync(join(runDir!, "events.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const event = JSON.parse(line) as { type: string; payload?: { type?: string } };
            return event.type === "harness.event"
              ? `harness.event:${event.payload?.type ?? "?"}`
              : event.type;
          }),
      });
      const ts = new Date().toISOString();
      yield { type: "started", ts, session_id: spec.session_id };
      writeFileSync(join(spec.cwd, `result-${id}.txt`), "created output\n");
      yield {
        type: "file_change",
        ts,
        session_id: spec.session_id,
        payload: { path: `result-${id}.txt` },
      };
      yield { type: "message", ts, session_id: spec.session_id, text: "Done.", final: true };
      yield { type: "completed", ts, session_id: spec.session_id };
    },
  };
}

function project() {
  const root = temp("cx-dir-prep-project-");
  writeFileSync(join(root, "input.txt"), "selected source\n");
  writeFileSync(join(root, "unselected.txt"), "unselected sibling\n");
  mkdirSync(join(root, "empty"));
  if (posix) symlinkSync("input.txt", join(root, "link"));
  return root;
}

function events(runDir: string): Array<{ type: string; payload: Record<string, unknown> }> {
  return readFileSync(join(runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

const none = { files: 0, directories: 0, symlinks: 0 };
const matrix = [
  { name: "omitted", scope: undefined, copied: none, missing: [], warning: true },
  { name: "[]", scope: [], copied: none, missing: [], warning: true },
  {
    name: "missing only",
    scope: ["new-output.txt"],
    copied: none,
    missing: ["new-output.txt"],
    warning: true,
  },
  {
    name: "partial",
    scope: ["input.txt", "new-output.txt"],
    copied: { ...none, files: 1 },
    missing: ["new-output.txt"],
    warning: true,
  },
  {
    name: "existing file",
    scope: ["input.txt"],
    copied: { ...none, files: 1 },
    missing: [],
    warning: false,
  },
  {
    name: "'.'",
    scope: ["."],
    copied: { files: 2, directories: 1, symlinks: posix ? 1 : 0 },
    missing: [],
    warning: false,
  },
  {
    name: "existing empty directory",
    scope: ["empty"],
    copied: { ...none, directories: 1 },
    missing: [],
    warning: false,
  },
  ...(posix
    ? [
        {
          name: "symlink",
          scope: ["link"],
          copied: { ...none, symlinks: 1 },
          missing: [],
          warning: false,
        },
      ]
    : []),
];

describe("an isolated directory copy announces its preparation before the executor starts", () => {
  it.each(matrix)("$name", async ({ scope, copied, missing, warning }) => {
    const root = project();
    const seen: Seen[] = [];
    const adapter = author("prep", new ArtifactStore(root).runsDir(), seen);
    const result = await new Orchestrator({ registry: new Map([[adapter.id, adapter]]) }).run({
      repoRoot: root,
      prompt: "Create the output",
      harnesses: [adapter.id],
      workspaceKind: "directory",
      ...(scope === undefined ? {} : { scopePaths: scope }),
      review: false,
    });

    // No refusal and no implicit whole-folder copy: the run succeeds with its output.
    expect(result.lifecycle).toBe("succeeded");
    const prepared = events(result.runDir).filter((event) => event.type === "workspace.prepared");
    expect(prepared).toHaveLength(1);
    const payload = WorkspacePreparedPayload.parse(prepared[0]!.payload);
    expect(payload).toEqual({
      attempt_id: "a01",
      source_root: root,
      scope_paths: scope ?? [],
      copied,
      missing_paths: missing,
    });
    const summary = workspacePreparationSummary(payload);
    expect(summary.warning).toBe(warning);
    // Already on record when the executor started, and in its prompt.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.before).toContain("workspace.prepared");
    // After the envelope exists (harness.started precedes creation in this lane),
    // before anything the executor itself emitted.
    expect(seen[0]!.before.indexOf("workspace.prepared")).toBeGreaterThan(
      seen[0]!.before.indexOf("harness.started"),
    );
    expect(seen[0]!.before).not.toContain("harness.event:started");
    expect(seen[0]!.prompt).toContain(`When this workspace was created: ${summary.text}`);
    for (const path of missing) expect(seen[0]!.prompt).toContain(JSON.stringify(path));
    if (missing.length === 0) expect(seen[0]!.prompt).not.toContain("Not found there");

    // An empty or partial start is not an empty result: the created file is exact output.
    const manifest = WorkspaceFilesManifest.parse(
      JSON.parse(readFileSync(join(result.runDir, "final/files/manifest.json"), "utf8")),
    );
    expect(manifest.entries.find((entry) => entry.path === "result-prep.txt")).toMatchObject({
      before: null,
      after: { kind: "file" },
    });
    expect(manifest.entries.some((entry) => entry.path === "unselected.txt")).toBe(
      scope?.includes(".") === true,
    );
    expect(readFileSync(join(result.runDir, "final/files/result.md"), "utf8")).toContain(
      "Files captured from a separate copy. Inspect the captured files; application is subject to the run's outcome and a delivery check.",
    );
    if (scope === undefined) {
      const applied = await applyWorkspaceFiles(root, manifest, result.runDir);
      expect(applied.applied).toBe(true);
      expect(readFileSync(join(root, "result-prep.txt"), "utf8")).toBe("created output\n");
      expect(readFileSync(join(root, "unselected.txt"), "utf8")).toBe("unselected sibling\n");
    }
  });

  it("each copy of a best-of run is announced once, before its own executor", async () => {
    const root = project();
    const seen: Seen[] = [];
    const runsDir = new ArtifactStore(root).runsDir();
    const adapters = [author("best-a", runsDir, seen), author("best-b", runsDir, seen)];
    const result = await new Orchestrator({
      registry: new Map(adapters.map((adapter) => [adapter.id, adapter])),
    }).run({
      repoRoot: root,
      prompt: "Create the output",
      harnesses: adapters.map((adapter) => adapter.id),
      n: 2,
      workspaceKind: "directory",
      scopePaths: ["input.txt"],
    });

    const prepared = events(result.runDir).filter((event) => event.type === "workspace.prepared");
    expect(prepared.map((event) => event.payload["attempt_id"]).sort()).toEqual(["a01", "a02"]);
    expect(seen).toHaveLength(2);
    for (const { prompt } of seen)
      expect(prompt).toContain(
        `When this workspace was created: Isolated copy prepared from ${root}: 1 file copied from "input.txt".`,
      );
  });

  it("names all 25 absent selections in the event and the executor prompt", async () => {
    const root = project();
    const seen: Seen[] = [];
    const adapter = author("many", new ArtifactStore(root).runsDir(), seen);
    const absent = Array.from(
      { length: 25 },
      (_, i) => `out/new-${String(i + 1).padStart(2, "0")}.md`,
    );
    const result = await new Orchestrator({ registry: new Map([[adapter.id, adapter]]) }).run({
      repoRoot: root,
      prompt: "Create the output",
      harnesses: [adapter.id],
      workspaceKind: "directory",
      scopePaths: ["input.txt", ...absent],
      review: false,
    });

    expect(result.lifecycle).toBe("succeeded");
    const [prepared] = events(result.runDir).filter((event) => event.type === "workspace.prepared");
    expect(prepared!.payload["missing_paths"]).toEqual(absent);
    const line = seen[0]!.prompt
      .split("\n")
      .find((text) => text.startsWith("When this workspace was created: "))!;
    for (const path of absent) expect(line.split(JSON.stringify(path)).length - 1).toBe(2);
    expect(line).toContain(
      '"out/new-21.md", "out/new-22.md", "out/new-23.md", "out/new-24.md", "out/new-25.md"',
    );
    expect(line).not.toMatch(/\d+ more/);
  });

  it("a live directory run announces no copy and adds no notice", async () => {
    const root = project();
    const seen: Seen[] = [];
    const adapter = author("live", new ArtifactStore(root).runsDir(), seen);
    const result = await new Orchestrator({ registry: new Map([[adapter.id, adapter]]) }).run({
      repoRoot: root,
      prompt: "Create the output",
      harnesses: [adapter.id],
      workspaceKind: "directory",
      scopePaths: ["missing.txt"],
      inPlace: true,
      review: false,
    });

    expect(events(result.runDir).some((event) => event.type === "workspace.prepared")).toBe(false);
    expect(seen[0]!.prompt).not.toContain("When this workspace was created");
    expect(existsSync(join(root, "result-live.txt"))).toBe(true);
  });
});

describe("directoryPreparationNotice", () => {
  it("announces a copy once while every round's prompt still gets the creation fact", async () => {
    const root = project();
    const manager = new WorkspaceManager(root, { runtimeRoot: temp("cx-dir-prep-rt-") });
    const envelope = await manager.create({
      taskId: "t",
      attemptId: "converge",
      workspaceKind: "directory",
      scopePaths: ["new-output.txt"],
    });
    const emitted: Array<[string, Record<string, unknown>]> = [];
    const log = {
      emit: (type: string, payload: Record<string, unknown>) => emitted.push([type, payload]),
    };

    const first = await directoryPreparationNotice(envelope, "a01", log as never);
    writeFileSync(join(envelope.worktree_path, "new-output.txt"), "written in round one\n");
    const second = await directoryPreparationNotice(envelope, "a02", log as never);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]![0]).toBe("workspace.prepared");
    expect(emitted[0]![1]).toMatchObject({ attempt_id: "a01", missing_paths: ["new-output.txt"] });
    // Worded for the copy's creation, so it stays true after round one wrote the path.
    expect(second).toBe(first);
    expect(second).toMatch(/^When this workspace was created: /);
    await manager.dispose(envelope);
  });
});
