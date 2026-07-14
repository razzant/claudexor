import { createInterface, type Interface } from "node:readline";
import process from "node:process";
import { Orchestrator } from "@claudexor/orchestrator";
import type { ModeKind } from "@claudexor/schema";
import { buildRegistry } from "./registry.js";
import { renderReplHelp } from "./command-registry.js";
import { controlApiFetch, type ControlApiAddress, followRun } from "./live.js";
import { connectDaemonIfRunning, ensureDaemon } from "./daemon-run.js";

/** REPL turn modes that MUTATE the tree. These are ALWAYS daemon-tracked —
 * there is NO in-process fallback for a mutating run (a run no daemon tracks is
 * un-unblockable by the apply gate). Read-only turns (ask/plan/audit, and
 * orchestrate which only plans in the REPL — no --autonomy surface here) may run
 * locally when the daemon cannot be started. */
const MUTATING_REPL_MODES = new Set<ModeKind>(["agent"]);

/** Does this REPL turn mode mutate the tree? (such turns are daemon-only.) */
export function replModeIsMutating(mode: ModeKind): boolean {
  return MUTATING_REPL_MODES.has(mode);
}

// Rendered from the command registry (REPL_COMMANDS) — the same one owner
// as the main CLI help.
const REPL_HELP = renderReplHelp();

interface ReplTurnSpec {
  mode: ModeKind;
  prompt: string;
  race?: boolean;
}

function parseReplLine(
  line: string,
): ReplTurnSpec | { command: "thread" | "new" | "help" | "quit"; arg?: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("/")) return { mode: "agent", prompt: trimmed };
  const [cmd, ...rest] = trimmed.slice(1).split(" ");
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "ask":
      return { mode: "ask", prompt: arg };
    case "plan":
      return { mode: "plan", prompt: arg };
    case "audit":
      return { mode: "audit", prompt: arg };
    case "best-of":
      return { mode: "agent", prompt: arg, race: true };
    case "orchestrate":
      return { mode: "orchestrate", prompt: arg };
    case "thread":
      return { command: "thread" };
    case "new":
      return { command: "new", arg };
    case "help":
      return { command: "help" };
    case "quit":
    case "exit":
      return { command: "quit" };
    default:
      return { command: "help" };
  }
}

/** Daemon control-api reachable right now? (threads SSOT lives there). */
async function daemonAddress(): Promise<ControlApiAddress | null> {
  return (await connectDaemonIfRunning())?.addr ?? null;
}

/**
 * Interactive REPL: `claudexor` with no arguments. A thread of turns over the
 * project in the current directory. The REPL is a THIN CLIENT of the control
 * API — threads live in the daemon SSOT and appear in the macOS app; turns
 * stream live through the same follow pipeline. If no daemon is up we AUTO-START
 * one (the same path `claudexor agent` uses) so mutating turns are daemon-tracked.
 * Only when the daemon cannot be started at all do we fall back to an
 * in-process engine — and that fallback serves READ-ONLY turns only; a mutating
 * (agent) turn there FAILS LOUDLY rather than silently running an in-process
 * Orchestrator that mutates the tree but no daemon tracks (un-unblockable).
 */
export async function runRepl(repoRoot: string): Promise<number> {
  const reachable = await daemonAddress();
  if (reachable) return runDaemonRepl(repoRoot, reachable);
  // No daemon reachable: auto-start it (mutating REPL turns MUST be daemon-tracked).
  try {
    const { addr } = await ensureDaemon();
    return runDaemonRepl(repoRoot, addr);
  } catch (err) {
    process.stdout.write(
      `claudexor: could not start the daemon (${err instanceof Error ? err.message : String(err)}).\n` +
        `Falling back to a local, READ-ONLY REPL — write turns require the daemon and will be refused.\n`,
    );
    return runLocalRepl(repoRoot);
  }
}

