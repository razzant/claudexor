import { describe, expect, it } from "vitest";
import { StreamEcho } from "./stream-echo.js";

/** Feed `steps` (a string = fragment, "|" = another event, { complete } = a
 * complete message) and return what each complete message repeats. */
function echoes(
  steps: readonly (string | { complete: string; buffered?: boolean; final?: boolean })[],
) {
  const echo = new StreamEcho();
  const out: (number | "previous" | null)[] = [];
  for (const step of steps) {
    if (step === "|") echo.interrupt();
    else if (typeof step === "string") echo.fragment(step);
    else
      out.push(
        echo.complete(step.complete, {
          buffered: step.buffered === true,
          final: step.final === true,
        }),
      );
  }
  return out;
}

describe("StreamEcho: which complete message exactly repeats streamed text", () => {
  it("a fragment run, all fragments across tools, or a suffix from a fragment's start", () => {
    // Directly after its fragments, a plain message repeating them.
    expect(echoes(["Hel", "lo", { complete: "Hello" }])).toEqual([0]);
    // An Antigravity result: every fragment of the turn, across tool calls.
    expect(
      echoes(["Checking. ", "|", "ha", "ha", { complete: "Checking. haha", final: true }]),
    ).toEqual([0]);
    // An ACP final: the text after its last tool, split by a thought.
    expect(echoes(["draft ", "|", "ans", "|", "wer", { complete: "answer", final: true }])).toEqual(
      [1],
    );
    // A Cursor-shaped snapshot: the run after the last tool, buffered, then flushed.
    expect(
      echoes([
        "draft",
        "|",
        "Final",
        " answer.",
        { complete: "Final answer.", buffered: true },
        { complete: "Final answer." },
      ]),
    ).toEqual([1, "previous"]);
  });

  it("never a suffix that begins inside one uninterrupted run (no producer sends one)", () => {
    expect(echoes(["Intro. ", "Answer", { complete: "Answer", buffered: true }])).toEqual([null]);
    expect(echoes(['[{"claim":"a', 'b"}]', { complete: 'b"}]', final: true }])).toEqual([null]);
    // The same text from a run start after another event still repeats.
    expect(echoes(["Intro. ", "|", "Answer", { complete: "Answer", final: true }])).toEqual([1]);
  });

  it("never a substring, a prefix, a cut through a fragment or trimmed text", () => {
    expect(echoes(["Hello ", "world", { complete: "world!", final: true }])).toEqual([null]);
    expect(echoes(["Hello ", "world", { complete: "Hello", final: true }])).toEqual([null]);
    expect(echoes(["Hello ", "world", { complete: "orld", final: true }])).toEqual([null]);
    expect(echoes(["Hello ", "world\n", { complete: "Hello world", final: true }])).toEqual([null]);
    expect(echoes(["Hello", { complete: "Hello Hello", final: true }])).toEqual([null]);
  });

  it("only an adjacent message repeats: after a fragment or a snapshot, or itself buffered or final", () => {
    // A plain message after another event is new text, even when identical.
    expect(echoes(["Hello", "|", { complete: "Hello" }])).toEqual([null]);
    expect(echoes(["Hello", "|", { complete: "Hello", buffered: true }])).toEqual([0]);
    expect(echoes(["Hello", "|", { complete: "Hello", final: true }])).toEqual([0]);
  });

  it("with no fragment since, the previous complete message; then everything starts over", () => {
    expect(
      echoes([
        "Hi",
        { complete: "Hi", buffered: true },
        { complete: "Hi" },
        { complete: "Hi", final: true },
        { complete: "Hi" },
        { complete: "Other", final: true },
        "Hi",
        { complete: "Hi there", final: true },
      ]),
    ).toEqual([0, "previous", "previous", null, null, null]);
  });

  it("a typed final ends its native turn: an equal later message is new text", () => {
    expect(
      echoes([
        { complete: "OK", final: true },
        { complete: "OK", final: true },
        { complete: "OK", buffered: true },
      ]),
    ).toEqual([null, null, null]);
  });

  it("text a speech key identifies resets the echo: it repeats nothing and is not repeated", () => {
    const echo = new StreamEcho();
    echo.fragment("Part one.");
    echo.reset();
    expect(echo.complete("Part one.", { buffered: false, final: true })).toBeNull();
    echo.complete("Hello", { buffered: true, final: false });
    echo.reset();
    expect(echo.complete("Hello", { buffered: false, final: false })).toBeNull();
    expect(echo.fragment("a")).toBe(false);
  });

  it("reports whether a fragment continues the open run", () => {
    const echo = new StreamEcho();
    expect(echo.fragment("a")).toBe(false);
    expect(echo.fragment("b")).toBe(true);
    echo.interrupt();
    expect(echo.fragment("c")).toBe(false);
    echo.complete("abc", { buffered: false, final: true });
    expect(echo.fragment("d")).toBe(false);
  });
});
