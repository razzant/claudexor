import { readVerifiedAttachmentBytes } from "@claudexor/core";
import type { AttachmentInputClass, HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";

/** Explicit offline fixture only: no PDF/DOCX parser or vendor capability claim. */
export const FAKE_DOCUMENT_INPUT: AttachmentInputClass = {
  kind: "file",
  mime_types: ["text/plain", "text/markdown", "application/json"],
  max_bytes: 65_536,
  max_count: 4,
  transport: "file_path",
};

/** Echo actual verified text, never the prompt; create no project files. */
export async function* runFakeDocument(
  spec: HarnessRunSpec,
  observedModel: string,
): AsyncIterable<HarnessEvent> {
  const attachments = spec.attachments;
  if (
    attachments.length > FAKE_DOCUMENT_INPUT.max_count ||
    attachments.some(
      (item) =>
        item.kind !== FAKE_DOCUMENT_INPUT.kind ||
        !FAKE_DOCUMENT_INPUT.mime_types.includes(item.mime) ||
        item.size_bytes > FAKE_DOCUMENT_INPUT.max_bytes,
    )
  ) {
    throw Object.assign(new Error("fake-document received an unsupported input"), {
      code: "attachment_unsupported",
    });
  }
  const output = JSON.stringify(
    attachments.map((item) => ({
      resourceId: item.resource_id,
      path: item.path,
      text: readVerifiedAttachmentBytes(item).toString("utf8"),
    })),
  );
  yield {
    type: "message",
    session_id: spec.session_id,
    ts: nowIso(),
    text: JSON.stringify({
      work_report: { state: "completed", required_inputs: [] },
      output,
    }),
    final: true,
    payload: { final_source: "fake" },
  };
  yield {
    type: "usage",
    session_id: spec.session_id,
    ts: nowIso(),
    usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
  };
  yield {
    type: "completed",
    session_id: spec.session_id,
    ts: nowIso(),
    observed_model: observedModel,
  };
}
