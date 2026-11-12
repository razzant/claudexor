import { afterEach, describe, expect, it, vi } from "vitest";
import { answerInteraction, projectRunInteractions } from "./mcp-run-interactions.js";

vi.mock("./live.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./live.js")>()),
  controlApiFetch: vi.fn(),
}));
import { controlApiFetch } from "./live.js";

const addr = { baseUrl: "http://local", token: "t" };
const pending = {
  interactionId: "q1",
  runId: "run-1",
  requestedAt: "2026-10-19T00:00:00.000Z",
  questions: [
    {
      id: "q",
      question: "Проверка 🙂 ".repeat(5_000),
      options: [{ label: "Продолжить 🚀", description: null }],
    },
  ],
};

afterEach(() => vi.resetAllMocks());

describe("pending interaction projection", () => {
  it("returns complete canonical bodies and converges a job id on its run", () => {
    const detail = {
      summary: { jobId: "job-1", runId: "run-1", state: "running" },
      pendingInteractions: [pending],
    };
    const result = projectRunInteractions("job-1", detail);
    expect(result).toMatchObject({
      runId: "run-1",
      summary: "1 pending interaction(s) for run run-1",
    });
    expect(result["interactions"]).toEqual([
      {
        ...pending,
        attemptId: null,
        harnessId: null,
        sourceTool: null,
        timeoutAt: null,
        // A row without `delivery` (an older engine) keeps its meaning: the agent waits.
        delivery: "blocking",
        questions: [{ ...pending.questions[0], header: null, multi_select: false }],
      },
    ]);
  });

  it.each([undefined, "nope", [{ interactionId: 1 }]])(
    "never invents an empty list from %j",
    (value) => {
      expect(() =>
        projectRunInteractions("run-1", {
          summary: { jobId: "job-1", runId: "run-1" },
          ...(value === undefined ? {} : { pendingInteractions: value }),
        }),
      ).toThrow(/no valid pending interactions/);
    },
  );
});

describe("interaction answers", () => {
  const answer = { interactionId: "q1", answers: [{ questionId: "q", selectedLabels: ["x"] }] };
  const respond = (status: number, body: unknown) =>
    vi.mocked(controlApiFetch).mockResolvedValue(Response.json(body, { status }));

  it("reports delivery with the daemon's typed receipt", async () => {
    respond(200, { accepted: true, status: "delivered" });
    expect(await answerInteraction(addr, "run-1", answer)).toEqual({
      summary: "answer delivered for interaction q1",
      runId: "run-1",
      interactionId: "q1",
      accepted: true,
      status: "delivered",
    });
    expect(controlApiFetch).toHaveBeenCalledOnce();
  });

  it.each([
    [409, "already_resolved"],
    [404, "not_found"],
    [409, "rejected"],
  ] as const)(
    "keeps HTTP %s %s as the typed failure code without retrying",
    async (code, status) => {
      respond(code, {
        code: `http_${code}`,
        message: `interaction ${status}`,
        retryable: false,
        context: { accepted: false, status },
      });
      await expect(answerInteraction(addr, "run-1", answer)).rejects.toMatchObject({
        code: status,
        retryable: false,
        context: { runId: "run-1", interactionId: "q1", status },
        requiredActions: [expect.any(String)],
      });
      expect(controlApiFetch).toHaveBeenCalledOnce();
    },
  );

  it("states that already_resolved never proves this answer landed", async () => {
    respond(409, {
      code: "http_409",
      message: "already resolved",
      retryable: false,
      context: { status: "already_resolved" },
    });
    await expect(answerInteraction(addr, "run-1", answer)).rejects.toMatchObject({
      requiredActions: [
        expect.stringContaining("does not prove this answer was the one delivered"),
      ],
    });
  });

  it("keeps an unknown run a plain typed refusal", async () => {
    respond(404, { code: "http_404", message: "no such run", retryable: false, context: {} });
    await expect(answerInteraction(addr, "run-x", answer)).rejects.toMatchObject({
      code: "http_404",
      message: "no such run",
    });
  });
});
