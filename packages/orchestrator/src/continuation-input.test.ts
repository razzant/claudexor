import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { writeContinuationSources } from "@claudexor/workspace";
import { unconfirmedContinuationInputs } from "./continuation-input.js";
import { uncertainInputFor } from "./inrun-continuity-carrier.js";

const roots: string[] = [];
afterEach(
  () => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  0,
); // synchronous removal: no deadline (#376, see vitest.setup.ts)

describe("continuation caller delivery", () => {
  it("marks every cut entry, including zero inline characters, with its complete durable text", () => {
    const runDir = mkdtempSync(join(tmpdir(), "cx-continuation-input-"));
    roots.push(runDir);
    const newest = "New instruction. ".repeat(160);
    const older = "Older instruction still needs reconciliation.";
    const notice = uncertainInputFor(
      runDir,
      [
        { text: newest, runDir },
        { text: older, runDir },
      ],
      new Set(["a01"]),
    )!;
    const cuts = [
      ...notice.matchAll(/\[cut: (\d+) of (\d+) characters; the complete text is in (.+)\]/g),
    ];
    expect(cuts).toHaveLength(2);
    for (const [index, text] of [newest, older].entries()) {
      expect(cuts[index]!.slice(1, 3)).toEqual([
        String(index === 0 ? 2048 : 0),
        String(text.length),
      ]);
      expect(readFileSync(cuts[index]![3]!, "utf8")).toBe(text);
      expect(isAbsolute(cuts[index]![3]!)).toBe(true);
    }
  });

  it("quotes later steering first and reuses complete work-order text", () => {
    const runDir = mkdtempSync(join(tmpdir(), "cx-continuation-input-"));
    roots.push(runDir);
    const older = "Original caller text. ".repeat(120);
    const latest = "Keep the interface";
    mkdirSync(join(runDir, "context"));
    const path = join(runDir, "context", "work-order.md");
    writeFileSync(path, older);
    writeFileSync(
      join(runDir, "events.jsonl"),
      JSON.stringify({
        type: "message.accepted",
        payload: { message_id: "correction", text: latest, attempt_id: "a01" },
      }) + "\n",
    );
    const notice = uncertainInputFor(runDir, [{ text: older, runDir }], new Set(["a01"]))!;
    expect(notice.startsWith(`${latest}\n\n`)).toBe(true);
    expect(notice).toContain(
      `[cut: ${2048 - latest.length} of ${older.length} characters; the complete text is in ${path}]`,
    );
    expect(readFileSync(path, "utf8")).toBe(older);
  });

  it.each([
    "unstarted",
    "mismatch_before_effects",
    "matched_before_effects",
    "another process session started",
  ])("carries unconfirmed caller text (%s)", (identity) => {
    const runDir = mkdtempSync(join(tmpdir(), "cx-continuation-input-"));
    roots.push(runDir);
    writeContinuationSources(runDir, [
      { runId: "run-a", runDir: join(runDir, "a"), state: "failed" },
    ]);
    const rows = [
      { type: "run.created", payload: { prompt: "Keep the existing public interface" } },
      ...(identity === "unstarted"
        ? []
        : [
            {
              type: "harness.event",
              payload: {
                type: "started",
                attempt_id: "a01",
                // The start joins its receipt only through the same process session.
                session_id: identity === "another process session started" ? "ses-2" : "ses-1",
              },
            },
          ]),
      {
        type: "run.continuity",
        payload: {
          attempt_id: "a01",
          session_id: "ses-1",
          receipt: {
            tryIndex: 0,
            attemptId: "a01",
            carrier: "native",
            cause: "transport",
            from: { runId: "run-a", attemptId: "a01", profileId: null },
            to: { profileId: null },
            workspace: "same_root",
            memory: "full",
            instructions: "as_sent",
            reingestedTokens: null,
            observedModel: null,
            modelMismatch: null,
            identityCheck: identity.endsWith("_effects") ? identity : "not_applicable",
            inputDelivery: "confirmed",
          },
        },
      },
    ];
    writeFileSync(
      join(runDir, "events.jsonl"),
      rows
        .map((row, seq) =>
          JSON.stringify({
            seq: seq + 1,
            run_id: "run-b",
            task_id: "task-b",
            ts: new Date().toISOString(),
            ...row,
          }),
        )
        .join("\n") + "\n",
    );
    expect(unconfirmedContinuationInputs([{ runId: "run-b", runDir, state: "failed" }])).toEqual(
      identity === "matched_before_effects"
        ? []
        : [{ text: "Keep the existing public interface", runDir }],
    );
  });
});
