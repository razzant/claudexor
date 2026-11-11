import resourceRefSchema from "@claudexor/schema/generated/ResourceAttachmentRef.schema.json" with { type: "json" };
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";

export const attachmentRefsSchema = {
  type: "array",
  items: inlineJsonSchemaRefs(resourceRefSchema),
  description:
    "Immutable resource references from upload finalize. Paths, base64 and internal resolved attachments are rejected; ordinary lane admission still applies.",
};
