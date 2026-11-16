import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { startOf } from "../../core/src/test-support/process-fixtures.js";
import { cli, makeSandbox, type Sandbox } from "./support.js";

/**
 * #694 r17 end to end: the BUILT CLI, the daemon it starts (the real HTTP
 * control API, SQL store, thread runner and resource owners), real files.
 *
 * What a stopped preparation leaves is planted as its record: the stopped step's
 * own process named by pid alone (this test's own sleeper, which nothing here
 * signals). On this platform no reader observes that pid's birth, so only the
 * operator's confirmation can release it: no injected seam is involved.
 */
const posix = process.platform !== "win32";

function control(sb: Sandbox) {
  let id = 0;
  return async (method: string, path: string, body?: unknown, key?: string | null) => {
    const pointer = JSON.parse(
      readFileSync(join(sb.configDir, "daemon", "control-api.json"), "utf8"),
    ) as { host: string; port: number };
    const token = readFileSync(join(sb.configDir, "daemon", "token"), "utf8").trim();
    const response = await fetch(`http://${pointer.host}:${pointer.port}/v2${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-claudexor-protocol-major": "3",
        ...(key === null ? {} : { "idempotency-key": key ?? `preparation-story-${++id}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: JSON.parse(await response.text()) as any };
  };
}

