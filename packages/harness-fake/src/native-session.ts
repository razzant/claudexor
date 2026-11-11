import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import type { NativeSessionExport } from "@claudexor/core";

const FAKE_NATIVE_STORE_ENV = "CLAUDEXOR_FAKE_NATIVE_STORE";

/** The format is this package's own, so its proof is its definition. It proves the
 * engine's export lifecycle and qualifies no vendor's format. */
export const fakeSessionExport: NativeSessionExport = {
  storeRoot: () => process.env[FAKE_NATIVE_STORE_ENV] ?? null,
  sessionLocations: { sessions: 1 },
  laneCredentialStores: [],
  formatEvidence: {
    fixture: "defined by @claudexor/harness-fake",
    vendorVersions: [],
    platforms: [process.platform],
    // Everything this fake writes for a session belongs with its one transcript.
    transcriptOf: (rel, id) => (rel.startsWith(`sessions/${id}`) ? `sessions/${id}.jsonl` : null),
    versionField: null,
  },
  outOfClosure: [],
};

/** A store-holding session for the exact-export contract: a transcript, a spilled
 * sidecar and a compressed part. Written only under an explicit fixture store. */
export function recordFakeSession(nativeSessionId: string, prompt: string): void {
  const store = process.env[FAKE_NATIVE_STORE_ENV];
  if (!store) return;
  const sessions = join(store, "sessions");
  mkdirSync(join(sessions, nativeSessionId, "tool-results"), { recursive: true });
  const line = `${JSON.stringify({ type: "user", session_id: nativeSessionId, prompt })}\n`;
  appendFileSync(join(sessions, `${nativeSessionId}.jsonl`), line);
  writeFileSync(join(sessions, nativeSessionId, "tool-results", "spilled.txt"), `${prompt}\n`);
  writeFileSync(
    join(sessions, `${nativeSessionId}.jsonl.zst`),
    zstdCompressSync(Buffer.from(line)),
  );
}
