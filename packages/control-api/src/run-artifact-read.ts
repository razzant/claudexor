import { projectionRead } from "./projection-context.js";
import { lstatSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { readFileUtf8BoundedSync } from "@claudexor/util";
import { safeArtifactPath } from "./artifact-paths.js";
import type { DaemonRunRecord } from "./run-record.js";

export function readTextArtifact(
  rec: DaemonRunRecord,
  relPath: string,
  maxBytes?: number,
): string | null {
  return projectionRead(rec.runDir ?? rec.id, `text:${maxBytes ?? "all"}:${relPath}`, () =>
    readRawTextArtifact(rec, relPath, maxBytes),
  );
}

export function readRawTextArtifact(
  rec: DaemonRunRecord,
  relPath: string,
  maxBytes?: number,
): string | null {
  return projectionRead(rec.runDir ?? rec.id, `artifact:raw:${maxBytes ?? "all"}:${relPath}`, () =>
    rawText(rec, relPath, maxBytes),
  );
}

function rawText(rec: DaemonRunRecord, relPath: string, maxBytes?: number): string | null {
  if (!rec.runDir) return null;
  const path = safeArtifactPath(rec.runDir, relPath);
  if (!path) return null;
  const st = lstatSync(path);
  if (st.isSymbolicLink() || st.isDirectory()) return null;
  return maxBytes === undefined
    ? readFileSync(path, "utf8")
    : readFileUtf8BoundedSync(path, maxBytes);
}

export function readStructured<T>(
  text: string | null,
  ext: string,
  schema: { parse(value: unknown): T },
): T | null {
  if (text === null) return null;
  if (ext === ".json") {
    return schema.parse(JSON.parse(text));
  }
  if (ext === ".yaml" || ext === ".yml") {
    return schema.parse(parseYaml(text));
  }
  throw new Error(`unsupported structured artifact extension: ${ext}`);
}

export function safeReadStructuredArtifact<T>(
  rec: DaemonRunRecord,
  relPath: string,
  schema: { parse(value: unknown): T },
  maxBytes?: number,
): T | null {
  return projectionRead(schema, `${rec.runDir ?? rec.id}:${maxBytes ?? "all"}:${relPath}`, () => {
    try {
      return readStructured(readTextArtifact(rec, relPath, maxBytes), extname(relPath), schema);
    } catch (error) {
      if (maxBytes !== undefined && (error as { status?: number }).status === 503) throw error;
      return null;
    }
  });
}
