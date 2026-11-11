import { Session, Thread, ThreadTurn } from "@claudexor/schema";
import type { EngineStore } from "./store.js";
import { decodeBody } from "./thread-rows.js";

const RetainedTurn = ThreadTurn.omit({ prompt: true });
type Body = { id: string; pid: number; body: Uint8Array };
type ThreadRow = Body & { state: string };
type SessionRow = Body & { harness_id: string; thread_id: string };
type TurnRow = Body & { thread_id: string };

/** One typed reader for the initial inventory AND changed-owner rechecks.
 * Protection only grows during a pass; release is recognized by the next pass. */
export class RetentionReferenceReader {
  readonly runs = new Set<string>();
  readonly sessions = new Map<string, Set<string>>();
  readonly roots = new Set<string>();
  /** Lane directories are named by globally unique thread id, independent of
   * the project spelling that happened to produce their runtime namespace. */
  readonly laneThreadIds = new Set<string>();

  constructor(
    private readonly store: EngineStore,
    private readonly ignored: ReadonlySet<string>,
    private readonly retained: (pid: number) => boolean,
  ) {}

  add = (id: string | null | undefined) => {
    if (id) this.runs.add(id);
  };

  thread(row: ThreadRow): Thread | undefined {
    if (row.state === "purged") {
      this.purgedLane(row);
      return;
    }
    if (!this.retained(row.pid)) return;
    const thread = this.read("thread", row, () => Thread.parse(decodeBody(row)));
    if (thread.state !== row.state || thread.id !== row.id)
      throw new Error(
        `thread ${row.id} in partition ${row.pid}: retention state or identity disagrees`,
      );
    if (thread.repo) this.roots.add(thread.repo.root);
    this.laneThreadIds.add(thread.id);
    if (this.ignored.has(thread.id) && thread.state === "trashed") return;
    thread.run_ids.forEach(this.add);
    this.add(thread.head_run_id);
    return thread;
  }

  /** A purge obligation still open owns its lane: only the purge owner removes
   * it, after rechecking what a conditional retirement accepted; the orphan
   * sweep must not delete those bytes first. */
  private purgedLane(row: ThreadRow): void {
    if (
      !this.store
        .prepare("SELECT 1 FROM effect_obligation WHERE kind='purge_fs' AND key=?")
        .get(row.id)
    )
      return;
    this.laneThreadIds.add(row.id);
  }

  /** Add lane owners from a quarantined partition without decoding its body.
   * Quarantine is precisely the state in which the body may be malformed. */
  addQuarantinedLaneThreadIds(pid?: number): void {
    const rows = this.store
      .prepare(
        `SELECT t.id FROM thread t JOIN partition q ON q.id=t.pid
         LEFT JOIN project p ON p.id=q.project_id LEFT JOIN partition g ON g.id=p.pid
         WHERE t.state<>'purged' AND (q.status='quarantined' OR g.status='quarantined')
         ${pid === undefined ? "" : "AND (q.id=? OR p.pid=?)"}`,
      )
      .all(...(pid === undefined ? [] : [pid, pid])) as Array<{ id: string }>;
    for (const row of rows) this.laneThreadIds.add(row.id);
  }

  turn(row: TurnRow, owner = this.owner(row.thread_id)): void {
    if (!this.retained(row.pid) || !owner) return;
    const turn = this.read("turn", row, () => RetainedTurn.parse(decodeBody(row)));
    if (turn.thread_id !== owner.id || turn.id !== row.id)
      throw new Error(`turn ${row.id} in partition ${row.pid}: retention owner disagrees`);
    [turn.run_id, turn.parent_run_id, turn.answers_plan_run_id, turn.plan_run_id].forEach(this.add);
  }

  session(row: SessionRow, owner = this.owner(row.thread_id)): void {
    if (!this.retained(row.pid) || !owner) return;
    const session = this.read("session", row, () => Session.parse(decodeBody(row)));
    if (
      session.thread_id !== owner.id ||
      session.harness_id !== row.harness_id ||
      session.id !== row.id
    )
      throw new Error(`session ${row.id} in partition ${row.pid}: retention owner disagrees`);
    if (session.native_session_id) {
      const ids = this.sessions.get(session.harness_id) ?? new Set<string>();
      ids.add(session.native_session_id);
      this.sessions.set(session.harness_id, ids);
    }
  }

  refresh(table: "thread" | "turn" | "session" | "interaction", id: string): void {
    if (table === "interaction") {
      const row = this.store
        .prepare("SELECT pid,run_id FROM interaction WHERE id=? AND state='pending'")
        .get(id) as { pid: number; run_id: string } | undefined;
      if (row && this.retained(row.pid)) this.add(row.run_id);
    } else if (table === "thread") {
      this.owner(id);
    } else if (table === "turn") {
      const row = this.store
        .prepare("SELECT id,pid,thread_id,body FROM turn WHERE id=?")
        .get(id) as TurnRow | undefined;
      if (row) this.turn(row);
    } else {
      const row = this.store
        .prepare("SELECT id,pid,thread_id,harness_id,body FROM session WHERE id=?")
        .get(id) as SessionRow | undefined;
      if (row) this.session(row);
    }
  }

  private read<T>(table: string, row: Body, read: () => T): T {
    try {
      return read();
    } catch (error) {
      throw new Error(`retention ${table} ${row.id} in partition ${row.pid}: ${String(error)}`, {
        cause: error,
      });
    }
  }

  private owner(id: string): Thread | undefined {
    const row = this.store.prepare("SELECT id,pid,state,body FROM thread WHERE id=?").get(id) as
      ThreadRow | undefined;
    if (!row) return;
    const thread = this.thread(row);
    if (thread && thread.id !== id)
      throw new Error(`thread ${id} in partition ${row.pid}: retention owner disagrees`);
    return thread;
  }
}
