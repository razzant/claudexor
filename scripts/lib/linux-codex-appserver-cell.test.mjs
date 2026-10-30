import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accessVerdicts,
  classifyDaemonRun,
  classifyProbe,
  classifyTurn,
  commandProbes,
  DAEMON_PROMPT,
  daemonAskRequest,
  deadProxyEnv,
  managedLaunch,
  modelExecCommand,
  outsideTargetGaps,
  POLICIES,
  telemetryFacts,
  WRITE_STARTED,
} from "./linux-codex-appserver-cell.mjs";
import { DOCTOR_SMOKE_STEP, EXEC_CALL_ID, IMAGE_CALL_ID } from "./scripted-responses-provider.mjs";
import { isExecutableFile, loadProduct } from "./linux-codex-appserver-worker.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "cx337-cell-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const NONCE = "5f0c2f1e9a7d4b3c8e6f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d";
const SPEC = {
  nonce: NONCE,
  nonceFile: "/cell/project/research/input.txt",
  marker: "cx-probe-marker-1",
  writeTargets: {
    readonly: "/cell/project/ro.txt",
    project: "/cell/project/ww.txt",
    outside: "/cell/outside/o.txt",
    full: "/cell/full-control/f.txt",
  },
};
const result = (exitCode, stdout, stderr = "") => ({
  state: "result",
  result: { exitCode, stdout, stderr },
  afterNotifications: 0,
});
const probe = (id) => commandProbes(SPEC).find((p) => p.id === id);

describe("managed app-server launch from the built product", () => {
  let product;
  // Loading the built product cold (Turbo output plus adapter imports) exceeded Vitest's
  // default 10 s hook timeout on a first run; the load is one-time and not a test subject.
  beforeAll(async () => {
    product = await loadProduct(REPO);
  }, 60_000);

  it("uses the adapter's exact argv, scrubs provider env and scopes CODEX_HOME", () => {
    const env = {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/cell/home",
    };
    const launch = managedLaunch(product, {
      codexHome: "/cell/codex-home",
      helper: "system",
      env,
      hasBwrap: () => false,
    });
    expect(launch.bin).toBe("codex");
    expect(launch.args).toEqual([
      "-c",
      'cli_auth_credentials_store="file"',
      "-c",
      'project_doc_fallback_filenames=["CLAUDE.md"]',
      "app-server",
      "--stdio",
    ]);
    expect(launch.patch).toMatchObject({
      CODEX_HOME: "/cell/codex-home",
      OPENAI_API_KEY: null,
      OPENAI_BASE_URL: null,
      CODEX_API_KEY: null,
    });
    expect(launch.patch.PATH).toBeUndefined();
    const dirs = launch.managedPath.split(":");
    expect(dirs).toContain("/cell/home/.claudexor/node/bin");
    expect(dirs.indexOf("/cell/home/.claudexor/node/bin")).toBeLessThan(dirs.indexOf("/usr/bin"));
  });

  it("removes only directories holding a bwrap from the bundled control's PATH", () => {
    const env = { PATH: "/usr/sbin:/usr/bin:/bin", HOME: "/cell/home" };
    const launch = managedLaunch(product, {
      codexHome: "/cell/codex-home",
      helper: "bundled",
      env,
      hasBwrap: (dir) => dir === "/usr/bin" || dir === "/bin",
    });
    expect(launch.removedFromPath).toEqual(["/usr/bin", "/bin"]);
    expect(launch.patch.PATH).toBe(
      launch.managedPath
        .split(":")
        .filter((dir) => dir !== "/usr/bin" && dir !== "/bin")
        .join(":"),
    );
  });

  it("keeps the bundled control's PATH through the product's own spawn composition", async () => {
    // A real bwrap-holding directory on the managed PATH ($HOME/.local/bin), removed for the
    // bundled control; the child the product spawns must see exactly the patched PATH.
    const home = join(scratch, "home");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "bwrap"), "#!/bin/sh\n");
    chmodSync(join(home, ".local", "bin", "bwrap"), 0o755);
    const launch = managedLaunch(product, {
      codexHome: join(scratch, "codex-home"),
      helper: "bundled",
      env: { PATH: "/usr/sbin:/usr/bin:/bin", HOME: home },
      hasBwrap: (dir) => isExecutableFile(join(dir, "bwrap")),
    });
    expect(launch.removedFromPath).toContain(join(home, ".local", "bin"));
    let stdout = "";
    for await (const event of product.spawnProcess("/usr/bin/env", [], { env: launch.patch }))
      if (event.type === "stdout") stdout += `${event.line}\n`;
    const childPath = /^PATH=(.*)$/m.exec(stdout)?.[1];
    expect(childPath).toBe(launch.patch.PATH);
    expect(childPath.split(":")).not.toContain(join(home, ".local", "bin"));
  });

  it("points every proxy at a closed loopback port and exempts loopback", () => {
    const env = deadProxyEnv();
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ])
      expect(env[name]).toBe("http://127.0.0.1:9");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1");
    expect(env.no_proxy).toBe(env.NO_PROXY);
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
  });

  it("starts the scripted turn with the params Claudexor sends for a readonly ask", () => {
    const spec = product.HarnessRunSpec.parse({
      session_id: "s",
      intent: "explain",
      prompt: "p",
      cwd: "/cell/project",
      access: "readonly",
      model_hint: "m",
      external_context_policy: "off",
    });
    const [method, params] = product.codexAppServerThreadRequest(spec, null);
    expect(method).toBe("thread/start");
    expect(params).toMatchObject({
      cwd: "/cell/project",
      model: "m",
      sandbox: "read-only",
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      config: { web_search: "disabled", project_doc_fallback_filenames: ["CLAUDE.md"] },
    });
    expect(product.codexTurnParams(spec)).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
    });
    expect(product.codexAppServerInput(spec)).toEqual([{ type: "text", text: "p" }]);
  });
});

