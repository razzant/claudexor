/**
 * Operational commands: daemon lifecycle, auth status/login hints, and the
 * managed secret store. Thin surfaces — every action delegates to the daemon
 * client, gateway, or SecretStore; --json purity via cli-io.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient, defaultSocketPath, logPath, readToken, rotateToken } from "@claudexor/daemon";
import { harnessRuntimeEnv } from "@claudexor/core";
import { MANAGED_SECRET_NAMES, SecretStore, type SecretBackend, isManagedSecretName } from "@claudexor/secrets";
import { type ParsedArgs, flagBool, flagStr } from "./args.js";
import { authSourceAvailability, checksSummary, print, printJson, printUsageError, statusGlyph } from "./cli-io.js";
import { buildGateway, buildRegistry, harnessModels } from "./registry.js";
import { nativeLoginCommand } from "./setup-jobs.js";
import { waitForDaemonReady } from "./daemon-run.js";

export async function daemonCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "status";
  if (sub === "start") {
    // Probe FIRST: with a live daemon the spawned child dies on the singleton
    // guard while readiness connects to the OLD daemon — reporting the DEAD
    // child's pid (the duplicate-start pid lie). "Already running" holds the
    // SAME readiness bar as a fresh start (socket health AND control API),
    // so a socket-alive daemon with a dead control API is not reported ready.
    const existingToken = readToken();
    if (existingToken) {
      try {
        await new DaemonClient(defaultSocketPath(), existingToken).health();
        // Same bar as a fresh start; shorter window is fine — an ALREADY
        // healthy daemon answers immediately (a fresh start waits out boot).
        const existingReady = await waitForDaemonReady(5_000);
        if (existingReady) {
          if (json) printJson({ pid: null, socket: defaultSocketPath(), ready: true, alreadyRunning: true });
          else print(`claudexord already running; socket ${defaultSocketPath()}`);
          return 0;
        }
        // Socket answers but the control API never came up — fall through and
        // report the honest failure the same way a fresh start would.
        if (json) printJson({ pid: null, socket: defaultSocketPath(), ready: false, alreadyRunning: true });
        else print("claudexord socket is alive but its control API is not ready; inspect `claudexor daemon logs`");
        return 1;
      } catch {
        /* not reachable — start a fresh daemon below */
      }
    }
    const daemonScript = fileURLToPath(new URL("./claudexord.js", import.meta.url));
    // Startup stderr goes to the daemon log (append), not the void — a crash
    // before the daemon's own logging starts must leave evidence for
    // `claudexor daemon logs`.
    mkdirSync(dirname(logPath()), { recursive: true });
    const stderrFd = openSync(logPath(), "a");
    const child = spawn(process.execPath, [daemonScript], {
      detached: true,
      stdio: ["ignore", "ignore", stderrFd],
      env: harnessRuntimeEnv(),
    });
    child.unref();
    closeSync(stderrFd);
    // Block until the daemon (socket + control API) is actually ready, so a
    // follow-up `status`/run can't race the spawn. Fail loudly (exit 1) if it
    // never comes up.
    const ready = await waitForDaemonReady(15_000);
    if (json) {
      printJson({ pid: child.pid ?? null, socket: defaultSocketPath(), ready: ready !== null });
    } else if (ready) {
      print(`claudexord ready (pid ${child.pid}); socket ${defaultSocketPath()}`);
    } else {
      print(
        `claudexord started (pid ${child.pid}) but did not become ready within 15s; check \`claudexor daemon logs\``,
      );
    }
    return ready ? 0 : 1;
  }
  const token = readToken();
  if (!token) {
    // --json purity: exactly one JSON object on stdout in json mode.
    if (json) printJson({ ok: false, error: "daemon not initialized — run: claudexor daemon start" });
    else print("daemon not initialized — run: claudexor daemon start");
    return 1;
  }
  const client = new DaemonClient(defaultSocketPath(), token);
  try {
    if (sub === "status") {
      const health = await client.health();
      if (json) printJson(health);
      else print(`claudexord: ${JSON.stringify(health)}`);
      return 0;
    }
    if (sub === "stop") {
      await client.shutdown();
      if (json) printJson({ ok: true, stopping: true });
      else print("claudexord shutting down");
      return 0;
    }
    if (sub === "logs") {
      // A missing/unreadable log FILE is not a daemon-reachability problem —
      // report it as what it is instead of the catch-all "not reachable".
      let tail: string;
      try {
        tail = readFileSync(logPath(), "utf8").split("\n").slice(-40).join("\n");
      } catch (err) {
        const message = `no daemon log at ${logPath()} (${err instanceof Error ? err.message : String(err)}); the daemon may not have started on this machine yet`;
        if (json) printJson({ ok: false, error: message });
        else process.stderr.write(`${message}\n`);
        return 1;
      }
      if (json) printJson({ ok: true, log_tail: tail });
      else print(tail);
      return 0;
    }
    if (sub === "rotate-token") {
      // Rotating under a LIVE daemon would strand it: the daemon keeps the old
      // in-memory token while stop/status would read the new one from disk.
      try {
        await client.health();
        const err = "daemon is running; stop it first (claudexor daemon stop), then rotate";
        if (json) printJson({ ok: false, error: err });
        else process.stderr.write(`${err}\n`);
        return 1;
      } catch {
        /* not reachable — safe to rotate */
      }
      rotateToken();
      const note = "token rotated; it takes effect on the next daemon start";
      if (json) printJson({ ok: true, rotated: true, note });
      else print(note);
      return 0;
    }
    if (json) printJson({ ok: false, exitCode: 2, error: "usage: claudexor daemon start|status|stop|logs|rotate-token" });
    else print("usage: claudexor daemon start|status|stop|logs|rotate-token");
    return 2;
  } catch (err) {
    const message = `claudexord not reachable (${err instanceof Error ? err.message : String(err)})`;
    if (json) printJson({ ok: false, error: message });
    else print(message);
    return 1;
  }
}


