import { describe, expect, it } from "vitest";
import { cUnquoteGitPath, parseUnifiedDiff } from "./diff.js";

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
    const stub = ["diff --git a/img.png b/img.png", "Binary files a/img.png and b/img.png differ", ""].join("\n");
    expect(parseUnifiedDiff(withPayload).files[0]).toMatchObject({ binary: true, binaryStub: false });
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