describe("command probes", () => {
  it("asks each access mode in Codex's echoed policy shape", () => {
    const probes = commandProbes(SPEC);
    expect(probes.map((p) => [p.id, p.params.sandboxPolicy.type])).toEqual([
      ["readonly_read", "readOnly"],
      ["readonly_identity", "readOnly"],
      ["readonly_write", "readOnly"],
      ["workspace_write_project", "workspaceWrite"],
      ["workspace_write_outside", "workspaceWrite"],
      ["full_read", "dangerFullAccess"],
      ["full_write", "dangerFullAccess"],
    ]);
    expect(POLICIES.readonly).toEqual({ type: "readOnly", networkAccess: false });
    expect(probe("workspace_write_outside").params.command.slice(-2)).toEqual([
      "cx-probe-marker-1",
      "/cell/outside/o.txt",
    ]);
    expect(probe("readonly_read").params).toMatchObject({
      command: ["/bin/cat", SPEC.nonceFile],
      timeoutMs: 30_000,
    });
  });

  it("refuses an outside-write target that workspace-write would make writable anyway", () => {
    const spec = { ...SPEC, project: "/cell/project", env: { TMPDIR: "/cell/tmp" } };
    expect(outsideTargetGaps(spec)).toEqual([]);
    expect(
      outsideTargetGaps({
        ...spec,
        writeTargets: { ...SPEC.writeTargets, outside: "/cell/tmp/o.txt" },
      }),
    ).toHaveLength(1);
    const macTmp = {
      ...spec,
      writeTargets: { ...SPEC.writeTargets, outside: "/tmp/cell/outside/o.txt" },
    };
    expect(outsideTargetGaps(macTmp, (path) => path.replace(/^\/tmp/, "/private/tmp"))[0]).toMatch(
      /under \/tmp/,
    );
  });

  it("reads only by exit code and the exact nonce bytes, never by stderr wording", () => {
    expect(
      classifyProbe(
        probe("readonly_read"),
        result(0, `${NONCE}\n`, "bwrap: loopback: Failed RTM_NEWADDR"),
        SPEC,
      ),
    ).toBe("read");
    expect(classifyProbe(probe("readonly_read"), result(0, `${NONCE}`), SPEC)).toBe("not_read");
    expect(classifyProbe(probe("readonly_read"), result(1, ""), SPEC)).toBe("not_read");
    expect(
      classifyProbe(probe("readonly_read"), { state: "error", error: { code: -1 } }, SPEC),
    ).toBe("rpc_error");
    expect(classifyProbe(probe("readonly_read"), { state: "timeout" }, SPEC)).toBe(
      "capture_unknown",
    );
  });

  it("classifies writes from the host file, the start marker and the exit code", () => {
    const started = `${WRITE_STARTED}\n`;
    expect(
      classifyProbe(probe("readonly_write"), result(2, started), SPEC, { exists: false }),
    ).toBe("refused");
    expect(classifyProbe(probe("readonly_write"), result(1, ""), SPEC, { exists: false })).toBe(
      "not_started",
    );
    expect(
      classifyProbe(probe("readonly_write"), { state: "closed" }, SPEC, { exists: true }),
    ).toBe("landed");
    expect(
      classifyProbe(probe("workspace_write_project"), result(0, started), SPEC, {
        exists: true,
        content: SPEC.marker,
      }),
    ).toBe("written");
    expect(
      classifyProbe(probe("workspace_write_project"), result(0, started), SPEC, {
        exists: true,
        content: "other",
      }),
    ).toBe("inconclusive");
    expect(
      classifyProbe(probe("workspace_write_outside"), result(0, started), SPEC, { exists: false }),
    ).toBe("inconclusive");
  });

  it("derives access verdicts and needs new user, mount and network namespaces for readonly", () => {
    const outside = { user: "user:[1]", mnt: "mnt:[1]", net: "net:[1]" };
    const inside = "user=user:[2]\nmnt=mnt:[2]\nnet=net:[2]\npid=pid:[2]\n";
    const good = {
      readonly_read: "read",
      readonly_write: "refused",
      workspace_write_project: "written",
      workspace_write_outside: "refused",
      full_read: "read",
      full_write: "written",
    };
    expect(accessVerdicts(good, inside, outside)).toMatchObject({
      readonly: "usable",
      workspace_write: "usable",
      full: "usable",
      namespaces: "isolated",
    });
    expect(accessVerdicts(good, "user=user:[1]\nmnt=mnt:[2]\nnet=net:[2]", outside).readonly).toBe(
      "not_isolated",
    );
    const failing = {
      ...good,
      readonly_read: "not_read",
      readonly_write: "not_started",
      workspace_write_project: "not_started",
      workspace_write_outside: "not_started",
    };
    expect(accessVerdicts(failing, "", outside)).toMatchObject({
      readonly: "capability_failed",
      workspace_write: "capability_failed",
      full: "usable",
    });
    expect(
      accessVerdicts(
        { ...good, readonly_write: "landed", workspace_write_outside: "landed" },
        inside,
        outside,
      ),
    ).toMatchObject({ readonly: "write_not_refused", workspace_write: "outside_write_landed" });
    expect(
      accessVerdicts({ ...good, readonly_read: "capture_unknown" }, inside, outside),
    ).toMatchObject({ readonly: "unknown", anyUnknown: true });
  });
});

