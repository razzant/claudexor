import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ControlResource,
  ControlUploadCreateRequest,
  ControlUploadStatus,
} from "@claudexor/schema";
import { bindIdempotencyInTx } from "./idempotency.js";
import {
  putResourceInTx,
  putUploadInTx,
  resourceSha,
  type UploadRow,
  type ResourceRow,
} from "./resource-rows.js";
import { parseLegacyUploadBinding, uploadKeyDigest } from "./upload-binding-retention.js";
import type { ImportContext } from "./import-context.js";
import { importError } from "./import-context.js";

export interface ImportResourceReceipt {
  resources: number;
  uploads: number;
  ignoredUploads: string[];
  legacyIdempotency: "present" | "absent";
}

/** Metadata enumeration is a one-time import. The large idempotency directory
 * is never enumerated; only a pending upload's exact recorded key is read. */
export function prepareImportResources(
  root: string,
): (sql: ImportContext) => ImportResourceReceipt {
  const resources: ResourceRow[] = [],
    uploads: UploadRow[] = [],
    ignoredUploads: string[] = [];
  const published = new Set<string>();
  const names = (dir: string) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.endsWith(".json"))
          .sort()
      : [];
  for (const name of names(join(root, "resources"))) {
    const resource = ControlResource.parse(
      JSON.parse(readFileSync(join(root, "resources", name), "utf8")),
    );
    if (name !== `${resource.resourceId}.json`)
      throw importError("store_import_resource_invalid", `resource identity mismatch: ${name}`);
    resources.push({ resource, state: "ready", expiresAt: null, releasedAt: null });
  }
  for (const name of names(join(root, "uploads"))) {
    try {
      const raw = JSON.parse(readFileSync(join(root, "uploads", name), "utf8")) as {
        request: unknown;
        status: unknown;
        finalization?: { key?: unknown };
      };
      const request = ControlUploadCreateRequest.parse(raw.request);
      let status = ControlUploadStatus.parse(raw.status);
      if (!/^[a-zA-Z0-9_-]+$/.test(status.uploadId) || name !== `${status.uploadId}.json`)
        throw new Error("upload identity mismatch");
      if (status.state === "uploading") status = { ...status, state: "open", receivedBytes: 0 };
      const finalization =
        raw.finalization && typeof raw.finalization.key === "string"
          ? parseLegacyUploadBinding(raw.finalization, "finalize", raw.finalization.key)
          : undefined;
      if (
        raw.finalization &&
        (!finalization || (finalization.result as ControlResource).purpose !== request.purpose)
      )
        throw new Error("invalid finalization binding");
      if (
        status.state !== "cancelled" &&
        !existsSync(join(root, "uploads", `${status.uploadId}.part`)) &&
        !finalization
      )
        throw new Error("upload part missing");
      const result = finalization?.result as ControlResource | undefined;
      const row: UploadRow = {
        request,
        status,
        state:
          status.state === "cancelled"
            ? "discarded"
            : status.state === "uploaded"
              ? "uploaded"
              : "open",
        finalizeSha: null,
      };
      if (finalization && result) {
        const keyDigest = uploadKeyDigest("finalize", finalization.key);
        let prior;
        try {
          prior = parseLegacyUploadBinding(
            JSON.parse(readFileSync(join(root, "idempotency", `${keyDigest}.json`), "utf8")),
            "finalize",
            finalization.key,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError))
            throw error;
        }
        if (prior && prior.requestDigest !== finalization.requestDigest)
          throw new Error("conflicting finalization binding");
        row.finalization = { keyDigest, requestDigest: finalization.requestDigest, result };
        row.resourceId = result.resourceId;
        row.state = prior ? "published" : "finalizing";
        row.finalizeSha = prior ? null : resourceSha(result);
        if (prior) published.add(status.uploadId);
      }
      uploads.push(row);
    } catch {
      ignoredUploads.push(name);
    } // Exact legacy restore behavior, disclosed in receipt.
  }
  const legacyIdempotency = existsSync(join(root, "idempotency")) ? "present" : "absent";
  return (sql) => {
    sql.prepare("DELETE FROM effect_obligation WHERE kind='publish_blob' AND pid=0").run();
    sql.prepare("DELETE FROM idempotency WHERE owner='upload' AND pid=0").run();
    sql.prepare("DELETE FROM upload").run();
    sql.prepare("DELETE FROM resource").run();
    for (const row of resources) {
      putResourceInTx(sql, row);
      sql
        .prepare("INSERT OR IGNORE INTO blob(sha256,size,inline) VALUES(?,?,NULL)")
        .run(resourceSha(row.resource), row.resource.sizeBytes);
    }
    for (const row of uploads) {
      putUploadInTx(sql, row);
      if (!row.finalization) continue;
      const { result, keyDigest, requestDigest } = row.finalization;
      bindIdempotencyInTx(sql, {
        owner: "upload",
        pid: 0,
        operation: "finalize",
        keyDigest,
        requestDigest,
        targetId: row.status.uploadId,
        result,
        createdAt: result.createdAt,
      });
      if (!published.has(row.status.uploadId)) {
        putResourceInTx(sql, {
          resource: result,
          state: "publishing",
          expiresAt: null,
          releasedAt: null,
        });
        sql
          .prepare(
            "INSERT INTO effect_obligation(kind,key,pid,created_at,payload,state) VALUES('publish_blob',?,0,?,?,'pending')",
          )
          .run(
            row.status.uploadId,
            result.createdAt,
            Buffer.from(
              JSON.stringify({ sha: resourceSha(result), resource_id: result.resourceId }),
            ),
          );
      }
    }
    sql
      .prepare(
        "INSERT INTO meta(key,value) VALUES('legacy_idempotency_dir',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(legacyIdempotency);
    return {
      resources: resources.length,
      uploads: uploads.length,
      ignoredUploads,
      legacyIdempotency,
    };
  };
}
