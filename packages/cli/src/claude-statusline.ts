import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { QuotaRefreshResult } from "@claudexor/daemon";
import { QuotaSnapshot as QuotaSnapshotSchema, type QuotaSnapshot } from "@claudexor/schema";
import { ensureDir, readJsonSafe, sha256, userConfigDir, writeJson } from "@claudexor/util";

const SOURCE = "claude_statusline" as const;
export const CLAUDE_STATUSLINE_MANAGED_ARG = "managed-v2";

type StatusLine = { type: "command"; command: string; padding?: number };
type StatuslineState = {
  version: 1;
  settings_path: string;
  installed_hash: string;
  has_previous: boolean;
  previous_status_line?: StatusLine;
  updated_at: string;
};

export interface ClaudeStatuslineResultSink {
  changed: boolean;
  actions: string[];
  notes: string[];
  errors: string[];
}

export interface ClaudeStatuslineRuntime {
  home: string;
  configDir: string;
  nodePath: string;
  cliPath: string;
  dryRun: boolean;
}

/** Parse only the vendor-documented subscription windows; discard every other statusline field. */
export function parseClaudeStatuslineQuota(
  value: unknown,
  observedAt = new Date(),
): QuotaSnapshot | null {
  const root = object(value);
  const limits = object(root?.["rate_limits"]);
  if (!limits) return null;
  const constraints = [
    parseWindow(limits["five_hour"], "five_hour", "5 hour", 5 * 60 * 60),
    parseWindow(limits["seven_day"], "seven_day", "7 day", 7 * 24 * 60 * 60),
  ].filter((item) => item !== null);
  if (constraints.length === 0) return null;
  return QuotaSnapshotSchema.parse({
    subject: {
      harness: "claude",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: null,
    },
    constraints,
    source: SOURCE,
    observed_at: observedAt.toISOString(),
    freshness: "fresh",
  });
}

export function ingestClaudeStatuslineQuota(
  value: unknown,
  observedAt = new Date(),
): QuotaSnapshot | null {
  const snapshot = parseClaudeStatuslineQuota(value, observedAt);
  if (!snapshot) return null;
  writeJson(claudeStatuslineSnapshotPath(), snapshot);
  return snapshot;
}

/** Daemon refresher: the spool is Claudexor-owned and contains no raw statusline payload.
 * A secondary source — it never claims typed absences (the oauth-usage source
 * owns the claude subject universe); missing spool stays a plain throw. */
export async function refreshClaudeStatuslineQuota(): Promise<QuotaRefreshResult> {
  const parsed = readJsonSafe(claudeStatuslineSnapshotPath());
  const snapshot = QuotaSnapshotSchema.safeParse(parsed);
  if (!snapshot.success) throw new Error("Claude statusline quota is not available");
  return { snapshots: [snapshot.data] };
}

export async function runClaudeStatuslineCollector(
  rawInput: string,
  upstreamBase64?: string,
): Promise<void> {
  let snapshot: QuotaSnapshot | null = null;
  try {
    snapshot = ingestClaudeStatuslineQuota(JSON.parse(rawInput));
  } catch {
    // Statusline telemetry must never break or replace the user's display command.
  }
  if (upstreamBase64) {
    const upstream = Buffer.from(upstreamBase64, "base64url").toString("utf8");
    if (upstream) await runUpstream(upstream, rawInput);
    return;
  }
  if (snapshot) {
    const summary = snapshot.constraints
      .map((item) => `${item.label}: ${Math.round((item.used_ratio ?? 0) * 100)}%`)
      .join(" · ");
    process.stdout.write(`Claude quota · ${summary}\n`);
  }
}

