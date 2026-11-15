# #672 QA: Copilot npm-copy conversion, `EPERM` on the hiding rename

Diagnostic QA only. No product file changes; nothing here is a repair or a
product gate. The workflow `.github/workflows/qa-copilot-672-9208.yml` runs on
a push to `qa/copilot-lock-672-9208` that changes a script, the observer,
`freeze.json` or the workflow. A push that changes only Markdown, `.gitignore`
or files under `evidence/` starts nothing. Since the first Windows run the
workflow runs only the conversion batch; native-update is not repeated.

## What is known

The failed main CI conversion (run 43645465508, attempt 1, commit `7a87c337`)
stopped at `rename …\@github\copilot -> …\@github\copilot.claudexor-converted`
with `EPERM`. The old package and `copilot.cmd` stayed. `EPERM` names the
operation, not the holder. The same commit passed on attempt 2.

Public CI runs of the repository show the following. The author's saved
copies and notes stay in the ignored `evidence/` folder and are not part of
this branch.

- On Windows a requested npm version and the returned bare `--version` differ:
  requested 1.0.111 → "1.0.112" on attempt 2 (green), requested 1.0.110 → "1.0.111" on
  all four green runs of the earlier diagnostic batch. The mismatch is present
  in green runs, so by itself it does not separate red from green. The answer
  does not prove which executable or vendor installation produced it.
- The earlier probe with arms A/B (`qa/c672/…`) never ran on Windows; its only
  Windows run was the four-shard full smoke. No `records.jsonl` exists.
- Earlier conversion failures predate the diagnostic change and do not expose
  the conversion error. They cannot yet be classified as the same `EPERM`
  mechanism.

## First Windows run

[Run 43685487641](https://github.com/razzant/claudexor/actions/runs/43685487641)
(attempt 1, commit `b31b052a`, image windows-2025-vs2026 20261103.298.1, as in
the failed run) ran both jobs once.

- native-update completed (exit 0); result below.
- The conversion batch built the product, passed `selftest.mjs --mutate` and
  stopped at calibration with exit 3. The batch step was skipped: no vendor
  program was installed or run in that job, and none of the eight hiding
  renames happened. The run gives no evidence about the historical holder.
- Calibration on that runner, one trial per class: the product rename failed
  with `EPERM` (errno -4048) for a file opened without delete sharing, the same
  with delete sharing, a process whose current directory was inside, and the
  probe-shaped parent's detached child. It succeeded with an executable running
  from inside. After each release the rename succeeded at once. Restart Manager
  named the holder in all three file classes, including the detached child.
- The blocker was in the instrument. Windows PowerShell (`powershell.exe`),
  started by Node from the `pwsh` step, could not autoload
  `Microsoft.PowerShell.Security` for `Get-AuthenticodeSignature`
  (`CouldNotAutoloadMatchingModule`). The signature was never checked, so
  `handle64` was not admitted, the current-directory holder stayed unnamed and
  the qualification rule stopped the job as intended.
- Change for the next push: `lib/observers.mjs` starts `powershell.exe` with
  the inherited environment minus `PSModulePath` (any letter case), as
  Microsoft's about_PSModulePath prescribes for Windows PowerShell started
  through an intermediate process from PowerShell 7. The inherited value was
  not recorded in the first run, so this mechanism is documented and matches
  the error but was not observed there. The handle-fetch record now also keeps
  the removed value, the child's version, edition and module path, the
  `Microsoft.PowerShell.Security` copies it lists and loads, and whether
  `handle64.exe` was extracted, with its digest. The signature gate and the
  qualification rule are unchanged.
- If calibration or setup refuses again, that run counts as incomplete and
  does not become a new baseline.

## The batch

One push runs one job, the conversion batch, on a fresh `windows-latest`
runner.

**native-update** (`native-update.mjs`, kept, no longer in the workflow) ran
once in the first Windows run and is not repeated. Its result: winget installed
1.0.111, which answered 1.0.111 to all three questions; its own `update` exited
0 and replaced `copilot.exe` in place, leaving the old bytes beside it as
`copilot.exe.old-<pid>-<ms>`; `~/.copilot` gained only `logs/`; afterwards all
three questions answered 1.0.112, while `winget list` still showed 1.0.111.
The design it ran: vendor copy installed at 1.0.111;
`--no-auto-update --version`, `--version`, `--no-auto-update --version`; its own
`update`; the same three questions. The start qualifies only if winget exits 0,
the installed `copilot.exe` is hashed and its first answer without auto-update
is 1.0.111; otherwise the job stops before `update` (exit 3). Whether `update`
ran to exit 0 is recorded and a failed run exits 4 with everything after it
still recorded; no post-update version is expected. Records the executable's
SHA-256 and `~/.copilot` before/after each probe interval, with an executable
hash taken immediately before and after update. These measurements separate
observed intervals; surviving probe children can still affect them, so they do
not establish an Update-only cache effect or executable origin from version
text.

**conversion-batch**: build at the pushed commit, then

1. `selftest.mjs --mutate`: offline checks of the hooks and evidence reducers,
   with deliberately broken variants that must be caught. `C672_SCRATCH` names
   an explicitly owned directory.
2. `calibrate.mjs`: own processes only, no vendor program. The synthetic
   package lives in a run-owned directory under `%USERPROFILE%`, the volume of
   the product's npm prefix (`RUNNER_TEMP` is another volume on hosted
   runners); both volumes are recorded. Proves the rename observer reaches the
   built `hideProgramPaths`; then holds the package with a file opened without
   and with delete sharing, a running executable inside, a process whose
   current directory is inside, and a probe-shaped parent that prints a
   version and exits 0 while its detached child keeps a file open. Records the
   product rename's error for each class and which observer named the holder.
   File holders use Windows `FileStream` with `FileShare.ReadWrite`, with or
   without `FileShare.Delete`. Readiness is acknowledged after the handle
   opens; release uses a named pipe and is acknowledged after disposal, then
   exit is checked. Missing readiness, release or child identity makes
   calibration incomplete and stops the job. The observers qualify only
   against these known holders: at least one class must make the product
   rename fail, and for each class whose rename failed at least one observer
   must name that holder's PID. One capable observer per class is enough;
   which observer that is for each class is itself a calibration result (by
   design Restart Manager reports file holders, the image census images below
   a root, and only `handle64` can show a directory handle such as a current
   directory). An observer that ran and did not name the holder answers false;
   one that gave no usable answer stays null and cannot qualify anything.
   Otherwise calibration exits 3 before any vendor program runs.
