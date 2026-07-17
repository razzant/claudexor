import { describe, expect, it } from "vitest";
import { cUnquoteGitPath, parseUnifiedDiff, summarizeDiffPaths } from "./diff.js";

describe("cUnquoteGitPath", () => {
  it("decodes octal escapes to utf8 and standard escapes", () => {
    // git quotes "файл.txt" as octal utf8 bytes under core.quotePath=true.
    expect(cUnquoteGitPath('"\\321\\204\\320\\260\\320\\271\\320\\273.txt"')).toBe("файл.txt");
    expect(cUnquoteGitPath('"with\\tтab\\"quote\\\\slash"')).toBe('with\tтab"quote\\slash');
    expect(cUnquoteGitPath("plain/path.txt")).toBe("plain/path.txt");
  });
});

describe("parseUnifiedDiff", () => {
  it("parses quoted non-ASCII headers (the gate-bypass class)", () => {
    const diff = [
      'diff --git "a/\\321\\204.txt" "b/\\321\\204.txt"',
      "index 000..111 100644",
      '--- "a/\\321\\204.txt"',
      '+++ "b/\\321\\204.txt"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const res = parseUnifiedDiff(diff);
    expect(res.files).toHaveLength(1);
    expect(res.files[0]?.newPath).toBe("ф.txt");
    expect(res.files[0]?.oldPath).toBe("ф.txt");
    expect(res.additions).toBe(1);
    expect(res.deletions).toBe(1);
  });

  it("never reads hunk CONTENT lines as file metadata (SQL-comment false-refusal class)", () => {
    const diff = [
      "diff --git a/query.sql b/query.sql",
      "--- a/query.sql",
      "+++ b/query.sql",
      "@@ -1,3 +1,2 @@",
      " select 1;",
      "--- /var/lib note looks like a header but is REMOVED CONTENT",
      "+++ another content line",
      "",
    ].join("\n");
    const res = parseUnifiedDiff(diff);
    expect(res.files).toHaveLength(1);
    expect(res.files[0]?.newPath).toBe("query.sql");
    // The content lines counted as -/+, not as paths.
    expect(res.deletions).toBe(1);
    expect(res.additions).toBe(1);
  });

  it("tracks adds, deletes, and renames with unquoting", () => {
    const diff = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      'diff --git "a/old \\321\\204.txt" "b/new \\321\\204.txt"',
      "similarity index 90%",
      'rename from "old \\321\\204.txt"',
      'rename to "new \\321\\204.txt"',
      "",
    ].join("\n");
    const res = parseUnifiedDiff(diff);
    expect(res.files.map((f) => [f.added, f.deleted, f.renamed])).toEqual([
      [true, false, false],
      [false, true, false],
      [false, false, true],
    ]);
    expect(res.files[0]?.oldPath).toBeNull();
    expect(res.files[1]?.newPath).toBeNull();
    expect(res.files[2]?.oldPath).toBe("old ф.txt");
    expect(res.files[2]?.newPath).toBe("new ф.txt");
  });

  it("classifies binary payloads vs undeliverable stubs", () => {
    const withPayload = [
      "diff --git a/img.png b/img.png",
      "index 000..111 100644",
      "GIT binary patch",
      "literal 5",
      "Mcmb=x#L",
      "",
    ].join("\n");
    const stub = [
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(withPayload).files[0]).toMatchObject({
      binary: true,
      binaryStub: false,
    });
    expect(parseUnifiedDiff(stub).files[0]).toMatchObject({ binary: true, binaryStub: true });
  });

  it("handles unquoted paths with spaces via the ' b/' boundary", () => {
    const diff = [
      "diff --git a/my file.txt b/my file.txt",
      "--- a/my file.txt",
      "+++ b/my file.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    const res = parseUnifiedDiff(diff);
    expect(res.files[0]?.newPath).toBe("my file.txt");
  });
});

describe("parseUnifiedDiff — plain GNU diffs (non-git in-place fallback)", () => {
  // Shape produced by the workspace manager's `diff -ruN <baseline> <live>`:
  // absolute paths, tab-separated timestamps, `diff …` command separators.
  const plain = [
    "diff -ruN -x .git /tmp/base/src/app.js /repo/src/app.js",
    "--- /tmp/base/src/app.js\t2026-07-08 10:00:00.000000000 +0300",
    "+++ /repo/src/app.js\t2026-07-08 10:05:00.000000000 +0300",
    "@@ -1,3 +1,3 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "diff -ruN -x .git /tmp/base/auth/token.js /repo/auth/token.js",
    "--- /tmp/base/auth/token.js\t2026-07-08 10:00:00.000000000 +0300",
    "+++ /repo/auth/token.js\t2026-07-08 10:05:00.000000000 +0300",
    "@@ -1 +1,2 @@",
    " export {};",
    "+leaked();",
    "",
  ].join("\n");

  it("summarizes every touched file — the class that used to project files:[] and blind path gates", () => {
    const res = parseUnifiedDiff(plain);
    expect(res.files).toHaveLength(2);
    expect(res.files[0]?.oldPath).toBe("/tmp/base/src/app.js");
    expect(res.files[0]?.newPath).toBe("/repo/src/app.js");
    expect(res.files[1]?.newPath).toBe("/repo/auth/token.js");
    expect(res.additions).toBe(2);
    expect(res.deletions).toBe(1);
    expect(res.hunks).toBe(2);
    const paths = summarizeDiffPaths(plain);
    expect(paths.paths).toEqual(["/repo/src/app.js", "/repo/auth/token.js"]);
    // Protected-path globs (e.g. **/auth/**) must see the touched auth file.
    expect(paths.paths.some((p) => p.includes("/auth/"))).toBe(true);
  });

  it("touchedPaths is the union every path gate must match: both rename sides AND added files (G1)", () => {
    const rename = [
      "diff --git a/secrets/key.txt b/public.txt",
      "similarity index 100%",
      "rename from secrets/key.txt",
      "rename to public.txt",
      "",
    ].join("\n");
    const renamed = summarizeDiffPaths(rename);
    // A rename-out gate matching only the new side would miss the source…
    expect(renamed.touchedPaths).toContain("secrets/key.txt");
    expect(renamed.touchedPaths).toContain("public.txt");

    const added = [
      "diff --git a/secrets/evil.txt b/secrets/evil.txt",
      "new file mode 100644",
      "index 0000000..257cc56",
      "--- /dev/null",
      "+++ b/secrets/evil.txt",
      "@@ -0,0 +1 @@",
      "+evil",
      "",
    ].join("\n");
    const summary = summarizeDiffPaths(added);
    // …and an existing-only gate would miss a brand-new file under the glob.
    expect(summary.existingPaths).toEqual([]);
    expect(summary.touchedPaths).toEqual(["secrets/evil.txt"]);
  });

  it("opens plain files only on the full ---/+++/@@ triple (SQL-comment content stays content)", () => {
    const tricky = [
      "--- /tmp/base/q.sql\t2026-07-08 10:00:00 +0300",
      "+++ /repo/q.sql\t2026-07-08 10:05:00 +0300",
      "@@ -1,3 +1,1 @@",
      " select 1;",
      "--- a removed sql comment line",
      "-another removed line",
      "",
    ].join("\n");
    const res = parseUnifiedDiff(tricky);
    expect(res.files).toHaveLength(1);
    expect(res.files[0]?.newPath).toBe("/repo/q.sql");
    expect(res.deletions).toBe(2);
  });

  it("a forged mid-hunk triple (deleted '-- x' + added '++ y' + next hunk) never opens a file", () => {
    const forged = [
      "--- /tmp/base/q.sql\t2026-07-08 10:00:00 +0300",
      "+++ /repo/q.sql\t2026-07-08 10:05:00 +0300",
      "@@ -1,4 +1,4 @@",
      " select 1;",
      "--- removed sql comment", // deleted content line, no tab witness
      "+++ added odd line", // added content line, no tab witness
      "@@ -9,1 +9,1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    const res = parseUnifiedDiff(forged);
    expect(res.files).toHaveLength(1);
    expect(res.files[0]?.newPath).toBe("/repo/q.sql");
    expect(res.hunks).toBe(2);
  });

  it("consecutive plain files without command separators still split on the header triple", () => {
    const noSep = [
      "--- /tmp/base/a.txt\t2026-01-01",
      "+++ /repo/a.txt\t2026-01-02",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "--- /tmp/base/b.txt\t2026-01-01",
      "+++ /repo/b.txt\t2026-01-02",
      "@@ -1 +1 @@",
      "-p",
      "+q",
      "",
    ].join("\n");
    const res = parseUnifiedDiff(noSep);
    expect(res.files.map((f) => f.newPath)).toEqual(["/repo/a.txt", "/repo/b.txt"]);
  });

  it("captures plain binary stubs and /dev/null adds", () => {
    const doc = [
      "diff -ruN /tmp/base/img.png /repo/img.png",
      "Binary files /tmp/base/img.png and /repo/img.png differ",
      "--- /dev/null\t1970-01-01",
      "+++ /repo/new.txt\t2026-01-02",
      "@@ -0,0 +1 @@",
      "+hello",
      "",
    ].join("\n");
    const res = parseUnifiedDiff(doc);
    expect(res.files).toHaveLength(2);
    expect(res.files[0]).toMatchObject({
      binary: true,
      binaryStub: true,
      newPath: "/repo/img.png",
    });
    expect(res.files[1]).toMatchObject({ added: true, oldPath: null, newPath: "/repo/new.txt" });
  });

  it("git-anchored documents keep git semantics — a plain-looking triple inside hunk content never opens a file", () => {
    const gitDoc = [
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,3 +1,3 @@",
      "--- looks like a plain header",
      "+++ but is content",
      "@@ escaped-looking content is a new hunk header only when bare",
      "",
    ].join("\n");
    const res = parseUnifiedDiff(gitDoc);
    expect(res.files).toHaveLength(1);
    expect(res.files[0]?.newPath).toBe("notes.md");
  });
});
