// Follow the existing scripted Orchestrator fixture into the actual detail and artifact HTTP routes.
import { execFileSync } from "node:child_process";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fixtureCheckpoint } from "./fixture.config.mjs";
import { run } from "./src/packages/orchestrator/src/inrun-continuity.test-support.ts";
import { DaemonControlApiServer } from "./src/packages/control-api/dist/index.js";
import * as schema from "./src/packages/schema/dist/index.js";

const report = ["# Picnic checklist", "",
  ...Array.from({ length: 120 }, (_, i) => `- Basket ${i + 1} has a label.`)].join("\n");
const messages = [report, "The picnic checklist above is complete."];
const malformed = "One deliberately unreadable synthetic record.";
const documentPath = "final/final-messages.jsonl";
// ONE shared synthetic picnic prompt reaches BOTH the orchestrator run
// (input.prompt overrides the test-support default) and the daemon record
// below, so the served detail provably describes that same prompt.
const prompt = "Plan the picnic: list what goes in the basket.";

// Validate the actual ordinary HTTP body against the published decoder schema.
// Do not substitute the candidate's decoder if the tag is absent or unreadable.
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const readAs620 = ajv.compile(JSON.parse(execFileSync("git", ["show", "v6.2.0:packages/schema/generated/ControlRunDetail.schema.json"], { cwd: join(import.meta.dirname, "src"), encoding: "utf8" })));

