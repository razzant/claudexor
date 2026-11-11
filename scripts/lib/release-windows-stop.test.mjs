import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jobSection, stepBody, stepRunScript } from "./workflow-sections.mjs";

// Executes the assembled Windows smoke's own stop loop, cut from release.yml at
// test time, under PowerShell 7 with a fake `node` and daemon: no real stop.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VERSION = "9.8.7";
const PREPARED_SHA = "0123456789abcdef0123456789abcdef01234567";
const ENTRY = "candidate-closure/claudexord.bundle.cjs";
// GitHub-hosted runners carry pwsh, the release step's shell, so CI must run
// these cases; only a machine without pwsh may skip them.
const pwshRequired = process.env.GITHUB_ACTIONS === "true";
const pwsh = pwshVersion();
// The release loop's own constants, which the expiry case measures.
const STOP_WINDOW_MS = 30_000;
const RETRY_PAUSE_MS = 500;
// Room for the instants between a measured timestamp and the loop's own clock
// reading next to it; far below one pause.
const CLOCK_SLACK_MS = 100;

const stopped = {
  exit: 0,
  stdout: ['{"stopped":true,"outcome":"exited","detail":"daemon exited"}'],
};
const activityUnknown = {
  exit: 1,
  stdout: [
    '{"stopped":false,"code":"runtime_activity_unknown","retryable":true,"detail":"runtime replacement could not prove daemon activity state"}',
  ],
};
const stillAlive = {
  exit: 1,
  stdout: ['{"stopped":false,"outcome":"still_alive","detail":"daemon remains alive"}'],
};

describe("assembled Windows smoke daemon stop loop", () => {
  it("is cut from the exact release step", () => {
    const loop = stopLoop();
    expect(loop).toContain("& node $entry --stop $env:VERSION $env:PREPARED_SHA");
    expect(loop.trimEnd().split("\n").at(-1)).toContain("$daemon.WaitForExit(");
  });

  it("stops at the first clean answer and waits for the daemon to exit", ({ skip }) => {
    requirePwsh(skip);
    expect(runStopLoop([stopped])).toMatchObject({
      attempts: 1,
      argv: [ENTRY, "--stop", VERSION, PREPARED_SHA],
      sleeps: [],
      waits: [15000],
      completed: true,
      error: null,
    });
  });

  it("retries a retryable refusal until the daemon stops", ({ skip }) => {
    requirePwsh(skip);
    expect(runStopLoop([activityUnknown, stopped])).toMatchObject({
      attempts: 2,
      sleeps: [500],
      waits: [15000],
      completed: true,
      error: null,
    });
  });

  it("names an empty answer with the stop command's exit code", ({ skip }) => {
    requirePwsh(skip);
    expect(runStopLoop([{ exit: 1, stdout: [] }])).toMatchObject({
      attempts: 1,
      sleeps: [],
      waits: [],
      completed: false,
      error: "assembled daemon stop answered nothing (exit 1)",
    });
  });

  it("names a whitespace-only answer as empty", ({ skip }) => {
    requirePwsh(skip);
    expect(runStopLoop([{ exit: 0, stdout: ["", " \t "] }])).toMatchObject({
      attempts: 1,
      sleeps: [],
      completed: false,
      error: "assembled daemon stop answered nothing (exit 0)",
    });
  });

  it("refuses a non-JSON answer without retrying", ({ skip }) => {
    requirePwsh(skip);
    const outcome = runStopLoop([{ exit: 1, stdout: ["Error: daemon store is locked"] }]);
    expect(outcome).toMatchObject({ attempts: 1, sleeps: [], waits: [], completed: false });
    expect(outcome.error.trimEnd()).toBe(
      "assembled daemon stop answered no JSON (exit 1): Error: daemon store is locked",
    );
  });

  it("does not retry a terminal refusal", ({ skip }) => {
    requirePwsh(skip);
    expect(runStopLoop([stillAlive])).toMatchObject({
      attempts: 1,
      sleeps: [],
      waits: [],
      completed: false,
      error: `assembled daemon graceful stop failed (exit 1): ${stillAlive.stdout[0]}`,
    });
  });

  it("gives up once retryable refusals outlast the 30 second window", ({ skip }) => {
    requirePwsh(skip);
    const outcome = runStopLoop([activityUnknown]);
    expect(outcome).toMatchObject({
      waits: [],
      completed: false,
      error: `assembled daemon graceful stop failed (exit 1): ${activityUnknown.stdout[0]}`,
    });
    expect(outcome.sleeps.every((milliseconds) => milliseconds === RETRY_PAUSE_MS)).toBe(true);
    expect(outcome.attempts).toBe(outcome.sleeps.length + 1);
    // The loop's clock is real elapsed time plus its virtual pauses. It gave up
    // at a check where that sum had reached the window, after a last retry
    // whose check still found the sum inside it.
    const slept = outcome.sleeps.reduce((sum, milliseconds) => sum + milliseconds, 0);
    expect(slept + outcome.endedAt).toBeGreaterThanOrEqual(STOP_WINDOW_MS);
    expect(slept - RETRY_PAUSE_MS + outcome.sleptAt.at(-1)).toBeLessThan(
      STOP_WINDOW_MS + CLOCK_SLACK_MS,
    );
  });

  it("reports a daemon that outlives a clean stop", ({ skip }) => {
    requirePwsh(skip);
    expect(runStopLoop([stopped], { daemonExits: false })).toMatchObject({
      attempts: 1,
      waits: [15000],
      completed: false,
      error: "assembled daemon remained after graceful stop",
    });
  });
});

