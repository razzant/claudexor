import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HarnessRunSpec, type Attachment, type HarnessEvent } from "@claudexor/schema";
import { createFakeHarness, FAKE_KINDS } from "./index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function fixture(mime = "text/plain") {
  const root = mkdtempSync(join(tmpdir(), "fake-doc-"));
  roots.push(root);
  const text = `\uFEFF文書 e\u0301 Привет 🙂 ${randomUUID()}\r\n`;
  const path = join(root, "文書.txt");
  const bytes = Buffer.from(text);
  writeFileSync(path, bytes);
  const resource: Attachment = {
    resource_id: "document-resource",
    kind: "file",
    mime,
    name: "文書.txt",
    path,
    size_bytes: bytes.length,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
  const spec = HarnessRunSpec.parse({
    session_id: "document-fixture",
    intent: "implement",
    cwd: root,
    prompt: "prompt-must-never-be-echoed",
    attachments: [resource],
  });
  return { root, text, spec, resource };
}

async function collect(spec: HarnessRunSpec) {
  const events: HarnessEvent[] = [];
  for await (const event of createFakeHarness("fake-document").run(spec)) events.push(event);
  return events;
}

it("registers one finite document fixture while preserving every existing fake's attachment refusal", async () => {
  expect(FAKE_KINDS).toContain("fake-document");
  const manifest = await createFakeHarness("fake-document").discover();
  expect(manifest.capability_profile.attachment_inputs).toEqual([
    {
      kind: "file",
      mime_types: ["text/plain", "text/markdown", "application/json"],
      max_bytes: 65_536,
      max_count: 4,
      transport: "file_path",
    },
  ]);
  expect(manifest.capabilities).toMatchObject({
    json_schema_output: true,
    work_report_transport: "constrained",
    structured_output_channel: "final_message",
  });
  for (const kind of FAKE_KINDS.filter((kind) => kind !== "fake-document")) {
    expect((await createFakeHarness(kind).discover()).capability_profile.attachment_inputs).toEqual(
      [],
    );
  }
});

it.each(["text/plain", "text/markdown", "application/json"])(
  "reads verified %s bytes into a completed final WorkReport without project writes or prompt echo",
  async (mime) => {
    const { root, text, spec, resource } = fixture(mime);
    const events = await collect(spec);
    const final = events.filter((event) => event.type === "message" && event.final);
    expect(final).toHaveLength(1);
    const envelope = JSON.parse(final[0]!.text!);
    expect(envelope.work_report).toEqual({ state: "completed", required_inputs: [] });
    expect(JSON.parse(envelope.output)).toEqual([
      { resourceId: resource.resource_id, path: resource.path, text },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "completed" });
    expect(JSON.stringify(events)).not.toContain(spec.prompt);
    expect(readdirSync(root)).toEqual(["文書.txt"]);
  },
);

it.each(["tamper", "size", "missing", "mime", "kind", "limit", "count"])(
  "refuses %s before producing a document answer",
  async (fault) => {
    const { spec, resource } = fixture();
    if (fault === "tamper") writeFileSync(resource.path, Buffer.alloc(resource.size_bytes));
    if (fault === "size") spec.attachments[0]!.size_bytes++;
    if (fault === "missing") rmSync(resource.path);
    if (fault === "mime") spec.attachments[0]!.mime = "application/pdf";
    if (fault === "kind") spec.attachments[0]!.kind = "image";
    if (fault === "limit") spec.attachments[0]!.size_bytes = 65_537;
    if (fault === "count") spec.attachments = Array(5).fill(resource);
    await expect(collect(spec)).rejects.toBeDefined();
  },
);
