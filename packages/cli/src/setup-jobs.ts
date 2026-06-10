import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { daemonDir } from "@claudexor/daemon";
import { appendLine, noProjectRepoRoot, readJsonSafe, redactSecrets } from "@claudexor/util";
import { ControlSetupJob as ControlSetupJobSchema, type ControlSetupJob } from "@claudexor/schema";
import { buildGateway } from "./registry.js";

const NO_PROJECT_ROOT = noProjectRepoRoot();
const SETUP_LOG = join(daemonDir(), "setup.log");

type SetupProfile = {
  guideUrl: string;
  installCommand: string | null;
  loginCommand: string | null;
  note: string;
  installRiskFlags: string[];
};

/**
 * Doctor verification runs IN-PROCESS (buildGateway().statusAll) — never as a
 * `claudexor ...` shell command. The bundled .app daemon has no global
 * `claudexor` binary on PATH, so the previous shell form always exited 127.
 */
const SETUP_PROFILES: Record<string, SetupProfile> = {
  codex: {
    guideUrl: "https://developers.openai.com/codex",
    installCommand: "npm install -g @openai/codex",
    loginCommand: "codex login",
    note: "Codex native login seeds the local CLI session; API-key fallback can be stored as the openai secret ref.",
    installRiskFlags: ["network_download", "global_npm_install"],
  },
  claude: {
    guideUrl: "https://docs.anthropic.com/en/docs/claude-code",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    loginCommand: "claude /login",
    note: "Claude Code native login is preferred; Anthropic API-key fallback can be stored as the anthropic secret ref.",
    installRiskFlags: ["network_download", "global_npm_install"],
  },
  cursor: {
    guideUrl: "https://docs.cursor.com/cli",
    installCommand: "curl https://cursor.com/install -fsS | bash",
    loginCommand: "cursor-agent login",
    note: "Cursor native CLI login is reused when available.",
    installRiskFlags: ["network_download", "shell_pipe", "no_static_sha256", "may_prompt_for_privilege"],
  },
  opencode: {
    guideUrl: "https://opencode.ai/docs",
    installCommand: "curl -fsSL https://opencode.ai/install | bash",
    loginCommand: "opencode auth login",
    note: "OpenCode native auth is reused when available.",
    installRiskFlags: ["network_download", "shell_pipe", "no_static_sha256", "may_prompt_for_privilege"],
  },
  raw: {
    guideUrl: "https://platform.openai.com/docs",
    installCommand: null,
    loginCommand: null,
    note: "Raw API routes use stored secret refs instead of a native CLI login.",
    installRiskFlags: [],
  },
};

/** Honest display label for the in-process doctor phase of a setup job. */
function inProcessDoctorLabel(harness: string): string {
  return harness === "raw" ? "(in-process doctor: all harnesses)" : `(in-process doctor: ${harness})`;
}

export function setupHarness(input: unknown) {
  const p = (input ?? {}) as Record<string, unknown>;
  const harness = typeof p["harness"] === "string" ? p["harness"] : "";
  const action = typeof p["action"] === "string" ? p["action"] : "login";
  const profile = SETUP_PROFILES[harness];
  if (!profile) throw new Error("unknown harness");

  let command: string | null = null;
  let message = profile.note;
  let status: "prepared" | "not_supported" = "prepared";
  if (action === "login") {
    if (profile.loginCommand) {
      command = profile.loginCommand;
      message = `Prepared allowlisted ${harness} native login command. Run it in Terminal, then recheck Harness Doctor.`;
    } else {
      status = "not_supported";
      message = `${harness} has no native login command; store API-key fallback refs in Settings.`;
    }
  } else if (action === "doctor") {
    // Doctor is not a shell command anymore: it runs in-process inside the
    // daemon (see setup jobs). Nothing to copy into a terminal.
    command = null;
    message = `Doctor for ${harness} runs in-process via a setup job or the Harness Doctor screen; no shell command is needed.`;
  } else if (action === "install") {
    if (profile.installCommand) {
      command = profile.installCommand;
      message = `Prepared allowlisted ${harness} install command. Start a setup job to execute it with confirmation and logs.`;
    } else {
      status = "not_supported";
      message = `${harness} has no native installer; store API-key fallback refs in Settings.`;
    }
  } else if (action === "install_guide") {
    message = `Prepared official ${harness} install/login guide URL.`;
  } else {
    throw new Error(`unsupported setup action: ${action}`);
  }

  appendLine(SETUP_LOG, `[${new Date().toISOString()}] setup ${harness} ${action}: ${message}`);
  return {
    harness,
    action,
    status,
    command,
    guideUrl: profile.guideUrl,
    logPath: SETUP_LOG,
    message,
  };
}