function requirePwsh(skip) {
  skip(pwsh === null && !pwshRequired, "pwsh (PowerShell 7) is not on PATH");
  expect(pwsh, "GitHub Actions must provide pwsh to execute the release stop loop").not.toBeNull();
}

function pwshVersion() {
  const probe = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (probe.error?.code === "ENOENT") return null;
  if (probe.error || probe.status !== 0) {
    throw new Error(`pwsh is present but failed: ${probe.error?.message ?? probe.stderr}`);
  }
  return probe.stdout.trim();
}

/** The stop loop, from its deadline through the exit wait, cut from the exact
 * script Actions hands to pwsh for the assembled stop step. */
function stopLoop(
  workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8"),
) {
  const script = stepRunScript(
    stepBody(
      jobSection(workflow, "windows-conpty-candidate-smoke"),
      "Probe, handshake and gracefully stop the assembled daemon closure",
    ),
  );
  const lines = script.split("\n");
  const first = uniqueLine(lines, (line) => line.trimStart().startsWith("$stopDeadline = "));
  const last = uniqueLine(lines, (line) => line.includes("$daemon.WaitForExit("));
  expect(first).toBeLessThan(last);
  return lines.slice(first, last + 1).join("\n");
}

function uniqueLine(lines, predicate) {
  const matches = lines.flatMap((line, index) => (predicate(line) ? [index] : []));
  expect(matches, "stop loop boundary must occur exactly once").toHaveLength(1);
  return matches[0];
}

describe.each([
  ["LF", "\n"],
  ["CRLF", "\r\n"],
])("workflow sections with %s checkout endings", (_name, eol) => {
  const step = "      - name: Stop\n        run: |\n          first\n          second\n";
  const job = `  smoke:\n    steps:\n${step}      - run: unrelated\n`;
  const source = `jobs:\n${job}  other:\n    steps:\n      - run: elsewhere\n`;
  const checkout = (text) => text.replace(/\r?\n/g, eol);

  it("bounds the job before the next job", () => {
    expect(jobSection(checkout(source), "smoke")).toBe(job);
  });

  it("bounds the named step before an unnamed sibling", () => {
    expect(stepBody(checkout(job), "Stop")).toBe(step);
  });

  it("extracts the literal script without its indentation or checkout CR", () => {
    expect(stepRunScript(checkout(step))).toBe("first\nsecond");
  });

  it("extracts the actual release stop loop on either checkout", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
    expect(stopLoop(checkout(workflow))).toBe(stopLoop(checkout(workflow).replace(/\r\n/g, "\n")));
  });
});

const harnessPrelude = [
  '$ErrorActionPreference = "Stop"',
  "$answers = @(Get-Content -LiteralPath $env:CX_STOP_ANSWERS -Raw | ConvertFrom-Json)",
  "$record = [ordered]@{ attempts = 0; argv = @(); sleeps = @(); sleptAt = @(); waits = @(); endedAt = $null; completed = $false; error = $null }",
  "# Each stop attempt gets the next scripted answer; the last answer repeats. A",
  "# loop that never reaches its deadline fails here instead of hanging.",
  "function node {",
  "  $record.attempts += 1",
  '  if ($record.attempts -gt 200) { throw "fake node: the stop loop made 200 attempts without ending" }',
  "  $record.argv = @($args)",
  "  $answer = $answers[[Math]::Min($record.attempts, $answers.Count) - 1]",
  "  $global:LASTEXITCODE = [int]$answer.exit",
  "  foreach ($line in @($answer.stdout)) { $line }",
  "}",
  "# A pause takes no real time: moving the deadline back by each requested pause",
  "# is the same as advancing the clock by it. Real elapsed time is recorded too.",
  "function Start-Sleep([int]$Milliseconds) {",
  "  $record.sleptAt += ([DateTime]::UtcNow - $t0).TotalMilliseconds",
  "  $record.sleeps += $Milliseconds",
  "  $deadline = Get-Variable -Name stopDeadline -Scope 1 -ValueOnly",
  "  Set-Variable -Name stopDeadline -Scope 1 -Value $deadline.AddMilliseconds(-$Milliseconds)",
  "}",
  "$entry = $env:CX_ENTRY",
  "$daemon = [pscustomobject]@{ Id = 4242; HasExited = $false }",
  "$daemon | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {",
  "  param([int]$Milliseconds)",
  "  $record.waits += $Milliseconds",
  '  $env:CX_DAEMON_EXITS -eq "1"',
  "}",
  "$t0 = [DateTime]::UtcNow",
  "try {",
].join("\n");

const harnessEpilogue = [
  "  $record.endedAt = ([DateTime]::UtcNow - $t0).TotalMilliseconds",
  "  $record.completed = $true",
  "} catch {",
  "  $record.endedAt = ([DateTime]::UtcNow - $t0).TotalMilliseconds",
  "  $record.error = $_.Exception.Message",
  "}",
  "[Console]::Out.Write((ConvertTo-Json -InputObject $record -Depth 4 -Compress))",
].join("\n");

function runStopLoop(answers, { daemonExits = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-release-stop-"));
  try {
    const answersPath = join(dir, "answers.json");
    const scriptPath = join(dir, "stop-loop.ps1");
    writeFileSync(answersPath, JSON.stringify(answers));
    writeFileSync(scriptPath, `${harnessPrelude}\n${stopLoop()}\n${harnessEpilogue}\n`);
    const run = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", scriptPath], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        VERSION,
        PREPARED_SHA,
        CX_ENTRY: ENTRY,
        CX_STOP_ANSWERS: answersPath,
        CX_DAEMON_EXITS: daemonExits ? "1" : "0",
      },
    });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
