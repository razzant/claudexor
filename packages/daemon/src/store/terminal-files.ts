import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RunTelemetry, validateRunFactsInvariants, type RunFacts } from "@claudexor/schema";
import { appendLine, hashJson } from "@claudexor/util";
import { parse as parseYaml } from "yaml";
import {
  lstatOrNull,
  normalizedTerminalEvents,
  recoveredTerminalFacts,
} from "../terminal-authority.js";
import { commandSummary } from "./command-rows.js";
import { writeExternalFile } from "./external-files.js";
import type { Obligations, ObligationEffects, ObligationRow } from "./obligations.js";
import { storedTerminal } from "./run-events.js";
import type { EngineStore } from "./store.js";

/** One handler for all partitions. SQL already owns the terminal; file repair
 * never inserts another terminal or changes its outcome. */
export class SqlTerminalFiles {
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

  private write(row: ObligationRow, effects: ObligationEffects): void {
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
    const write = this.io.write ?? writeExternalFile;
    write(this.store, {
      dir: finalDir,
      name: "run_facts.yaml",
      bytes: Buffer.from(`${JSON.stringify(facts, null, 2)}\n`),
    });
    effects.register(finalDir);
    const telemetry = (row.payload as { telemetry?: unknown } | null)?.telemetry;
    if (telemetry !== null && telemetry !== undefined) {
      const prepared = RunTelemetry.parse(telemetry);
      if (hashJson(prepared.run_facts) !== hashJson(facts))
        throw new Error("durable terminal telemetry does not match SQL authority");
      write(this.store, {
        dir: finalDir,
        name: "telemetry.yaml",
        bytes: Buffer.from(`${JSON.stringify(prepared, null, 2)}\n`),
      });
      effects.register(finalDir);
    }
    const eventsPath = join(root, "events.jsonl");
    const existing = lstatOrNull(eventsPath);
    if (existing && (!existing.isFile() || existing.isSymbolicLink()))
      throw new Error("durable terminal event log is not a regular file");
    const bytes = existing ? readFileSync(eventsPath) : Buffer.alloc(0);
    const normalized = Buffer.from(normalizedTerminalEvents(bytes, event, terminalSeq));
    if (!bytes.equals(normalized)) {
      const added = Buffer.from(`${JSON.stringify(event)}\n`);
      if (normalized.equals(Buffer.concat([bytes, added])))
        (this.io.append ?? appendLine)(eventsPath, JSON.stringify(event));
      else write(this.store, { dir: root, name: "events.jsonl", bytes: normalized });
    }
    effects.register(root);
  }
}
