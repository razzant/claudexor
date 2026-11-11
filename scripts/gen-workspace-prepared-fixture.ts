#!/usr/bin/env tsx
/**
 * Generates the macOS live-row parity fixture for `workspace.prepared` (#563).
 * Each case pairs an engine event with the row the server timeline projects
 * for it (`timelineEvents`, which words it through the schema's
 * `workspacePreparationSummary`). Swift folds the same event into the turn
 * card's transcript and restores it there from the snapshot row; both must
 * equal this projection.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { WorkspacePreparedPayload } from "../packages/schema/src/workspace-preparation.js";
import { timelineEvents } from "../packages/control-api/src/run-timeline.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(
  repoRoot,
  "apps/macos/ClaudexorApp/Tests/ClaudexorAppTests/Fixtures/workspace-prepared-parity.json",
);

const none = { files: 0, directories: 0, symlinks: 0 };
const many = Array.from({ length: 25 }, (_, i) => `out/new-${String(i + 1).padStart(2, "0")}.md`);
const odd = ["line\nbreak.txt", 'quote".md', "é/ü 日本.txt", "tab\tname", "bell\u0007.txt"];
const cases = [
  { name: "nothing-selected", scope: [], copied: none, missing: [] },
  { name: "missing-only", scope: ["new-output.txt"], copied: none, missing: ["new-output.txt"] },
  {
    name: "partial",
    scope: ["input.txt", "new-output.txt"],
    copied: { ...none, files: 1 },
    missing: ["new-output.txt"],
  },
  { name: "copied-file", scope: ["input.txt"], copied: { ...none, files: 1 }, missing: [] },
  {
    name: "whole-folder",
    scope: ["."],
    copied: { files: 4, directories: 3, symlinks: 1 },
    missing: [],
  },
  { name: "empty-directory", scope: ["empty"], copied: { ...none, directories: 1 }, missing: [] },
  { name: "symlink", scope: ["link"], copied: { ...none, symlinks: 1 }, missing: [] },
  {
    name: "many-and-unusual-missing",
    scope: ["input.txt", ...many, ...odd],
    copied: { ...none, files: 1, directories: 2 },
    missing: [...many, ...odd],
  },
].map(({ name, scope, copied, missing }) => {
  const payload = WorkspacePreparedPayload.parse({
    attempt_id: "a01",
    source_root: "/work/project with space",
    scope_paths: scope,
    copied,
    missing_paths: missing,
  });
  const event = { type: "workspace.prepared", ts: "2026-11-01T00:00:00.000Z", payload };
  const [row] = timelineEvents({}, [event]);
  return { name, event, row };
});

const fixture = { generatedBy: ["WorkspacePreparedPayload", "timelineEvents"], cases };
const body = await format(JSON.stringify(fixture), { parser: "json", printWidth: 100 });
if (process.argv.includes("--check")) {
  if (!existsSync(fixturePath) || readFileSync(fixturePath, "utf8") !== body) {
    console.error("workspace.prepared parity fixture drift (regenerate: pnpm fixtures:swift)");
    process.exit(1);
  }
  console.log("workspace.prepared parity fixture fresh");
} else {
  writeFileSync(fixturePath, body);
  console.log(`wrote workspace.prepared parity fixture to ${fixturePath}`);
}
