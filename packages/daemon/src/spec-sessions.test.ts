import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal } from "@claudexor/journal";
import { afterEach, describe, expect, it } from "vitest";
import { SpecSessionStore } from "./spec-sessions.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(root?: string) {
  const dir = root ?? realpathSync(mkdtempSync(join(tmpdir(), "claudexor-spec-sessions-")));
  if (!root) roots.push(dir);
  const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "project:test" });
  return { dir, journal, store: new SpecSessionStore(journal) };
}

const request = {
  prompt: "Implement durable specs",
  threadId: "th-test",
  scope: { kind: "project" as const, root: "/tmp/project", context: "auto" as const },
};

describe("SpecSessionStore", () => {
  it("deduplicates create and journals questions, answers and frozen output", () => {
    const f = fixture();
    const created = f.store.create({ request, idempotencyKey: "create-1", clientId: "test" });
    const repeated = f.store.create({ request, idempotencyKey: "create-1", clientId: "test" });
    expect(repeated.reused).toBe(true);
    expect(repeated.session.sessionId).toBe(created.session.sessionId);
    expect(created.session.threadId).toBe("th-test");

    const id = created.session.sessionId;
    f.store.completeGrounding(id, {
      planRunId: "run-plan",
      planText: "## Open Questions\n- [text] Name?",
      questions: [
        {
          id: "q1",
          tier: 0,
          prompt: "Name?",
          kind: "text",
          options: [],
          allow_text: true,
          rationale: "Choose the product name.",
        },
      ],
    });
    f.store.recordAnswers(id, {
      answers: [{ question_id: "q1", option_ids: [], text: "Claudexor" }],
    });
    expect(f.store.beginFreeze(id).planText).toContain("Open Questions");
    f.store.completeFreeze(id, {
      specId: "spec-1",
      specDir: "/external/spec-1",
      specPath: "/external/spec-1/spec.json",
      specHash: "abc",
      changes: [],
    });
    expect(f.store.frozenResult(id)).toMatchObject({ sessionId: id, state: "frozen" });
    expect(f.store.cancel(id)).toMatchObject({ sessionId: id, state: "cancelled" });
    f.journal.close();

    const restarted = fixture(f.dir);
    expect(restarted.store.get(id)).toMatchObject({
      state: "cancelled",
      specId: "spec-1",
      threadId: "th-test",
    });
    restarted.journal.close();
  });

  it("marks an in-flight grounding session interrupted after restart", () => {
    const first = fixture();
    const session = first.store.create({ request, idempotencyKey: "create-2", clientId: "test" });
    first.journal.close();

    const second = fixture(first.dir);
    expect(second.store.get(session.session.sessionId)).toMatchObject({
      state: "interrupted_unknown",
      error: expect.stringContaining("restarted"),
    });
    expect(second.store.restart(session.session.sessionId)).toMatchObject({
      action: "grounding",
      session: { state: "grounding" },
    });
    second.journal.close();
  });

  it("resumes an interrupted freeze without discarding journaled interview state", () => {
    const first = fixture();
    const created = first.store.create({
      request,
      idempotencyKey: "freeze-resume",
      clientId: "test",
    });
    const id = created.session.sessionId;
    first.store.completeGrounding(id, {
      planRunId: "run-plan",
      planText: "## Open Questions\n- [text] Name?",
      questions: [
        {
          id: "q1",
          tier: 0,
          prompt: "Name?",
          kind: "text",
          options: [],
          allow_text: true,
          rationale: "Choose the product name.",
        },
      ],
    });
    first.store.recordAnswers(id, {
      answers: [{ question_id: "q1", option_ids: [], text: "Claudexor" }],
    });
    first.store.beginFreeze(id);
    first.journal.close();

    const second = fixture(first.dir);
    expect(second.store.get(id)).toMatchObject({ state: "interrupted_unknown" });
    expect(second.store.restart(id)).toMatchObject({
      action: "freezing",
      session: {
        state: "answered",
        planRunId: "run-plan",
        answers: [{ question_id: "q1", text: "Claudexor" }],
      },
    });
    expect(second.store.material(id)).toMatchObject({
      planText: "## Open Questions\n- [text] Name?",
      answers: { answers: [{ question_id: "q1", text: "Claudexor" }] },
    });
    second.journal.close();
  });

  it("rejects idempotency-key reuse with a different prompt", () => {
    const f = fixture();
    f.store.create({ request, idempotencyKey: "same", clientId: "test" });
    expect(() =>
      f.store.create({
        request: { ...request, prompt: "Different" },
        idempotencyKey: "same",
        clientId: "test",
      }),
    ).toThrow(/different request/);
    f.journal.close();
  });
});
