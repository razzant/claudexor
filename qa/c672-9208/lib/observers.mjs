/** Windows post-failure observers for #672 QA. Prepared once before any
 * iteration; executed only after a watched operation has already failed.
 * Every empty answer is a bounded observation, never proof of no holder. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { sha256File } from "./evidence.mjs";
import { preview } from "./hooks.mjs";

const FRAMEWORK_CSC = [
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
];

function run(binary, args, { env, timeout = 120_000 } = {}) {
  const start = performance.now();
  const r = spawnSync(binary, args, {
    env,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 16 << 20,
  });
  return {
    binary,
    args,
    status: r.status,
    signal: r.signal,
    error: r.error ? String(r.error) : null,
    ms: Math.round(performance.now() - start),
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/** The environment for a Windows PowerShell 5.1 child: every inherited
 * variable except PSModulePath, matched without letter case as Windows does.
 * A PowerShell 7 step hands its module paths to Node; Windows PowerShell
 * started through such an intermediate process keeps them ahead of its own and
 * can fail to autoload shared modules such as Microsoft.PowerShell.Security
 * (Microsoft, about_PSModulePath, "Starting Windows PowerShell from
 * PowerShell 7"). Without the variable it builds its own module path.
 * `source` is never modified. */
export function windowsPowerShellEnv(source = process.env) {
  const env = {};
  const removed = {};
  for (const [name, value] of Object.entries(source))
    if (name.toUpperCase() === "PSMODULEPATH") removed[name] = value;
    else env[name] = value;
  return { env, removed };
}

// Facts the PowerShell child prints about itself as `c672-ps <key>=<value>`
// lines on stderr. They use .NET and core cmdlets only, run before the
// stopping preference or inside try, and never decide the exit code.
const PS_FACTS = ["version", "edition", "PSModulePath", "securityCandidates", "securityModule"];
const psFact = (key, expr) => `[Console]::Error.WriteLine('c672-ps ${key}=' + (${expr}))`;
const securityModules = (listAvailable) =>
  `@(Get-Module ${listAvailable ? "-ListAvailable " : ""}-Name Microsoft.PowerShell.Security -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.Version + ' ' + $_.Path }) -join ' | '`;

/** The known facts from a PowerShell child's stderr, each value bounded. */
export function powershellFacts(stderr) {
  const facts = {};
  for (const line of String(stderr ?? "").split(/\r?\n/)) {
    const m = /^c672-ps ([A-Za-z]+)=(.*)$/.exec(line);
    if (m && PS_FACTS.includes(m[1]) && !(m[1] in facts)) facts[m[1]] = preview(m[2], 2000);
  }
  return facts;
}

/** Compile the read-only observer and fetch Sysinternals handle64 (the only
 * observer here that can name directory handles). Failures are recorded. */
export function prepareObservers({ source, workDir, evidence }) {
  mkdirSync(workDir, { recursive: true });
  const prep = { helper: null, handle: null, gaps: [] };
  const csc = FRAMEWORK_CSC.find((p) => existsSync(p));
  if (!csc)
    prep.gaps.push("no .NET Framework csc.exe: Restart Manager and image census unavailable");
  else {
    const out = join(workDir, "c672obs.exe");
    const r = run(csc, ["/nologo", "/optimize+", "/platform:anycpu", `/out:${out}`, source]);
    evidence.record({
      phase: "observer-compile",
      csc,
      status: r.status,
      ms: r.ms,
      stdout: evidence.raw("csc-stdout", r.stdout),
      stderr: evidence.raw("csc-stderr", r.stderr),
    });
    if (r.status === 0 && existsSync(out)) prep.helper = { path: out, sha256: sha256File(out) };
    else prep.gaps.push("observer compile failed");
  }
  const zip = join(workDir, "Handle.zip");
  const exe = join(workDir, "handle64.exe");
  const ps = [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    [
      psFact("version", "[string]$PSVersionTable.PSVersion"),
      psFact("edition", "[string]$PSVersionTable.PSEdition"),
      psFact("PSModulePath", "[string]$env:PSModulePath"),
      psFact("securityCandidates", securityModules(true)),
      `$ErrorActionPreference='Stop'; Invoke-WebRequest -UseBasicParsing -Uri 'https://download.sysinternals.com/files/Handle.zip' -OutFile '${zip}'; Expand-Archive -LiteralPath '${zip}' -DestinationPath '${workDir}' -Force; $s = Get-AuthenticodeSignature -LiteralPath '${exe}'`,
      `try { ${psFact("securityModule", securityModules(false))} } catch { }`,
      "[pscustomobject]@{ status = [string]$s.Status; subject = $s.SignerCertificate.Subject } | ConvertTo-Json -Compress",
    ].join("; "),
  ];
  const child = windowsPowerShellEnv();
  const h = run("powershell.exe", ps, { env: child.env });
  let signature = null;
  try {
    signature = JSON.parse(h.stdout.trim());
  } catch {
    /* recorded raw below */
  }
  const handle64File = { exists: existsSync(exe) };
  if (handle64File.exists)
    try {
      handle64File.sha256 = sha256File(exe);
    } catch (error) {
      handle64File.error = error.code ?? String(error);
    }
  evidence.record({
    phase: "observer-handle-fetch",
    status: h.status,
    signal: h.signal,
    error: h.error,
    ms: h.ms,
    signature,
    // Removed from this child only, with the value it would have inherited.
    childEnvRemoved: Object.fromEntries(
      Object.entries(child.removed).map(([name, value]) => [name, preview(value, 2000)]),
    ),
    powershell: powershellFacts(h.stderr),
    handle64File,
    stdout: evidence.raw("handle-fetch-stdout", h.stdout),
    stderr: evidence.raw("handle-fetch-stderr", h.stderr),
  });
  if (
    h.status === 0 &&
    existsSync(exe) &&
    signature?.status === "Valid" &&
    /O=Microsoft Corporation/.test(signature?.subject ?? "")
  )
    prep.handle = { path: exe, sha256: sha256File(exe), signer: signature.subject };
  else
    prep.gaps.push(
      "handle64 unavailable or not Microsoft-signed: directory handles cannot be named",
    );
  return prep;
}

