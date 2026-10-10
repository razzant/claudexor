import { directDelegatedChildrenFromRecords, type CommandListQuery } from "@claudexor/schema";
import { parseCommandListQuery } from "../command-list-select.js";
import { publicJobRecord, type JobRecord } from "../job-record.js";
import type { CommandQueries } from "../store-contracts.js";
import type { BlobFiles } from "./blob-files.js";
import {
  commandRow,
  commandSummary,
  hydrateCommand,
  type MaintenanceCommandSummary,
} from "./command-rows.js";
import type { EngineStore } from "./store.js";

type SummaryRow = {
  id: string;
  pid: number;
  run_id: string | null;
  created_at: string;
  summary: Uint8Array;
};
const COLUMNS = "c.id,c.pid,c.run_id,c.created_at,c.summary";

/** Exact resource custody, distinct from the existence of a historical receipt. */
export interface ModelResourceQueries {
  expiredResponses(now: string): string[];
  nextResponseExpiry(): string | null;
  retainsResourceBytes(resourceId: string, now: string): boolean;
  hasTerminalResourceReceipt(resourceId: string): boolean;
}

export const MODEL_RETAINS_RESOURCE_SQL = `SELECT (
  EXISTS(SELECT 1 FROM command INDEXED BY command_request_resource WHERE request_resource_id = ?1
    AND kind = 'model' AND live = 1 AND state IN ('queued','running'))
  OR EXISTS(SELECT 1 FROM command INDEXED BY command_response_resource WHERE response_resource_id = ?1
    AND kind = 'model' AND live = 1 AND response_state = 'ready' AND response_expires_at > ?2)) AS owned`;

export const MODEL_TERMINAL_RESOURCE_SQL = `SELECT (
  EXISTS(SELECT 1 FROM command INDEXED BY command_request_resource WHERE request_resource_id = ?1
    AND kind = 'model' AND live = 1 AND state NOT IN ('queued','running'))
  OR EXISTS(SELECT 1 FROM command INDEXED BY command_response_resource WHERE response_resource_id = ?1
    AND kind = 'model' AND live = 1 AND state NOT IN ('queued','running'))) AS bound`;

/** Every collection selects compact rows through an address or keyset page.
 * Only id/turn detail and getByRunId hydrate the selected full record. */
export class SqlCommandQueries implements CommandQueries, ModelResourceQueries {
  constructor(
    private readonly store: EngineStore,
    private readonly blobs: BlobFiles,
  ) {}

  getByRunId(runId: string): JobRecord | undefined {
    const row = this.rows("c.run_id = ?", [runId])[0];
    return row ? this.detail(row.id) : undefined;
  }

  select(query: CommandListQuery): JobRecord[] {
    return this.selectRows(parseCommandListQuery(query), false);
  }

  publicList(query: CommandListQuery): JobRecord[] {
    return this.selectRows(parseCommandListQuery(query), true).map(publicJobRecord);
  }

  active(): JobRecord[] {
    return this.rows("c.state IN ('queued','running')", []).map(commandSummary);
  }

  count(): number {
    return Number(
      (this.store.prepare("SELECT count(*) AS n FROM command").get() as { n: number }).n,
    );
  }

  /** Newest retained operations for this harness, without params/result bodies. */
  maintenanceForHarness(harness: string): MaintenanceCommandSummary[] {
    return (
      this.store
        .prepare(
          `SELECT summary FROM command INDEXED BY command_maintenance_harness
      WHERE live=1 AND kind='maintenance' AND json_extract(CAST(summary AS TEXT),'$.params.harness')=?
      ORDER BY created_at DESC,rowid DESC`,
        )
        .all(harness) as Array<{ summary: Uint8Array }>
    ).map((row) => {
      const record = commandSummary(row);
      return {
        id: record.id,
        state: record.state,
        createdAt: record.createdAt,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        harness,
        evidence: record.result as MaintenanceCommandSummary["evidence"],
      };
    });
  }

