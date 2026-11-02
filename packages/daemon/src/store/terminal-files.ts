import { readFileSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RunTelemetry,
  validateRunFactsInvariants,
  type RunEvent,
  type RunFacts,
} from "@claudexor/schema";
import { appendLine, hashJson } from "@claudexor/util";
import { parse as parseYaml } from "yaml";
import type { JobRecord } from "../job-record.js";
import {
  lstatOrNull,
  normalizedTerminalEvents,
  recoveredTerminalFacts,
} from "../terminal-authority.js";
import { sha256Hex } from "./blob-files.js";
import { commandSummary } from "./command-rows.js";
import {
  publishStagedFile,
  writeExternalFile,
  writeStagedTemp,
  type ExternalWritePurpose,
} from "./external-files.js";
import type { Obligations, ObligationEffects, ObligationRow } from "./obligations.js";
import { storedTerminal } from "./run-events.js";
import type { EngineStore } from "./store.js";

interface TerminalFile {
  dir: string;
  name: string;
  bytes: Buffer;
  purpose: ExternalWritePurpose;
}

const receipt = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** The telemetry receipt for a terminal's RunFacts; a mismatch is refused. */
function telemetryReceipt(telemetry: unknown, facts: RunFacts): Buffer | null {
  if (telemetry === null || telemetry === undefined) return null;
  const prepared = RunTelemetry.parse(telemetry);
  if (hashJson(prepared.run_facts) !== hashJson(facts))
    throw new Error("durable terminal telemetry does not match SQL authority");
  return receipt(prepared);
}

/** What a terminal needs of its per-run log: nothing, its line appended, or a rewrite. */
function eventsRepair(
  bytes: Buffer,
  event: RunEvent,
  terminalSeq: number,
): null | "append" | Buffer {
  const normalized = Buffer.from(normalizedTerminalEvents(bytes, event, terminalSeq));
  if (bytes.equals(normalized)) return null;
  const added = Buffer.from(`${JSON.stringify(event)}\n`);
  return normalized.equals(Buffer.concat([bytes, added])) ? "append" : normalized;
}

/** One handler for all partitions. SQL already owns the terminal; file repair
 * never inserts another terminal or changes its outcome. */
export class SqlTerminalFiles {
  /** Receipts written off the request thread for a run's coming terminal,
   * by final path; the synchronous write publishes those whose bytes match. */
  private readonly staged = new Map<string, Map<string, { temp: string; sha: string }>>();

  constructor(
    private readonly store: EngineStore,
    private readonly obligations: Obligations,
    private readonly io: { write?: typeof writeExternalFile; append?: typeof appendLine } = {},
  ) {
    obligations.registerHandler("terminal_files", (row, effects) => this.write(row, effects));
  }

  pending(runIdOrCommandId: string): boolean {
    return !!this.store
      .prepare(
        "SELECT 1 FROM effect_obligation WHERE kind='terminal_files' AND key=coalesce((SELECT run_id FROM command WHERE id=?1),?1) AND state='pending'",
      )
      .get(runIdOrCommandId);
  }

  materialize(runId: string): void {
    const row = this.obligations.get("terminal_files", runId);
    if (!row) return;
    this.write(row, {
      register: (dir) => this.obligations.registerEffect("terminal_files", runId, dir),
    });
    this.obligations.materialize("terminal_files", runId);
  }

  prepareRecoveryTelemetry(runDir: string, facts: RunFacts): RunTelemetry | null {
    try {
      const telemetry = RunTelemetry.safeParse(
        parseYaml(readFileSync(join(runDir, "final", "telemetry.yaml"), "utf8")),
      );
      return telemetry.success ? RunTelemetry.parse({ ...telemetry.data, run_facts: facts }) : null;
    } catch {
      return null;
    }
  }

  /**
   * Off the request thread, before the synchronous terminal hook: write the
   * receipts (and a needed per-run log rewrite) its file step will publish, as
   * `O_DSYNC` temps with fresh names in the body directory, which the existing
   * orphan sweep reclaims if the process dies first. The hook renames a temp
   * into place, after its SQL commit and in the same synchronous section, only
   * when its bytes equal what it would write; anything else it writes itself.
   */
  async stage(record: JobRecord, event: RunEvent, telemetry: RunTelemetry | null): Promise<void> {
    this.discard(event.run_id);
    const files: TerminalFile[] = [];
    try {
      const { facts, terminalSeq } = recoveredTerminalFacts(record, event);
      const finalDir = join(record.runDir!, "final");
      files.push({
        dir: finalDir,
        name: "run_facts.yaml",
        bytes: receipt(facts),
        purpose: "terminal_receipt",
      });
      const telemetryBytes = telemetryReceipt(telemetry, facts);
      if (telemetryBytes)
        files.push({
          dir: finalDir,
          name: "telemetry.yaml",
          bytes: telemetryBytes,
          purpose: "terminal_receipt",
        });
      const log = await readFile(join(record.runDir!, "events.jsonl")).catch(() => Buffer.alloc(0));
      const repair = eventsRepair(log, event, terminalSeq);
      if (repair instanceof Buffer)
        files.push({
          dir: record.runDir!,
          name: "events.jsonl",
          bytes: repair,
          purpose: "terminal_log",
        });
    } catch {
      return; // the hook decides and writes
    }
    const entries = new Map<string, { temp: string; sha: string }>();
    this.staged.set(event.run_id, entries);
    await Promise.all(
      files.map(async ({ dir, name, bytes }) => {
        try {
          const temp = await writeStagedTemp(this.store.paths.blobs, name, bytes);
          entries.set(join(dir, name), { temp, sha: sha256Hex(bytes) });
        } catch {
          /* the hook writes it */
        }
      }),
    );
  }

