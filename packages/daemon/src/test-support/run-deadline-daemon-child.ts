/**
 * A real DaemonServer in its own process, for the run-deadline/1 process trials
 * (`run-deadline-process.test.ts`). It talks to the test only through files in
 * <dir>, so no socket path is involved; the test SIGKILLs it by its verified pid.
 *
 * argv: <dir> <mode>
 * - `run`: enqueue the job in env CX_JOB ({ key, label, deadlineAt }) and keep
 *   serving until killed. The runner does what the production runner does at the
 *   hand-off (`ctx.deadlineScope.attach` before the first launch), then launches
 *   a "harness" through core's spawnProcess (so a proven cgroup boundary applies)
 *   that starts a grandchild in its own session (setsid) and, with CX_CLEAN=1,
 *   a second one with an empty environment (no marker: only a cgroup can reach
 *   it). Each harness line is appended raw to <dir>/pids.jsonl.
 * - `read`: open the same journal as a new daemon generation (no startup crash
 *   GC here), read the job in env CX_JOB_ID and its deadline into <dir>/read.json.
 *
 * <dir>/ready (JSON) carries this process's pid and the proven boundary.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintRunScopeMarker, spawnProcess } from "@claudexor/core";
import { DaemonLocalClient } from "../daemon-local-client.js";
import { DaemonServer } from "../server.js";
import { DurableJournal } from "../store/test-support/fixtures/legacy/journal/index.js";
import { CommandStore } from "../store/test-support/fixtures/legacy/daemon/command-store.js";
import { legacyCommandFixture } from "../store/test-support/legacy-command-fixture.js";

const HARNESS = `
const { spawn } = require("node:child_process");
const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { detached: true, stdio: "ignore" });
g.unref();
let clean = null;
if (process.env.CX_CLEAN === "1") {
  const c = spawn("/bin/sh", ["-c", "exec sleep 1000"], { detached: true, stdio: "ignore", env: {} });
  c.unref();
  clean = c.pid;
}
process.stdout.write(JSON.stringify({ child: process.pid, grandchild: g.pid, clean }) + "\\n");
setInterval(() => {}, 1e6);
`;

const [dir, mode] = process.argv.slice(2) as [string, "run" | "read"];
const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
const store = new CommandStore(journal);
store.recoverAfterStartup();

const server = new DaemonServer({
  socketPath: join(dir, "unused.sock"),
  token: "token",
  commands: legacyCommandFixture({ current: () => store }),
  runDeadlines: { dir: join(dir, "deadlines") },
  runner: async (_params, ctx) => {
    const marker = mintRunScopeMarker();
    await ctx.deadlineScope?.attach(marker);
    const events = spawnProcess(process.execPath, ["-e", HARNESS], { env: { [marker]: "1" } });
    void (async () => {
      for await (const event of events)
        if (event.type === "stdout") appendFileSync(join(dir, "pids.jsonl"), `${event.line}\n`);
    })().catch(() => {});
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) resolve();
      ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { lifecycle: "cancelled" };
  },
});
const client = new DaemonLocalClient(() => server);
const boundary = await server.deadlines.prepare();
writeFileSync(join(dir, "ready"), JSON.stringify({ pid: process.pid, boundary: boundary.kind }));

if (mode === "run") {
  const job = JSON.parse(process.env.CX_JOB ?? "{}") as {
    key: string;
    label: string;
    deadlineAt: string;
  };
  const accepted = await client.enqueue(
    { label: job.label, deadline: { at: job.deadlineAt } },
    { idempotencyKey: job.key, clientId: "test" },
  );
  writeFileSync(join(dir, "job"), accepted.id);
  setInterval(() => {}, 1e6);
} else {
  const id = process.env.CX_JOB_ID ?? "";
  const status = await client.status(id);
  const deadline = await client.runDeadline(id, { action: "read" }).catch((error: unknown) => ({
    error: (error as { code?: string }).code ?? String(error),
  }));
  writeFileSync(join(dir, "read.json"), JSON.stringify({ status, deadline }));
  journal.close();
  process.exit(0);
}