describe("scripted turn", () => {
  const command = (exitCode, output) => ({
    method: "item/completed",
    params: { item: { type: "commandExecution", exitCode, aggregatedOutput: output } },
  });
  const log = (outputs, tools = ["exec_command", "view_image"], credentialHeaders = []) => [
    { tools, functionCallOutputs: outputs, credentialHeaders },
  ];

  it("reads through exec_command and sees an image through view_image", () => {
    const verdict = classifyTurn({
      turn: { started: true },
      notifications: [
        command(0, `${NONCE}\napparmor=bwrap//&unpriv_bwrap (enforce)\nNoNewPrivs=1\nwrite_rc=1\n`),
        { method: "turn/completed", params: { turn: { status: "completed" } } },
      ],
      providerLog: log({
        [EXEC_CALL_ID]: `Process exited with code 0\nOutput:\n${NONCE}\n`,
        [IMAGE_CALL_ID]: [{ type: "input_image", image_url: "data:image/png;base64,AA" }],
      }),
      nonce: NONCE,
      hostWrite: { exists: false },
    });
    expect(verdict).toMatchObject({
      exec: "read",
      viewImage: "returned_image",
      write: "refused",
      turnStatus: "completed",
      providerSawNonce: true,
      credentialHeaders: [],
    });
    expect(verdict.execIdentity).toMatchObject({
      apparmor: "bwrap//&unpriv_bwrap (enforce)",
      NoNewPrivs: "1",
    });
  });

  it("reports the fs-helper failure text as a failed view_image and a failed command as not_read", () => {
    const verdict = classifyTurn({
      turn: { started: true },
      notifications: [command(1, "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n")],
      providerLog: log(
        {
          [EXEC_CALL_ID]: "Process exited with code 1",
          [IMAGE_CALL_ID]: "unable to locate image at `/p/x.png`: fs sandbox helper failed",
        },
        undefined,
        ["authorization"],
      ),
      nonce: NONCE,
    });
    expect(verdict).toMatchObject({
      exec: "not_read",
      viewImage: "failed",
      write: "not_started",
      credentialHeaders: ["authorization"],
    });
    const landed = classifyTurn({
      turn: { started: true },
      notifications: [command(0, `${NONCE}\nwrite_rc=0\n`)],
      providerLog: log({ [EXEC_CALL_ID]: "Process exited with code 0" }),
      nonce: NONCE,
      hostWrite: { exists: true },
    });
    expect(landed.write).toBe("landed");
  });

  it("keeps a turn that never started or a missing tool apart from a sandbox verdict", () => {
    expect(
      classifyTurn({
        turn: { started: false, startState: "timeout" },
        notifications: [],
        providerLog: [],
        nonce: NONCE,
      }).exec,
    ).toBe("capture_unknown");
    expect(
      classifyTurn({
        turn: { started: true },
        notifications: [],
        providerLog: log({}, ["exec_command"]),
        nonce: NONCE,
      }),
    ).toMatchObject({ exec: "not_called", viewImage: "tool_unavailable" });
  });

  it("puts the nonce read first and reports the readonly write without changing the status", () => {
    const lines = modelExecCommand("/cell/it's.txt", "/cell/project/w.txt", "m-1").split("\n");
    expect(lines[0]).toBe("/bin/cat '/cell/it'\"'\"'s.txt' || exit $?");
    expect(lines.slice(-2)).toEqual([
      "printf %s 'm-1' 2>/dev/null > '/cell/project/w.txt'",
      'printf "write_rc=%s\\n" "$?"',
    ]);
  });
});