  private write(row: ObligationRow, effects: ObligationEffects): void {
    try {
      this.writeFiles(row, effects);
    } finally {
      this.discard(row.key);
    }
  }

  private writeFiles(row: ObligationRow, effects: ObligationEffects): void {
    const event = storedTerminal(this.store, row.key, row.pid);
    const raw = this.store
      .prepare("SELECT summary FROM command WHERE run_id=? AND pid=?")
      .get(row.key, row.pid) as { summary: Uint8Array } | undefined;
    if (!event || !raw) throw new Error("terminal obligation has no canonical command/event");
    const record = commandSummary(raw);
    const { facts, terminalSeq } = recoveredTerminalFacts(record, event);
    const root = record.runDir!;
    const finalDir = join(root, "final");
    const rootStat = lstatOrNull(root),
      finalStat = lstatOrNull(finalDir);
    // Existing retention may already have reclaimed historical file evidence.
    if (!rootStat || !finalStat) return;
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      !finalStat.isDirectory() ||
      finalStat.isSymbolicLink()
    )
      throw new Error("durable terminal run directory is not a canonical directory");
    const factsPath = join(finalDir, "run_facts.yaml");
    const prior = lstatOrNull(factsPath);
    if (prior) {
      if (!prior.isFile() || prior.isSymbolicLink())
        throw new Error("durable terminal RunFacts receipt is not a regular file");
      let value: unknown;
      try {
        value = parseYaml(readFileSync(factsPath, "utf8"));
      } catch {
        value = undefined;
      }
      if (value !== undefined && hashJson(validateRunFactsInvariants(value)) !== hashJson(facts))
        throw new Error("durable terminal RunFacts receipt does not match SQL authority");
    }
    this.publish(row.key, {
      dir: finalDir,
      name: "run_facts.yaml",
      bytes: receipt(facts),
      purpose: "terminal_receipt",
    });
    effects.register(finalDir);
    const telemetry = telemetryReceipt(
      (row.payload as { telemetry?: unknown } | null)?.telemetry,
      facts,
    );
    if (telemetry) {
      this.publish(row.key, {
        dir: finalDir,
        name: "telemetry.yaml",
        bytes: telemetry,
        purpose: "terminal_receipt",
      });
      effects.register(finalDir);
    }
    const eventsPath = join(root, "events.jsonl");
    const existing = lstatOrNull(eventsPath);
    if (existing && (!existing.isFile() || existing.isSymbolicLink()))
      throw new Error("durable terminal event log is not a regular file");
    const bytes = existing ? readFileSync(eventsPath) : Buffer.alloc(0);
    const repair = eventsRepair(bytes, event, terminalSeq);
    if (repair === "append") (this.io.append ?? appendLine)(eventsPath, JSON.stringify(event));
    else if (repair)
      this.publish(row.key, {
        dir: root,
        name: "events.jsonl",
        bytes: repair,
        purpose: "terminal_log",
      });
    effects.register(root);
  }

  /** A staged temp with exactly these bytes is renamed into place; else they are written. */
  private publish(runId: string, file: TerminalFile): void {
    const target = join(file.dir, file.name);
    const staged = this.staged.get(runId)?.get(target);
    if (staged && staged.sha === sha256Hex(file.bytes)) {
      this.staged.get(runId)!.delete(target);
      const published = publishStagedFile(this.store, {
        temp: staged.temp,
        dir: file.dir,
        name: file.name,
        bytes: file.bytes.byteLength,
        purpose: file.purpose,
      });
      if (published) return;
    }
    (this.io.write ?? writeExternalFile)(this.store, file);
  }

  /** A run's staged temps nobody published (bytes changed, or the hook failed) go. */
  private discard(runId: string): void {
    const entries = this.staged.get(runId);
    this.staged.delete(runId);
    for (const { temp } of entries?.values() ?? []) {
      try {
        unlinkSync(temp);
      } catch {
        /* the orphan sweep reclaims it after the next start */
      }
    }
  }
}
