/** Built stdio MCP -> actual sandbox HTTP upload owner -> verified text fixture.
 * No real accounts/vendors; this proves byte custody, not PDF/DOCX extraction. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { expect, it } from "vitest";
import { afterEachClosed } from "../../cli/src/test-support/after-each-closed.js";
import { daemonApi, follow, ok, refused, TERMINAL } from "./mcp-controller-support.js";
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

it("[INV-064:mcp-document-custody] replays upload stages and reads immutable Unicode bytes in Ask, Agent and a thread", async () => {
  sb = makeSandbox();
  const started = cli(sb, ["daemon", "start", "--json"]);
  expect(started.code, started.stdout + started.stderr).toBe(0);
  let mcp = await connect(sb);
  const api = daemonApi(sb);
  const sourceDir = join(sb.home, "文書 e\u0301");
  mkdirSync(sourceDir);
  const source = join(sourceDir, "Привет 🙂.txt");
  // The random marker exists only in the explicit file, never in any prompt.
  const text = `\uFEFF文書 e\u0301 Привет 🙂 ${randomUUID()}\r\nsecond line\r\n`;
  const bytes = Buffer.from(text);
  const expectedSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  writeFileSync(source, bytes);
  const projectBefore = readdirSync(sb.repo).sort();
  const create = {
    idempotencyKey: randomUUID(),
    request: { kind: "file", mime: "text/plain", name: "Привет 🙂.txt", sizeBytes: bytes.length },
  };
  const upload = await ok(mcp, "claudexor_upload_create", create);
  expect(upload).toMatchObject({ state: "open", receivedBytes: 0, expectedBytes: bytes.length });
  expect(await ok(mcp, "claudexor_upload_create", create)).toEqual(upload);
  expect(
    (
      await refused(mcp, "claudexor_upload_create", {
        ...create,
        request: { ...create.request, name: "other.txt" },
      })
    ).failure,
  ).toMatchObject({ code: "idempotency_conflict" });
  const target = { uploadId: upload.uploadId };
  const imported = await ok(mcp, "claudexor_upload_import_local", { ...target, path: source });
  expect(imported).toMatchObject({
    ...target,
    state: "uploaded",
    receivedBytes: bytes.length,
    expectedSha256,
  });
  const status = await ok(mcp, "claudexor_upload_status", target);
  expect(status).toMatchObject({ ...target, state: "uploaded", receivedBytes: bytes.length });
  expect(await api(`/uploads/${upload.uploadId}`)).toEqual(status);
  // Recover a digest from an uploaded part without overwriting its bytes.
  expect(await ok(mcp, "claudexor_upload_import_local", { ...target, path: source })).toEqual(
    imported,
  );
  const finalize = { ...target, idempotencyKey: randomUUID(), request: { expectedSha256 } };
  const resource = await ok(mcp, "claudexor_upload_finalize", finalize);
  expect(resource).toMatchObject({
    kind: "file",
    mime: "text/plain",
    sha256: expectedSha256,
    sizeBytes: bytes.length,
  });
  expect(resource.resourceId).toEqual(expect.any(String));
  await mcp.close();
  mcp = await connect(sb);
  expect(await ok(mcp, "claudexor_upload_finalize", finalize)).toEqual(resource);
  expect(
    (
      await refused(mcp, "claudexor_upload_finalize", {
        ...finalize,
        request: { expectedSha256: `sha256:${"0".repeat(64)}` },
      })
    ).failure,
  ).toMatchObject({ code: "idempotency_conflict" });
  // Source removal cannot affect the finalized resource or later turns.
  rmSync(sourceDir, { recursive: true });
  const attachments = [{ resourceId: resource.resourceId }];
  let immutablePath: string | undefined;
  const output = async (handle: Record<string, any>, mode: "ask" | "agent") => {
    const runId = handle.runId ?? handle.jobId;
    expect(runId).toEqual(expect.any(String));
    const done = await follow(mcp, runId, 0, (_events, page) => TERMINAL.includes(page.status));
    expect(done.page.status).toBe("succeeded");
    const result = await ok(mcp, "claudexor_run_result", { runId });
    expect(result.outcomeFacts).toMatchObject({ work_state: { state: "completed" } });
    expect(result.runFacts.mode).toBe(mode);
    const producer = result.runFacts.deliverable.producer_attempt_id;
    expect(producer).toEqual(expect.any(String));
    // Decode only the identified producer's typed final WorkReport message.
    // Ask's final artifact has a canonical title wrapper; Agent's is the answer.
    const finals = done.events.filter(
      ({ event }) =>
        event.type === "harness.event" &&
        event.payload?.attempt_id === producer &&
        event.payload?.type === "message" &&
        event.payload?.final === true,
    );
    expect(finals).toHaveLength(1);
    const envelope = JSON.parse(finals[0].event.payload.text);
    expect(envelope.work_report).toEqual({ state: "completed", required_inputs: [] });
    const delivered = JSON.parse(envelope.output);
    expect(delivered).toEqual([
      { resourceId: resource.resourceId, path: expect.any(String), text },
    ]);
    expect(readRunFile(result.runDir, "final/answer.md")).toBe(
      mode === "ask" ? `# Answer\n\n${envelope.output}\n` : `${envelope.output}\n`,
    );
    const path = delivered[0].path as string;
    expect(isAbsolute(path)).toBe(true);
    const relativeBlob = relative(realpathSync(sb!.configDir), realpathSync(path));
    expect(relativeBlob).not.toBe("..");
    expect(relativeBlob.startsWith(`..${sep}`) || isAbsolute(relativeBlob)).toBe(false);
    expect(path.startsWith(sb!.repo + sep)).toBe(false);
    expect(readFileSync(path)).toEqual(bytes);
    if (immutablePath) expect(path).toBe(immutablePath);
    immutablePath = path;
  };
  const launch = {
    prompt: "Read the attached fixture document.",
    repoPath: sb.repo,
    harness: "fake-document",
    attachments,
    web: "off",
  };
  await output(await ok(mcp, "claudexor_ask", launch), "ask");
  await output(await ok(mcp, "claudexor_run", { ...launch, review: false }), "agent");
  const thread = await ok(mcp, "claudexor_thread_create", {
    repoPath: sb.repo,
    defaultMode: "ask",
    primaryHarness: "fake-document",
    eligibleHarnesses: ["fake-document"],
    access: "readonly",
    idempotencyKey: randomUUID(),
  });
  const turn = {
    threadId: thread.threadId,
    prompt: "Read the same immutable document in this turn.",
    attachments,
    idempotencyKey: randomUUID(),
    web: "off",
  };
  const accepted = await ok(mcp, "claudexor_thread_turn", turn);
  await output(accepted, "ask");
  expect(await ok(mcp, "claudexor_thread_turn", turn)).toMatchObject({ turnId: accepted.turnId });
  expect(
    (await ok(mcp, "claudexor_thread_read", { threadId: thread.threadId })).turns,
  ).toHaveLength(1);

  const count = (await ok(mcp, "claudexor_runs", {})).total;
  for (const bad of [
    [{ path: source }],
    [{ resourceId: resource.resourceId, path: source }],
    [{ resourceId: "" }],
  ]) {
    await refused(mcp, "claudexor_ask", { ...launch, attachments: bad });
    await refused(mcp, "claudexor_thread_turn", {
      ...turn,
      attachments: bad,
      idempotencyKey: randomUUID(),
    });
  }
  expect(
    (
      await refused(mcp, "claudexor_ask", {
        ...launch,
        attachments: [{ resourceId: "missing-resource" }],
      })
    ).failure,
  ).toMatchObject({ code: "resource_not_found" });
  expect(
    (await refused(mcp, "claudexor_ask", { ...launch, harness: "fake-success" })).failure,
  ).toMatchObject({ code: "attachment_pool_unsupported" });
  expect((await ok(mcp, "claudexor_runs", {})).total).toBe(count);

  // Synthetic sensitive path only; never inspect the operator's files.
  const sensitive = join(sb.home, ".env");
  const dummy = "fixture-only\n";
  writeFileSync(sensitive, dummy);
  const blocked = await ok(mcp, "claudexor_upload_create", {
    idempotencyKey: randomUUID(),
    request: { ...create.request, name: "safe.txt", sizeBytes: Buffer.byteLength(dummy) },
  });
  expect(
    (
      await refused(mcp, "claudexor_upload_import_local", {
        uploadId: blocked.uploadId,
        path: sensitive,
      })
    ).failure,
  ).toMatchObject({ code: "sensitive_resource_rejected" });
  expect(await ok(mcp, "claudexor_upload_status", { uploadId: blocked.uploadId })).toMatchObject({
    state: "open",
    receivedBytes: 0,
  });
  expect(await ok(mcp, "claudexor_upload_cancel", { uploadId: blocked.uploadId })).toMatchObject({
    state: "cancelled",
  });
  expect(readdirSync(sb.repo).sort()).toEqual(projectBefore);
  expect(readFileSync(immutablePath!)).toEqual(bytes);
}, 240_000);