const control = process.env.P06_CONTROL;
for (const scenario of control ? ["same-finals"] : ["complete", "partial", "gap"]) {
  it("emits terminal HTTP bytes / " + scenario, async () => {
    const mark = (checkpoint) => fixtureCheckpoint("307", scenario, checkpoint);
    mark("scripted-run");
    const { result, root, spawns } = await run({
      mode: "ask", profiles: ["a"],
      input: { prompt, onRunStart({ runDir }) {
        if (scenario === "partial") appendFileSync(join(runDir, "events.jsonl"), malformed + "\n");
        if (scenario === "gap") mkdirSync(join(runDir, documentPath), { recursive: true });
      } },
      script: function* ({ emit }) {
        yield emit({ type: "started" });
        yield emit({ type: "message", text: messages[0], final: true, payload: { final_source: "result" } });
        // Synthetic background completion between the two finals, mirroring the
        // product scenario (final-messages.integration.test.ts): the second
        // final must prove late confirmation, not just two adjacent finals.
        // No provider routing or probing is involved — this is one more
        // synthetic harness event on the same fake run.
        yield emit({ type: "status", text: "background task finished" });
        yield emit({ type: "message", text: messages[1], final: true, payload: { final_source: "result", native_turn_id: "turn-2" } });
        yield emit({ type: "completed" });
      },
    });
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(spawns).toHaveLength(1);
    expect(spawns[0].prompt).toContain(prompt);
    const record = { id: "job-" + result.runId, runId: result.runId, taskId: result.taskId,
      state: result.lifecycle, runDir: result.runDir, params: { mode: "ask", prompt,
        scope: { kind: "project", root }, harnesses: ["fake"], n: 1 } };
    const daemon = {
      status: async () => record, list: async (query) => query && "delegatedFromRunId" in query ? [] : [record],
      enqueue: async () => { throw new Error("Read-only fixture"); },
      cancel: async () => { throw new Error("Read-only fixture"); },
    };
    const api = new DaemonControlApiServer({ token: "picnic-control", daemon });
    try {
      mark("operations");
      const { host, port } = await api.start();
      expect(host).toBe("127.0.0.1");
      const url = "http://" + host + ":" + port + "/v2/runs/" + result.runId;
      const headers = { Authorization: "Bearer picnic-control", "X-Claudexor-Protocol-Major": String(schema.CONTROL_PROTOCOL_MAJOR) };
      const get = async (target) => {
        const r = await fetch(target, { headers });
        expect(r.status).toBe(200);
        return Buffer.from(await r.arrayBuffer());
      };
      const catalogBytes = await get(`http://${host}:${port}/v2/operations`);
      const descriptor = JSON.parse(catalogBytes).operations.find(op => op.method === "GET" && op.path === "/v2/runs/:id");
      expect(descriptor).toBeDefined();
      const supported = descriptor.parameters.some(p => p.location === "query" && p.name === "includeFinalMessages" && p.enum?.includes("true"));
      expect(supported).toBe(control !== "base");
      // Default GET and ?includeFinalMessages=false must satisfy the released
      // 6.2.0 STRICT schema, carry no finalMessages, and keep the last short
      // final as the primary output.
      mark("legacy-detail");
      const readPlain620 = (bytes) => {
        const plain = JSON.parse(bytes);
        expect(readAs620(plain), "plain detail must satisfy the released 6.2.0 strict schema").toBe(true);
        expect(plain).not.toHaveProperty("finalMessages");
        expect(plain.primaryOutput?.text).toBe("# Answer\n\n" + messages[1] + "\n");
        return plain;
      };
      const defaultBytes = await get(url);
      readPlain620(defaultBytes);
      if (supported) readPlain620(await get(url + "?includeFinalMessages=false"));
      mark("served-detail");
      const detailBytes = supported ? await get(url + "?includeFinalMessages=true") : defaultBytes;
      const dir = join(process.env.P06_OUT, "307", scenario);
      mkdirSync(dir, { recursive: true });
      const save = (name, value) => writeFileSync(join(dir, name), value, { flag: "wx" });
      save("detail.json", detailBytes);
      if (scenario === "complete" || scenario === "same-finals") {
        save("operations.json", catalogBytes);
        save("default-detail.json", defaultBytes);
      }
      const detail = schema.ControlRunDetail.parse(JSON.parse(detailBytes));
      const pointer = detail.finalMessages;
      mark("event-journal");
      const rawLines = readFileSync(join(result.runDir, "events.jsonl"), "utf8").trimEnd().split("\n");
      expect(rawLines.filter(line => line === malformed)).toHaveLength(scenario === "partial" ? 1 : 0);
      const lines = rawLines.filter(line => line !== malformed);
      const rows = lines.map(line => JSON.parse(line));
      const terminal = rows.find(row => row.type === "run.completed");
      expect(pointer).toEqual(terminal.payload.final_messages);
      if (control) {
        // Two real typed finals reached the log — separated by a synthetic
        // background event — and both versions served the same primary answer.
        // Observe what each then makes available by HTTP.
        const finals = rows.filter(e => e.type === "harness.event" && e.payload.type === "message" && e.payload.final === true);
        expect(finals.map(e => e.payload.text)).toEqual(messages);
        const intervening = rows.find(e => e.type === "harness.event" && e.payload.type === "status" && e.payload.text === "background task finished" && e.seq > finals[0].seq && e.seq < finals[1].seq);
        expect(intervening).toBeDefined();
        expect(finals[1].payload.payload.native_turn_id).toBe("turn-2");
        mark("primary-artifact");
        const primary = await fetch(url + "/artifacts/final/answer.md", { headers });
        expect(primary.status).toBe(200);
        const answer = Buffer.from(await primary.arrayBuffer());
        expect(answer.toString()).toBe("# Answer\n\n" + messages[1] + "\n");
        save("primary.md", answer);
        mark(control === "base" ? "baseline-artifact" : "enriched-artifact");
        const artifact = await fetch(url + "/artifacts/" + documentPath, { headers });
        const bytes = Buffer.from(await artifact.arrayBuffer());
        if (control === "base") {
          mark("baseline-artifact-fetch");
          expect(JSON.parse(detailBytes)).not.toHaveProperty("finalMessages");
          expect(artifact.status).toBe(404);
          mark("baseline-artifact-status");
          // The inner readArtifactFile 404 {error:'no such artifact'} never
          // reaches the wire as-is: the v2 json() layer projects every >=400
          // JSON error into application/problem+json, the same form the
          // existing same-route 404 tests pin as {code:'http_404', ...}.
          expect(artifact.headers.get("content-type") ?? "").toContain("application/problem+json");
          const problem = JSON.parse(bytes);
          expect(problem).toMatchObject({ code: "http_404", message: "no such artifact" });
          expect(problem).not.toHaveProperty("error");
          mark("baseline-artifact-body");
          save("artifact-error.json", bytes);
        } else {
          expect(pointer).toMatchObject({ state: "complete", path: documentPath, count: 2, bytes: bytes.length });
          expect(artifact.status).toBe(200);
          expect("sha256:" + createHash("sha256").update(bytes).digest("hex")).toBe(pointer.sha256);
          expect(bytes.toString().trimEnd().split("\n").slice(1).map(s => JSON.parse(s).payload.text)).toEqual(messages);
          expect(bytes.equals(readFileSync(join(result.runDir, documentPath)))).toBe(true);
          save("final-messages.jsonl", bytes);
          save("pointer.json", JSON.stringify(pointer, null, 2) + "\n");
        }
        save("observation.json", JSON.stringify({ finals: finals.map(e => e.payload.text),
          backgroundEventBetweenFinals: true,
          spawns: spawns.length, artifactStatus: artifact.status, primaryStatus: primary.status }, null, 2) + "\n");
        mark("teardown");
        return;
      }
      if (scenario === "gap") {
        mark("artifact-gap");
        expect(pointer).toEqual({ state: "unavailable", reason: "publication_failed" });
      } else {
        mark("enriched-artifact");
        expect(pointer).toMatchObject({ state: scenario, count: 2, path: documentPath });
        const artifact = await fetch(url + "/artifacts/" + pointer.path, { headers });
        expect(artifact.status).toBe(200);
        const bytes = Buffer.from(await artifact.arrayBuffer());
        expect(bytes.equals(readFileSync(join(result.runDir, pointer.path)))).toBe(true);
        expect(bytes.length).toBe(pointer.bytes);
        expect("sha256:" + createHash("sha256").update(bytes).digest("hex")).toBe(pointer.sha256);
        const [first, ...records] = bytes.toString("utf8").split("\n");
        expect(records.pop()).toBe("");
        const header = JSON.parse(first);
        expect(header).toMatchObject({ schemaVersion: 1, state: scenario, runId: result.runId, count: 2, throughEventSeq: pointer.throughEventSeq });
        const finals = lines.filter((_, i) => rows[i].type === "harness.event" && rows[i].payload.type === "message" &&
          rows[i].payload.final === true && rows[i].payload.payload?.delta !== true && rows[i].payload.payload?.buffered !== true);
        expect(records).toEqual(finals);
        expect(records.map(line => JSON.parse(line).payload.text)).toEqual(messages);
        save("final-messages.jsonl", bytes);
      }
      // This is an extracted JSON value. detail.json above is the unmodified wire body.
      save("pointer.json", JSON.stringify(pointer, null, 2) + "\n");
      mark("teardown");
    } finally {
      await api.stop();
    }
  }, 60_000);
}
