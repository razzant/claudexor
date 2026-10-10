/**
 * Operational commands: daemon lifecycle, auth status/login hints, and the
 * managed secret store. Thin surfaces — every action delegates to the daemon
 * client, gateway, or SecretStore; --json purity via cli-io.
 */
import { fileURLToPath } from "node:url";
import {
  DaemonClient,
  canonicalDefaultSocketPath,
  awaitDaemonTermination,
  defaultSocketPath,
  inspectDaemonWriterLease,
  logPath,
  readToken,
  rotateToken,
} from "@claudexor/daemon";
import { atRiskNodeAdvisory, harnessRuntimeEnv } from "@claudexor/core";
import { CLAUDEXOR_VERSION, claudexorOwnedRoot } from "@claudexor/util";
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
  GitCapability,
} from "@claudexor/schema";
import { type ParsedArgs, flagBool, flagStr } from "./args.js";
import { GC_LOCKSTEP_REPORTS, gcReceiptNotes } from "./gc-receipt-notes.js";
import { harnessListPath, requestedHarnesses, unknownHarnesses } from "./ops-harness-selection.js";
import { CliError, controlProblemError, renderCliFailure, usageError } from "./cli-error.js";
import { accountsCommand, profilesCommand, secretsCommand } from "./credential-commands.js";
import { CLI_DAEMON_LAUNCH_SOURCES, launchDetachedDaemon } from "./daemon-launch.js";
import { reportDaemonStartReady } from "./daemon-start-report.js";
import { daemonLoopLine, daemonStoreLine } from "./daemon-status-report.js";
import {
  authSourceAvailability,
  checksSummary,
  print,
  printJson,
  printUsageError,
  statusGlyph,
} from "./cli-io.js";
import { authLoginHarnessList, isKnownAuthLoginHarness } from "./auth-login-harnesses.js";
export { authLoginHarnessList, isKnownAuthLoginHarness } from "./auth-login-harnesses.js";
export { stopDaemonForOperator } from "./daemon-run.js";
import {
  DAEMON_START_READY_TIMEOUT_MS,
  ensureDaemon,
  waitForDaemonReady,
  stopDaemonForOperator,
} from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { streamDurableLogin } from "./setup-login-inline.js";
import { terminalLoginFallback } from "./setup-login-fallback.js";
import { readDaemonDiagnosticTail } from "./startup-diagnostics.js";
import {
  assertOperatorDaemonLifecycle,
  daemonOwner,
  managedDaemonUnavailable,
} from "./daemon-owner.js";

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
    case "accounts":
      return accountsCommand(args, json);
    default:
      return undefined;
  }
}

