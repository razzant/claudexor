import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { readFileUtf8BoundedSync } from "./bounded-file-read.js";

it("preserves BOM bytes in exact immutable reads and still refuses oversized evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "cx-bounded-bom-"));
  try {
    const file = join(root, "bytes.txt");
    const text = "\ufeffhello";
    writeFileSync(file, text);
    expect(readFileUtf8BoundedSync(file, 8)).toBe(text);
    expect(() => readFileUtf8BoundedSync(file, 7)).toThrow(
      expect.objectContaining({ code: "artifact_read_limit", status: 503 }),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
