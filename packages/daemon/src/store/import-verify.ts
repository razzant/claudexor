import type { JournalRecord } from "@claudexor/journal";
import { hashJson } from "@claudexor/util";
import { parseMutation } from "../thread-store-support.js";
import { sqlEventVerdict } from "./retention.js";
import { ImportContext, importError } from "./import-context.js";
import type { ImportSource } from "./import-source.js";

/** Level 1 compares source tuples and dropped thread state using the same
 * single temp connection. It does not execute import reducers a second time. */
export function verifyImportedPartition(
  sql: ImportContext,
  source: ImportSource,
  pid: number,
): number {
  const expected = new Map<number, JournalRecord>();
  // readImportSource already applied the canonical legacy fold. SQL only
  // removes entity snapshots from that retained set; added group keys do not
  // change which setup saves or decision records survive.
  for (const record of source.records) {
    const verdict = sqlEventVerdict({ ...record, byteLength: 0 });
    if (verdict.drop) continue;
    expected.set(record.seq, record);
  }
  let compared = 0;
  for (const row of sql
    .prepare("SELECT seq,time,type,payload,payload_sha FROM event WHERE pid=? ORDER BY seq")
    .iterate(pid) as Iterable<{
    seq: number;
    time: string;
    type: string;
    payload: Uint8Array;
    payload_sha: string | null;
  }>) {
    const wanted = expected.get(row.seq);
    const payload = JSON.parse(
      (row.payload_sha ? sql.read(row.payload_sha) : Buffer.from(row.payload)).toString("utf8"),
    );
    if (
      !wanted ||
      row.time !== wanted.time ||
      row.type !== wanted.type ||
      hashJson(payload) !== hashJson(wanted.payload)
    )
      throw importError(
        "store_import_equivalence_mismatch",
        `event mismatch ${source.source.name}:${row.seq}`,
      );
    expected.delete(row.seq);
    compared++;
  }
  if (expected.size)
    throw importError(
      "store_import_equivalence_mismatch",
      `missing events in ${source.source.name}`,
    );
  const identity = sql.prepare("SELECT name,epoch,next_seq FROM partition WHERE id=?").get(pid) as {
    name: string;
    epoch: string;
    next_seq: number;
  };
  if (
    identity.name !== source.source.name ||
    identity.epoch !== source.epoch ||
    identity.next_seq !== source.nextSeq
  )
    throw importError(
      "store_import_equivalence_mismatch",
      `partition identity mismatch ${source.source.name}`,
    );
  const marker = sql
    .prepare("SELECT previous_frame_hash,digest FROM import_partition WHERE pid=?")
    .get(pid) as { previous_frame_hash: string; digest: string };
  if (marker.previous_frame_hash !== source.previousFrameHash || marker.digest !== source.digest)
    throw importError(
      "store_import_equivalence_mismatch",
      `source chain mismatch ${source.source.name}`,
    );
  return compared + verifyThreadRows(sql, source, pid);
}

function verifyThreadRows(sql: ImportContext, source: ImportSource, pid: number): number {
  const groups = {
    threads: new Map<string, unknown>(),
    turns: new Map<string, unknown>(),
    sessions: new Map<string, unknown>(),
    checkpoints: new Map<string, unknown>(),
  };
  for (const entry of source.records) {
    if (entry.type !== "thread.entities_upserted") continue;
    const mutation = parseMutation(entry.payload);
    for (const key of ["threads", "turns", "sessions", "checkpoints"] as const)
      for (const item of mutation[key] ?? []) {
        const identity =
          key === "checkpoints"
            ? `${(item as { thread_id: string }).thread_id}\0${(item as { harness_id: string }).harness_id}\0${(item as { profile_id?: string | null }).profile_id ?? ""}`
            : item.id;
        // Existing lane move keeps the stable checkpoint entity under its new lane.
        if (key === "checkpoints")
          for (const [old, value] of groups[key])
            if ((value as { id: string }).id === item.id) groups[key].delete(old);
        groups[key].set(identity, item);
      }
  }
  let compared = 0;
  for (const [key, table] of [
    ["threads", "thread"],
    ["turns", "turn"],
    ["sessions", "session"],
    ["checkpoints", "lane_checkpoint"],
  ] as const) {
    const actual = sql
      .prepare(`SELECT body${table === "turn" ? ",prompt_sha" : ""} FROM ${table} WHERE pid=?`)
      .all(pid) as Array<{ body: Uint8Array; prompt_sha?: string }>;
    const expected = groups[key];
    if (actual.length !== expected.size)
      throw importError(
        "store_import_equivalence_mismatch",
        `${table} count mismatch in ${source.source.name}`,
      );
    for (const row of actual) {
      const value = JSON.parse(Buffer.from(row.body).toString("utf8"));
      if (row.prompt_sha) value.prompt = sql.read(row.prompt_sha).toString("utf8");
      const id =
        key === "checkpoints"
          ? `${value.thread_id}\0${value.harness_id}\0${value.profile_id ?? ""}`
          : value.id;
      if (hashJson(expected.get(id)) !== hashJson(value))
        throw importError("store_import_equivalence_mismatch", `${table} mismatch ${id}`);
      compared++;
    }
  }
  return compared;
}