describe.runIf(posix)("held preparation maintenance through the built CLI (#694 r17)", () => {
  it("[INV-144:held-preparation-release] inspect changes nothing; release needs the inspected digest and an explicit confirmation, is recorded durably, replays by its key across a restart, never follows a link, and the thread's next turn runs", async () => {
    const sb = makeSandbox();
    const sleeper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "cx-prep-outside-")));
    try {
      await new Promise((resolve) => sleeper.once("spawn", resolve));
      let sleeperStart: string | "gone" | null = null;
      for (let i = 0; i < 100 && (sleeperStart = startOf(sleeper.pid!)) === null; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(typeof sleeperStart).toBe("string");
      const started = cli(sb, ["daemon", "start", "--json"]);
      expect(started.code, started.stdout + started.stderr).toBe(0);
      const api = control(sb);
      expect((await api("POST", "/handshake", { protocolMajor: 3, client: "canary" })).status).toBe(
        200,
      );
      const thread = (
        await api("POST", "/threads", {
          scope: { kind: "project", root: sb.repo },
          mode: "agent",
          workspace: "isolated",
          primaryHarness: "fake-success",
          eligibleHarnesses: ["fake-success"],
        })
      ).body as { id: string };
      const turn = async (prompt: string) =>
        api("POST", `/threads/${thread.id}/turns`, { prompt, mode: "agent" });
      const finished = async (runId: string) => {
        for (let i = 0; i < 600; i += 1) {
          const detail = await api("GET", `/runs/${runId}`);
          if (
            ["succeeded", "failed", "cancelled", "interrupted"].includes(
              detail.body?.summary?.state,
            )
          )
            return detail.body.summary.state as string;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`run ${runId} did not finish`);
      };
      const first = await turn("first edit");
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(await finished(first.body.runId)).toBe("succeeded");
      const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: sb.repo,
        encoding: "utf8",
      });
      const tree = worktrees
        .split("\n\n")
        .find((block) => block.includes(`branch refs/heads/claudexor/thread-${thread.id}`))!
        .split("\n")[0]!
        .slice("worktree ".length);
      const threads = dirname(dirname(tree));
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: sb.repo,
        encoding: "utf8",
      }).trim();
      const opened = new Date(Date.now() - 60_000).toISOString();
      const heldAt = new Date(Date.now() - 30_000).toISOString();
      const writer = {
        reason: "direct_child_alive",
        groups: [],
        direct_writer_pid: sleeper.pid,
        at: heldAt,
      };

      // A finished checkout whose stop left its writer's pid in use: held.
      const recordPath = join(threads, thread.id, "preparation.json");
      writeFileSync(
        recordPath,
        `${JSON.stringify({ schema: 1, thread_id: thread.id, tree, scope: null, opened_at: opened, complete: true, own_registration: true, own_branch: null, held: writer })}\n`,
      );
      // A purged-like thread directory the thread list does not name, owning a branch.
      const ghost = "ghost-694";
      const ghostDir = join(threads, ghost);
      mkdirSync(join(ghostDir, "tree"), { recursive: true });
      writeFileSync(join(ghostDir, "tree", "half"), "checkout\n");
      execFileSync("git", ["branch", `claudexor/thread-${ghost}`, head], { cwd: sb.repo });
      const ghostRecord = join(ghostDir, "preparation.json");
      writeFileSync(
        ghostRecord,
        `${JSON.stringify({ schema: 1, thread_id: ghost, tree: join(ghostDir, "tree"), scope: null, opened_at: opened, own_registration: false, own_branch: { name: `claudexor/thread-${ghost}`, tip: head }, held: writer })}\n`,
      );
      // A thread directory that is a link to user data outside the runtime tree.
      mkdirSync(join(outside, "victim", "tree"), { recursive: true });
      writeFileSync(join(outside, "victim", "tree", "keep.txt"), "user data\n");
      writeFileSync(
        join(outside, "victim", "preparation.json"),
        `${JSON.stringify({ schema: 1, thread_id: "linked", tree: join(threads, "linked", "tree"), scope: null, opened_at: opened, own_registration: false, own_branch: null, held: writer })}\n`,
      );
      symlinkSync(join(outside, "victim"), join(threads, "linked"));
      const recordBytes = readFileSync(recordPath, "utf8");
      const ghostBytes = readFileSync(ghostRecord, "utf8");

      // Every turn now refuses with what is held, and says only an operator can release it.
      const refused = await turn("edit while held");
      expect(refused.status).not.toBe(200);
      expect(refused.body).toMatchObject({
        code: "termination_unconfirmed",
        context: { release_requires: "operator_confirmation", held: [tree] },
      });
      expect(readFileSync(recordPath, "utf8")).toBe(recordBytes);

      // Inspect: lists both held records (the thread list names neither the ghost nor its
      // record), discloses the link without following it, and changes nothing.
      const listed = cli(sb, ["gc", "preparations", "--json"]);
      expect(listed.code, listed.stdout + listed.stderr).toBe(0);
      const inventory = listed.json() as {
        preparations: Array<Record<string, any>>;
        errors: string[];
      };
      const byThread = Object.fromEntries(
        inventory.preparations.map((item) => [item.thread_id, item]),
      );
      expect(Object.keys(byThread).sort()).toEqual([ghost, thread.id].sort());
      expect(byThread[thread.id]).toMatchObject({
        kind: "thread",
        path: tree,
        release: "operator_confirmation",
        refusal: null,
        stop: { reason: "direct_child_alive" },
        read: { status: "held" },
      });
      expect(inventory.errors.join("\n")).toMatch(/link/);
      expect(readFileSync(recordPath, "utf8")).toBe(recordBytes);
      expect(readFileSync(ghostRecord, "utf8")).toBe(ghostBytes);
      const item = byThread[thread.id]!;
      const ghostItem = byThread[ghost]!;

      // No confirmation, no digest: the CLI refuses before any request; the route refuses
      // a request without the explicit confirmation or without a key.
      for (const argv of [
        ["gc", "release-preparation", item.selector, "--digest", item.digest],
        ["gc", "release-preparation", item.selector, "--confirm-ended"],
      ]) {
        const result = cli(sb, argv);
        expect(result.code).not.toBe(0);
      }
      for (const [body, key] of [
        [{ selector: item.selector, digest: item.digest }, undefined],
        [{ selector: item.selector, digest: item.digest, confirm_processes_ended: true }, null],
      ] as const) {
        expect((await api("POST", "/maintenance/preparations/release", body, key)).status).toBe(
          400,
        );
      }
      // A selector naming `..`, or the link, is refused; the user data stays.
      const crafted = (value: unknown) =>
        `prep1.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
      const dotdot = cli(sb, [
        "gc",
        "release-preparation",
        crafted({ k: "thread", root: sb.repo, id: ".." }),
        "--digest",
        item.digest,
        "--confirm-ended",
      ]);
      expect(dotdot.code).not.toBe(0);
      expect(dotdot.stderr).toMatch(/preparation_selector_invalid/);
      const linked = cli(sb, [
        "gc",
        "release-preparation",
        crafted({ k: "thread", root: sb.repo, id: "linked" }),
        "--digest",
        "0".repeat(64),
        "--confirm-ended",
      ]);
      expect(linked.code).not.toBe(0);
      expect(linked.stderr).toMatch(/preparation_not_plain/);
      expect(readFileSync(join(outside, "victim", "tree", "keep.txt"), "utf8")).toBe("user data\n");
      expect(existsSync(join(outside, "victim", "preparation.json"))).toBe(true);
      // A stale digest: refused, the record unchanged.
      const stale = cli(sb, [
        "gc",
        "release-preparation",
        item.selector,
        "--digest",
        "0".repeat(64),
        "--confirm-ended",
        "--json",
      ]);
      expect(stale.code).toBe(1);
      expect(stale.json()).toMatchObject({ outcome: "stale", basis: null, replayed: false });
      expect(readFileSync(recordPath, "utf8")).toBe(recordBytes);

      // The confirmation cannot be written (the record's directory is read-only):
      // nothing is released (the tree, branch and record stay as they were).
      chmodSync(ghostDir, 0o500);
      try {
        const unwritable = cli(sb, [
          "gc",
          "release-preparation",
          ghostItem.selector,
          "--digest",
          ghostItem.digest,
          "--confirm-ended",
          "--json",
        ]);
        expect(unwritable.code).toBe(1);
        expect(unwritable.json()).toMatchObject({
          outcome: "basis_not_recorded",
          confirmed_at: null,
        });
      } finally {
        chmodSync(ghostDir, 0o700);
      }
      expect(readFileSync(ghostRecord, "utf8")).toBe(ghostBytes);
      expect(readFileSync(join(ghostDir, "tree", "half"), "utf8")).toBe("checkout\n");
      // Confirmed, but Git cannot delete the branch (a held ref lock): a cleanup fault,
      // with the confirmation recorded at the resource.
      const lock = join(sb.repo, ".git", "refs", "heads", "claudexor", `thread-${ghost}.lock`);
      writeFileSync(lock, "");
      const failed = cli(sb, [
        "gc",
        "release-preparation",
        ghostItem.selector,
        "--digest",
        ghostItem.digest,
        "--confirm-ended",
        "--idempotency-key",
        "story-ghost-1",
        "--json",
      ]);
      expect(failed.code).toBe(1);
      expect(failed.json()).toMatchObject({
        outcome: "cleanup_failed",
        basis: "operator_confirmed",
        continued: false,
        confirmed_at: expect.any(String),
        cleanup_error: expect.stringMatching(/could not be deleted/),
      });

      // The thread's own record: released on the inspected digest; the checkout is kept.
      const releaseArgs = [
        "gc",
        "release-preparation",
        item.selector,
        "--digest",
        item.digest,
        "--confirm-ended",
        "--idempotency-key",
        "story-thread-1",
        "--json",
      ];
      const released = cli(sb, releaseArgs);
      expect(released.code, released.stdout + released.stderr).toBe(0);
      const receipt = released.json() as Record<string, any>;
      expect(receipt).toMatchObject({
        outcome: "completed",
        basis: "operator_confirmed",
        replayed: false,
        operation_id: expect.stringMatching(/^delivery-/),
        stop: { reason: "direct_child_alive", at: heldAt },
        writer: { pid: sleeper.pid, outcome: "unknown" },
      });
      expect(released.stderr).toContain("operation key: story-thread-1");
      expect(existsSync(recordPath)).toBe(false);
      expect(readFileSync(join(tree, "README.md"), "utf8")).toBe("# canary fixture\n");
      // Nothing was signalled: the pid's process is the one this test started.
      expect(startOf(sleeper.pid!)).toBe(sleeperStart);
      // The request is a durable delivery command; the first run's facts are untouched.
      const { DatabaseSync } = await import("node:sqlite");
      const rows = () => {
        const store = new DatabaseSync(join(sb.configDir, "daemon", "engine.sqlite"), {
          readOnly: true,
        });
        try {
          return {
            release: store
              .prepare(
                "SELECT operation, state, kind, result_sha IS NOT NULL AS result FROM command WHERE id = ?",
              )
              .get(receipt.operation_id),
            run: store
              .prepare("SELECT state, result_sha, error, finished_at FROM command WHERE run_id = ?")
              .get(first.body.runId),
          };
        } finally {
          store.close();
        }
      };
      const durable = rows();
      expect(durable.release).toEqual({
        operation: "delivery.preparation_release",
        state: "succeeded",
        kind: "delivery",
        result: 1,
      });

      // A daemon restart: the same key answers the recorded receipt (a lost answer is
      // read back, not re-run); a new key finds nothing held, which proves nothing.
      const stopped = cli(sb, ["daemon", "stop", "--json"]);
      expect(stopped.code, stopped.stdout + stopped.stderr).toBe(0);
      expect(cli(sb, ["daemon", "start", "--json"]).code).toBe(0);
      const replay = cli(sb, releaseArgs);
      expect(replay.code).toBe(0);
      expect(replay.json()).toEqual({ ...receipt, replayed: true });
      const again = cli(sb, [
        "gc",
        "release-preparation",
        item.selector,
        "--digest",
        item.digest,
        "--confirm-ended",
        "--json",
      ]);
      expect(again.code).toBe(1);
      expect(again.json()).toMatchObject({
        outcome: "not_held",
        remains: expect.stringMatching(/does not show whether an earlier request released it/),
      });
      expect(rows().run).toEqual(durable.run);

      // After the restart the confirmed ghost is still listed with its confirmation; its
      // cleanup continues (a new inspection, a new request), and finishes once Git can.
      const relisted = (
        cli(sb, ["gc", "preparations", "--json"]).json() as typeof inventory
      ).preparations.find((entry) => entry.thread_id === ghost)!;
      expect(relisted).toMatchObject({
        operator_release: { confirmed_at: expect.any(String) },
        cleanup_error: expect.stringMatching(/could not be deleted/),
      });
      rmSync(lock);
      const continued = cli(sb, [
        "gc",
        "release-preparation",
        relisted.selector,
        "--digest",
        relisted.digest,
        "--confirm-ended",
        "--json",
      ]);
      expect(continued.code, continued.stdout + continued.stderr).toBe(0);
      expect(continued.json()).toMatchObject({ outcome: "released", continued: true });
      expect(existsSync(ghostDir)).toBe(false);
      expect(
        execFileSync("git", ["branch", "--list", `claudexor/thread-${ghost}`], {
          cwd: sb.repo,
          encoding: "utf8",
        }).trim(),
      ).toBe("");

      // The thread's next turn runs in the kept checkout.
      const next = await turn("edit after release");
      expect(next.status, JSON.stringify(next.body)).toBe(200);
      expect(await finished(next.body.runId)).toBe("succeeded");
      expect(readFileSync(join(outside, "victim", "tree", "keep.txt"), "utf8")).toBe("user data\n");
      expect(startOf(sleeper.pid!)).toBe(sleeperStart);
    } finally {
      // Only this test's own child, through its own handle.
      sleeper.kill("SIGKILL");
      sb.dispose();
      rmSync(outside, { recursive: true, force: true });
    }
  }, 240_000);
});
