import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAttachments } from "./attachment-resolver.js";

describe("daemon attachment resolver", () => {
  let previousConfigDir: string | undefined;
  let configDir: string;

  beforeEach(() => {
    previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), "claudexor-attachment-config-"));
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("resolves valid inline base64 to a scoped file", () => {
    const [attachment] = resolveAttachments([
      {
        kind: "file",
        mime: "text/plain",
        name: "note.txt",
        data: Buffer.from("hello").toString("base64"),
        path: null,
      },
    ]);
    expect(attachment?.path).toBeTruthy();
    expect(readFileSync(attachment?.path ?? "", "utf8")).toBe("hello");
  });

  it("fails loudly on malformed inline base64 data", () => {
    expect(() =>
      resolveAttachments([
        {
          kind: "file",
          mime: "text/plain",
          name: "bad.txt",
          data: "!!!!",
          path: null,
        },
      ]),
    ).toThrow(/attachment 0 data must be non-empty valid base64/);
  });

  it("resolves absolute path-only attachments without copying bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-attachment-resolver-"));
    const path = join(dir, "note.txt");
    writeFileSync(path, "hello\n");
    expect(
      resolveAttachments([
        {
          kind: "file",
          mime: "text/plain",
          name: "note.txt",
          data: null,
          path,
        },
      ]),
    ).toEqual([expect.objectContaining({ kind: "file", mime: "text/plain", name: "note.txt", path })]);
  });
});
