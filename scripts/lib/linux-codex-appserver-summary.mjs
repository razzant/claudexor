/** Harness defects, the job conclusion and the human summary of the Linux Codex app-server
 * probe. Sandbox verdicts are data and never a defect: the job fails only when the harness
 * cannot stand behind a result (unknown capture or cleanup, a model path never exercised,
 * a missing cell, an unverified
 * change or restore, a mutated fixture, a credential header, missing geometry or evidence). */
import { CELLS, PHASES, verdictGaps } from "./linux-codex-appserver-phases.mjs";

export const DIAGNOSTIC_CONTROL =
  "Diagnostic control on a disposable GitHub-hosted runner. Between an unchanged baseline and a " +
  "restored baseline, one phase installs Ubuntu noble's packaged bwrap-userns-restrict profile the " +
  "documented way and removes it again; only if that profile fails for the system helper, one " +
  "labelled comparison loads the prior minimal per-binary profile and removes it again. No sysctl " +
  "changes. Neither change nor its absence is a recommendation, and the comparison is not a product " +
  "fallback. Sandbox verdicts are data: the job fails only on a harness defect.";

export const READING = [
  "Compare phases only in a `complete` run; a `not_run` cell or any defect leaves the comparison open. A `skipped` phase is a comparison whose condition did not hold, not a defect.",
  "Remedy support needs: `system` readonly and workspace_write `capability_failed` at baseline, `usable` under distro-profile with the scripted turn's exec_command `read`, view_image `returned_image` and write `refused`, the `daemon` cell `read` with effective access readonly, and the baseline verdicts back in restored-baseline.",
  "`daemon` is the real built daemon, orchestrator and Codex adapter on the api_key route with a labelled dummy key; Codex's system config layer names the loopback provider, which also answers the doctor's `Reply exactly OK` smoke. That is admission through a fixture route, never auth readiness. Its `read` needs the tool output and the daemon's recorded answer to carry the nonce.",
  "`bundled` is a negative control (no bwrap on its PATH, a disclosed deviation from the managed PATH, checked against the PATH the app-server actually ran with): the profile names /usr/bin/bwrap, so `bundled` usable under distro-profile breaks the control.",
  "`full` runs without bubblewrap and should stay `usable` in every phase; a failure there is not about the userns restriction.",
  "minimal-profile runs only after a known read failure of the system helper under the distro profile (readonly `capability_failed`, the turn's exec_command or the daemon read `not_read`) with every earlier phase verified; inconclusive or unknown evidence is data and never admits it. A system cell that passes there but failed under distro-profile points at the distro profile itself (its stacked `unpriv_bwrap` child, NoNewPrivileges), not at the userns restriction.",
  "Helper identity comes from evidence, not PATH: executables the cgroup sampler saw (a short-lived failing helper can be missed), the in-sandbox label (`bwrap//&unpriv_bwrap` expected under the distro profile), `command -v bwrap`, Codex's startup configWarning, and kernel `execpath` lines. A missing kernel line is not evidence that nothing happened.",
  "A configWarning list counts as complete only when `settled` (Codex's remote-control status frame, sent right after its startup warnings, arrived).",
  "A sandbox that refuses (`not_read`, `capability_failed`, a refused write) is data; a missing model request, tool call or captured tool result (`no_model_request`, `not_called`, `capture_unknown`, `rpc_error`) for the scripted turn's exec_command or the daemon read is a harness defect, and unknown namespace identity alone only leaves readonly `inconclusive`. Without a commandExecution item the turn's exec_command is `not_read` only from Codex's pre-start denial frame (wall time zero, non-zero exit, a denial keyword, untruncated, no nonce, turn completed; `execEvidence: denied_before_start`); any other item-less output stays `capture_unknown`.",
  "Model-path verdicts come from a scripted provider: they show the tool surfaces and Claudexor's handling of a report derived from the tool result, not a real model's choices or `needs_input` judgement.",
];

export const LIMITATIONS = [
  "A scripted loopback provider stands in for the model: the observed model is whatever slug Codex sent, and the work report is derived from the read's exit status.",
  "The daemon cells use the api_key route with a dummy key; the native subscription route of the #337 runs needs a real login and is not exercised.",
  "Codex 0.162.1 only; the #337 host ran 0.153.3.",
  "A GitHub-hosted Ubuntu 24.04 VM is not the #337 host; the transient unit carries the reported hardening plus loopback-only networking (IPAddressDeny) and a private /tmp (PrivateTmp=yes, for Codex 0.162.1's fixed /tmp/codex-daemon-<uid>), deliberate additions.",
  "Only the packaged profile file is installed (extracted from the pinned .deb, not the package), loaded with the runner's own apparmor_parser and -K (no cache write).",
  "Kernel lines are those printed while a cell ran, by any process, through the printk rate limit; they are raw diagnostics.",
];