  expiredResponses(now: string): string[] {
    return (
      this.store
        .prepare(
          `SELECT id FROM command INDEXED BY command_expiry
      WHERE kind='model' AND live=1 AND response_state='ready' AND response_expires_at <= ?
        AND state NOT IN ('queued','running') ORDER BY response_expires_at,id`,
        )
        .all(now) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  nextResponseExpiry(): string | null {
    const row = this.store
      .prepare(
        `SELECT response_expires_at FROM command INDEXED BY command_expiry
      WHERE kind='model' AND live=1 AND response_state='ready' AND response_expires_at IS NOT NULL
      ORDER BY response_expires_at LIMIT 1`,
      )
      .get() as { response_expires_at: string } | undefined;
    return row?.response_expires_at ?? null;
  }

  retainsResourceBytes(resourceId: string, now: string): boolean {
    return (
      Number(
        (this.store.prepare(MODEL_RETAINS_RESOURCE_SQL).get(resourceId, now) as { owned: number })
          .owned,
      ) === 1
    );
  }

  hasTerminalResourceReceipt(resourceId: string): boolean {
    return (
      Number(
        (this.store.prepare(MODEL_TERMINAL_RESOURCE_SQL).get(resourceId) as { bound: number })
          .bound,
      ) === 1
    );
  }

  private detail(id: string): JobRecord {
    const row = commandRow(this.store, id);
    if (!row) throw new Error(`no such job: ${id}`);
    return hydrateCommand(row, this.blobs);
  }

  private selectRows(query: CommandListQuery, product: boolean): JobRecord[] {
    if ("id" in query) {
      const row = this.rows("(c.id = ? OR c.run_id = ?)", [query.id, query.id], product)[0];
      return row ? [this.detail(row.id)] : [];
    }
    if ("turnId" in query) {
      const row = this.rows(
        "c.turn_id = ?",
        [query.turnId],
        product,
        "c.created_at DESC,c.rowid DESC LIMIT 1",
      )[0];
      return row ? [this.detail(row.id)] : [];
    }
    if ("page" in query) {
      const { cursor, state, limit } = query.page;
      const where = ["1=1"];
      const args: Array<string | number> = [];
      if (state !== null) {
        where.push("c.state = ?");
        args.push(state);
      }
      if (cursor) {
        where.push("(c.created_at,c.id) < (?,?)");
        args.push(cursor.createdAt, cursor.id);
      }
      args.push(limit + 1);
      return this.rows(
        where.join(" AND "),
        args,
        product,
        "c.created_at DESC,c.id DESC LIMIT ?",
      ).map(commandSummary);
    }
    if ("ids" in query)
      return this.rows(
        "(c.id IN (SELECT value FROM json_each(?)) OR c.run_id IN (SELECT value FROM json_each(?)))",
        [JSON.stringify(query.ids), JSON.stringify(query.ids)],
        product,
      ).map(commandSummary);
    if ("delegatedFromRunId" in query)
      return directDelegatedChildrenFromRecords(
        query.delegatedFromRunId,
        this.rows("c.delegated_from = ?", [query.delegatedFromRunId], product).map(commandSummary),
      );
    if ("continuationChainOf" in query) {
      const seed = this.rows(
        "(c.id = ? OR c.run_id = ?)",
        [query.continuationChainOf, query.continuationChainOf],
        product,
      )[0];
      if (!seed) return [];
      const visited = new Map([[seed.id, seed]]);
      const pending = [seed];
      for (let i = 0; i < pending.length; i++) {
        const parent = pending[i]!;
        for (const child of this.rows(
          "c.continue_from IN (?,?)",
          [parent.id, parent.run_id ?? parent.id],
          product,
        )) {
          if (visited.has(child.id)) continue;
          visited.set(child.id, child);
          pending.push(child);
        }
      }
      return this.byIds([...visited.keys()], product).map(commandSummary);
    }
    if ("delegatedDescendantsOf" in query) {
      const queue = [query.delegatedDescendantsOf];
      const seen = new Set(queue);
      const out: JobRecord[] = [];
      for (let i = 0; i < queue.length; i++)
        for (const child of this.rows("c.delegated_from = ?", [queue[i]!], product)) {
          const id = child.run_id ?? child.id;
          if (seen.has(id)) continue;
          seen.add(id);
          queue.push(id);
          out.push(commandSummary(child));
        }
      return out;
    }
    if ("threadId" in query || "threadIds" in query) {
      const threadIds = "threadId" in query ? [query.threadId] : query.threadIds;
      const active = "activeOnly" in query && query.activeOnly === true;
      const members = this.rows(
        `c.thread_id IN (SELECT value FROM json_each(?))${active ? " AND c.state IN ('queued','running')" : ""}`,
        [JSON.stringify(threadIds)],
        product,
      );
      if (active || members.length === 0) return members.map(commandSummary);
      const children = this.rows(
        "c.delegated_from IN (SELECT value FROM json_each(?))",
        [JSON.stringify(members.map((row) => row.run_id ?? row.id))],
        product,
      );
      return this.byIds([...new Set([...members, ...children].map((row) => row.id))], product).map(
        commandSummary,
      );
    }
    return this.rows("c.state IN ('queued','running')", [], product).map(commandSummary);
  }

  private byIds(ids: string[], product: boolean): SummaryRow[] {
    return this.rows("c.id IN (SELECT value FROM json_each(?))", [JSON.stringify(ids)], product);
  }

  private rows(
    where: string,
    args: Array<string | number>,
    product = false,
    order?: string,
  ): SummaryRow[] {
    // Legacy enumeration is global then registry-created projects, each in
    // first command insertion order. Joins occur only for the addressed set;
    // public pages use their separate createdAt/id index order without joins.
    const joins = order
      ? ""
      : ` JOIN partition p ON p.id=c.pid
      LEFT JOIN project pr ON pr.current_pid=c.pid AND pr.status='active'`;
    const ordering = order ?? "(p.name='global') DESC,pr.created_at,pr.rowid,c.rowid";
    return this.store
      .prepare(
        `SELECT ${COLUMNS} FROM command c${joins}
      WHERE c.live=1${product ? " AND c.kind='product'" : ""} AND ${where} ORDER BY ${ordering}`,
      )
      .all(...args) as SummaryRow[];
  }
}