/**
 * The real CONSUMER (ADP4) of the adapter models() producer: list a harness's
 * enumerable models. With --harness it queries that one; otherwise it tries
 * every non-unavailable harness and shows which can honestly enumerate.
 */
export async function modelsCommand(args: ParsedArgs, json: boolean): Promise<number> {
  // `--all` includes fakes (they honestly report source:"none"); honoring it here
  // mirrors doctor/auth/harness-list instead of silently ignoring the flag (P15).
  const includeFakes = flagBool(args, "all");
  const only = flagStr(args, "harness");
  let ids: string[];
  if (only) {
    ids = only
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // An explicit --harness typo fails loudly (consistent with doctor/auth), not a
    // silent source:"none" exit 0.
    const known = new Set(buildRegistry({ includeFakes: true }).keys());
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length)
      return printUsageError(
        json,
        `claudexor: unknown harness(es): ${unknown.join(", ")} (run \`claudexor harness list --all\`)`,
      );
  } else {
    // Default to harnesses that doctor considers usable (not unavailable);
    // each harnessModels() reports source "none" when it cannot enumerate.
    const statuses = await buildGateway({ includeFakes }).statusAll({ cwd: process.cwd() });
    ids = statuses.filter((s) => s.status !== "unavailable").map((s) => s.id);
  }
  const results = await Promise.all(
    ids.map((id) => harnessModels(id, process.cwd(), includeFakes)),
  );
  if (json) {
    printJson({ harnesses: results });
    return 0;
  }
  for (const r of results) {
    if (r.source === "none") {
      print(`${r.harnessId}: no model enumeration (adapter cannot list models)`);
      continue;
    }
    print(`${r.harnessId}: ${r.models.length} model(s) [source=${r.source}]`);
    for (const m of r.models) {
      const ctx = m.context_window ? ` (${m.context_window} ctx)` : "";
      const label = m.label && m.label !== m.id ? ` — ${m.label}` : "";
      print(`    ${m.id}${label}${ctx}`);
    }
  }
  return 0;
}