function filesBelow(root, limit = 600) {
  const out = [];
  const walk = (d) => {
    let names;
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      if (out.length >= limit) return;
      const p = join(d, n);
      let s;
      try {
        s = lstatSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  return out;
}

/** `ps --since=<FILETIME>` for processes created at or after `epochMs` minus one
 * second (Windows creation times are tick-granular). Null without a start. */
export function sinceArg(epochMs) {
  if (!Number.isFinite(epochMs)) return null;
  const filetime = (BigInt(Math.floor(epochMs) - 1000) + 11644473600000n) * 10000n;
  return `--since=${filetime}`;
}

/**
 * One synchronous look after a failure: Restart Manager for every file below
 * `root`, image census below `roots` (with processes created since
 * `sinceEpochMs` from the same enumeration), and handle64 by path substring.
 * Records when each started relative to the failure clock `failedAtMs`.
 */
export function observeHolders({
  prep,
  root,
  roots,
  failedAtMs,
  listDir,
  label,
  evidence,
  sinceEpochMs = null,
}) {
  const out = {
    label,
    startedAfterFailureMs: Math.round(performance.now() - failedAtMs),
    gaps: [...prep.gaps],
  };
  const files = filesBelow(root);
  out.registeredFiles = files.length;
  if (files.length >= 600) out.gaps.push("file list truncated at 600 for Restart Manager");
  if (prep.helper) {
    mkdirSync(listDir, { recursive: true });
    const list = join(listDir, `${label}-rm-files.txt`);
    writeFileSync(list, files.join("\r\n"), "utf8");
    const rm = run(prep.helper.path, ["rm", `@${list}`]);
    out.rm = {
      ...rm,
      atMs: Math.round(performance.now() - failedAtMs),
      stdout: evidence.raw(`${label}-rm`, rm.stdout),
      stderr: rm.stderr || null,
    };
    try {
      out.rmParsed = JSON.parse(rm.stdout);
    } catch {
      out.gaps.push("Restart Manager output unparsed");
    }
    const since = sinceArg(sinceEpochMs);
    const ps = run(prep.helper.path, ["ps", ...(since ? [since] : []), ...roots]);
    out.ps = {
      ...ps,
      atMs: Math.round(performance.now() - failedAtMs),
      stdout: evidence.raw(`${label}-ps`, ps.stdout),
      stderr: ps.stderr || null,
    };
    try {
      out.psParsed = JSON.parse(ps.stdout);
    } catch {
      out.gaps.push("process census output unparsed");
    }
  }
  if (prep.handle) {
    const h = run(prep.handle.path, ["-accepteula", "-nobanner", "-u", root]);
    out.handle = {
      ...h,
      atMs: Math.round(performance.now() - failedAtMs),
      stdout: evidence.raw(`${label}-handle`, h.stdout),
      stderr: h.stderr || null,
    };
  }
  out.reading =
    "Each list is a later, bounded look. An empty list does not prove that no holder existed at the failure.";
  return out;
}
