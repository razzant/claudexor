/**
 * Operational commands: daemon lifecycle, auth status/login hints, and the
 * managed secret store. Thin surfaces — every action delegates to the daemon
 * client, gateway, or SecretStore; --json purity via cli-io.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { controlProblemError } from "@claudexor/control-api";
import {
  DaemonClient,
  awaitDaemonTermination,
  defaultSocketPath,
  ensureDaemonRuntimeRoot,
  logPath,
  readToken,
  rotateToken,
} from "@claudexor/daemon";
import { atRiskNodeAdvisory, harnessRuntimeEnv } from "@claudexor/core";
import {
  ControlGcReceipt,
  ControlHarnessListResponse,
  ControlHarnessModelsResponse,
  ControlHarnessSetupHarness,
  ControlJournalExportReceipt,
  ControlJournalInspection,
  ControlJournalQuarantineReceipt,
  ControlJournalQuarantineRequest,
  ControlJournalValidation,
  ControlSetupJob,
} from "@claudexor/schema";
import { type ParsedArgs, flagBool, flagStr } from "./args.js";
import { profilesCommand, secretsCommand } from "./credential-commands.js";
import {
  authSourceAvailability,
  checksSummary,
  print,
  printCliFailure,
  printJson,
  printUsageError,
  statusGlyph,
} from "./cli-io.js";
import { ensureDaemon, waitForDaemonReady } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";

export function dispatchOpsCommand(
  command: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> | undefined {
  switch (command) {
    case "auth":
      return authCommand(args, json);
    case "daemon":
      return daemonCommand(args, json);
    case "doctor":
      return doctorCommand(args, json);
    case "gc":
      return gcCommand(args, json);
    case "models":
      return modelsCommand(args, json);
    case "recovery":
      return recoveryCommand(args, json);
    case "secrets":
      return secretsCommand(args, json);
    case "profiles":
      return profilesCommand(args, json);
    default:
      return undefined;
  }
}

export async function daemonCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "status";
  if (!["start", "status", "stop", "logs", "rotate-token"].includes(sub)) {
    return printUsageError(json, "usage: claudexor daemon start|status|stop|logs|rotate-token");
  }
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
        const existingReady = await waitForDaemonReady(5_000);
        if (existingReady) {
          if (json)
            printJson({
              pid: null,
              socket: defaultSocketPath(),
              ready: true,
              alreadyRunning: true,
            });
          else print(`claudexord already running; socket ${defaultSocketPath()}`);
          return 0;
        }
        return printCliFailure(
          json,
          "claudexord socket is alive but its control API is not ready; inspect `claudexor daemon logs`",
          {
            category: "operational",
            fallbackCode: "daemon_not_ready",
            context: {
              pid: null,
              socket: defaultSocketPath(),
              ready: false,
              alreadyRunning: true,
            },
          },
        );
      } catch {
        /* not reachable — start a fresh daemon below */
      }
    }
    const daemonScript = fileURLToPath(new URL("./claudexord.js", import.meta.url));
    // Startup stderr goes to the daemon log (append), not the void — a crash
    // before the daemon's own logging starts must leave evidence for
    // `claudexor daemon logs`.
    ensureDaemonRuntimeRoot();
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
    if (!ready) {
      return printCliFailure(
        json,
        "claudexord started but did not become ready within 15s; check `claudexor daemon logs`",
        {
          category: "operational",
          fallbackCode: "daemon_start_timeout",
          context: {
            pid: child.pid ?? null,
            socket: defaultSocketPath(),
            ready: false,
          },
        },
      );
    }
    if (json) printJson({ pid: child.pid ?? null, socket: defaultSocketPath(), ready: true });
    else print(`claudexord ready (pid ${child.pid}); socket ${defaultSocketPath()}`);
    return 0;
  }
  if (sub === "logs") {
    let tail: string;
    try {
      tail = readFileSync(logPath(), "utf8").split("\n").slice(-40).join("\n");
    } catch (err) {
      return printCliFailure(json, err, {
        category: "operational",
        fallbackCode: "daemon_log_unavailable",
        prefix: "no daemon log: ",
        context: {
          logPath: logPath(),
          hint: "the daemon may not have started on this machine yet",
        },
      });
    }
    if (json) printJson({ ok: true, log_tail: tail });
    else print(tail);
    return 0;
  }

  const token = readToken();
  if (!token) {
    return printCliFailure(json, "daemon not initialized — run: claudexor daemon start", {
      category: "operational",
      fallbackCode: "daemon_not_initialized",
    });
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
      // "stop requested" is not "stopped" (W3.5): confirm the daemon's death
      // before reporting success, so scripts and test disposers can trust the
      // exit code instead of racing a still-live process.
      const termination = await awaitDaemonTermination(defaultSocketPath());
      if (termination.outcome === "still_alive") {
        return printCliFailure(json, termination.detail, {
          category: "operational",
          fallbackCode: "daemon_stop_failed",
          prefix: "claudexord stop FAILED: ",
          context: { stopping: true, stopped: false, ...termination },
        });
      }
      if (json) printJson({ ok: true, stopping: true, stopped: true, ...termination });
      else
        print(
          termination.outcome === "killed"
            ? `claudexord stopped (${termination.detail})`
            : "claudexord stopped",
        );
      return 0;
    }
    if (sub === "rotate-token") {
      // Rotating under a LIVE daemon would strand it: the daemon keeps the old
      // in-memory token while stop/status would read the new one from disk.
      try {
        await client.health();
        const err = "daemon is running; stop it first (claudexor daemon stop), then rotate";
        return printCliFailure(json, err, {
          category: "operational",
          fallbackCode: "daemon_token_rotation_blocked",
        });
      } catch {
        /* not reachable — safe to rotate */
      }
      rotateToken();
      const note = "token rotated; it takes effect on the next daemon start";
      if (json) printJson({ ok: true, rotated: true, note });
      else print(note);
      return 0;
    }
  } catch (err) {
    return printCliFailure(json, err, {
      category: "operational",
      fallbackCode: "daemon_unreachable",
      prefix: "claudexord not reachable: ",
      context: { operation: sub },
    });
  }
  return 0;
}