export function cellDefects(cell) {
  if (["not_run", "skipped"].includes(cell.verdict)) return [];
  const where = `${cell.phase}/${cell.id}`;
  const defects = [];
  if (cell.capture?.known === false)
    defects.push(`${where}: capture unknown (${cell.capture.problems.join("; ")})`);
  if (cell.cleanup?.known === false)
    defects.push(`${where}: cleanup unknown (${cell.cleanup.problems.join("; ")})`);
  if (
    cell.controls &&
    !(cell.controls.read && cell.controls.writeProject && cell.controls.writeOutside)
  )
    defects.push(`${where}: an outside-Codex read or write control failed`);
  if (cell.serviceGeometry && !cell.serviceGeometry.established)
    defects.push(
      `${where}: service geometry not established (${cell.serviceGeometry.mismatches.join("; ")})`,
    );
  if (cell.egress && !cell.egress.blocked)
    defects.push(`${where}: egress not shown closed (${cell.egress.code})`);
  if (cell.fixture && !cell.fixture.unchanged)
    defects.push(`${where}: fixture changed (${cell.fixture.differences.join("; ")})`);
  const credentialHeaders = [
    ...(cell.turn?.credentialHeaders ?? []),
    ...(cell.daemon?.credentialHeaders ?? []),
  ];
  if (credentialHeaders.length)
    defects.push(`${where}: the provider saw credential headers ${credentialHeaders.join(", ")}`);
  if (cell.kernelLog?.state === "unavailable") defects.push(`${where}: kernel log unavailable`);
  const unpinned = (cell.helperEvidence?.codexAppServer ?? []).filter((entry) => !entry.pinned);
  if (unpinned.length)
    defects.push(
      `${where}: an app-server binary is not the pinned Codex (${unpinned.map((entry) => entry.exe).join(", ")})`,
    );
  if (cell.helperEvidence?.actualPath?.bundledControlEffective === false)
    defects.push(`${where}: the bundled control's app-server PATH still holds a bwrap`);
  if (cell.daemon?.read === "not_admitted")
    defects.push(`${where}: the fixture route did not admit the codex lane`);
  // `namespaces` is isolation evidence and stays data; not_read, refused and tool_error results
  // are data too. The gaps are the verdicts that never saw a command or its result.
  defects.push(...verdictGaps(cell).map((gap) => `${where}: ${gap}`));
  return defects;
}

function phaseDefects(phase) {
  const defects = [];
  if (phase.notRunReason)
    defects.push(`${phase.id}: planned cells not run (${phase.notRunReason})`);
  if (phase.setup && !phase.setup.verified)
    defects.push(
      `${phase.id}: change not verified (${phase.setup.differences.join("; ") || "no difference"})`,
    );
  if (phase.endState && !phase.endState.restored)
    defects.push(
      `${phase.id}: host state not restored (${[...phase.endState.differences, ...(phase.restore?.gaps ?? [])].join("; ")})`,
    );
  if (phase.error) defects.push(`${phase.id}: harness error: ${phase.error.split("\n")[0]}`);
  return defects;
}

function routeDefects(route) {
  if (!route) return [];
  const defects = [];
  if (route.refused) defects.push(`provider route refused: ${route.refused}`);
  else if (!route.verified) defects.push("provider route: /etc/codex/config.toml not verified");
  if (route.restore && !route.restore.restored)
    defects.push(`provider route not restored (${route.restore.gaps.join("; ")})`);
  return defects;
}

export function summarize(phases = [], cells = [], route = null) {
  const defects = [
    ...routeDefects(route),
    ...phases.flatMap(phaseDefects),
    ...cells.flatMap(cellDefects),
  ];
  return { outcome: defects.length ? "incomplete" : "complete", defects };
}

export function exitCodeFor(outcome) {
  if (outcome === "complete") return 0;
  return outcome === "incomplete" ? 1 : 2;
}

const ROWS = {
  appserver: [
    ["readonly (command/exec)", (cell) => cell.access?.readonly],
    ["workspace_write (command/exec)", (cell) => cell.access?.workspace_write],
    ["full (command/exec)", (cell) => cell.access?.full],
    ["readonly turn: exec_command", (cell) => cell.turn?.exec],
    ["readonly turn: view_image", (cell) => cell.turn?.viewImage],
    ["readonly turn: write", (cell) => cell.turn?.write],
  ],
  daemon: [
    ["daemon readonly ask: read", (cell) => cell.daemon?.read],
    ["daemon: view_image", (cell) => cell.daemon?.viewImage],
    ["daemon: write", (cell) => cell.daemon?.write],
    [
      "daemon: run / work state",
      (cell) => cell.daemon && `${cell.daemon.status} / ${cell.daemon.workState}`,
    ],
    [
      "daemon: effective access",
      (cell) => cell.daemon && `${cell.daemon.access.requested} -> ${cell.daemon.access.effective}`,
    ],
    [
      "daemon: tool_errors_total",
      (cell) => cell.daemon?.telemetry?.attempts?.[0]?.tool_errors_total ?? null,
    ],
  ],
};