export async function authCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "status";
  const harness = args._[2];
  if (sub === "status") {
    const gateway = buildGateway({ includeFakes: flagBool(args, "all") });
    // Scope discovery to the requested harness (P14) instead of probe-all-then-filter.
    const statuses = await gateway.statusAll(
      { cwd: process.cwd() },
      harness ? [harness] : undefined,
    );
    // An explicit unknown harness must FAIL LOUDLY, not silently succeed over empty.
    if (harness && !statuses.some((s) => s.id === harness)) {
      return printUsageError(
        json,
        `claudexor: unknown harness '${harness}' (run \`claudexor harness list --all\`)`,
      );
    }
    const filtered = statuses;
    if (json) {
      printJson({ harnesses: filtered });
      return 0;
    }
    for (const s of filtered) {
      print(
        `${statusGlyph(s.status)} ${s.id} ready=${s.status} sources=${authSourceAvailability(s)}`,
      );
      print(`    checks: ${checksSummary(s)}`);
      if (s.reasons.length) print(`    reasons: ${s.reasons.join(", ")}`);
    }
    return 0;
  }
  if (sub === "login") {
    if (!harness) {
      return printUsageError(json, "usage: claudexor auth login <codex|claude|cursor|opencode>");
    }
    // On a real terminal, RUN the native login flow instead of only hinting at
    // it: inherited stdio hands the TTY to the vendor CLI (device-code /
    // browser prompts work), and its exit code is the verb's exit code.
    // Non-TTY and --json callers keep the hint (no interactive flow to run).
    const native = nativeLoginCommand(harness);
    if (!json && process.stdin.isTTY && native) {
      print(`launching native login: ${native}`);
      return await new Promise<number>((resolve) => {
        const child = spawn("sh", ["-c", native], { stdio: "inherit", env: harnessRuntimeEnv() });
        child.on("error", (err) => {
          print(`could not launch native login (${err.message}); run it yourself: ${native}`);
          resolve(1);
        });
        child.on("exit", (code) => resolve(code ?? 1));
      });
    }
    const hints: Record<string, string> = {
      codex:
        "Run the native Codex login flow, or store an API key ref with: claudexor secrets set openai --from-env OPENAI_API_KEY",
      claude:
        "Run the native Claude Code login flow, or store an API key ref with: claudexor secrets set anthropic --from-env ANTHROPIC_API_KEY",
      cursor: "Sign in through Cursor, then let Claudexor mirror the native session.",
      opencode: "Run the native OpenCode auth flow, or store the provider key as a secret ref.",
    };
    const hint =
      hints[harness] ?? `Run the native ${harness} auth flow, then retry: claudexor auth status ${harness}`;
    if (json) printJson({ ok: true, harness, hint });
    else print(hint);
    return 0;
  }
  return printUsageError(json, "usage: claudexor auth status|login");
}

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function secretsCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "list";
  // `--backend file` (or env CLAUDEXOR_SECRETS_BACKEND=file) keeps secret I/O in
  // the 0600 file store — sandbox/CI safe (never touches the real login Keychain).
  const backendFlag = flagStr(args, "backend");
  if (
    backendFlag !== undefined &&
    backendFlag !== "auto" &&
    backendFlag !== "keychain" &&
    backendFlag !== "file"
  ) {
    return printUsageError(json, "--backend must be auto|keychain|file");
  }
  let store: SecretStore;
  try {
    store = new SecretStore((backendFlag as SecretBackend | undefined) ?? "auto");
    // Surface an invalid CLAUDEXOR_SECRETS_BACKEND now, honoring --json, instead of
    // letting the throw escape to the plain-text top-level catch.
    store.resolvedBackend();
  } catch (err) {
    const msg = `claudexor secrets: ${err instanceof Error ? err.message : String(err)}`;
    if (json) printJson({ error: msg });
    else process.stderr.write(`${msg}\n`);
    return 1;
  }
  if (sub === "list") {
    const secrets = store.list();
    if (json) printJson({ backend: store.resolvedBackend(), secrets });
    else {
      if (secrets.length === 0) print(`no stored secrets (${store.resolvedBackend()})`);
      for (const s of secrets) print(`${s.name} [${s.backend}]`);
    }
    return 0;
  }
  if (sub === "set") {
    const name = args._[2];
    if (!name) {
      return printUsageError(json, "usage: claudexor secrets set <name> --from-env <ENV_VAR>  # or pipe value on stdin");
    }
    if (!isManagedSecretName(name)) {
      return printUsageError(json, `secret name must be one of: ${MANAGED_SECRET_NAMES.join(", ")}`);
    }
    const envVar = flagStr(args, "from-env");
    const value = envVar ? process.env[envVar] : process.stdin.isTTY ? "" : await stdinText();
    if (!value) {
      return printUsageError(
        json,
        "secret value required via --from-env or stdin; values are not accepted as positional args",
      );
    }
    const backend = store.set(name, value);
    const warning = store.lastFallbackReason;
    if (json) printJson({ name, backend, stored: true, ...(warning ? { warning } : {}) });
    else {
      print(`stored ${name} in ${backend}`);
      if (warning) print(`warning: ${warning}`);
    }
    return 0;
  }
  if (sub === "delete" || sub === "rm") {
    const name = args._[2];
    if (!name) {
      return printUsageError(json, "usage: claudexor secrets delete <name>");
    }
    if (!isManagedSecretName(name)) {
      return printUsageError(json, `secret name must be one of: ${MANAGED_SECRET_NAMES.join(", ")}`);
    }
    store.delete(name);
    if (json) printJson({ name, deleted: true });
    else print(`deleted ${name}`);
    return 0;
  }
  return printUsageError(json, "usage: claudexor secrets list|set|delete");
}
