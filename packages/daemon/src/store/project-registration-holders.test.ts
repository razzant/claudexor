import { describe, expect, it } from "vitest";
import { commandRecordedFolders, draftRecordedFolders } from "./project-registration-holders.js";

// The release fence's one reader of a live holder's recorded folder facts: the
// accepted summary of a command, or the captured start of a reserved draft.
// Only a one-off (ephemeral) project scope is a folder fact — a named scope is
// a registry key — and unreadable bytes are unknown, never "no folder". These
// are pure reads: no store, no rows and nothing to damage.

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("live holder folder facts", () => {
  it("reads a one-off scope's root and an explicit workspace, and nothing else", () => {
    expect(
      commandRecordedFolders(
        encode({ params: { scope: { kind: "project", root: "/one-off", ephemeral: true } } }),
      ),
    ).toEqual(["/one-off"]);
    expect(
      commandRecordedFolders(encode({ params: { execution: { workspaceRoot: "/workspace" } } })),
    ).toEqual(["/workspace"]);
    expect(
      commandRecordedFolders(
        encode({
          params: {
            scope: { kind: "project", root: "/one-off", ephemeral: true },
            execution: { workspaceRoot: "/workspace" },
          },
        }),
      ),
    ).toEqual(["/one-off", "/workspace"]);
    // A named project scope and a folderless request are not folder facts.
    expect(
      commandRecordedFolders(encode({ params: { scope: { kind: "project", root: "/named" } } })),
    ).toEqual([]);
    expect(commandRecordedFolders(encode({ params: { prompt: "no folders" } }))).toEqual([]);
  });

  it("treats unreadable recorded facts as unknown, never as absence", () => {
    expect(commandRecordedFolders(Buffer.from("{not json"))).toBeNull();
    expect(commandRecordedFolders(Uint8Array.from([0xff, 0xfe]))).toBeNull();
    expect(
      draftRecordedFolders(
        {
          read: () => {
            throw new Error("body is unavailable");
          },
        },
        "0".repeat(64),
      ),
    ).toBeNull();
    // A one-off declaration whose root cannot be read is unknown too.
    expect(
      commandRecordedFolders(encode({ params: { scope: { kind: "project", ephemeral: true } } })),
    ).toBeNull();
  });

  it("reads a reserved draft's captured start the same way", () => {
    const body = encode({
      capturedStart: {
        scope: { kind: "project", root: "/one-off", ephemeral: true },
        execution: { workspaceRoot: "/workspace" },
      },
    });
    expect(draftRecordedFolders({ read: () => body }, "sha")).toEqual(["/one-off", "/workspace"]);
  });
});