export async function daemonCommand(args: ParsedArgs, json: boolean): Promise<number> {
  daemonOwner();
  const sub = args._[1] ?? "status";
  if (["start", "stop", "rotate-token"].includes(sub)) assertOperatorDaemonLifecycle();
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
          reportDaemonStartReady({
            json,
            socket: defaultSocketPath(),
            servingMode: existingReady.engine.servingMode,
            pid: null,
            alreadyRunning: true,
          });
          return 0;
        }
        if (json)
          printJson({ pid: null, socket: defaultSocketPath(), ready: false, alreadyRunning: true });
        else
          print(
            "claudexord socket is alive but its control API is not ready; inspect `claudexor daemon logs`",
          );
        return 1;
      } catch (err) {
        // Absence starts a fresh daemon below. A TYPED handshake refusal means
        // an incompatible daemon HOLDS the socket — a fresh spawn would only
        // die on the singleton guard, so surface the typed problem (#93).
        if (err instanceof CliError) throw err;
        /* not reachable — start a fresh daemon below */
      }
    }
    const daemonScript =
      process.env["CLAUDEXOR_DAEMON_ENTRY"] ??
      fileURLToPath(new URL("./claudexord.js", import.meta.url));
    let launch;
    try {
      launch = launchDetachedDaemon({
        entryPath: daemonScript,
        launchSource: CLI_DAEMON_LAUNCH_SOURCES.explicitStart,
        env: harnessRuntimeEnv(),
      });
    } catch (error) {
      return renderCliFailure(json, error);
    }
    // Block until the daemon (socket + control API) is actually ready, so a
    // follow-up `status`/run can't race the spawn. Fail loudly (exit 1) if it
    // never comes up.
    let ready;
    try {
      ready = await waitForDaemonReady(DAEMON_START_READY_TIMEOUT_MS, () =>
        launch.failure()
          ? launch.callerError("readiness_wait", DAEMON_START_READY_TIMEOUT_MS)
          : null,
      );
    } catch (error) {
      return renderCliFailure(json, error, {
        extras: { pid: launch.pid, socket: defaultSocketPath(), ready: false },
      });
    }
    if (!ready) {
      return renderCliFailure(
        json,
        launch.callerError("readiness_wait", DAEMON_START_READY_TIMEOUT_MS),
        {
          extras: { pid: launch.pid, socket: defaultSocketPath(), ready: false },
        },
      );
    }
    launch.markReady();
    reportDaemonStartReady({
      json,
      socket: defaultSocketPath(),
      servingMode: ready.engine.servingMode,
      pid: launch.pid,
      alreadyRunning: false,
    });
    return 0;
  }
  if (sub === "logs") {
    let tail: string;
    try {
      tail = readDaemonDiagnosticTail({ path: logPath(), lines: 40 }).text;
    } catch (err) {
      const message = `no daemon log at ${logPath()} (${err instanceof Error ? err.message : String(err)}); the daemon may not have started on this machine yet`;
      return renderCliFailure(json, new Error(message));
    }
    if (json) printJson({ ok: true, log_tail: tail });
    else print(tail);
    return 0;
  }

  const token = readToken();
  if (!token) {
    return renderCliFailure(
      json,
      daemonOwner() === "external"
        ? managedDaemonUnavailable()
        : new Error("daemon not initialized — run: claudexor daemon start"),
    );
  }
  const client = new DaemonClient(
    daemonOwner() === "external" ? canonicalDefaultSocketPath() : defaultSocketPath(),
    token,
  );
  try {
    if (sub === "status") {
      const health = await client.health();
      if (json) printJson(health);
      else
        print(
          `claudexord: ${JSON.stringify(health)}\n${daemonLoopLine(health)}\n${daemonStoreLine(health)}`,
        );
      return 0;
    }
    if (sub === "stop") {
      // "stop requested" is not "stopped" (W3.5): confirm the daemon's death
      // before reporting success, so scripts and test disposers can trust the
      // exit code instead of racing a still-live process.
      const termination = await stopDaemonForOperator(defaultSocketPath(), {
        inspectLease: inspectDaemonWriterLease,
        shutdown: () => client.shutdown(),
        awaitTermination: awaitDaemonTermination,
      });
      if (termination.outcome === "still_alive") {
        // D-7 projector: one failure envelope; the stop-state facts ride as
        // per-command extras (previously a message-less {ok:false,...} straggler).
        return renderCliFailure(json, new Error(`claudexord stop failed: ${termination.detail}`), {
          extras: { stopping: true, stopped: false, ...termination },
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
        return renderCliFailure(
          json,
          new Error("daemon is running; stop it first (claudexor daemon stop), then rotate"),
        );
      } catch {
        /* not reachable — safe to rotate */
      }
      rotateToken();
      const note = "token rotated; it takes effect on the next daemon start";
      if (json) printJson({ ok: true, rotated: true, note });
      else print(note);
      return 0;
    }
    return renderCliFailure(
      json,
      usageError("usage: claudexor daemon start|status|stop|logs|rotate-token"),
    );
  } catch (err) {
    const message = `claudexord not reachable (${err instanceof Error ? err.message : String(err)})`;
    return renderCliFailure(json, new Error(message));
  }
}

export async function daemonGet(path: string): Promise<unknown> {
  const { addr } = await ensureDaemon();
  const response = await controlApiFetch(addr, path, {
    headers: { Authorization: `Bearer ${addr.token}` },
  });
  if (!response.ok) {
    throw new Error(`control API ${path} failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

export async function doctorCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const raw = await daemonGet(harnessListPath(args));
  const response = ControlHarnessListResponse.parse(raw);
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
  // Additive/optional for old-daemon compatibility. Parsing from the raw
  // response preserves omission/null without a second catalog request (and
  // therefore without repeating harness discovery/model probes).
  const parsedGit = GitCapability.nullable()
    .optional()
    .safeParse(
      raw && typeof raw === "object" ? (raw as Record<string, unknown>)["git"] : undefined,
    );
  const git = parsedGit.success ? (parsedGit.data ?? null) : null;
  const advisory = atRiskNodeAdvisory();
  if (json) {
    printJson({ harnesses: response.harnesses, git, node_advisory: advisory });
    return 0;
  }
  print(
    git?.status === "available"
      ? `✓ git${git.version ? ` ${git.version}` : ""}`
      : git
        ? `✗ git: ${git.status}${git.remediation ? ` — ${git.remediation}` : ""}`
        : "? git: readiness unavailable from this engine version",
  );
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
    } else if (status.configuredModelCheck?.message) {
      // An advisory harness admitted a model its list lacks: the human form
      // says so too, not only the JSON readiness row.
      print(`    model: ${status.configuredModel ?? ""} — ${status.configuredModelCheck.message}`);
    }
  }
  if (advisory) print(`advisory: ${advisory}`);
  return 0;
}

/** List the daemon's live model truth for each requested/available harness. */
export async function modelsCommand(args: ParsedArgs, json: boolean): Promise<number> {
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
  const route = flagStr(args, "route");
  if (route !== undefined && route !== "local_session" && route !== "api_key") {
    return printUsageError(json, "claudexor: --route must be local_session or api_key");
  }
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
      const resolved =
        m.resolved_model && m.resolved_model !== m.id ? ` → ${m.resolved_model}` : "";
      const hint = m.origin === "hint" ? " (hint)" : "";
      print(`    ${m.id}${label}${resolved}${ctx}${routes}${hint}`);
    }
  }
  return 0;
}

export interface AuthCommandOptions {
  /** ACP owns the interactive terminal: never detach successfully or open a second terminal. */
  acpTerminal?: boolean;
}

export async function authCommand(
  args: ParsedArgs,
  json: boolean,
  options: AuthCommandOptions = {},
): Promise<number> {
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
      return printUsageError(json, `usage: claudexor auth login <${authLoginHarnessList()}>`);
    }
    if (!isKnownAuthLoginHarness(harness)) {
      return printUsageError(
        json,
        ControlHarnessSetupHarness.safeParse(harness).success
          ? `claudexor: ${harness} has no default account to sign in to — use \`claudexor profiles login ${harness} <profile-id>\``
          : `claudexor: unknown auth-login harness '${harness}' (expected ${authLoginHarnessList()})`,
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
      const detail = await response.text();
      // D-7 projector: canonical envelope; harness + HTTP status ride as extras.
      return renderCliFailure(
        json,
        new Error(`could not create durable ${harness} login job (${response.status}): ${detail}`),
        { extras: { harness, status: response.status } },
      );
    }
    const job = ControlSetupJob.parse(await response.json());
    const accepted = !["failed", "cancelled", "timed_out", "not_supported"].includes(job.state);
    // Daemon-hosted login discloses its interaction in the job snapshot:
    // URL-only, device code, or URL plus one-shot completion input. The explicit
    // legacy browser redirect retains its actual external-terminal handoff.
    if (accepted && job.transport === "daemon" && !browserRedirect) {
      if (!json) print(`${harness} login is managed by claudexord as ${job.jobId}.`);
      return streamDurableLogin(addr, job.jobId, {
        label: harness,
        json,
        resumeCommand: `claudexor auth login ${harness}`,
        ...(options.acpTerminal
          ? { detachExitCode: 130 }
          : harness === "codex"
            ? { fallback: { harness: "codex" as const } }
            : {}),
      });
    }
    if (json) {
      const nextAction = terminalLoginFallback(job);
      printJson({ ok: accepted, job, ...(nextAction ? { nextAction } : {}) });
      return accepted ? 0 : 1;
    }
    print(
      accepted
        ? `${harness} login is managed by claudexord as ${job.jobId}: ${job.message}`
        : `${harness} login was not started: ${job.message}`,
    );
    return accepted ? 0 : 1;
  }
  return printUsageError(json, "usage: claudexor auth status|login");
}

/** Thin client of the daemon-owned retention service (W3.6). */
export async function gcCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const dryRun = flagBool(args, "dry-run") === true;
  const { addr, engine } = await ensureDaemon();
  // Capability negotiation over the handshake's validated engine identity:
  // request the opt-in receipt reports (data-root scan, thread purges)
  // ONLY from a lockstep daemon (same engine version as this CLI). Any skew —
  // older daemon, newer daemon, or a malformed identity — omits the flags, so
  // both sides exchange the exact pre-feature request/receipt shapes and a
  // strict old schema never rejects the receipt of a mutating verb the daemon
  // already executed.
  const lockstep = engine.engineVersion === CLAUDEXOR_VERSION;
  const response = await controlApiFetch(addr, "/maintenance/gc", {
    method: "POST",
    headers: { Authorization: `Bearer ${addr.token}`, "content-type": "application/json" },
    body: JSON.stringify({ dry_run: dryRun, ...(lockstep ? GC_LOCKSTEP_REPORTS : {}) }),
  });
  if (!response.ok) throw new Error(`gc failed (${response.status}): ${await response.text()}`);
  const receipt = ControlGcReceipt.parse(await response.json());
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
  for (const note of gcReceiptNotes(receipt, claudexorOwnedRoot())) print(note);
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
  const { addr } = await ensureDaemon();
  const base = `/recovery/partitions/${encodeURIComponent(partition)}`;
  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await controlApiFetch(addr, path, init);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      // Preserve the typed server problem (code/retryable/fieldErrors/context)
      // through the ONE projector instead of flattening it to a bare string
      // (QA-063): the top-level projector renders the JSON envelope even when
      // the run fails.
      throw controlProblemError(
        response.status,
        body,
        `journal recovery request failed (HTTP ${response.status})`,
      );
    }
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
    const expectedFingerprint = args._[3];
    const confirmation = args._[4];
    const body = ControlJournalQuarantineRequest.parse({ expectedFingerprint, confirmation });
    result = ControlJournalQuarantineReceipt.parse(
      await request(`${base}/quarantine`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  } else {
    return printUsageError(json, `unknown recovery action '${action}'`);
  }
  if (json) printJson(result);
  else print(JSON.stringify(result, null, 2));
  return 0;
}
