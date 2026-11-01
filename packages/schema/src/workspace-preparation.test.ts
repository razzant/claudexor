import { describe, expect, it } from "vitest";
import { WorkspacePreparedPayload, workspacePreparationSummary } from "./workspace-preparation.js";

const none = { files: 0, directories: 0, symlinks: 0 };
const summary = (scope: string[], copied: typeof none, missing: string[] = []) =>
  workspacePreparationSummary(
    WorkspacePreparedPayload.parse({
      attempt_id: "a01",
      source_root: "/work/project",
      scope_paths: scope,
      copied,
      missing_paths: missing,
    }),
  );

describe("workspacePreparationSummary (#563)", () => {
  it("warns that nothing was copied when no path was selected", () => {
    expect(summary([], none)).toEqual({
      warning: true,
      text: "Isolated copy prepared from /work/project: nothing copied (no input paths were selected).",
    });
  });

  it("names a missing selected path and its resolution root as possible new output, not an error", () => {
    const { warning, text } = summary(["notes/new.md"], none, ["notes/new.md"]);
    expect(warning).toBe(true);
    expect(text).toBe(
      'Isolated copy prepared from /work/project: nothing copied from "notes/new.md".' +
        ' Not found there when the copy was prepared: "notes/new.md" (absent in the copy; may be created as new output).',
    );
    expect(text).not.toMatch(/error|fail/i);
  });

  it("warns for a partial copy and names only the missing path", () => {
    const { warning, text } = summary(["input.txt", "new.txt"], { ...none, files: 1 }, ["new.txt"]);
    expect(warning).toBe(true);
    expect(text).toContain('1 file copied from "input.txt", "new.txt".');
    expect(text).toContain('Not found there when the copy was prepared: "new.txt"');
    expect(text).not.toContain('found there when the copy was prepared: "input.txt"');
  });

  it("is quiet for selections that were copied, including an empty directory and a link", () => {
    expect(summary(["."], { files: 2, directories: 1, symlinks: 0 })).toEqual({
      warning: false,
      text: 'Isolated copy prepared from /work/project: 2 files, 1 directory copied from ".".',
    });
    expect(summary(["empty"], { ...none, directories: 1 }).warning).toBe(false);
    const link = summary(["link"], { ...none, symlinks: 1 });
    expect(link.warning).toBe(false);
    expect(link.text).toContain("1 symbolic link copied");
    expect(link.text).toContain("Symbolic links were copied as links, not followed.");
  });

  it("names every selected and missing path, quoted, however many there are", () => {
    const paths = Array.from({ length: 25 }, (_, i) => `p${i}`);
    const odd = ["line\nbreak.txt", 'quote".md', "é/ü 日本.txt", "tab\tname"];
    const { text } = summary([...paths, ...odd], none, [...paths, ...odd]);
    for (const path of [...paths, ...odd])
      expect(text.split(JSON.stringify(path)).length - 1).toBe(2);
    expect(text).not.toContain("more");
    // One line: a path's own newline or quote stays escaped.
    expect(text).not.toContain("\n");
    expect(text).toContain('"line\\nbreak.txt"');
  });
});
