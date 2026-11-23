import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
import schemas from "./run-results-6.2.0.schema.json" with { type: "json" };

const ajv = new Ajv({ strict: false });
const addFormats =
  addFormatsModule.default ?? (addFormatsModule as unknown as typeof addFormatsModule.default);
addFormats(ajv);
ajv.addSchema(schemas, "release-6.2.0");

export function releasedRunReader(
  name: "ControlRunDetail" | "McpRunToolResult" | "McpRunHandleResult",
) {
  return ajv.getSchema(`release-6.2.0#/definitions/${name}`)!;
}
