// Run only in the imported guest alongside a clean src/ tree; all native frames are invented.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { fixtureCheckpoint } from "./fixture.config.mjs";
import { sqlFixture } from "./src/packages/daemon/src/store/test-support/sql-fixture.ts";
import { requestBodyText } from "./src/packages/harness-codex/src/test-support/request-body.ts";
import { DaemonClient, DaemonServer, ModelOperations } from "./src/packages/daemon/dist/index.js";
import { DaemonControlApiServer } from "./src/packages/control-api/dist/index.js";
import { createCodexModelAdapter } from "./src/packages/harness-codex/dist/model.js";
import {
  CONTROL_PROTOCOL_MAJOR, ControlModelOperationDetail, CredentialProfile, ModelCallRequest, ModelCallResult,
} from "./src/packages/schema/dist/index.js";

const privateNote = "The picnic basket holds two pears.";
const question = "What is on the picnic menu?";
const parts = [
  { type: "output_text", text: "Menu\n" },
  { type: "refusal", refusal: "" },
  { type: "refusal", refusal: "No picnic today. 🧺" },
  { type: "output_text", text: "\nFin." },
];
const failed = (code, message) => ({
  type: "response.failed",
  response: { status: "failed", error: { code, message }, usage: { input_tokens: 6, output_tokens: 1 } },
});
const completed = (content) => ({
  type: "response.completed",
  response: { model: "test-model", output: [{ type: "message", role: "assistant", content }] },
});
const refusal = failed("cyber_policy", privateNote);
const control = process.env.P06_CONTROL;
const cases = control ? [
  // The same pre-existing route/query, body, HTTP status and adapter input on both trees.
  { name: "same-http-503", http: 503, code: "provider_failed", legacy: true, capture: true },
] : [
  // The terminal refusal and the successfully completed mixed answer are
  // checked as separate cases ("failed" vs "mixed"/"refusal-only"), never
  // merged into one observation.
  { name: "failed", event: refusal, code: "provider_content_refused", capture: true },
  { name: "failed-no-capture", event: refusal, code: "provider_content_refused" },
  { name: "http-refusal", http: 403, code: "provider_content_refused", capture: true },
  { name: "legacy-failure", event: refusal, code: "provider_failed", legacy: true },
  { name: "ordinary-error", event: failed("server_overloaded", "The label reads cyber_policy."), code: "provider_failed" },
  { name: "mixed", event: completed(parts), content: parts.map(p => p.type === "output_text" ? { type: "text", text: p.text } : p) },
  { name: "refusal-only", event: completed([parts[2]]), content: [parts[2]] },
  { name: "legacy-mixed", event: completed(parts), legacy: true, content: "Menu\nNo picnic today. 🧺\nFin." },
  { name: "ordinary-text", event: completed([{ type: "output_text", text: "The label reads cyber_policy." }]), content: "The label reads cyber_policy." },
];

