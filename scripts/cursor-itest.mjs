#!/usr/bin/env node
/**
 * Cursor plugin end-to-end integration test (phases A/C/D + failure
 * modes; scripted parts only). The two MANUAL phases live in
 * docs/CHECKLISTS.md ("Cursor E2E"): B (Cursor discovery after reload) and
 * E (agent-in-the-loop through the Cursor UI).
 *
 * Safe by construction: installs/doctors against a SCRATCH HOME first. Phase
 * C READS the real `~/.cursor/plugins/local/claudexor/mcp.json` and EXECUTES
 * the exact registered command — but with an ISOLATED CLAUDEXOR_CONFIG_DIR
 * and fake harnesses only, so no real host or engine state is mutated.
 * Exit 1 on any failed check.
 */
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "cli", "dist", "cli.js");
const results = [];
const check = (phase, name, ok, detail = {}) => {
  results.push({ phase, name, ok, detail });
  process.stdout.write(
    `${ok ? "PASS" : "FAIL"}  ${phase.padEnd(8)} ${name.padEnd(52)} ${JSON.stringify(detail).slice(0, 160)}\n`,
  );
};

// SHORT base path: the daemon's AF_UNIX socket lives under the config dir and
// macOS caps socket paths at 104 bytes — the default $TMPDIR (/var/folders/…)
// alone burns ~49 of them (the canary sandbox documents the same OS limit).
const scratch = mkdtempSync("/tmp/cxi-");
const scratchHome = join(scratch, "home");
const fixtureRepo = join(scratch, "repo");
mkdirSync(scratchHome, { recursive: true });
mkdirSync(fixtureRepo, { recursive: true });
writeFileSync(
  join(fixtureRepo, "math.js"),
  "export function add(a, b) {\n  return a - b; // bug\n}\n",
);
spawnSync("git", ["init", "-q"], { cwd: fixtureRepo });
spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: fixtureRepo });
spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
  cwd: fixtureRepo,
});
const scratchEnv = {
  ...process.env,
  HOME: scratchHome,
  CLAUDEXOR_CONFIG_DIR: join(scratch, "config"),
};

function runCli(args, env, cwd = scratch) {
  const out = spawnSync(process.execPath, [cli, ...args], {
    env,
    cwd,
    encoding: "utf8",
    timeout: 180_000,
  });
  let json = null;
  try {
    const text = out.stdout ?? "";
    json = JSON.parse(text.slice(text.indexOf("{")));
  } catch {
    /* callers assert on json presence */
  }
  return { code: out.status, json, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
}

/** Newline JSON-RPC driver over an arbitrary spawned command. */
function jsonRpc(command, args, env, cwd) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += String(c);
  });
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (l) => {
    if (l.trim()) {
      try {
        messages.push(JSON.parse(l));
      } catch {
        /* noise */
      }
    }
  });
  return {
    send: (obj) => child.stdin.write(JSON.stringify(obj) + "\n"),
    waitFor: async (pred, timeout) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const hit = messages.find(pred);
        if (hit) return hit;
        if (Date.now() > deadline) return null;
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    close: async () => {
      child.stdin.end();
      await new Promise((r) => setTimeout(r, 200));
      child.kill();
    },
    stderrText: () => stderr,
    exited: new Promise((res) => child.on("exit", res)),
  };
}

// ---------- Phase A: install lifecycle (scratch HOME) ----------
async function phaseA() {
  const install = runCli(["plugin", "install", "cursor", "--json"], scratchEnv);
  check("A", "install cursor (scratch HOME)", install.code === 0 && install.json?.ok === true, {
    state: install.json?.results?.[0]?.state,
  });
  const artifacts = [
    ".cursor-plugin/plugin.json",
    "skills/claudexor/SKILL.md",
    "commands/claudexor.md",
    "mcp.json",
    "README.md",
  ];
  const pluginRoot = join(scratchHome, ".cursor", "plugins", "local", "claudexor");
  const allOwned = artifacts.every(
    (a) =>
      existsSync(join(pluginRoot, a)) &&
      readFileSync(join(pluginRoot, a), "utf8").includes("claudexor:managed"),
  );
  check("A", "5 artifacts exist with ownership marker", allOwned, { pluginRoot });
  const rerun = runCli(["plugin", "install", "cursor", "--json"], scratchEnv);
  check("A", "idempotent rerun (changed:false)", rerun.json?.results?.[0]?.changed === false, {});
  const doctor = runCli(["plugin", "doctor", "cursor", "--json"], scratchEnv);
  const mcpAction = (doctor.json?.results?.[0]?.actions ?? []).some((a) =>
    a.includes("MCP initialize/tools-list self-test passed"),
  );
  check("A", "doctor MCP self-test passes", doctor.code === 0 && mcpAction, {});
  // Collision: an UNOWNED artifact blocks install even with --force. Fresh
  // HOME *and* fresh config dir — plugin state is config-dir-scoped, and a
  // shared state file would surface as a state-path error instead of the
  // ownership block this case pins.
  const collisionHome = join(scratch, "collision-home");
  mkdirSync(
    join(collisionHome, ".cursor", "plugins", "local", "claudexor", "skills", "claudexor"),
    { recursive: true },
  );
  writeFileSync(
    join(
      collisionHome,
      ".cursor",
      "plugins",
      "local",
      "claudexor",
      "skills",
      "claudexor",
      "SKILL.md",
    ),
    "user file\n",
  );
  const blocked = runCli(["plugin", "install", "cursor", "--force", "--json"], {
    ...scratchEnv,
    HOME: collisionHome,
    CLAUDEXOR_CONFIG_DIR: join(scratch, "config-collision"),
  });
  check(
    "A",
    "unowned SKILL.md blocks install (even --force)",
    blocked.json?.ok === false && /not Claudexor-owned/.test(blocked.stdout + blocked.stderr),
    {},
  );
}