async function runDaemonRepl(repoRoot: string, addr: ControlApiAddress): Promise<number> {
  const headers = { Authorization: `Bearer ${addr.token}`, "content-type": "application/json" };
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const res = await controlApiFetch(addr, path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok)
      throw new Error(typeof json?.error === "string" ? json.error : `HTTP ${res.status}`);
    return json;
  };

  // Lazy thread: a bare `claudexor` that the user immediately quits must NOT
  // litter the app with an empty "repl <date>" thread (the v0.9 leak). The
  // thread is created on the first real turn (or an explicit /new), and titled
  // by its first prompt server-side.
  let thread: any = null;
  // A title from `/new [title]` that applies to the next lazily-created thread.
  let pendingTitle: string | undefined;
  const ensureThread = async (title?: string): Promise<any> => {
    if (!thread) {
      const effectiveTitle = title ?? pendingTitle;
      thread = await api("POST", "/threads", {
        ...(effectiveTitle ? { title: effectiveTitle } : {}),
        scope: { kind: "project", root: repoRoot },
      });
      pendingTitle = undefined;
    }
    return thread;
  };
  process.stdout.write(
    `claudexor REPL on ${repoRoot} (daemon-backed; the thread appears in the app on your first message)\nType /help for commands.\n`,
  );
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "claudexor> ",
  });
  rl.prompt();

  for await (const line of rl) {
    const parsed = parseReplLine(line);
    if (!parsed) {
      rl.prompt();
      continue;
    }
    if ("command" in parsed) {
      if (parsed.command === "quit") break;
      if (parsed.command === "help") process.stdout.write(REPL_HELP + "\n");
      if (parsed.command === "new") {
        // Lazy: forget the current thread (and any pending title) so the NEXT
        // message creates a fresh one. Eagerly POSTing here would re-introduce
        // the empty-thread litter `/new` then quit was meant to avoid.
        thread = null;
        pendingTitle = parsed.arg || undefined;
        process.stdout.write(
          pendingTitle
            ? `new thread (will be titled on your first message)\n`
            : "new thread (starts on your next message)\n",
        );
      }
      if (parsed.command === "thread") {
        if (!thread) {
          process.stdout.write("no thread yet — send a message to start one\n");
          rl.prompt();
          continue;
        }
        try {
          const detail = await api("GET", `/threads/${encodeURIComponent(thread.id)}`);
          process.stdout.write(
            `thread ${detail.thread.id} (${detail.thread.title ?? "untitled"})\n`,
          );
          for (const t of detail.turns ?? [])
            process.stdout.write(
              `  turn ${t.id} run=${t.runId ?? "-"} [${t.run?.state ?? "?"}] :: ${String(t.prompt).slice(0, 80)}\n`,
            );
          for (const s of detail.sessions ?? [])
            process.stdout.write(
              `  session ${s.harnessId} native=${s.nativeSessionId ?? "-"} state=${s.state ?? "?"}\n`,
            );
        } catch (err) {
          process.stdout.write(
            `thread fetch failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      rl.prompt();
      continue;
    }
    if (!parsed.prompt) {
      process.stdout.write("(empty prompt)\n");
      rl.prompt();
      continue;
    }
    try {
      const active = await ensureThread();
      const started = await api("POST", `/threads/${encodeURIComponent(active.id)}/turns`, {
        prompt: parsed.prompt,
        mode: parsed.mode,
        ...(parsed.race ? { n: 2 } : {}),
      });
      if (started.runId) {
        // Live-stream the turn through the shared follow pipeline (replay +
        // push + interactive question answering). Pause our readline so the
        // two stdin consumers never fight.
        rl.pause();
        try {
          await followRun(String(started.runId), false);
        } finally {
          rl.resume();
        }
      } else {
        process.stdout.write(`turn queued: ${JSON.stringify(started)}\n`);
      }
    } catch (err) {
      process.stdout.write(`turn failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    rl.prompt();
  }
  rl.close();
  process.stdout.write("bye\n");
  return 0;
}

async function runLocalRepl(repoRoot: string): Promise<number> {
  // No daemon (and it could not be auto-started): in-process engine with
  // EPHEMERAL, in-memory continuity. There is no durable thread store here (the
  // daemon owns the thread journal single-writer); native session ids are kept in
  // memory for this process so plan->continue still resumes within the session,
  // and nothing is persisted/shared. This path is READ-ONLY — mutating
  // (agent) turns are refused, never run in-process and left un-unblockable.
  const orch = new Orchestrator({ registry: buildRegistry() });
  let sessions = new Map<string, string>();
  const localTurns: { runId: string | null; status: string; prompt: string }[] = [];

  process.stdout.write(
    `claudexor REPL on ${repoRoot} (local engine; READ-ONLY ephemeral thread — start the daemon for write turns and to persist/share with the app)\nType /help for commands.\n`,
  );
  const rl: Interface = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "claudexor> ",
  });
  rl.prompt();

  for await (const line of rl) {
    const parsed = parseReplLine(line);
    if (!parsed) {
      rl.prompt();
      continue;
    }
    if ("command" in parsed) {
      if (parsed.command === "quit") break;
      if (parsed.command === "help") process.stdout.write(REPL_HELP + "\n");
      if (parsed.command === "new") {
        sessions = new Map();
        localTurns.length = 0;
        process.stdout.write("new ephemeral thread\n");
      }
      if (parsed.command === "thread") {
        process.stdout.write(`ephemeral thread — ${localTurns.length} turn(s)\n`);
        for (const t of localTurns)
          process.stdout.write(
            `  run=${t.runId ?? "-"} [${t.status}] :: ${t.prompt.slice(0, 80)}\n`,
          );
        for (const [harnessId, nativeId] of sessions)
          process.stdout.write(`  session ${harnessId} native=${nativeId}\n`);
      }
      rl.prompt();
      continue;
    }
    if (!parsed.prompt) {
      process.stdout.write("(empty prompt)\n");
      rl.prompt();
      continue;
    }
    // a mutating turn must be daemon-tracked. The local engine cannot
    // produce an applicable/unblockable run, so refuse it loudly here instead of
    // silently mutating the tree with a run no daemon owns.
    if (replModeIsMutating(parsed.mode)) {
      process.stdout.write(
        "write turns require the daemon (start it with `claudexor daemon start`, then retry); this local REPL serves read-only turns (/ask, /plan, /audit, /orchestrate) only\n",
      );
      rl.prompt();
      continue;
    }
    try {
      const res = await orch.run({
        repoRoot,
        prompt: parsed.prompt,
        mode: parsed.mode,
        n: parsed.race ? 2 : undefined,
        resumeSessions: Object.fromEntries(sessions),
        onSessionObserved: (harnessId, nativeSessionId) => sessions.set(harnessId, nativeSessionId),
        onHarnessEvent: (ev) => {
          if (ev.type === "message" && ev.text)
            process.stdout.write(ev.text.endsWith("\n") ? ev.text : ev.text + "\n");
          else if (ev.type === "tool_call" && ev.tool)
            process.stdout.write(
              `  [tool] ${ev.tool.name}${ev.tool.target ? `: ${ev.tool.target}` : ""}\n`,
            );
          else if (ev.type === "error" && ev.error) process.stdout.write(`  [error] ${ev.error}\n`);
        },
      });
      localTurns.push({ runId: res.runId, status: res.status, prompt: parsed.prompt });
      process.stdout.write(
        `\n[turn done] status=${res.status} run=${res.runId}\n${res.summary ? res.summary.split("\n").slice(0, 6).join("\n") + "\n" : ""}`,
      );
    } catch (err) {
      process.stdout.write(`turn failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    rl.prompt();
  }
  rl.close();
  process.stdout.write("bye\n");
  return 0;
}

export { parseReplLine };
