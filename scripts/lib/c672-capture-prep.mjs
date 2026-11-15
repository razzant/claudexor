/**
 * #672 TEST-ONLY observer preparation, factored so the actually-invoked path is
 * unit-testable (the PowerShell child env in particular). Windows-specific, but
 * the env/fact helpers are platform-neutral so they run in CI on any host.
 *
 * The qualified pieces are reused verbatim in spirit from the merged QA
 * (git 0eefe54ab:qa/c672-9208/lib/observers.mjs), not re-derived: the
 * case-insensitive PSModulePath removal that stops Windows PowerShell 5.1,
 * started through a PowerShell 7 step, from inheriting PS7 module paths and
 * failing to autoload Microsoft.PowerShell.Security, and the signed-then-hashed
 * handle64 admission.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

/** Bounded preview of a recorded value. */
export function preview(text, n = 2000) {
  if (text == null) return null;
  const s = String(text);
  return s.length > n ? `${s.slice(0, n)}…[+${s.length - n} chars]` : s;
}

export function sha256File(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      hash.update(buffer.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Every inherited variable EXCEPT PSModulePath, matched without letter case as
 * Windows does. `source` is never modified. Returns the child env and, for the
 * evidence record, the removed key/value(s). */
export function windowsPowerShellEnv(source = process.env) {
  const env = {};
  const removed = {};
  for (const [name, value] of Object.entries(source))
    if (name.toUpperCase() === "PSMODULEPATH") removed[name] = value;
    else env[name] = value;
  return { env, removed };
}

const PS_FACTS = ["version", "edition", "PSModulePath", "securityModule"];
const psFact = (key, expr) => `[Console]::Error.WriteLine('c672-ps ${key}=' + (${expr}))`;
const securityModules = () =>
  `@(Get-Module -Name Microsoft.PowerShell.Security -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.Version + ' ' + $_.Path }) -join ' | '`;

/** Short facts the PowerShell child printed about itself on stderr, bounded. */
export function powershellFacts(stderr) {
  const facts = {};
  for (const line of String(stderr ?? "").split(/\r?\n/)) {
    const m = /^c672-ps ([A-Za-z]+)=(.*)$/.exec(line);
    if (m && PS_FACTS.includes(m[1]) && !(m[1] in facts)) facts[m[1]] = preview(m[2], 1000);
  }
  return facts;
}

/** Fetch Sysinternals handle64, admit it only on a Valid Microsoft Authenticode
 * signature, then record its observed digest (re-checked at use, not a fixed
 * published SHA). The child runs with PSModulePath removed so the security
 * module autoloads; the removal and the child's own module facts are returned
 * as evidence. `spawn` is injected so the invoked env is testable. Never
 * throws: every failure is a gap. */
export function fetchHandle64({
  toolsDir,
  zip,
  exe,
  source = process.env,
  spawn,
  timeoutMs = 120_000,
}) {
  const { env, removed } = windowsPowerShellEnv(source);
  const command = [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    [
      psFact("version", "[string]$PSVersionTable.PSVersion"),
      psFact("edition", "[string]$PSVersionTable.PSEdition"),
      psFact("PSModulePath", "[string]$env:PSModulePath"),
      "$ErrorActionPreference='Stop'",
      `Invoke-WebRequest -UseBasicParsing -Uri 'https://download.sysinternals.com/files/Handle.zip' -OutFile '${zip}'`,
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${toolsDir}' -Force`,
      `$s = Get-AuthenticodeSignature -LiteralPath '${exe}'`,
      `try { ${psFact("securityModule", securityModules())} } catch { }`,
      "[pscustomobject]@{ status=[string]$s.Status; subject=$s.SignerCertificate.Subject } | ConvertTo-Json -Compress",
    ].join("; "),
  ];
  const run = spawn("powershell.exe", command, {
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 8 << 20,
  });
  const facts = powershellFacts(run.stderr);
  const removedPsModulePath = Object.fromEntries(
    Object.entries(removed).map(([k, v]) => [k, preview(v, 1000)]),
  );
  let signature = null;
  try {
    signature = JSON.parse(String(run.stdout ?? "").trim());
  } catch {
    /* recorded as a gap below */
  }
  const evidence = {
    facts,
    removedPsModulePath,
    signatureStatus: signature?.status ?? null,
    signer: signature?.subject ?? null,
  };
  const valid =
    run.status === 0 &&
    signature?.status === "Valid" &&
    /O=Microsoft Corporation/.test(signature?.subject ?? "");
  if (!valid)
    return {
      handle: null,
      evidence,
      gap: `handle64 unavailable or not Microsoft-signed (exit ${run.status ?? "none"}, status ${signature?.status ?? "none"}): directory handles cannot be named`,
    };
  return { handle: { path: exe, signer: signature.subject }, evidence, gap: null };
}
