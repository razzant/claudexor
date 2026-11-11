import {
  spawnProcess,
  reapProcessTree,
  WINDOWS_TREE_DEATH_PROOF_UNAVAILABLE,
  type spawnProcess as SpawnProcess,
} from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnChild } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runCodexAppServer } from "./app-server-run.js";

const peer = fileURLToPath(new URL("../fixtures/app-server/cleanup-peer.mjs", import.meta.url));

interface NativeCase {
  cancel?: boolean;
  wrapper?: boolean;
  survivor?: number;
  /** A root systemError the peer writes at stdin EOF before it exits (natural EOF). */
  lateError?: "lf" | "unterminated" | "malformed";
  /** The peer answers with this prompt as it received it. */
  echo?: string;
  /** A descendant inherits stdout, writes a partial frame and holds the pipe past the drain. */
  hold?: boolean;
}

/** drain-holder plan: one benign child frame, then a partial frame after the root exits. */
function holdPlan(dir: string) {
  const at = (name: string) => join(dir, name);
  const plan = {
    identity: at("holder.json"),
    stop: at("stop-holder"),
    afterExit: at("after-exit"),
    held: at("held"),
    written: at("late-written"),
    hold: [
      { method: "thread/status/changed", params: { threadId: "child", status: { type: "idle" } } },
    ],
    frames: [],
    partial: true,
    mode: "quiet",
  };
  writeFileSync(plan.held, "nothing to hold: the LF reader never waits for capacity\n");
  writeFileSync(at("plan.json"), JSON.stringify(plan));
  return { ...plan, path: at("plan.json") };
}

