/** Built stdio MCP + CLI + raw HTTP -> one sandbox daemon's keyed upload import -> fake-document
 * consumers. No real accounts/vendors; this proves byte custody and replay, not parsing. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { afterEachClosed } from "../../cli/src/test-support/after-each-closed.js";
import { follow, ok, refused, TERMINAL } from "./mcp-controller-support.js";
import { closeThenDispose, mcpStdioClient, type McpStdioClient } from "./mcp-stdio.js";
import { cli, makeSandbox, readRunFile, type Sandbox } from "./support.js";

let sb: Sandbox | undefined;
const clients: McpStdioClient[] = [];
afterEachClosed((context) => {
  // This test's sandbox, taken here: a late close never reaches the next test's.
  const owned = sb;
  sb = undefined;
  return closeThenDispose(context, owned, clients.splice(0));
});

async function connect(sandbox: Sandbox) {
  const mcp = mcpStdioClient(sandbox, { cwd: sandbox.home });
  clients.push(mcp);
  await mcp.initialize();
  return mcp;
}

/** The daemon's own HTTP surface, re-resolved per call because a restart moves its port. */
async function http(
  sandbox: Sandbox,
  method: string,
  path: string,
  init: { key?: string; json?: unknown; bytes?: Buffer } = {},
) {
  const daemonDir = join(sandbox.configDir, "daemon");
  const pointer = JSON.parse(readFileSync(join(daemonDir, "control-api.json"), "utf8")) as {
    host: string;
    port: number;
    tokenPath?: string;
  };
  const token = readFileSync(pointer.tokenPath ?? join(daemonDir, "token"), "utf8").trim();
  const response = await fetch(`http://${pointer.host}:${pointer.port}/v2${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "x-claudexor-protocol-major": "3",
      ...(init.key ? { "idempotency-key": init.key } : {}),
      ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.bytes ? { "content-type": "application/octet-stream" } : {}),
    },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    ...(init.bytes ? { body: init.bytes } : {}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const digest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const delivered = (runDir: string) =>
  JSON.parse(readRunFile(runDir, "final/answer.md").replace(/^# Answer\n\n/, "")) as Array<{
    resourceId: string;
    text: string;
  }>;

it("[INV-064:keyed-import-replay] imports once per saved store and key, then replays without the source", async () => {
  sb = makeSandbox();
  const started = cli(sb, ["daemon", "start", "--json"]);
  expect(started.code, started.stdout + started.stderr).toBe(0);
  let mcp = await connect(sb);

  // The store identity is read and saved before any import effect.
  const { storeId } = await ok(mcp, "claudexor_store_identity", {});
  expect(storeId).toMatch(/^[0-9a-f-]{36}$/);
  const cliIdentity = cli(sb, ["store-identity", "--json"]);
  expect(cliIdentity.code, cliIdentity.stderr).toBe(0);
  expect(cliIdentity.json()).toMatchObject({ storeId });
  const handshake = await fetchHandshake(sb);
  expect(handshake).toMatchObject({ storeId });
  const catalog = await http(sb, "GET", "/operations");
  expect(catalog.body.operations).toContainEqual(
    expect.objectContaining({ id: "post:uploads.imports", idempotency: "key_required" }),
  );

  const dir = join(sb.home, "documents 文書");
  mkdirSync(dir);
  const source = join(dir, "Brief 🙂.md");
  const text = `# Brief 🙂\n\nmarker ${randomUUID()}\r\n`;
  const bytes = Buffer.from(text);
  writeFileSync(source, bytes);
  const args = { expectedStoreId: storeId, path: source, idempotencyKey: randomUUID() };
  const ready = await ok(mcp, "claudexor_upload_import", args);
  expect(ready).toMatchObject({
    storeId,
    state: "ready",
    content: { sizeBytes: bytes.length, sha256: digest(bytes) },
    resource: { kind: "file", mime: "text/markdown", name: "Brief 🙂.md", sha256: digest(bytes) },
  });
  expect(await ok(mcp, "claudexor_upload_import", args)).toEqual(ready);
  writeFileSync(source, "a later edition that must not replace the imported bytes\n");
  expect(await ok(mcp, "claudexor_upload_import", args)).toEqual(ready);
  rmSync(source);
  expect(await ok(mcp, "claudexor_upload_import", args)).toEqual(ready);
  expect(
    (await refused(mcp, "claudexor_upload_import", { ...args, name: "renamed.md" })).failure,
  ).toMatchObject({ code: "idempotency_conflict" });
  expect(
    (
      await refused(mcp, "claudexor_upload_import", {
        ...args,
        expectedStoreId: "00000000-0000-4000-8000-000000000000",
      })
    ).failure,
  ).toMatchObject({ code: "store_mismatch" });

  // A restart reopens the same store; the saved store and key still replay.
  await mcp.close();
  expect(cli(sb, ["daemon", "stop", "--json"]).code).toBe(0);
  const restarted = cli(sb, ["daemon", "start", "--json"]);
  expect(restarted.code, restarted.stdout + restarted.stderr).toBe(0);
  mcp = await connect(sb);
  expect(await ok(mcp, "claudexor_store_identity", {})).toMatchObject({ storeId });
  expect(await ok(mcp, "claudexor_upload_import", args)).toEqual(ready);

  // An HTTP client sent complete bytes and lost every reply; the one call completes it
  // from the daemon's receipt although no file exists at the bound source.
  const lostPath = join(dir, "lost.txt");
  const lostBytes = Buffer.from("bytes accepted before the reply was lost\n");
  const lostKey = randomUUID();
  const lostBody = {
    expectedStoreId: storeId,
    kind: "file",
    mime: "text/plain",
    name: "lost.txt",
    source: lostPath,
    content: { sizeBytes: lostBytes.length, sha256: digest(lostBytes) },
  };
  const begun = await http(sb, "POST", "/uploads/imports", { key: lostKey, json: lostBody });
  expect(begun).toMatchObject({ status: 200, body: { storeId, state: "open" } });
  const put = await http(sb, "PUT", `/uploads/${begun.body.uploadId}/bytes`, { bytes: lostBytes });
  expect(put).toMatchObject({ status: 200, body: { state: "uploaded" } });
  const lost = await ok(mcp, "claudexor_upload_import", {
    expectedStoreId: storeId,
    path: lostPath,
    idempotencyKey: lostKey,
  });
  expect(lost).toMatchObject({ state: "ready", resource: { sha256: digest(lostBytes) } });

  // A bound import without complete bytes stays honestly unfinished when its source is gone.
  const draftPath = join(dir, "draft.txt");
  const draftKey = randomUUID();
  const draft = await http(sb, "POST", "/uploads/imports", {
    key: draftKey,
    json: { ...lostBody, name: "draft.txt", source: draftPath },
  });
  expect(draft.body.state).toBe("open");
  expect(
    (
      await refused(mcp, "claudexor_upload_import", {
        expectedStoreId: storeId,
        path: draftPath,
        idempotencyKey: draftKey,
      })
    ).failure,
  ).toMatchObject({
    code: "upload_import_source_unavailable",
    context: { uploadId: draft.body.uploadId, state: "open" },
  });

  // Ready refs are reused by MCP and CLI consumers; the deleted, edited source never matters.
  const resourceId = ready.resource.resourceId as string;
  const handle = await ok(mcp, "claudexor_ask", {
    prompt: "Read the attached document.",
    repoPath: sb.repo,
    harness: "fake-document",
    attachments: [{ resourceId }],
    web: "off",
  });
  const runId = handle.runId ?? handle.jobId;
  const done = await follow(mcp, runId, 0, (_events, page) => TERMINAL.includes(page.status));
  expect(done.page.status).toBe("succeeded");
  const result = await ok(mcp, "claudexor_run_result", { runId });
  expect(delivered(result.runDir)).toEqual([expect.objectContaining({ resourceId, text })]);
  const imported = cli(sb, [
    "upload-import",
    lostPath,
    "--expected-store-id",
    storeId,
    "--idempotency-key",
    lostKey,
    "--json",
  ]);
  expect(imported.code, imported.stdout + imported.stderr).toBe(0);
  expect(imported.json()).toEqual(lost);
  const asked = cli(sb, [
    "ask",
    "Read both attached documents.",
    "--harness",
    "fake-document",
    "--web",
    "off",
    "--attach-resource",
    `${resourceId},${lost.resource.resourceId}`,
    "--json",
  ]);
  expect(asked.code, asked.stdout + asked.stderr).toBe(0);
  const run = asked.json() as { runDir: string; status: string };
  expect(run.status).toBe("succeeded");
  expect(delivered(run.runDir).map((item) => item.text)).toEqual([
    text,
    lostBytes.toString("utf8"),
  ]);
}, 240_000);

async function fetchHandshake(sandbox: Sandbox) {
  const daemonDir = join(sandbox.configDir, "daemon");
  const pointer = JSON.parse(readFileSync(join(daemonDir, "control-api.json"), "utf8")) as {
    host: string;
    port: number;
  };
  const response = await fetch(`http://${pointer.host}:${pointer.port}/v2/handshake`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${readFileSync(join(daemonDir, "token"), "utf8").trim()}`,
      "content-type": "application/json",
      "x-claudexor-store-identity": "1",
    },
    body: JSON.stringify({ protocolMajor: 3, client: "canary-http-client" }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}