export async function daemonGet(path: string): Promise<unknown> {
  const { addr } = await ensureDaemon();
  const response = await controlApiFetch(addr, path, {
    headers: { Authorization: `Bearer ${addr.token}` },
  });
  const body = await responseBody(response);
  if (!response.ok) throw controlProblemError(response.status, body);
  return body;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function requestedHarnesses(args: ParsedArgs): string[] | undefined {
  const only = flagStr(args, "harness");
  return only
    ? only
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    : undefined;
}

function harnessListPath(args: ParsedArgs, fresh = false): string {
  const query = new URLSearchParams();
  if (fresh) query.set("fresh", "true");
  if (flagBool(args, "all")) query.set("all", "true");
  for (const id of requestedHarnesses(args) ?? []) query.append("harness", id);
  const encoded = query.toString();
  return `/harnesses${encoded ? `?${encoded}` : ""}`;
}

function unknownHarnesses(requested: string[] | undefined, observed: string[]): string[] {
  if (!requested) return [];
  const known = new Set(observed);
  return requested.filter((id) => !known.has(id));
}

export async function doctorCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const response = ControlHarnessListResponse.parse(await daemonGet(harnessListPath(args)));
  const unknown = unknownHarnesses(
    requestedHarnesses(args),
    response.harnesses.map((status) => status.id),
  );
  if (unknown.length > 0) {
    return printUsageError(
      json,
      `claudexor: unknown harness(es): ${unknown.join(", ")} (run \`claudexor harness list --all\`)`,
    );
  }
  const advisory = atRiskNodeAdvisory();
  if (json) {
    printJson({ harnesses: response.harnesses, node_advisory: advisory });
    return 0;
  }
  for (const status of response.harnesses) {
    const version = status.manifest?.version ? ` ${status.manifest.version}` : "";
    print(`${statusGlyph(status.status)} ${status.id}${version}`);
    if (status.enabledIntents.length) print(`    intents: ${status.enabledIntents.join(", ")}`);
    // The doctor-gated availability truth: what this harness can ACTUALLY be
    // routed for right now (empty on degraded/unauth — nothing routes).
    print(
      `    routable: ${status.routableIntents.length ? status.routableIntents.join(", ") : "(none)"}`,
    );
    print(`    auth sources: ${authSourceAvailability(status)}`);
    print(`    checks: ${checksSummary(status)}`);
    if (status.reasons.length) print(`    reasons: ${status.reasons.join(", ")}`);
    if (status.configuredModelCheck?.status === "rejected") {
      print(`    model: INVALID — ${status.configuredModelCheck.message}`);
    }
  }
  if (advisory) print(`advisory: ${advisory}`);
  return 0;
}

