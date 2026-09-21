import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

import { runCaptureRaw, spawnProcess } from "./proc.js";

function completedChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
  });
  return child;
}

describe("background process window policy", () => {
  it("hides the console window for streamed child processes", async () => {
    spawnMock.mockReturnValueOnce(completedChild());

    for await (const _event of spawnProcess("opencode", ["--version"])) {
      // Consume the completed child lifecycle.
    }

    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true });
  });

  it("hides the console window for raw capture child processes", async () => {
    spawnMock.mockReturnValueOnce(completedChild());

    await runCaptureRaw("opencode", ["--version"]);

    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true });
  });
});
