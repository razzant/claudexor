/**
 * An external MCP controller asks a general question without a project over
 * the BUILT `claudexor mcp serve` and a real disposable daemon with the
 * deterministic fake harness: the keyed launch is recovered from a restarted
 * server in another directory, while a changed body or a second scope is
 * refused. Fixture-only; no vendor runs.
 */
import { expect, it } from "vitest";
import { afterEachClosed } from "../../cli/src/test-support/after-each-closed.js";
import { makeSandbox, type Sandbox } from "./support.js";
import { closeThenDispose, mcpStdioClient, type McpStdioClient } from "./mcp-stdio.js";
import { daemonApi, follow, ok, refused, TERMINAL } from "./mcp-controller-support.js";

let sandbox: Sandbox | undefined;
const clients: McpStdioClient[] = [];
afterEachClosed((context) => {
  const owned = sandbox;
  sandbox = undefined;
  return closeThenDispose(context, owned, clients.splice(0));
});

function connect(sb: Sandbox, opts: { cwd?: string } = {}): McpStdioClient {
  const client = mcpStdioClient(sb, opts);
  clients.push(client);
  return client;
}

it("[INV-071:mcp-no-project-ask] answers a keyed Ask without a project, replays it from another directory, and refuses changed bodies or two scopes", async () => {
  sandbox = makeSandbox();
  const first = connect(sandbox);
  await first.initialize();
  const launch = {
    prompt: "Answer a general question.",
    noProject: true,
    harness: "fake-success",
    idempotencyKey: "no-project-launch",
  };
  const accepted = await ok(first, "claudexor_ask", launch);
  expect(accepted.jobId).toBeTruthy();
  await follow(first, accepted.runId ?? accepted.jobId, 0, (_events, page) =>
    TERMINAL.includes(page.status),
  );
  await first.kill();

  // A restarted server in another directory recovers the same accepted launch.
  const second = connect(sandbox, { cwd: sandbox.home });
  await second.initialize();
  const replay = await ok(second, "claudexor_ask", launch);
  expect(replay.jobId).toBe(accepted.jobId);
  expect(replay.runId).toBeTruthy();
  if (accepted.runId) expect(replay.runId).toBe(accepted.runId);
  const result = await ok(second, "claudexor_run_result", { runId: replay.runId });
  expect(result.status).toBe("succeeded");

  const conflict = await refused(second, "claudexor_ask", { ...launch, prompt: "Another one." });
  expect(conflict.text).toContain("idempotency_conflict");
  const twoScopes = await refused(second, "claudexor_ask", { ...launch, repoPath: sandbox.repo });
  expect(twoScopes.failure).toMatchObject({ code: "no_project_scope_conflict" });

  const api = daemonApi(sandbox);
  const detail = await api(`/runs/${encodeURIComponent(replay.runId)}`);
  expect(detail.summary.project).toMatchObject({ kind: "none", root: null, context: "off" });
  // Nothing registered the MCP server's working directory as a project.
  expect((await api("/projects")).projects).toEqual([]);
  expect((await ok(second, "claudexor_runs", {})).total).toBe(1);
}, 240_000);
