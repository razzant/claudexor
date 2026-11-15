#!/usr/bin/env node
/**
 * #672 TEST-ONLY: prepare the read-only rename-failure observers BEFORE the
 * Windows vendor-program smoke, in a separate process from the CLI being
 * studied. Downloading or compiling after the failure is too late, so this runs
 * first and leaves a tools manifest the capture preload reads only on a failure.
 *
 * It compiles `c672obs.cs` with the .NET Framework csc already on the runner
 * (Restart Manager + a scoped process census) and fetches Sysinternals
 * handle64, admitted only when its Authenticode signature is Valid and
 * Microsoft-signed; its digest is then recorded (and re-checked at use), not
 * pinned to a fixed published SHA. The handle64 PowerShell child runs with
 * PSModulePath removed (case-insensitively, as Windows compares) so it builds
 * its own module path and autoloads Microsoft.PowerShell.Security instead of
 * inheriting a PowerShell 7 step's module paths — the exact failure the merged
 * QA measured and corrected. The removal and the child's module facts are kept
 * as short evidence.
 *
 * Every missing tool, source, hash or output error is a RECORDED GAP, never a
 * failure: the smoke runs the same, and a later real failure is still captured
 * with whatever observers prepared. Nothing here installs a vendor program,
 * signs anything or mutates product state; only ephemeral runner facts reach the
 * manifest. Output: `<tools>/tools.json`, and, under GitHub Actions,
 * `C672_CAPTURE_DIR` and `C672_CAPTURE_TOOLS` appended to `$GITHUB_ENV`. Exit is
 * always 0.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchHandle64, sha256File } from "../lib/c672-capture-prep.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const base = process.env.RUNNER_TEMP ?? tmpdir();
const toolsDir = join(base, "c672-capture-tools");
const evidenceDir = join(base, "c672-capture-evidence");
const toolsPath = join(toolsDir, "tools.json");

const result = {
  helper: null,
  handle: null,
  powershell: null,
  gaps: [],
  source: null,
  platform: process.platform,
};

function recordGap(message) {
  result.gaps.push(String(message));
}

try {
  mkdirSync(toolsDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });

  if (process.platform !== "win32") {
    recordGap(`capture observers are Windows-only; platform ${process.platform} prepared nothing`);
  } else {
    const source = join(here, "c672obs.cs");
    try {
      result.source = existsSync(source)
        ? { path: "scripts/c672/c672obs.cs", sha256: sha256File(source) }
        : null;
    } catch (error) {
      recordGap(`c672obs.cs could not be hashed: ${error?.code ?? error}`);
    }
    if (!result.source) recordGap("c672obs.cs source missing");

    // Restart Manager + census helper, compiled with the Framework csc on-image.
    const cscCandidates = [
      "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
      "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
    ];
    const csc = cscCandidates.find((p) => existsSync(p));
    if (!csc) {
      recordGap("no .NET Framework csc.exe: Restart Manager and process census unavailable");
    } else if (result.source) {
      try {
        const out = join(toolsDir, "c672obs.exe");
        const compile = spawnSync(
          csc,
          ["/nologo", "/optimize+", "/platform:anycpu", `/out:${out}`, source],
          {
            encoding: "utf8",
            timeout: 120_000,
            windowsHide: true,
            maxBuffer: 8 << 20,
          },
        );
        if (compile.status === 0 && existsSync(out))
          result.helper = { path: out, sha256: sha256File(out) };
        else
          recordGap(
            `observer compile failed (exit ${compile.status}); ${(compile.stderr || "").slice(0, 400)}`,
          );
      } catch (error) {
        recordGap(`observer compile error: ${error?.code ?? error}`);
      }
    }

    // Sysinternals handle64, signed-then-hashed, PSModulePath isolated.
    try {
      const exe = join(toolsDir, "handle64.exe");
      const fetched = fetchHandle64({
        toolsDir,
        zip: join(toolsDir, "Handle.zip"),
        exe,
        spawn: spawnSync,
      });
      result.powershell = fetched.evidence;
      if (fetched.gap) recordGap(fetched.gap);
      else if (!existsSync(exe)) recordGap("handle64 reported valid but is missing on disk");
      else result.handle = { path: exe, sha256: sha256File(exe), signer: fetched.handle.signer };
    } catch (error) {
      recordGap(`handle64 preparation error: ${error?.code ?? error}`);
    }
  }
} catch (error) {
  recordGap(`capture preparation error: ${error?.stack ? error.stack.slice(0, 600) : error}`);
}

try {
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(toolsPath, JSON.stringify(result, null, 1));
} catch (error) {
  // Even the manifest write failing is a visible diagnostic, not a crash.
  console.error(`c672 prep could not write tools.json: ${error?.code ?? error}`);
}

if (process.env.GITHUB_ENV) {
  try {
    appendFileSync(process.env.GITHUB_ENV, `C672_CAPTURE_DIR=${evidenceDir}\n`);
    appendFileSync(process.env.GITHUB_ENV, `C672_CAPTURE_TOOLS=${toolsPath}\n`);
  } catch (error) {
    console.error(`c672 prep could not export env: ${error?.code ?? error}`);
  }
}

console.log(
  JSON.stringify({
    toolsPath,
    evidenceDir,
    helper: result.helper ? { sha256: result.helper.sha256 } : null,
    handle: result.handle ? { sha256: result.handle.sha256, signer: result.handle.signer } : null,
    removedPsModulePath: result.powershell?.removedPsModulePath ?? null,
    gaps: result.gaps,
  }),
);
// Preparation never fails the job; an unavailable tool is a gap the capture records.
process.exit(0);
