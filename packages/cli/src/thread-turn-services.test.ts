import { describe, expect, it } from "vitest";
import { threadTurnServices } from "./thread-turn-services.js";

describe("thread turn creation", () => {
  it("writes the prompt body off the request thread before the turn commits", async () => {
    const calls: string[] = [];
    const turn = { id: "turn-1" };
    const services = threadTurnServices(
      {
        stageTurnPrompt: async (id: string, prompt: string) => {
          await Promise.resolve();
          calls.push(`stage:${id}:${prompt.length}`);
        },
        createTurn: (id: string, prompt: string) => {
          calls.push(`create:${id}:${prompt.length}`);
          return turn;
        },
      } as never,
      { resolve: () => [] } as never,
    );
    expect(await services.createThreadTurn("thread-1", "p".repeat(70_000), {})).toBe(turn);
    expect(calls).toEqual(["stage:thread-1:70000", "create:thread-1:70000"]);
  });
});
