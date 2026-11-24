/**
 * A real DaemonServer in its own process whose runner takes a production path
 * under a run-deadline/1 deadline (`run-deadline-cli.process.test.ts`):
 * - `adapter`: the real Claude adapter runs `claude` from `CX_FAKE_BIN` on PATH,
 *   with the run's marker in its spec env (the vendor CLI path);
 * - `delivery`: an in-place delivery (`verifyAndDeliver`, apply) inside the
 *   run's launch scope, whose final verification gate blocks.
 * Both hand the run's marker to the warden first, as the production runner does.
 * argv: <dir> <mode>; env CX_JOB ({ key, deadlineAt }), CX_REPO (delivery).
 * <dir>/ready carries this process's pid and the proven boundary.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintRunScopeMarker, scopeMarkerEnv, withinRunScope } from "@claudexor/core";
import { DaemonLocalClient, DaemonServer, type RunnerFn } from "@claudexor/daemon";
import { legacyCommandFixture } from "../../../daemon/src/store/test-support/legacy-command-fixture.js";
import { CommandStore } from "../../../daemon/src/store/test-support/fixtures/legacy/daemon/command-store.js";
import { DurableJournal } from "../../../daemon/src/store/test-support/fixtures/legacy/journal/index.js";
import { createClaudeAdapter } from "@claudexor/harness-claude";
import { verifyAndDeliver } from "@claudexor/delivery";
import { HarnessRunSpec } from "@claudexor/schema";

const [dir, mode] = process.argv.slice(2) as [string, "adapter" | "delivery"];
const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
const store = new CommandStore(journal);
store.recoverAfterStartup();

const waitForStop = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

const runner: RunnerFn = async (_params, ctx) => {
  const marker = mintRunScopeMarker();
  await ctx.deadlineScope?.attach(marker);
  if (mode === "adapter") {
    const spec = HarnessRunSpec.parse({
      session_id: "sess-deadline",
      intent: "implement",
      prompt: "work until stopped",
      cwd: dir,
      env: {
        PATH: `${process.env.CX_FAKE_BIN}:${process.env.PATH ?? ""}`,
        HOME: dir,
        CX_TREE: join(dir, "tree.jsonl"),
        ...scopeMarkerEnv(marker),
      },
    });
    void (async () => {
      for await (const _event of createClaudeAdapter().run(spec)) void _event;
    })().catch(() => {});
  } else {
    void withinRunScope(marker, () =>
      verifyAndDeliver(
        process.env.CX_REPO!,
        readFileSync(join(dir, "change.patch"), "utf8"),
        { mode: "apply", signal: ctx.signal },
        [
          {
            id: "blocking-gate",
            program: "/bin/sh",
            args: [
              "-c",
              'setsid sleep 1000 </dev/null >/dev/null 2>&1 & echo "{\\"child\\":$$,\\"grandchild\\":$!}" >> "$CX_TREE"; exec sleep 1000',
            ],
            envAllowlist: ["CX_TREE", "PATH"],
            env: { ...scopeMarkerEnv(marker), CX_TREE: join(dir, "tree.jsonl") },
          },
        ],
      ),
    ).catch(() => {});
  }
  await waitForStop(ctx.signal);
  return { lifecycle: "cancelled" };
};

const server = new DaemonServer({
  socketPath: join(dir, "unused.sock"),
  token: "token",
  commands: legacyCommandFixture({ current: () => store }),
  runDeadlines: { dir: join(dir, "deadlines"), platform: "linux" },
  runner,
});
const client = new DaemonLocalClient(() => server);
await server.deadlines.startup();
const boundary = await server.deadlines.proveBoundary();
writeFileSync(join(dir, "ready"), JSON.stringify({ pid: process.pid, boundary: boundary.kind }));
const job = JSON.parse(process.env.CX_JOB ?? "{}") as { key: string; deadlineAt: string };
const accepted = await client.enqueue(
  { label: mode, deadline: { at: job.deadlineAt } },
  { idempotencyKey: job.key, clientId: "test" },
);
writeFileSync(join(dir, "job"), accepted.id);
setInterval(() => {}, 1e6);