function escape(text) {
  return String(text ?? "n/a")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function find(cells, phase, id) {
  return cells.find((cell) => cell.phase === phase && cell.id === id);
}

export function renderSummary(summary) {
  const out = [
    `# Linux Codex app-server probe: harness ${summary.outcome}`,
    "",
    DIAGNOSTIC_CONTROL,
    "",
  ];
  for (const gap of summary.gaps ?? []) out.push(`- unsupported: ${gap}`);
  if (summary.gaps?.length) out.push("");
  if (summary.error) out.push(`- harness error: ${summary.error.split("\n")[0]}`, "");
  const cells = summary.cells ?? [];
  const phases = summary.phases ?? [];
  if (cells.length) {
    out.push("## Verdicts", "", `| cell | surface | ${PHASES.map((p) => p.id).join(" | ")} |`);
    out.push(`| --- | --- |${" --- |".repeat(PHASES.length)}`);
    for (const plan of CELLS)
      for (const [label, pick] of ROWS[plan.kind])
        out.push(
          `| ${plan.id} | ${label} | ${PHASES.map((p) => escape(cellValue(find(cells, p.id, plan.id), pick))).join(" | ")} |`,
        );
    out.push("", "## Helper evidence and Codex startup warnings", "");
    out.push(
      "| phase | cell | bwrap on app-server PATH | executed helpers | inside: label | inside: NoNewPrivs/CapEff | inside: command -v bwrap | configWarning (settled) | kernel execpaths |",
    );
    out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const cell of cells.filter((c) => !["not_run", "skipped"].includes(c.verdict))) {
      const h = cell.helperEvidence ?? {};
      const inside = h.inside ?? {};
      const warnings = cell.startup
        ? `${(cell.startup.configWarnings ?? []).map((w) => w?.summary).join(" / ") || "none"} (${cell.startup.settled ? "settled" : "not settled"})`
        : "n/a (inside the daemon)";
      const pathBwrap = h.actualPath?.firstBwrap ?? h.pathBwrap;
      out.push(
        `| ${cell.phase} | ${cell.id} | ${escape(pathBwrap)} | ${escape((h.executed ?? []).join(", ") || "none seen")} | ${escape(inside.apparmor)} | ${escape(`${inside.NoNewPrivs ?? "?"}/${inside.CapEff ?? "?"}`)} | ${escape(inside.bwrap || "none")} | ${escape(warnings)} | ${escape((h.kernelExecpaths ?? []).join(", ") || "none")} |`,
      );
    }
    out.push(
      "",
      "## Phases",
      "",
      "| phase | host change | ran | change verified | host state restored |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const phase of phases)
      out.push(
        `| ${phase.id} | ${escape(phase.change)} | ${phase.ran ? "yes" : phase.skipped ? `skipped: ${escape(phase.skipped)}` : "no"} | ${phase.setup ? (phase.setup.verified ? "yes" : "no") : "n/a"} | ${phase.endState ? (phase.endState.restored ? "yes" : "no") : "n/a"} |`,
      );
    const route = summary.providerRoute;
    if (route)
      out.push(
        "",
        `Provider route for the daemon cells: /etc/codex/config.toml -> 127.0.0.1:${route.port}, installed ${route.verified ? "and verified" : "NOT verified"}, removed ${route.restore?.restored ? "and verified" : "NOT verified"}.`,
      );
    out.push("", "## How to read", "", ...READING.map((rule) => `- ${rule}`), "");
  }
  if (summary.outcome === "complete" || summary.outcome === "incomplete")
    out.push(
      "## Harness defects",
      "",
      ...((summary.defects ?? []).length ? summary.defects.map((d) => `- ${d}`) : ["- none"]),
      "",
    );
  out.push(
    "Raw evidence: phases/<phase>/cells/<cell>/ in the uploaded artifact.",
    "",
    "Limits:",
    ...LIMITATIONS.map((l) => `- ${l}`),
    "",
  );
  return out.join("\n");
}

function cellValue(cell, pick) {
  if (!cell) return "missing";
  if (["not_run", "skipped"].includes(cell.verdict)) return cell.verdict;
  if (cell.verdict === "harness_error") return "harness_error";
  return pick(cell);
}
