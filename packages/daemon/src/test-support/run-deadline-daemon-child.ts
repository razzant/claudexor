/**
 * A real DaemonServer in its own process, for the run-deadline/1 process tests
 * (`run-deadline-process.test.ts`). The test SIGKILLs this process; nothing
 * here may outlive it except what a run spawned and the run's warden.
 *
 * argv: <dir>. The runner does what the orchestrator does at the scope hand-off
 * (`onRunScopeOpened`): mint a marker, hand it to `ctx.deadlineScope` BEFORE the
 * first launch, then launch a "harness" carrying the marker that starts a
 * grandchild in its own session (setsid). It never ends them itself: after a
 * SIGKILL only the warden can. Every launched pid is appended to <dir>/pids.jsonl.
 *
 * Not a fixture for anything else: the startup crash GC of the real daemon is
 * deliberately absent, so a test can prove the warden alone kept the deadline.
 */
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { mintRunScopeMarker } from "@claudexor/core";
import { DaemonServer } from "../server.js";
import { DurableJournal } from "../store/test-support/fixtures/legacy/journal/index.js";
import { CommandStore } from "../store/test-support/fixtures/legacy/daemon/command-store.js";
import { legacyCommandFixture } from "../store/test-support/legacy-command-fixture.js";

const HARNESS = `
const { spawn } = require("node:child_process");
const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { detached: true, stdio: "ignore" });
g.unref();
process.stdout.write(JSON.stringify({ child: process.pid, grandchild: g.pid }) + "\\n");
setInterval(() => {}, 1e6);
`;

const dir = process.argv[2]!;
const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
const store = new CommandStore(journal);
store.recoverAfterStartup();

const server = new DaemonServer({
  socketPath: join(dir, "d.sock"),
  token: "token",
  commands: legacyCommandFixture({ current: () => store }),
  runDeadlines: { dir: join(dir, "deadlines") },
  runner: async (params, ctx) => {
    const marker = mintRunScopeMarker();
    await ctx.deadlineScope?.attach(marker, new Date().toISOString());
    const harness = spawn(process.execPath, ["-e", HARNESS], {
      env: { ...process.env, [marker]: "1" },
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = await new Promise<string>((resolve) =>
      createInterface({ input: harness.stdout! }).once("line", resolve),
    );
    const pids = JSON.parse(line) as { child: number; grandchild: number };
    appendFileSync(
      join(dir, "pids.jsonl"),
      `${JSON.stringify({ jobId: ctx.jobId, label: (params as { label?: string }).label, ...pids })}\n`,
    );
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) resolve();
      ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { lifecycle: "cancelled" };
  },
});

await server.start();
writeFileSync(join(dir, "ready"), String(process.pid));