const SETUP_JOBS_DIR = join(daemonDir(), "setup-jobs");
const SETUP_JOBS_REGISTRY = join(SETUP_JOBS_DIR, "jobs.json");
/** A hung installer must reach a visible terminal state, not run forever. */
const SETUP_JOB_TIMEOUT_MS = 15 * 60_000;

/** Minimal doctor view the in-process verification needs (gateway statusAll). */
export interface SetupDoctorStatus {
  id: string;
  status: string;
  checks: { id: string; status: string }[];
  reasons?: string[];
}

export interface SetupJobManagerOptions {
  /** Injectable doctor probe (tests); defaults to the real gateway statusAll. */
  statusAll?: () => Promise<SetupDoctorStatus[]>;
  /** Override the doctor phase timeout (tests). */
  doctorTimeoutMs?: number;
}

export function createSetupJobManager(opts: SetupJobManagerOptions = {}) {
  const jobs = new Map<string, ControlSetupJob>();
  const children = new Map<string, ChildProcess>();
  const timeouts = new Map<string, NodeJS.Timeout>();
  const statusAll = opts.statusAll ?? (() => buildGateway({ includeFakes: false }).statusAll({ cwd: NO_PROJECT_ROOT }));

  // Durable registry: a daemon restart must not erase job history. Jobs that
  // were mid-flight when the daemon died are marked failed (honest terminal),
  // except Terminal logins, which legitimately outlive the daemon process.
  mkdirSync(SETUP_JOBS_DIR, { recursive: true, mode: 0o700 });
  const persisted = readJsonSafe<unknown[]>(SETUP_JOBS_REGISTRY);
  if (Array.isArray(persisted)) {
    for (const raw of persisted) {
      const parsed = ControlSetupJobSchema.safeParse(raw);
      if (!parsed.success) continue;
      const job = parsed.data;
      if (job.state === "running" || job.state === "queued") {
        jobs.set(job.jobId, {
          ...job,
          state: "failed",
          finishedAt: new Date().toISOString(),
          message: `${job.harness} ${job.action} job was interrupted by a daemon restart.`,
        });
      } else {
        jobs.set(job.jobId, job);
      }
    }
  }

  const persist = (): void => {
    try {
      writeFileSync(SETUP_JOBS_REGISTRY, JSON.stringify([...jobs.values()], null, 2) + "\n", { mode: 0o600 });
    } catch {
      /* registry persistence is best-effort; state stays authoritative in memory */
    }
  };

  const save = (job: ControlSetupJob): ControlSetupJob => {
    jobs.set(job.jobId, job);
    persist();
    return job;
  };

  const update = (jobId: string, patch: Partial<ControlSetupJob>): ControlSetupJob => {
    const prev = jobs.get(jobId);
    if (!prev) throw Object.assign(new Error("setup job not found"), { status: 404 });
    return save({ ...prev, ...patch });
  };

  const writeJobLog = (job: ControlSetupJob, line: string): void => {
    if (!job.logPath) return;
    appendLine(job.logPath, `[${new Date().toISOString()}] ${redactSecrets(line)}`);
  };

  const noteJobOutput = (jobId: string): void => {
    const current = jobs.get(jobId);
    if (!current || current.state !== "running") return;
    const now = nowForDto();
    update(jobId, {
      firstOutputAt: current.firstOutputAt ?? now,
      lastOutputAt: now,
      message: current.firstOutputAt
        ? `Running allowlisted ${current.harness} ${current.action} job. Latest output at ${now}.`
        : `Running allowlisted ${current.harness} ${current.action} job. First output received.`,
    });
  };

  /**
   * In-process doctor: probes the harness through the SAME gateway code the
   * Harness Doctor screen uses. No shell, no PATH dependency — the bundled
   * .app daemon has no global `claudexor` binary (the old shell form was a
   * guaranteed exit 127).
   */
  const doctorTimeoutMs = opts.doctorTimeoutMs ?? 60_000;
  const runInProcessDoctor = (jobId: string): void => {
    void (async () => {
      const job = jobs.get(jobId);
      if (!job || job.state !== "running") return;
      writeJobLog(job, `doctor: probing ${job.harness} in-process (no shell, no PATH dependency)`);
      try {
        const statuses = await Promise.race([
          statusAll(),
          new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new Error(`doctor timed out after ${doctorTimeoutMs / 1000}s`)), doctorTimeoutMs);
            t.unref();
          }),
        ]);
        noteJobOutput(jobId);
        const targets = job.harness === "raw" ? statuses : statuses.filter((s) => s.id === job.harness);
        if (targets.length === 0) throw new Error(`no doctor report for harness '${job.harness}'`);
        for (const s of targets) {
          const checks = s.checks.map((c) => `${c.id}:${c.status}`).join(", ");
          writeJobLog(job, `doctor ${s.id}: ${s.status}${checks ? ` — ${checks}` : ""}`);
          for (const reason of s.reasons ?? []) writeJobLog(job, `doctor ${s.id}: ${reason}`);
        }
        const ok = targets.every((s) => s.status === "ok");
        const degraded = targets.some((s) => s.status === "degraded");
        const reasons = targets.flatMap((s) => s.reasons ?? []).slice(0, 2).join("; ");
        const message = ok
          ? `${job.harness} doctor passed (in-process).`
          : `${job.harness} doctor reports ${degraded ? "degraded" : "unavailable"}: ${reasons || "see the job log for checks"}`;
        // A cancel may have landed while statusAll() was in flight; a terminal
        // cancelled state must never be overwritten by a late doctor verdict.
        const beforeTerminal = jobs.get(jobId);
        if (!beforeTerminal || beforeTerminal.state !== "running") return;
        const done = update(jobId, { state: ok ? "succeeded" : "failed", finishedAt: nowForDto(), message });
        writeJobLog(done, message);
      } catch (err) {
        const message = `in-process doctor failed: ${err instanceof Error ? err.message : String(err)}`;
        const current = jobs.get(jobId);
        // Same cancel-race guard as the success path: only a still-running
        // job may take a terminal verdict from this async phase.
        if (!current || current.state !== "running") return;
        const failed = update(jobId, { state: "failed", finishedAt: nowForDto(), message });
        writeJobLog(failed, message);
      }
    })();
  };

  const startInProcessDoctorJob = (job: ControlSetupJob): ControlSetupJob => {
    const started = update(job.jobId, {
      state: "running",
      startedAt: nowForDto(),
      message: `Running in-process ${job.harness} doctor.`,
    });
    runInProcessDoctor(job.jobId);
    return started;
  };

  const startShellJob = (job: ControlSetupJob, command: string, onSuccess?: (jobId: string) => void): ControlSetupJob => {
    const started = update(job.jobId, { state: "running", startedAt: nowForDto(), message: `Running allowlisted ${job.harness} ${job.action} job.` });
    writeJobLog(started, `$ ${command}`);
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: NO_PROJECT_ROOT,
      env: setupJobEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.set(job.jobId, child);
    // Watchdog: a wedged install/doctor must surface as a failed terminal state.
    const watchdog = setTimeout(() => {
      const current = jobs.get(job.jobId);
      if (!current || current.state !== "running") return;
      writeJobLog(current, `watchdog: job exceeded ${SETUP_JOB_TIMEOUT_MS / 60000} minutes; terminating`);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      const failed = update(job.jobId, {
        state: "failed",
        finishedAt: nowForDto(),
        message: `${job.harness} ${job.action} job timed out after ${SETUP_JOB_TIMEOUT_MS / 60000} minutes and was terminated.`,
      });
      writeJobLog(failed, failed.message);
    }, SETUP_JOB_TIMEOUT_MS);
    watchdog.unref();
    timeouts.set(job.jobId, watchdog);
    child.stdout.on("data", (chunk) => { noteJobOutput(job.jobId); writeJobLog(jobs.get(job.jobId) ?? started, String(chunk)); });
    child.stderr.on("data", (chunk) => { noteJobOutput(job.jobId); writeJobLog(jobs.get(job.jobId) ?? started, String(chunk)); });
    child.on("error", (err) => {
      children.delete(job.jobId);
      clearTimeout(timeouts.get(job.jobId));
      timeouts.delete(job.jobId);
      const failed = update(job.jobId, { state: "failed", finishedAt: nowForDto(), message: `Setup job failed to start: ${err.message}` });
      writeJobLog(failed, failed.message);
    });
    child.on("exit", (code, signal) => {
      children.delete(job.jobId);
      clearTimeout(timeouts.get(job.jobId));
      timeouts.delete(job.jobId);
      const current = jobs.get(job.jobId);
      if (!current || current.state === "cancelled" || current.state === "failed") return;
      const ok = code === 0;
      if (ok && onSuccess) {
        // The shell phase finished; the job stays running for the in-process
        // doctor phase, which owns the terminal state.
        const phase = update(job.jobId, { message: `${job.harness} ${job.action} shell phase finished; verifying with in-process doctor.` });
        writeJobLog(phase, phase.message);
        onSuccess(job.jobId);
        return;
      }
      const message = ok
        ? `${job.harness} ${job.action} job finished.`
        : `${job.harness} ${job.action} job failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}.`;
      const done = update(job.jobId, { state: ok ? "succeeded" : "failed", finishedAt: nowForDto(), message });
      writeJobLog(done, message);
    });
    return started;
  };

  const startTerminalLoginJob = (job: ControlSetupJob, command: string): ControlSetupJob => {
    const scriptPath = join(SETUP_JOBS_DIR, `${job.jobId}.command`);
    const script = `#!/usr/bin/env bash
set -euo pipefail
${command}
printf '\\nClaudexor setup command finished. Press Return to close this window. '
IFS= read -r _
`;
    writeFileSync(scriptPath, script, { mode: 0o700 });
    chmodSync(scriptPath, 0o700);
    writeJobLog(job, `Terminal script: ${scriptPath}`);
    const child = spawn("/usr/bin/open", ["-a", "Terminal", scriptPath], { detached: true, stdio: "ignore" });
    child.unref();
    const waiting = update(job.jobId, {
      state: "waiting_for_input",
      startedAt: nowForDto(),
      message: `Opened allowlisted ${job.harness} login in Terminal. Complete native auth there, then recheck Harness Doctor.`,
    });
    return waiting;
  };

  return {
    create(input: unknown): ControlSetupJob {
      mkdirSync(SETUP_JOBS_DIR, { recursive: true, mode: 0o700 });
      const p = (input ?? {}) as Record<string, unknown>;
      const harness = typeof p["harness"] === "string" ? p["harness"] : "";
      const action = typeof p["action"] === "string" ? p["action"] : "";
      const profile = SETUP_PROFILES[harness];
      if (!profile) throw new Error("unknown harness");
      if (action !== "install" && action !== "login" && action !== "doctor" && action !== "store_key") throw new Error("unsupported setup job action");

      const jobId = `setup-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const logPath = join(SETUP_JOBS_DIR, `${jobId}.log`);
      // Honest retry accounting: a new job for the same harness+action after a
      // failed one IS the user retrying.
      const priorFailures = [...jobs.values()].filter(
        (j) => j.harness === harness && j.action === action && (j.state === "failed" || j.state === "cancelled"),
      ).length;
      const base: ControlSetupJob = {
        jobId,
        harness: harness as ControlSetupJob["harness"],
        action,
        state: "queued",
        command: null,
        guideUrl: profile.guideUrl,
        logPath,
        message: profile.note,
        riskFlags: action === "install" ? profile.installRiskFlags : [],
        requiresConfirmation: false,
        createdAt: nowForDto(),
        startedAt: null,
        firstOutputAt: null,
        lastOutputAt: null,
        finishedAt: null,
        retryCount: priorFailures,
      };
      writeJobLog(base, `created ${harness} ${action}${priorFailures > 0 ? ` (retry #${priorFailures})` : ""}`);

      if (action === "login") {
        if (!profile.loginCommand) {
          return save({
            ...base,
            state: "not_supported",
            finishedAt: nowForDto(),
            message: `${harness} has no native login command; store API-key fallback refs in Settings.`,
          });
        }
        const job = save({ ...base, command: profile.loginCommand });
        return startTerminalLoginJob(job, job.command ?? "");
      }

      if (action === "doctor") {
        const job = save({ ...base, command: inProcessDoctorLabel(harness) });
        return startInProcessDoctorJob(job);
      }

      if (action === "store_key") {
        // Honest message: this job only verifies via doctor. The key itself is
        // stored by the separate Settings store-secret call, never by this job.
        const job = save({
          ...base,
          command: inProcessDoctorLabel(harness),
          message: `Running post-store doctor for ${harness}. (The key itself is saved via Settings > secrets, not by this job.)`,
        });
        return startInProcessDoctorJob(job);
      }

      if (!profile.installCommand) {
        return save({
          ...base,
          state: "not_supported",
          finishedAt: nowForDto(),
          message: `${harness} has no native installer; use stored API-key fallback refs instead.`,
        });
      }
      return save({
        ...base,
        state: "waiting_for_input",
        command: profile.installCommand,
        requiresConfirmation: true,
        message: `Confirm to run allowlisted ${harness} installer. Risks: ${profile.installRiskFlags.join(", ") || "standard process execution"}.`,
      });
    },

    confirm(input: unknown): ControlSetupJob {
      const p = (input ?? {}) as Record<string, unknown>;
      const jobId = typeof p["jobId"] === "string" ? p["jobId"] : "";
      const confirmed = p["confirmed"] !== false;
      const job = jobs.get(jobId);
      if (!job) throw Object.assign(new Error("setup job not found"), { status: 404 });
      if (!confirmed) return job;
      if (!job.requiresConfirmation || job.action !== "install" || !job.command) {
        throw new Error("setup job does not require confirmation");
      }
      if (job.state !== "waiting_for_input") {
        throw new Error(`setup job cannot be confirmed while ${job.state}`);
      }
      const ready = save({ ...job, requiresConfirmation: false });
      // Shell phase = the native installer only; verification runs in-process.
      return startShellJob(ready, ready.command ?? "", runInProcessDoctor);
    },

    list(): ControlSetupJob[] {
      return [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    status(input: unknown): ControlSetupJob {
      const p = (input ?? {}) as Record<string, unknown>;
      const jobId = typeof p["jobId"] === "string" ? p["jobId"] : "";
      const job = jobs.get(jobId);
      if (!job) throw Object.assign(new Error("setup job not found"), { status: 404 });
      return job;
    },

    cancel(input: unknown): ControlSetupJob {
      const p = (input ?? {}) as Record<string, unknown>;
      const jobId = typeof p["jobId"] === "string" ? p["jobId"] : "";
      const job = jobs.get(jobId);
      if (!job) throw Object.assign(new Error("setup job not found"), { status: 404 });
      const child = children.get(jobId);
      if (child) {
        child.kill("SIGTERM");
        children.delete(jobId);
      }
      clearTimeout(timeouts.get(jobId));
      timeouts.delete(jobId);
      const cancelled = update(jobId, { state: "cancelled", finishedAt: nowForDto(), message: `Cancelled ${job.harness} ${job.action} setup job.` });
      writeJobLog(cancelled, cancelled.message);
      return cancelled;
    },
  };
}

function setupJobEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME ?? "";
  const path = [
    join(home, ".local", "bin"),
    join(home, ".claudexor", "node", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter(Boolean).join(":");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: path,
    SHELL: process.env.SHELL ?? "/bin/bash",
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env;
}

function nowForDto(): string {
  return new Date().toISOString();
}