async function nativeCodexEvents(text: string, options: NativeCase = {}): Promise<HarnessEvent[]> {
  const { cancel = false, wrapper = false, survivor, lateError } = options;
  const abort = new AbortController();
  const pids = new Set<number>();
  const observed: HarnessEvent[] = [];
  const dir = options.hold ? mkdtempSync(join(tmpdir(), "cx-native-hold-")) : undefined;
  const plan = dir ? holdPlan(dir) : undefined;
  const holderPid = (): number | undefined =>
    plan && existsSync(plan.identity)
      ? (JSON.parse(readFileSync(plan.identity, "utf8")) as { pid: number }).pid
      : undefined;
  const alive = (pid: number | undefined): boolean => {
    if (pid === undefined) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let observedLateFrame = false;
  let releaseLateFrame!: () => void;
  const lateFrame = new Promise<void>((resolve) => {
    releaseLateFrame = resolve;
  });
  let atExit: { drain?: string; written: boolean } | undefined;
  let releaseDrained!: () => void;
  const drained = new Promise<void>((resolve) => {
    releaseDrained = resolve;
  });
  // Test-only synchronization; real cleanup runs even if the bounded observation fails.
  const observedWithin5s = async (observation: Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        observation,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const spawn: typeof SpawnProcess = async function* (bin, args, spawnOptions) {
    for await (const event of spawnProcess(bin, args, {
      ...spawnOptions,
      // A quiet bound well past the holder's partial write; no group kill before it.
      ...(plan ? { exitDrainMs: 300, exitDrainMaxMs: 10_000, cancelKillDelayMs: 10_000 } : {}),
      ...(survivor === undefined && !lateError && !plan
        ? {}
        : {
            reap: async (opts) => {
              if (plan) {
                // Only after the forced closure ended our read side: stop the
                // holder through its exact stop file, then reap for real.
                await observedWithin5s(drained);
                writeFileSync(plan.stop, "stop only this fixture\n");
                for (const until = Date.now() + 5000; alive(holderPid()) && Date.now() < until;)
                  await new Promise((resolve) => setTimeout(resolve, 20));
                return reapProcessTree(opts);
              }
              // Windows taskkill is synchronous and otherwise wins before stdin
              // EOF can produce the drained frame.
              if (lateError) await observedWithin5s(lateFrame);
              const real = await reapProcessTree(opts);
              if (lateError) {
                if (real.state === "unconfirmed" && real.survivors.length) return real;
                return {
                  state: "unconfirmed",
                  survivors: [],
                  unresolved: [
                    { pgid: opts.rootPid, reason: WINDOWS_TREE_DEATH_PROOF_UNAVAILABLE },
                  ],
                };
              }
              process.kill(survivor!, 0); // positive OS observation of this fixture's retained child
              return { state: "unconfirmed" as const, survivors: [survivor!], unresolved: [] };
            },
          }),
    })) {
      if (event.type === "stderr" && event.line.startsWith("fixture-pid:"))
        pids.add(Number(event.line.slice(12)));
      // Before the yield: the adapter stops iterating at a malformed frame.
      if (lateError && event.type === "stdout" && event.line.includes('"systemError"')) {
        observedLateFrame = true;
        releaseLateFrame();
      }
      if (plan && event.type === "exit") {
        atExit = {
          ...(event.drain ? { drain: event.drain } : {}),
          written: existsSync(plan.written),
        };
        releaseDrained();
      }
      yield event;
    }
  };
  try {
    for await (const event of runCodexAppServer({
      bin: process.execPath,
      args: [
        peer,
        ...(wrapper ? ["--wrapper"] : []),
        ...(cancel ? ["--wait-for-cancel"] : []),
        ...(lateError ? ["--late-system-error"] : []),
        ...(lateError && lateError !== "lf" ? [`--${lateError}`] : []),
        ...(options.echo === undefined ? [] : ["--echo-prompt"]),
      ],
      env: { CX_FIXTURE_ANSWER: text, ...(plan ? { CX_FIXTURE_DRAIN_PLAN: plan.path } : {}) },
      spawn,
      pollIntervalMs: 0,
      spec: {
        ...HarnessRunSpec.parse({
          session_id: "native-cleanup",
          intent: "implement",
          prompt: options.echo ?? "fixture",
          cwd: process.cwd(),
        }),
        extra: { abortSignal: abort.signal },
      },
    })) {
      observed.push(event);
      if (cancel && event.type === "started") abort.abort();
    }
    if (lateError)
      expect(observedLateFrame, "test-only late-frame synchronization reached").toBe(true);
    if (plan) {
      expect(holderPid(), "the inheriting holder started").toBeTypeOf("number");
      // The partial frame reached the pipe before the forced closure dropped it.
      expect(atExit).toEqual({ drain: "truncated", written: true });
    }
    expect(pids.size).toBe(wrapper ? 2 : 1);
    for (const pid of [...pids, ...(plan ? [holderPid()!] : [])])
      expect(() => process.kill(pid, 0), `fixture process ${pid} must be gone`).toThrow();
    return observed;
  } finally {
    // Only exact processes this fixture launched; no name matching or live daemon.
    abort.abort();
    releaseDrained();
    if (plan) writeFileSync(plan.stop, "stop only this fixture\n");
    for (const pid of [...pids, ...(alive(holderPid()) ? [holderPid()!] : [])])
      if (alive(pid)) await reapProcessTree({ rootPid: pid, deadlineMs: 5000 });
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

describe("native process Codex cleanup (no vendor credentials)", () => {
  it.each(["\u2028", "\u2029"])(
    "preserves Unicode JSON content %j over the real pipe",
    async (separator) => {
      const text = "before" + separator + "after";
      const events = await nativeCodexEvents(text);
      expect(events.filter((event) => event.final).map((event) => event.text)).toEqual([text]);
      expect(events.some((event) => event.type === "error")).toBe(false);
    },
    30000,
  );

  it("returns a prompt with literal separators unchanged through both pipe directions", async () => {
    const prompt = "до\u2028середина\u2029после\u0085 😀";
    const events = await nativeCodexEvents("unused", { echo: prompt });
    expect(events.filter((event) => event.final).map((event) => event.text)).toEqual([prompt]);
    expect(events.some((event) => event.type === "error")).toBe(false);
  }, 30000);

  it("rejects a native root error drained during normal shutdown", async () => {
    // Real peer, I/O and reaper; only the known Windows observer outcome is injected.
    const events = await nativeCodexEvents('{"verdict":"PASS"}', { lateError: "lf" });
    expect(events.some((e) => e.final)).toBe(false);
    expect(events.find((e) => e.type === "error")?.payload?.["code"]).toBe("codex_control_loss");
  }, 30000);
  it.each([false, true])(
    "rejects a root error left without its LF at natural EOF through wrapper=%s",
    async (wrapper) => {
      // Natural EOF: every writer, including an inheriting descendant, closed the pipe.
      const events = await nativeCodexEvents('{"verdict":"PASS"}', {
        wrapper,
        lateError: "unterminated",
      });
      expect(events.some((e) => e.final)).toBe(false);
      expect(events.find((e) => e.type === "error")?.payload?.["code"]).toBe("codex_control_loss");
    },
    30000,
  );
  it("fails a malformed final frame at natural EOF", async () => {
    const events = await nativeCodexEvents('{"verdict":"PASS"}', { lateError: "malformed" });
    expect(events.some((e) => e.final)).toBe(false);
    const error = events.find((e) => e.type === "error");
    expect(error?.payload?.["code"]).toBe("codex_app_server_failure");
    expect(error?.error).toMatch(/Invalid Codex app-server frame/);
  }, 30000);
  it("drops a partial frame an inheriting descendant holds past the post-exit drain", async () => {
    // The same kind of unterminated bytes as above, but the pipe never reaches
    // EOF: the bounded drain stops the reader after the completed turn.
    const text = '{"verdict":"PASS"}';
    const events = await nativeCodexEvents(text, { hold: true });
    expect(events.filter((e) => e.final).map((e) => e.text)).toEqual([text]);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)?.payload?.["output_drain"]).toBe("truncated");
  }, 30000);
  it.each([false, true])(
    "preserves ordinary completion through wrapper=%s",
    async (wrapper) => {
      const text = '{"verdict":"FAIL","finding":"controlled fixture"}';
      const events = await nativeCodexEvents(text, { wrapper });
      if (process.env["CX_CLEANUP_BASELINE"] === "1") {
        expect(process.platform).toBe("win32");
        expect(events.some((e) => e.final)).toBe(false);
        expect(events.find((e) => e.type === "error")?.payload?.["code"]).toBe(
          "codex_control_loss",
        );
        expect(events.at(-1)?.payload?.["termination_unconfirmed"]).toBeTruthy();
        return;
      }
      expect(events.filter((e) => e.final).map((e) => e.text)).toEqual([text]);
      expect(events.some((e) => e.type === "error")).toBe(false);
      if (process.platform === "win32")
        expect(events.at(-1)?.payload?.["termination_unconfirmed"]).toBeTruthy();
    },
    30000,
  );
  it("does not turn an externally cancelled native process into a usable answer", async () => {
    const events = await nativeCodexEvents("partial", { cancel: true });
    expect(events.some((e) => e.final)).toBe(false);
    expect(events.at(-1)?.aborted).toBe(true);
  }, 30000);
  it("rejects an observed live survivor through the controlled reap seam", async () => {
    // The survivor is real, but intentionally outside the peer tree. Only the
    // reap outcome is injected; this is not a claim that taskkill failed.
    const child = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const events = await nativeCodexEvents("complete but cleanup failed", {
        survivor: child.pid,
      });
      expect(events.some((e) => e.final)).toBe(false);
      expect(events.find((e) => e.type === "error")?.payload?.["code"]).toBe("codex_control_loss");
      expect(events.at(-1)?.payload?.["termination_unconfirmed"]).toMatchObject({
        survivors: [child.pid],
      });
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  }, 30000);
});
