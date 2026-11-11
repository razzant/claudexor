import { McpUploadImportInput } from "@claudexor/schema";
import { flagStr, requiredStringFlagError, type ParsedArgs } from "./args.js";
import { printJson } from "./cli-io.js";
import { renderCliFailure, usageError } from "./cli-error.js";
import { uploadQuery } from "./upload-query.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Import JSON carries only metadata; the file, store id and key stay explicit arguments. */
const ImportMetadata = McpUploadImportInput.pick({ kind: true, mime: true, name: true }).strict();

/** Terminal spelling of the same finite MCP/HTTP controls. */
export async function uploadCommand(args: ParsedArgs, json: boolean): Promise<number> {
  try {
    const error = requiredStringFlagError(args, [
      "request-json",
      "idempotency-key",
      "expected-store-id",
    ]);
    if (error) throw usageError(error, { code: "invalid_argument" });
    const action =
      args._[0] === "store-identity"
        ? "store_identity"
        : (args._[0]?.slice("upload-".length).replaceAll("-", "_") ?? "");
    const rawRequest = flagStr(args, "request-json");
    let request: unknown;
    if (rawRequest !== undefined) {
      try {
        request = JSON.parse(rawRequest);
      } catch {
        throw usageError("--request-json must contain a JSON object", { code: "invalid_argument" });
      }
    }
    // Import takes optional kind/mime/name overrides as its request body.
    if (action === "import" && request !== undefined && !isRecord(request))
      throw usageError("--request-json must contain a JSON object", { code: "invalid_argument" });
    const metadata =
      action === "import" && request !== undefined ? ImportMetadata.parse(request) : {};
    const input = {
      ...(action === "store_identity"
        ? {}
        : action === "import"
          ? {
              ...metadata,
              path: args._[1],
              ...(flagStr(args, "expected-store-id") !== undefined
                ? { expectedStoreId: flagStr(args, "expected-store-id") }
                : {}),
            }
          : {
              ...(action !== "create" ? { uploadId: args._[1] } : {}),
              ...(action === "import_local" ? { path: args._[2] } : {}),
              ...(request !== undefined ? { request } : {}),
            }),
      ...(flagStr(args, "idempotency-key") !== undefined
        ? { idempotencyKey: flagStr(args, "idempotency-key") }
        : {}),
    };
    printJson(await uploadQuery(action, input));
    return 0;
  } catch (error) {
    return renderCliFailure(json, error, { messagePrefix: "claudexor upload:" });
  }
}