/** Explicit `plugin install claude` lifecycle; no project settings or credential/session files. */
export function manageClaudeStatusline(
  verb: "install" | "status" | "doctor" | "repair" | "uninstall",
  runtime: ClaudeStatuslineRuntime,
  sink: ClaudeStatuslineResultSink,
): boolean {
  try {
    const settingsPath = join(runtime.home, ".claude", "settings.json");
    const statePath = join(runtime.configDir, "plugins", "claude-statusline.json");
    const settings = readSettings(settingsPath);
    const current = statusLine(settings["statusLine"]);
    const state = readState(statePath);
    if (verb !== "uninstall" && settings["disableAllHooks"] === true) {
      sink.errors.push(
        "Claude disableAllHooks=true disables statusLine; subscription quota remains unavailable",
      );
      return false;
    }

    if (verb === "status" || verb === "doctor") {
      if (!state) {
        sink.notes.push("Claude subscription quota statusline is not installed");
        return false;
      }
      if (
        state.settings_path !== settingsPath ||
        hashStatusLine(current) !== state.installed_hash
      ) {
        sink.errors.push("Claude statusLine changed outside Claudexor; leaving it untouched");
        return false;
      }
      const desired = desiredStatusLine(runtime, statePrevious(state));
      if (hashStatusLine(current) !== hashStatusLine(desired)) {
        sink.notes.push("Claude quota statusline command is drifted");
        return false;
      }
      sink.notes.push("Claude subscription quota source is composed through the user statusLine");
      return true;
    }

    if (verb === "uninstall") {
      if (!state) return true;
      if (
        state.settings_path !== settingsPath ||
        hashStatusLine(current) !== state.installed_hash
      ) {
        sink.errors.push("Claude statusLine changed outside Claudexor; refusing to overwrite it");
        return false;
      }
      if (!runtime.dryRun) {
        if (state.has_previous) settings["statusLine"] = state.previous_status_line;
        else delete settings["statusLine"];
        writeSettings(settingsPath, settings);
        rmSync(statePath, { force: true });
      }
      sink.changed = true;
      sink.actions.push(
        `${runtime.dryRun ? "would restore" : "restored"} the prior Claude statusLine`,
      );
      return true;
    }

    let previous: StatusLine | undefined;
    if (state) {
      if (
        state.settings_path !== settingsPath ||
        hashStatusLine(current) !== state.installed_hash
      ) {
        sink.errors.push("Claude statusLine changed outside Claudexor; refusing to overwrite it");
        return false;
      }
      previous = statePrevious(state);
    } else {
      previous = current;
    }
    const desired = desiredStatusLine(runtime, previous);
    if (hashStatusLine(current) === hashStatusLine(desired)) return true;
    if (!runtime.dryRun) {
      settings["statusLine"] = desired;
      writeSettings(settingsPath, settings);
      writeJson(statePath, {
        version: 1,
        settings_path: settingsPath,
        installed_hash: hashStatusLine(desired),
        has_previous: previous !== undefined,
        ...(previous ? { previous_status_line: previous } : {}),
        updated_at: new Date().toISOString(),
      } satisfies StatuslineState);
    }
    sink.changed = true;
    sink.actions.push(
      `${runtime.dryRun ? "would compose" : "composed"} Claude subscription quota statusline${previous ? " with the existing command" : ""}`,
    );
    return true;
  } catch (error) {
    sink.errors.push(error instanceof Error ? error.message : String(error));
    return false;
  }
}

export function claudeStatuslineSnapshotPath(configDir = userConfigDir()): string {
  return join(configDir, "quota", "claude-statusline.json");
}

function desiredStatusLine(runtime: ClaudeStatuslineRuntime, previous?: StatusLine): StatusLine {
  const encoded = previous ? ` ${Buffer.from(previous.command, "utf8").toString("base64url")}` : "";
  return {
    type: "command",
    command: `${shellQuote(runtime.nodePath)} ${shellQuote(runtime.cliPath)} quota ingest-claude-statusline ${CLAUDE_STATUSLINE_MANAGED_ARG}${encoded}`,
    ...(previous?.padding === undefined ? {} : { padding: previous.padding }),
  };
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${path} is not a regular settings file`);
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} is not a Claude settings JSON object`);
  }
  return value as Record<string, unknown>;
}

function writeSettings(path: string, settings: Record<string, unknown>): void {
  ensureDir(dirname(path));
  writeJson(path, settings);
}

function readState(path: string): StatuslineState | null {
  if (!existsSync(path)) return null;
  const value = readJsonSafe<StatuslineState>(path);
  if (
    !value ||
    value.version !== 1 ||
    typeof value.settings_path !== "string" ||
    typeof value.installed_hash !== "string" ||
    typeof value.has_previous !== "boolean"
  ) {
    throw new Error(`${path} has unsupported Claude statusline state`);
  }
  if (value.has_previous && !statusLine(value.previous_status_line)) {
    throw new Error(`${path} is missing its prior Claude statusLine`);
  }
  return value;
}

function statePrevious(state: StatuslineState): StatusLine | undefined {
  return state.has_previous ? statusLine(state.previous_status_line) : undefined;
}

function statusLine(value: unknown): StatusLine | undefined {
  if (value === undefined) return undefined;
  const item = object(value);
  if (
    !item ||
    item["type"] !== "command" ||
    typeof item["command"] !== "string" ||
    !item["command"].trim() ||
    (item["padding"] !== undefined &&
      (typeof item["padding"] !== "number" || !Number.isFinite(item["padding"])))
  ) {
    throw new Error(
      "Claude statusLine is not a supported command configuration; leaving it untouched",
    );
  }
  return {
    type: "command",
    command: item["command"],
    ...(item["padding"] === undefined ? {} : { padding: item["padding"] as number }),
  };
}

function hashStatusLine(value: StatusLine | undefined): string {
  return sha256(JSON.stringify(value ?? null));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseWindow(
  value: unknown,
  id: string,
  label: string,
  windowSeconds: number,
): QuotaSnapshot["constraints"][number] | null {
  const item = object(value);
  if (!item) return null;
  const used = item["used_percentage"];
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return null;
  const reset = item["resets_at"];
  const resetsAt =
    typeof reset === "number" && Number.isFinite(reset) && reset > 0
      ? new Date(reset * 1000).toISOString()
      : null;
  return {
    id,
    label,
    used_ratio: used / 100,
    window_seconds: windowSeconds,
    resets_at: resetsAt,
    cooldown_until: null,
  };
}

async function runUpstream(command: string, input: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "ignore"] });
    child.stdout.pipe(process.stdout, { end: false });
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
    child.stdin.end(input);
  });
}