/** List the daemon's live model truth for each requested/available harness. */
export async function modelsCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const route = flagStr(args, "route");
  if (route !== undefined && route !== "local_session" && route !== "api_key") {
    return printUsageError(json, "claudexor: --route must be local_session or api_key");
  }
  const statuses = ControlHarnessListResponse.parse(await daemonGet(harnessListPath(args)));
  const requested = requestedHarnesses(args);
  const unknown = unknownHarnesses(
    requested,
    statuses.harnesses.map((status) => status.id),
  );
  if (unknown.length > 0) {
    return printUsageError(
      json,
      `claudexor: unknown harness(es): ${unknown.join(", ")} (run \`claudexor harness list --all\`)`,
    );
  }
  const ids =
    requested ?? statuses.harnesses.filter((s) => s.status !== "unavailable").map((s) => s.id);
  const results = await Promise.all(
    ids.map(async (id) =>
      ControlHarnessModelsResponse.parse(
        await daemonGet(
          `/harnesses/${encodeURIComponent(id)}/models${route ? `?route=${route}` : ""}`,
        ),
      ),
    ),
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
      const routes = m.routes ? ` [routes: ${m.routes.join(", ")}]` : "";
      print(`    ${m.id}${label}${ctx}${routes}`);
    }
  }
  return 0;
}

export async function authCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "status";
  const harness = args._[2];
  if (sub === "status") {
    const queryArgs = harness ? { ...args, flags: { ...args.flags, harness } } : args;
    const statuses = ControlHarnessListResponse.parse(
      await daemonGet(harnessListPath(queryArgs, true)),
    ).harnesses;
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
      return printUsageError(json, "usage: claudexor auth login <codex|claude|cursor>");
    }
    if (!isKnownAuthLoginHarness(harness)) {
      return printUsageError(
        json,
        `claudexor: unknown auth-login harness '${harness}' (expected codex|claude|cursor)`,
      );
    }
    // --browser-redirect (codex only): explicit opt-in for the localhost
    // OAuth flow; the default is device-auth (v3.0.3 S6, safe for sibling
    // OpenAI sessions when completed in an isolated browser context).
    const browserRedirect = args.flags["browser-redirect"] === true;
    if (browserRedirect && harness !== "codex") {
      return printUsageError(json, "claudexor: --browser-redirect applies only to codex login");
    }
    const { addr } = await ensureDaemon();
    const response = await controlApiFetch(addr, "/setup/jobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${addr.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        harness,
        action: "login",
        authRequest: "subscription",
        ...(browserRedirect ? { loginFlow: "browser_redirect" } : {}),
      }),
    });
    if (!response.ok) {
      return printCliFailure(
        json,
        controlProblemError(response.status, await responseBody(response)),
        {
          fallbackCode: "auth_login_start_failed",
          prefix: `could not create durable ${harness} login job: `,
          context: { harness },
        },
      );
    }
    const job = ControlSetupJob.parse(await response.json());
    const accepted = !["failed", "cancelled", "timed_out", "not_supported"].includes(job.state);
    if (json) printJson({ ok: accepted, job });
    else
      print(
        accepted
          ? `${harness} login is managed by claudexord as ${job.jobId}; follow the opened Terminal and setup status.`
          : `${harness} login was not started: ${job.message}`,
      );
    return accepted ? 0 : 1;
  }
  return printUsageError(json, "usage: claudexor auth status|login");
}