// ---------- Phase C: protocol truth over the REGISTERED command ----------
async function phaseC() {
  // Prefer the REAL installed mcp.json (the exact command Cursor launches);
  // fall back to the scratch install for machines without a real install.
  const realMcpJson = join(homedir(), ".cursor", "plugins", "local", "claudexor", "mcp.json");
  const mcpJsonPath = existsSync(realMcpJson)
    ? realMcpJson
    : join(scratchHome, ".cursor", "plugins", "local", "claudexor", "mcp.json");
  const cfg = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
  const server = cfg.mcpServers?.claudexor;
  check("C", "registered command parses", Boolean(server?.command && Array.isArray(server?.args)), {
    source: mcpJsonPath === realMcpJson ? "real" : "scratch",
  });
  const srv = jsonRpc(
    server.command,
    server.args,
    { ...process.env, ...(server.env ?? {}), CLAUDEXOR_CONFIG_DIR: join(scratch, "config-c") },
    fixtureRepo,
  );
  try {
    srv.send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cursor-itest", version: "1.0" },
      },
    });
    const init = await srv.waitFor((m) => m.id === 0, 20_000);
    check("C", "initialize negotiates 2025-06-18", init?.result?.protocolVersion === "2025-06-18", {
      serverInfo: init?.result?.serverInfo,
    });
    srv.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    srv.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = await srv.waitFor((m) => m.id === 1, 15_000);
    const list = tools?.result?.tools ?? [];
    const race = list.find((t) => t.name === "claudexor_best_of");
    check(
      "C",
      "12 tools; best_of n.minimum=2",
      list.length === 12 && race?.inputSchema?.properties?.n?.minimum === 2,
      { count: list.length },
    );
    const runSchema = list.find((t) => t.name === "claudexor_run")?.inputSchema?.properties ?? {};
    const requiredControls = ["prompt", "repoPath", "model", "effort", "web", "reviewerPanel"];
    check(
      "C",
      "run schema exposes 0.14+ controls",
      requiredControls.every((k) => k in runSchema),
      { present: Object.keys(runSchema).length },
    );
    // Invalid args are isError tool results (SDK contract), runner untouched.
    srv.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "claudexor_run", arguments: { prompt: "x", repoPath: "relative/path" } },
    });
    const invalid = await srv.waitFor((m) => m.id === 2, 15_000);
    check("C", "invalid args -> isError result", invalid?.result?.isError === true, {
      head: String(invalid?.result?.content?.[0]?.text ?? "").slice(0, 80),
    });
    // Live fake ask through the registered command + ping DURING it.
    srv.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "claudexor_ask",
        arguments: { prompt: "what is 2+2?", repoPath: fixtureRepo, harness: "fake-success" },
      },
    });
    srv.send({ jsonrpc: "2.0", id: 4, method: "ping" });
    const ping = await srv.waitFor((m) => m.id === 4, 10_000);
    check("C", "ping answers during the ask", Boolean(ping), {});
    const ask = await srv.waitFor((m) => m.id === 3, 120_000);
    const text = String(ask?.result?.content?.[0]?.text ?? "");
    check(
      "C",
      "ask returns text + runId trailer",
      !ask?.result?.isError && /runId: \S+/.test(text),
      { head: text.slice(0, 60) },
    );
  } finally {
    await srv.close();
  }
}

