import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { WorkProduct, WorkspaceFilesManifest } from "@claudexor/schema";
import { sha256, readFileUtf8BoundedSync } from "@claudexor/util";
import { safeArtifactPath } from "./artifact-paths.js";
import { artifactReadFault } from "./run-artifact-read.js";
import type { DaemonRunRecord } from "./run-record.js";
import { projectionRead } from "./projection-context.js";

/** Exact immutable result, shared by apply, display, and artifact streaming. */
export function readFilesWorkProduct(record: Pick<DaemonRunRecord, "runDir">, maxBytes?: number) {
  return projectionRead(record.runDir ?? "", `files-work-product:${maxBytes ?? "all"}`, () =>
    readFilesWorkProductRaw(record, maxBytes),
  );
}

function readFilesWorkProductRaw(record: Pick<DaemonRunRecord, "runDir">, maxBytes?: number) {
  if (!record.runDir) return null;
  const runDir = record.runDir;
  // A record that is there but cannot be read is refused typed (#535 R14 O3).
  const read = (relPath: string) => {
    try {
      const path = safeArtifactPath(runDir, relPath);
      if (!path) return null;
      return maxBytes === undefined
        ? readFileSync(path, "utf8")
        : readFileUtf8BoundedSync(path, maxBytes);
    } catch (error) {
      throw artifactReadFault(relPath, error);
    }
  };
  const workProductText = projectionRead<string | null>(
    runDir,
    `files-work-product:raw:${maxBytes ?? "all"}:final/work_product.yaml`,
    () => read("final/work_product.yaml"),
  );
  if (workProductText === null) return null;
  // Authority parsing keeps this reader's path policy and unredacted bytes:
  // presentation redaction must not change the immutable manifest binding.
  const workProduct = WorkProduct.parse(parseYaml(workProductText));
  if (workProduct.kind !== "files") return null;
  const manifestPath = workProduct.files.manifest;
  const manifestSha256 = workProduct.meta.manifest_sha256;
  if (typeof manifestPath !== "string" || typeof manifestSha256 !== "string")
    throw new Error("Files work product has no immutable manifest reference");
  const text = projectionRead<string | null>(
    runDir,
    `files-work-product:raw:${maxBytes ?? "all"}:${manifestPath}`,
    () => read(manifestPath),
  );
  if (text === null) throw new Error("Files work product manifest is unavailable");
  if (sha256(text) !== manifestSha256) throw new Error("Files manifest digest mismatch");
  return {
    workProduct,
    manifest: WorkspaceFilesManifest.parse(JSON.parse(text)),
    manifestPath,
    manifestSha256,
    artifactRoot: record.runDir,
    text,
  };
}
