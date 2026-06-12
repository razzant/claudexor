import { createInterface } from "node:readline";
import { join } from "node:path";
import { ThreadStore, daemonDir } from "@claudexor/daemon";
import { Orchestrator } from "@claudexor/orchestrator";
import type { ModeKind } from "@claudexor/schema";
import { buildRegistry } from "./registry.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const REPL_HELP = `claudexor REPL — a thread of turns over your harnesses
  <text>            run an agent turn (plan first with /plan if you prefer)
  /ask <q>          read-only answer turn
  /plan <prompt>    read-only planning turn
  /audit [prompt]   read-only audit turn
  /race <prompt>    best-of-2 race turn (cross-family review)
  /orchestrate <g>  brain: typed orchestration plan over the tool belt
  /thread           show the current thread (turns + native sessions)
  /new [title]      start a new thread
  /help             this help
  /quit             exit
Turns RESUME each harness's own native CLI session (plan -> implement is one conversation).`;

interface ReplTurnSpec {
  mode: ModeKind;
  prompt: string;
  race?: boolean;
}

function parseReplLine(line: string): ReplTurnSpec | { command: "thread" | "new" | "help" | "quit"; arg?: string } | null {
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
    case "race":
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

/**
 * Interactive REPL: `claudexor` with no arguments. A thread of turns over the
 * project in the current directory — each turn resumes the routed harness's
 * own native CLI session, so "plan, then continue" is one conversation, not a
 * context reset. Thread state shares the daemon's durable ThreadStore.
 */
export async function runRepl(repoRoot: string): Promise<number> {
  // The REPL runs the engine IN-PROCESS and keeps its own thread store file:
  // ThreadStore has no cross-process locking, so sharing the daemon's
  // threads.json would let two writers clobber each other's conversations.
  // REPL threads are local to the terminal session by design (the daemon/app
  // SSOT stays single-writer).
  const threads = new ThreadStore(join(daemonDir(), "threads-repl.json"));
  let thread = threads.createThread({ title: `repl ${new Date().toISOString().slice(0, 16)}`, repoRoot });
  const orch = new Orchestrator({ registry: buildRegistry() });

  process.stdout.write(`claudexor REPL — thread ${thread.id} on ${repoRoot} (terminal-local thread store)\nType /help for commands.\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "claudexor> " });
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
        thread = threads.createThread({ title: parsed.arg || undefined, repoRoot });
        process.stdout.write(`new thread ${thread.id}\n`);
      }
      if (parsed.command === "thread") {
        const turns = threads.turnsFor(thread.id);
        const sessions = threads.sessionsForThread(thread.id);
        process.stdout.write(`thread ${thread.id} (${thread.title ?? "untitled"})\n`);
        for (const t of turns) process.stdout.write(`  turn ${t.id} run=${t.run_id ?? "-"} :: ${t.prompt.slice(0, 80)}\n`);
        for (const s of sessions) process.stdout.write(`  session ${s.harness_id} native=${s.native_session_id ?? "-"} state=${s.state}\n`);
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
      const res = await orch.run({
        repoRoot,
        prompt: parsed.prompt,
        mode: parsed.mode,
        n: parsed.race ? 2 : undefined,
        threadId: thread.id,
        resumeSessions: threads.resumeMap(thread.id),
        onSessionObserved: (harnessId, nativeSessionId) => threads.recordSession(thread.id, harnessId, nativeSessionId),
        onHarnessEvent: (ev) => {
          if (ev.type === "message" && ev.text) process.stdout.write(ev.text.endsWith("\n") ? ev.text : ev.text + "\n");
          else if (ev.type === "tool_call" && ev.tool) process.stdout.write(`  [tool] ${ev.tool.name}${ev.tool.target ? `: ${ev.tool.target}` : ""}\n`);
          else if (ev.type === "error" && ev.error) process.stdout.write(`  [error] ${ev.error}\n`);
        },
      });
      threads.addTurn(thread.id, res.runId, parsed.prompt);
      process.stdout.write(`\n[turn done] status=${res.status} run=${res.runId}\n${res.summary ? res.summary.split("\n").slice(0, 6).join("\n") + "\n" : ""}`);
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