3. `batch.mjs`: frozen inputs (`freeze.json`) checked against the registry;
   vendor copy 1.0.112 via winget and the product's own Update of it; vendor
   answers before/after. The vendor setup must qualify from what the runner
   observed: winget and the Update exit 0, the Update receipt is a verified
   success that selects the hashed `copilot.exe` at 1.0.112, that copy answers
   1.0.112 to `--no-auto-update --version` before and after, and its bytes do
   not change across the questions or the Update. The MSI SHA-256 values in
   `freeze.json` are provenance of the winget manifests, never compared with
   the installed executable. Then a bounded census wait and snapshot S0 of
   `~/.copilot`. Then the fixed order A,B,B,A,A,B,B,A. Each iteration starts
   from the same verified state: no observed matching process in the bounded
   census, `~/.copilot` restored from S0 and compared by manifest (relative
   symlinks copied verbatim), a fresh npm copy whose package, loader and
   `copilot.exe` bytes equal the integrity-verified 1.0.111 tarballs. The
   vendor directory must also match its baseline before mutation. Failed
   enumeration, malformed output, unreadable images with a Copilot or
   unavailable Toolhelp name, and incomplete manifests stop comparability. A
   successful empty census passes. Toolhelp names are read independently of
   image paths: unreadable paths with other names (including ordinary OS
   processes) do not by themselves stop the batch. Every such PID, name and
   Windows error remains in `unreadableImages`. Hygiene covers readable images
   under the supplied roots and names containing Copilot. A nonmatching name
   with an unreadable path could still be under a root; this gap prevents a
   claim of universal absence and does not detect handles, loaded modules or
   working directories. Before S0 and before each iteration a match is waited
   out for at most 60 s (a look every 2 s, the first look kept, nothing
   stopped, no product call repeated); an unknown census is not re-polled.
   After the batch, or its stop, npm dist-tags are read once more.
4. `iteration.mjs` runs the built product in process, from the same run-owned
   temporary directory as the batch's other commands (the smoke runs its CLI
   from one, and product probes inherit their parent's directory):
   `inspectHarness`, then `runHarnessUpdate("copilot")`, through the
   product's existing `options.spawn` seam. The product sequence is unchanged.
   - **A**: every argv exactly as the product builds it.
   - **B**: Copilot `--version` probes receive the program's declared
     `childUpdateArgs` (`--no-auto-update`) immediately before `--version`.
     Installer and `update` commands are untouched.