for (const sample of cases) {
  it("emits model HTTP bytes / " + sample.name, async () => {
    const mark = (checkpoint) => fixtureCheckpoint("697", sample.name, checkpoint);
    mark("setup");
    const root = mkdtempSync(join(tmpdir(), "m6-"));
    const sql = await sqlFixture(root);
    const socket = join(root, "s");
    const client = new DaemonClient(socket, "fixture-control");
    const wire = Buffer.from(sample.http
      ? JSON.stringify({ error: { code: "cyber_policy", message: privateNote } })
      : "data: " + JSON.stringify(sample.event) + "\n\n");
    let posts = 0;
    let catalogs = 0;
    let nativeRequest, nativePath;
    const adapter = createCodexModelAdapter({
      now: () => 1900000000000,
      clientVersion: async () => ({ version: "0.156.1", source: "verified_transport" }),
      readAuthFile: async () => JSON.stringify({ auth_mode: "chatgpt", tokens: {
        account_id: "fixture", access_token: "fixture." + Buffer.from('{"exp":2100000000}').toString("base64url") + ".signature",
      } }),
      refresh: async () => { throw new Error("Synthetic account never refreshes"); },
      fetch: async (url, init) => {
        if (init?.method === "POST") {
          posts++;
          nativePath = new URL(url).pathname;
          nativeRequest = await requestBodyText(init);
          return new Response(wire, { status: sample.http ?? 200,
            headers: { "content-type": sample.http ? "application/json" : "text/event-stream" } });
        }
        catalogs++;
        return Response.json({ models: [{ slug: "test-model" }] });
      },
    });
    const profile = CredentialProfile.parse({
      profile_id: "fixture", harness_id: "codex", display_name: "Picnic",
      credential_kind: "config_dir_login",
      isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR, "profiles", "fixture"),
    });
    const ops = new ModelOperations({
      commands: sql.graph.commands, resourceQueries: sql.graph.commands.queries,
      resources: () => sql.graph.resources, resolve: async () => ({ adapter, profile }),
      enqueue: (env) => client.call("claudexor.enqueue", env), cancel: (id, reason) => client.cancel(id, reason),
    });
    const daemon = new DaemonServer({
      socketPath: socket, token: "fixture-control", maxConcurrent: 1, commands: sql.graph.commands,
      runner: (input, ctx) => ops.execute(input, ctx), onCommandTerminal: (record) => ops.onCommandTerminal(record),
    });
    const api = new DaemonControlApiServer({ daemon: client, token: "fixture-control", services: {
      createModelOperation: ops.create.bind(ops), getModelOperation: async (id) => ops.inspect(id),
      readModelResult: async (id) => ops.readResult(id), acknowledgeModelResult: async (id, digest) => ops.acknowledge(id, digest),
    } });
    try {
      await daemon.start();
      const { host, port } = await api.start();
      expect(host).toBe("127.0.0.1");
      mark("operation-admission");
      const endpoint = "http://" + host + ":" + port + "/v2/model-operations";
      const headers = { Authorization: "Bearer fixture-control", "X-Claudexor-Protocol-Major": String(CONTROL_PROTOCOL_MAJOR),
        "Idempotency-Key": "picnic-" + sample.name, "Content-Type": "application/json" };
      const request = ModelCallRequest.parse({ source: "codex", model: "test-model", account: { mode: "pin", profileId: "fixture" },
        messages: [{ role: "user", content: question }] });
      const requestBytes = Buffer.from(JSON.stringify(request));
      const ref = sql.graph.resources.publishModel(requestBytes);
      const params = new URLSearchParams();
      if (!sample.legacy) params.set("typedRefusals", "true");
      if (sample.capture) params.set("captureFailureEvidence", "true");
      const create = () => fetch(endpoint + "?" + params, { method: "POST", headers, body: JSON.stringify({ request: ref }) });
      const accepted = await create();
      expect(accepted.status).toBe(202);
      const { id } = ControlModelOperationDetail.parse(await accepted.json());
      mark("operation-detail");
      const url = endpoint + "/" + id;
      const deadline = Date.now() + 20000;
      let detail, detailBytes;
      do {
        const r = await fetch(url, { headers });
        expect(r.status).toBe(200);
        detailBytes = Buffer.from(await r.arrayBuffer());
        detail = ControlModelOperationDetail.parse(JSON.parse(detailBytes));
        if (!["queued", "running"].includes(detail.state)) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      const dir = join(process.env.P06_OUT, "697", sample.name);
      mkdirSync(dir, { recursive: true });
      const save = (name, value) => writeFileSync(join(dir, name), value, { flag: "wx" });
      save("detail.json", detailBytes);
      if (sample.name === "failed") {
        mark("operations");
        const operations = await fetch(`http://${host}:${port}/v2/operations`, { headers });
        expect(operations.status).toBe(200);
        const catalog = Buffer.from(await operations.arrayBuffer());
        const op = JSON.parse(catalog).operations.find(entry => entry.path === "/v2/model-operations" && entry.method === "POST");
        expect(op.parameters.find(p => p.name === "typedRefusals")).toMatchObject({location:"query", required:false, enum:["true", "false"]});
        save("operations.json", catalog);
        mark("operation-detail");
      }
      expect(detail).toMatchObject({ id, state: sample.code ? "failed" : "succeeded",
        dispatch: { state: "response_received" }, response: { state: "ready" } });
      mark("result-receipt");
      const r = await fetch(url + "/result", { headers });
      expect(r.status).toBe(200);
      const bytes = Buffer.from(await r.arrayBuffer());
      save("result.json", bytes);
      const sha256 = "sha256:" + createHash("sha256").update(bytes).digest("hex");
      expect(r.headers.get("etag")).toBe('"' + sha256 + '"');
      expect(r.headers.get("content-length")).toBe(String(bytes.length));
      expect(detail.response.ref).toMatchObject({ sha256, sizeBytes: bytes.length });
      expect(ops.readResult(id).bytes.equals(bytes)).toBe(true);
      mark("result-shape");
      const result = ModelCallResult.parse(JSON.parse(bytes));
      expect(detail.problem).toEqual(result.problem);
      if (sample.code) {
        expect(result).toMatchObject({ outcome: "failed", problem: { code: sample.code } });
        mark("retryability");
        if (control) expect(result.problem.retryable).toBe(control === "base");
        else if (sample.event === refusal || sample.http) expect(result.problem.retryable).toBe(false);
        mark("detail-privacy");
        expect(detailBytes.toString()).not.toContain(privateNote);
      } else {
        expect(result).toMatchObject({ outcome: "completed", message: { role: "assistant", content: sample.content }, problem: null });
      }
      mark("failure-evidence");
      if (sample.capture) {
        expect(Buffer.from(result.failureEvidence.bodyBase64, "base64").equals(wire)).toBe(true);
      } else expect(result).not.toHaveProperty("failureEvidence");
      // A repeated create with the same idempotency key must return the same
      // operation id without a second native POST to the provider.
      mark("idempotent-replay");
      const replay = await create();
      expect(replay.status).toBe(202);
      expect((await replay.json()).id).toBe(id);
      expect(posts).toBe(1);
      mark("native-request");
      expect(nativePath).toMatch(/\/responses$/);
      expect(JSON.parse(nativeRequest)).toMatchObject({ model: "test-model",
        input: [{ role: "user", content: [{ type: "input_text", text: question }] }] });
      save("transport.json", JSON.stringify({ id, posts, catalogs, idempotentRejoin: true, typedRefusals: !sample.legacy,
        captureFailureEvidence: !!sample.capture, query: params.toString(), nativeStatus: sample.http ?? 200,
        // Hash of the client-side request resource bytes we published.
        requestSha256: createHash("sha256").update(requestBytes).digest("hex"),
        nativePath,
        // Hash of the DECODED native request body: requestBodyText undoes the
        // content encoding (zstd) before this hash, so this is the decoded
        // body text, not the raw wire bytes.
        nativeRequestDecodedBodySha256: createHash("sha256").update(nativeRequest).digest("hex"),
        // Hash of the raw response wire bytes the fake provider returned.
        nativeResponseSha256: createHash("sha256").update(wire).digest("hex"),
        etag: r.headers.get("etag"), contentLength: bytes.length }, null, 2) + "\n");
      mark("teardown");
    } finally {
      try { await api.stop(); } finally {
        try { await daemon.stop(); } finally { ops.close(); await sql.close(); }
      }
    }
  }, 45_000);
}