describe("daemon route", () => {
  const spec = { project: "/cell/project" };
  const codeMode = (exitCode, output, view) => [
    {
      type: "input_text",
      text: JSON.stringify({ probe: "exec_command", result: { exit_code: exitCode, output } }),
    },
    { type: "input_text", text: JSON.stringify({ probe: "view_image", ...view }) },
    ...(view.image ? [{ type: "input_image", image_url: "data:image/png;base64,AA" }] : []),
  ];
  const providerLog = (output) => [
    { reply: DOCTOR_SMOKE_STEP, credentialHeaders: [] },
    { reply: "call:code_mode_exec", tools: ["functions.exec"], credentialHeaders: [] },
    {
      reply: "final_message",
      tools: ["functions.exec"],
      functionCallOutputs: { [EXEC_CALL_ID]: output },
      credentialHeaders: [],
    },
  ];
  const obs = (answer, eventTypes = { "harness.started": 1 }) => ({
    outcome: { runId: "run-1", status: "succeeded" },
    eventTypes,
    detail: {
      primaryOutput: { text: answer },
      summary: { requestedAccess: "readonly", effectiveAccess: "readonly" },
      runFacts: { outcome: { work_state: { state: "completed" } } },
    },
  });

  it("asks one readonly codex question the product's own request schema accepts", async () => {
    const schema = await import(pathToFileURL(join(REPO, "packages/schema/dist/index.js")).href);
    const request = daemonAskRequest(spec);
    expect(schema.ControlRunStartRequest.parse(request)).toMatchObject({
      mode: "ask",
      access: "readonly",
      harnesses: ["codex"],
    });
    expect(request).toMatchObject({ prompt: DAEMON_PROMPT, paidBudget: { kind: "unlimited" } });
    for (const pinned of ["model", "effort", "credentialProfileId"])
      expect(request).not.toHaveProperty(pinned);
    expect(DAEMON_PROMPT).not.toMatch(/[0-9a-f]{64}/);
  });

  it("reads only when the tool output and the daemon's answer both carry the nonce", () => {
    const ok = codeMode(0, `${NONCE}\napparmor=bwrap//&unpriv_bwrap\nwrite_rc=1\n`, {
      image: true,
    });
    const verdict = classifyDaemonRun({
      obs: obs(`exec output: ${NONCE}`),
      providerLog: providerLog(ok),
      nonce: NONCE,
      hostWrite: { exists: false },
    });
    expect(verdict).toMatchObject({
      read: "read",
      viewImage: "returned_image",
      write: "refused",
      status: "succeeded",
      workState: "completed",
      access: { requested: "readonly", effective: "readonly" },
      admitted: true,
      toolSurface: "code_mode",
      doctorSmokeRequests: 1,
      execIdentity: { apparmor: "bwrap//&unpriv_bwrap" },
    });
    expect(
      classifyDaemonRun({ obs: obs("no nonce here"), providerLog: providerLog(ok), nonce: NONCE })
        .read,
    ).toBe("not_read");
  });

  it("keeps a failed helper, a refused admission and a lost run apart", () => {
    const failed = codeMode(1, "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n", {
      image: false,
      result: { error: "fs sandbox helper failed" },
    });
    expect(
      classifyDaemonRun({
        obs: obs("needs input"),
        providerLog: providerLog(failed),
        nonce: NONCE,
      }),
    ).toMatchObject({
      read: "not_read",
      viewImage: "failed",
      write: "not_started",
      imageError: "fs sandbox helper failed",
    });
    // The whole code-mode cell failed: Codex returned plain text, no `view_image` line.
    const cellFailed = classifyDaemonRun({
      obs: obs("needs input"),
      providerLog: providerLog("exec failed: code mode host could not start"),
      nonce: NONCE,
    });
    expect(cellFailed).toMatchObject({
      read: "not_read",
      viewImage: "not_reached",
      write: "not_started",
      toolSurface: "code_mode",
    });
    const refused = classifyDaemonRun({ obs: obs("x", {}), providerLog: [], nonce: NONCE });
    expect(refused).toMatchObject({ read: "not_admitted", viewImage: "not_admitted" });
    expect(classifyDaemonRun({ obs: {}, providerLog: [], nonce: NONCE }).read).toBe(
      "capture_unknown",
    );
    const typed = { refusal: { code: "harness_unavailable", message: "no codex lane" } };
    expect(classifyDaemonRun({ obs: typed, providerLog: [], nonce: NONCE }).read).toBe(
      "not_admitted",
    );
  });

  it("takes access, auth route, model and tool-error counts from the run's telemetry", () => {
    const text = JSON.stringify({
      requested_access: "readonly",
      effective_access: "readonly",
      attempts: [
        {
          harness_id: "codex",
          auth_mode: "api_key",
          observed_model: "gpt-6.1-sol",
          tool_errors_total: 0,
          dropped_events: 8,
          outcome: { status: "success", work_state: { state: "needs_input" } },
        },
      ],
    });
    expect(telemetryFacts(text)).toMatchObject({
      effective_access: "readonly",
      attempts: [
        {
          auth_mode: "api_key",
          tool_errors_total: 0,
          dropped_events: 8,
          work_state: "needs_input",
        },
      ],
    });
    expect(telemetryFacts("not: [json")).toBeNull();
  });
});