// ---------- Phase D: run lifecycle + artifacts ----------
async function phaseD() {
  const configDir = join(scratch, "config-d");
  const env = { ...scratchEnv, CLAUDEXOR_CONFIG_DIR: configDir };
  const srv = jsonRpc(process.execPath, [cli, "mcp", "serve"], env, fixtureRepo);
  try {
    srv.send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cursor-itest", version: "1.0" },
      },
    });
    await srv.waitFor((m) => m.id === 0, 20_000);
    srv.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    srv.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "claudexor_run",
        arguments: {
          prompt: "fix add() so it adds",
          repoPath: fixtureRepo,
          harness: "fake-implement",
          tests: ['node -e "process.exit(0)"'],
        },
      },
    });
    const call = await srv.waitFor((m) => m.id === 1, 180_000);
    const text = String(call?.result?.content?.[0]?.text ?? "");
    const runId = /runId: (\S+)/.exec(text)?.[1];
    check("D", "write run returns runId", Boolean(runId), { head: text.slice(0, 80) });
    // Artifact correlation BY ID (the old mtime hack is retired): inspect works.
    const inspect = runCli(["inspect", runId ?? "missing", "--json"], env, fixtureRepo);
    check(
      "D",
      "inspect resolves the MCP-started run",
      inspect.code === 0 && inspect.stdout.includes(runId ?? "@"),
      {},
    );
    // Artifacts are PROJECT-scoped (the daemon tracks the run; evidence lives
    // in the target repo's .claudexor/runs), exactly like a CLI run.
    const runDir = join(fixtureRepo, ".claudexor", "runs", runId ?? "missing");
    check(
      "D",
      "run artifacts live under the project repo",
      existsSync(join(runDir, "context", "task.yaml")),
      { runDir },
    );
    const patchPath = join(runDir, "final", "patch.diff");
    const patch = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
    check("D", "patch.diff captured", patch.length > 0, { bytes: patch.length });
  } finally {
    await srv.close();
  }
}

// ---------- Failure modes ----------
async function failureModes() {
  // Mode 1: read-only verbs work with NO daemon and NO doctor-ok harness -> honest failure text.
  const env = { ...scratchEnv, CLAUDEXOR_CONFIG_DIR: join(scratch, "config-f1") };
  const srv = jsonRpc(process.execPath, [cli, "mcp", "serve"], env, fixtureRepo);
  try {
    srv.send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cursor-itest", version: "1.0" },
      },
    });
    await srv.waitFor((m) => m.id === 0, 20_000);
    srv.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    srv.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "claudexor_ask",
        arguments: { prompt: "x", repoPath: fixtureRepo, harness: "no-such-harness" },
      },
    });
    const bad = await srv.waitFor((m) => m.id === 1, 60_000);
    const text = String(bad?.result?.content?.[0]?.text ?? "");
    check("F", "unknown harness fails LOUD in the result", /unknown harness/.test(text), {
      head: text.slice(0, 80),
    });
  } finally {
    await srv.close();
  }
  // Mode 2: stale cliPath in mcp.json -> the registered command fails to boot (host-visible).
  const staleCmd = jsonRpc(
    process.execPath,
    [join(scratch, "nonexistent-cli.js"), "mcp", "serve"],
    scratchEnv,
    scratch,
  );
  const exitCode = await Promise.race([
    staleCmd.exited,
    new Promise((r) => setTimeout(() => r("timeout"), 10_000)),
  ]);
  check(
    "F",
    "stale cliPath fails to boot (nonzero exit)",
    exitCode !== 0 && exitCode !== "timeout",
    { exitCode },
  );
  // Mode 3: version-skew warning on stderr.
  const skew = jsonRpc(
    process.execPath,
    [cli, "mcp", "serve"],
    {
      ...scratchEnv,
      CLAUDEXOR_PLUGIN_VERSION: "0.0.1",
      CLAUDEXOR_CONFIG_DIR: join(scratch, "config-f3"),
    },
    scratch,
  );
  skew.send({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "x", version: "1" },
    },
  });
  await skew.waitFor((m) => m.id === 0, 15_000);
  await skew.close();
  check(
    "F",
    "version-skew warning on stderr",
    skew.stderrText().includes("plugin artifacts are version 0.0.1"),
    {},
  );
}

await phaseA();
await phaseC();
await phaseD();
await failureModes();

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\nRESULT PASS=${results.length - failed.length} FAIL=${failed.length}\n`);
process.stdout.write(
  "Manual phases B (Cursor discovery after reload) and E (agent-in-the-loop) live in docs/CHECKLISTS.md.\n",
);
process.exit(failed.length > 0 ? 1 : 0);