export function isKnownAuthLoginHarness(harness: string): boolean {
  return ControlHarnessSetupHarness.safeParse(harness).success;
}

/** Thin client of the daemon-owned retention service (W3.6). */
export async function gcCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const dryRun = flagBool(args, "dry-run") === true;
  const { addr } = await ensureDaemon();
  const response = await controlApiFetch(addr, "/maintenance/gc", {
    method: "POST",
    headers: { Authorization: `Bearer ${addr.token}`, "content-type": "application/json" },
    body: JSON.stringify({ dry_run: dryRun }),
  });
  const body = await responseBody(response);
  if (!response.ok) throw controlProblemError(response.status, body);
  const receipt = ControlGcReceipt.parse(body);
  if (json) {
    printJson(receipt);
    return 0;
  }
  const verb = receipt.dry_run ? "would free" : "freed";
  const mb = (receipt.freed_bytes / (1024 * 1024)).toFixed(1);
  print(
    `${verb} ${mb} MiB: ${receipt.deleted_runs.length} run tree(s), ${receipt.deleted_reviews.length} review tree(s) ` +
      `(examined ${receipt.examined_runs}; kept active=${receipt.kept.active} recent=${receipt.kept.recent} young=${receipt.kept.young} ` +
      `referenced=${receipt.kept.referenced} actionable=${receipt.kept.actionable} unknown=${receipt.kept.unknown_state})`,
  );
  for (const error of receipt.errors) print(`warning: ${error}`);
  return 0;
}

export async function recoveryCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const action = args._[1] ?? "inspect";
  const partition = args._[2];
  if (!partition) {
    return printUsageError(
      json,
      "usage: claudexor recovery inspect|validate|export <partition> | quarantine <partition> <fingerprint> quarantine_and_start_fresh",
    );
  }
  if (!["inspect", "validate", "export", "quarantine"].includes(action)) {
    return printUsageError(json, `unknown recovery action '${action}'`);
  }
  let quarantineRequest: ReturnType<typeof ControlJournalQuarantineRequest.parse> | undefined;
  if (action === "quarantine") {
    try {
      quarantineRequest = ControlJournalQuarantineRequest.parse({
        expectedFingerprint: args._[3],
        confirmation: args._[4],
      });
    } catch (error) {
      return printUsageError(json, error, {
        prefix: "claudexor recovery: ",
        fallbackCode: "invalid_quarantine_request",
      });
    }
  }
  const { addr } = await ensureDaemon();
  const base = `/recovery/partitions/${encodeURIComponent(partition)}`;
  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await controlApiFetch(addr, path, init);
    const body = await responseBody(response);
    if (!response.ok) throw controlProblemError(response.status, body);
    return body;
  };
  let result: unknown;
  if (action === "inspect") {
    result = ControlJournalInspection.parse(await request(base));
  } else if (action === "validate") {
    result = ControlJournalValidation.parse(await request(`${base}/validate`, { method: "POST" }));
  } else if (action === "export") {
    result = ControlJournalExportReceipt.parse(await request(`${base}/export`, { method: "POST" }));
  } else if (action === "quarantine") {
    result = ControlJournalQuarantineReceipt.parse(
      await request(`${base}/quarantine`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(quarantineRequest),
      }),
    );
  }
  if (json) printJson(result);
  else print(JSON.stringify(result, null, 2));
  return 0;
}
