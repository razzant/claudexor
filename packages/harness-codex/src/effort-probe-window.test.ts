import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";

// A pass-through spy over the real spawn: the recorded options show the window
// policy while the fixture app-server still answers over real pipes.
const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  spawnSpy.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnSpy };
});

import { probeCodexEfforts } from "./effort-probe.js";

it.skipIf(process.platform === "win32")(
  "runs its captured model/list app-server without a console window and stops it after the answer",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-effort-window-"));
    try {
      const bin = join(dir, "codex");
      writeFileSync(
        bin,
        `#!/usr/bin/env node
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "model/list" ? { data: [{ id: "fixture", isDefault: true,
    defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] } : {};
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`,
      );
      chmodSync(bin, 0o755);
      const probed = await probeCodexEfforts(bin, {
        env: { PATH: dirname(process.execPath) },
        timeoutMs: 10_000,
      });
      expect(probed?.models["fixture"]).toEqual({ levels: ["high"], default: "high" });
      expect(spawnSpy).toHaveBeenCalledOnce();
      expect(spawnSpy.mock.calls[0]?.[1]).toEqual(["app-server", "--stdio"]);
      expect(spawnSpy.mock.calls[0]?.[2]).toMatchObject({
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      expect(spawnSpy.mock.calls[0]?.[2]).not.toHaveProperty("detached");
      const child = spawnSpy.mock.results[0]?.value as ChildProcess;
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
      expect(child.signalCode ?? child.exitCode).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