Spawns are recorded in memory. `fs.renameSync` is a pass-through: the real call
runs first; only if it throws for the hiding rename are the error and clock
captured, then Restart Manager, an image census and Sysinternals `handle64` run,
then the same error is rethrown and the product continues. Nothing is written
and no observer runs between the probes and the first rename. The image census
at that moment also lists, from the same enumeration, up to 64 processes
created since the iteration started. After the product returns: a census with
the same recent list, cache and vendor-folder diffs, and at most one residual
QA rename plus restoration, only after a confirmed initial hide failure, if the
package remains and the census is known. It records actual elapsed time from
the first failure across processes. No observer runs again for that residual
check, and no product update is repeated. It measures only whether the
condition remains at that moment; the first failure is preserved.

## Reading rules (fixed before the run)

- Inspect preconditions that stopped before Update, Update calls, real
  receipts (including `ok:false`), receipts whose product attempted the hiding
  rename (`hideAttempts`) and incomplete outcomes are counted separately. A
  receipt alone is no conversion: the product can refuse before the rename,
  and such iterations are listed as `receiptsWithoutRename`. The batch is
  complete only when all eight iterations attempted the rename and npm
  `latest` read after the batch equals the value read before setup. A null
  receipt, precondition exit, thrown operation or unreadable result stops the
  batch.
- Process counts are scoped: `observedMatchingProcessesAfter` counts the
  census scope, `processImageGapsAfter` keeps the gaps, and
  `recentProcessesAfter` lists processes created since the iteration started
  that were still present. A failed or malformed census leaves them null. No
  count covers every process (PID 0 never yields an image path). Manifest gaps
  retain read errors, truncation and missing hashes; missing/empty directories
  and type changes differ. Visible differences do not erase incomplete
  coverage.
- Deterministic outputs, independent of a rare `EPERM`: which version each
  probe reported per arm, whether a probe changed `~/.copilot`, processes
  present after the product returned, the gap between the last npm-copy probe
  and the rename, and the native-update result.
- No failure in an arm means the condition was not caught there. With four
  attempted renames per arm, this experiment cannot establish a failure rate
  or rule out an intermittent cause.
- Failures only in A support the update/cache hypothesis only together with a
  named holder, its resource and a link to a probe.
- Failures in both arms do not show auto-update is irrelevant: the flag also
  changes the executed version, cache use and timing, and equal errors can
  have different holders.
- An empty Restart Manager, census or handle list is a later bounded look, not
  proof that no holder existed. The historical holder stays unknown.

## Known differences from the failed run

winget pinned with `--version 1.0.112`; inspect runs through the synchronous
resolver (the CLI's used the asynchronous one); agy, claude, codex and grok are
not installed or converted first, and calibration's synthetic holders ran on
the same runner before the batch; setup asks the vendor copy six direct version
questions the smoke does not ask; `~/.copilot` is restored before each
iteration; before each iteration QA reads and hashes the fresh npm package,
its `copilot.exe` and the vendor folder, so those bytes are read (file cache,
possible antivirus scan) before the product touches them; the npm copy comes
from a run-owned npm cache with `--prefer-offline`; `iteration.mjs` requires
the inspect selection to report a version (the smoke requires only the npm-copy
path), so one missing answer stops the batch as a precondition; one runner,
possibly another region and Defender state (recorded). If `latest` is no longer
1.0.112 the batch stops before any vendor iteration (set
`C672_ALLOW_LATEST_DRIFT=1` only for a labelled run).

## Not checked on the author's Mac

`selftest.mjs --mutate` ran here (macOS, Node 24.16), including its checks of
`prepareObservers` against a fake `powershell.exe`, which do not run on
Windows. The first Windows run executed the C# observer (`win/c672obs.cs`,
compiled by the .NET Framework `csc.exe`; its `hold`, `rm` and `ps` modes),
calibration up to its verdict, native-update, and the path filter for a script
push. Still unexecuted on Windows: the `handle64` signature check and
`handle64` itself (the error came at the signature command, after the download
and extraction statements; their result was not recorded), the `PSModulePath`
change, `batch.mjs`, `iteration.mjs`, and the filter's no-run case for a
Markdown-only push. Calibration exists to catch the observer failures before
any vendor iteration.

## Files

`freeze.json`, `lib/hooks.mjs`, `lib/evidence.mjs`, `lib/observers.mjs`,
`win/c672obs.cs`, `selftest.mjs`, `calibrate.mjs`, `iteration.mjs`,
`batch.mjs`, `native-update.mjs` (ran once; no longer in the workflow).
