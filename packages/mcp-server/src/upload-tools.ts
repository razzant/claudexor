import createSchema from "@claudexor/schema/generated/McpUploadCreateInput.schema.json" with { type: "json" };
import targetSchema from "@claudexor/schema/generated/McpUploadTargetInput.schema.json" with { type: "json" };
import importSchema from "@claudexor/schema/generated/McpUploadImportLocalInput.schema.json" with { type: "json" };
import finalizeSchema from "@claudexor/schema/generated/McpUploadFinalizeInput.schema.json" with { type: "json" };
import keyedImportSchema from "@claudexor/schema/generated/McpUploadImportInput.schema.json" with { type: "json" };
import importStateSchema from "@claudexor/schema/generated/ControlUploadImport.schema.json" with { type: "json" };
import handshakeSchema from "@claudexor/schema/generated/ControlHandshakeResponse.schema.json" with { type: "json" };
import storeIdentitySchema from "@claudexor/schema/generated/McpStoreIdentityInput.schema.json" with { type: "json" };
import importResultSchema from "@claudexor/schema/generated/McpUploadImportLocalResult.schema.json" with { type: "json" };
import statusSchema from "@claudexor/schema/generated/ControlUploadStatus.schema.json" with { type: "json" };
import resourceSchema from "@claudexor/schema/generated/ControlResource.schema.json" with { type: "json" };
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";
import { mcpToolFailure } from "./tool-failure.js";
import type { McpTool, RunnerFn } from "./index.js";

/** No upload state lives in MCP; every call is one finite daemon operation. */
export function uploadTools(runner: RunnerFn): McpTool[] {
  return [
    [
      "claudexor_store_identity",
      "store_identity",
      storeIdentitySchema,
      handshakeSchema,
      "Read the running daemon's durable store identity (storeId) through the opt-in handshake. Save storeId durably with each import key BEFORE claudexor_upload_import, and replay that saved value unchanged; never replace it with a later answer. Resource ids and import keys belong to that store only.",
    ],
    [
      "claudexor_upload_import",
      "import",
      keyedImportSchema,
      importStateSchema,
      "Import one explicit absolute regular file ON THE MCP-SERVER HOST as a ready immutable attachment in one call. First save expectedStoreId (from claudexor_store_identity) and idempotencyKey with the exact arguments; another store is refused before the file is touched. After any uncertainty or failure repeat the identical call: a completed import returns its original resource without reading the file again, even if the file has since changed or been deleted. Different arguments under a used key are refused; a new edition of the file needs a new key. Pass resource.resourceId in run/turn attachments. No remote-client path, URL, glob or directory; bytes only, no parsing or OCR.",
    ],
    [
      "claudexor_upload_create",
      "create",
      createSchema,
      statusSchema,
      "Low-level stage (claudexor_upload_import is the one-call keyed path). Create an ordinary attachment upload. Save the caller-owned idempotencyKey and exact request before calling; replay both after a lost response. Save uploadId before importing bytes.",
    ],
    [
      "claudexor_upload_import_local",
      "import_local",
      importSchema,
      importResultSchema,
      "Stream one explicit absolute regular file ON THE MCP-SERVER HOST into an existing upload using one PUT. No remote-client path, URL, glob or directory. Save uploadId and returned expectedSha256. After an uncertain PUT read status: uploaded -> finalize, uploading -> observe, cancelled -> explicitly create a new upload. Already uploaded bytes are never overwritten; this call can hash the same local file to recover its digest.",
    ],
    [
      "claudexor_upload_status",
      "status",
      targetSchema,
      statusSchema,
      "Read existing upload state once. A finalized upload can return 404: replay finalize with the original key/body to recover its resource; absence is not proof of failure.",
    ],
    [
      "claudexor_upload_finalize",
      "finalize",
      finalizeSchema,
      resourceSchema,
      "Finalize immutable attachment bytes. Save and replay the original caller-owned key and exact request after an unknown response, even if status returns 404. Never auto-cancel uncertain finalization. Attach the returned resourceId to run/turn attachments.",
    ],
    [
      "claudexor_upload_cancel",
      "cancel",
      targetSchema,
      statusSchema,
      "Explicitly cancel an unfinished upload. Do not use cancellation to recover an unknown finalize outcome.",
    ],
  ].map(([name, action, input, output, description]) => ({
    name: name as string,
    description: description as string,
    inputSchema: inlineJsonSchemaRefs(input as Record<string, unknown>),
    outputSchema: inlineJsonSchemaRefs(output as Record<string, unknown>),
    annotations: {
      readOnlyHint: action === "status" || action === "store_identity",
      destructiveHint: action === "cancel",
    },
    handler: async (args, ctx) => {
      try {
        const result = await runner(
          { ...args, mode: `__upload_${action}` },
          ctx.signal ? { signal: ctx.signal } : {},
        );
        return { text: JSON.stringify(result), structured: result as Record<string, unknown> };
      } catch (error) {
        return mcpToolFailure(error);
      }
    },
  }));
}
