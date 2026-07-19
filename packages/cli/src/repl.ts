import { createInterface } from "node:readline";
import process from "node:process";
import type { ModeKind } from "@claudexor/schema";
import { renderReplHelp } from "./command-registry.js";
import { controlApiFetch, type ControlApiAddress, followRun } from "./live.js";
import { ensureDaemon } from "./daemon-run.js";

// Rendered from the command registry (REPL_COMMANDS) — the same one owner
// as the main CLI help.
const REPL_HELP = renderReplHelp();

interface ReplTurnSpec {
  mode: ModeKind;
  prompt: string;
  race?: boolean;
}

type ReplCommand = {
  command: "thread" | "new" | "help" | "quit" | "harness" | "profile";
  arg?: string;
};

function parseReplLine(line: string): ReplTurnSpec | ReplCommand | null {
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
    case "best-of":
      return { mode: "agent", prompt: arg, race: true };
    case "thread":
      return { command: "thread" };
    case "new":
      return { command: "new", arg };
    case "harness":
      return { command: "harness", arg };
    case "profile":
      return { command: "profile", arg };
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
 * project in the current directory. The REPL is a THIN CLIENT of the control
 * API — threads live in the daemon SSOT and appear in the macOS app; turns
 * stream live through the same follow pipeline. If no daemon is up, the CLI
 * starts the managed daemon; startup failure is surfaced instead of creating a
 * second in-process thread/run authority.
 */
export async function runRepl(repoRoot: string): Promise<number> {
  try {
    const { addr } = await ensureDaemon();
    return runDaemonRepl(repoRoot, addr);
  } catch (err) {
    process.stderr.write(
      `claudexor: could not start the daemon (${err instanceof Error ? err.message : String(err)})\n`,
    );
    return 1;
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
      if (parsed.command === "harness" || parsed.command === "profile") {
        // Sticky lane preference: PATCH the thread through the SAME server route
        // the app composer uses (never a REPL-only path). `/harness <id>` sets
        // the sticky primary; `/profile <id|default>` sets the sticky credential
        // profile (`default` => null, back to the engine ladder). A bare command
        // with no id clears the preference (null).
        const raw = parsed.arg ?? "";
        const clear = raw === "" || (parsed.command === "profile" && raw === "default");
        const body =
          parsed.command === "harness"
            ? { primaryHarness: clear ? null : raw }
            : { credentialProfileId: clear ? null : raw };
        try {
          const active = await ensureThread();
          await api("PATCH", `/threads/${encodeURIComponent(active.id)}`, body);
          const label = parsed.command === "harness" ? "primary harness" : "credential profile";
          process.stdout.write(
            clear
              ? `sticky ${label} cleared (back to engine routing)\n`
              : `sticky ${label} set to ${raw}\n`,
          );
        } catch (err) {
          process.stdout.write(
            `${parsed.command} failed: ${err instanceof Error ? err.message : String(err)}\n`,
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

export { parseReplLine };
