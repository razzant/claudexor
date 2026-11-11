import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  print: vi.fn(),
  printJson: vi.fn(),
  printUsageError: vi.fn((_json: boolean, _message: string) => 2),
}));

vi.mock("./cli-io.js", () => ({
  print: mocks.print,
  printJson: mocks.printJson,
  printUsageError: mocks.printUsageError,
}));

import { FAKE_KINDS } from "@claudexor/harness-fake";
import { parseArgs } from "./args.js";
import { harnessCommand } from "./harness-command.js";

// Dispatch, flag scope and explicit retired-flag errors; vendor execution uses fixtures.
describe("harnessCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists only real harnesses by default — fakes stay undisclosed", () => {
    expect(harnessCommand(parseArgs(["harness", "list"]), true)).toBe(0);
    expect(mocks.printJson).toHaveBeenCalledTimes(1);
    const { harnesses } = mocks.printJson.mock.calls[0]?.[0] as { harnesses: string[] };
    for (const id of ["codex", "claude", "cursor", "copilot"]) expect(harnesses).toContain(id);
    expect(harnesses.filter((id) => (FAKE_KINDS as readonly string[]).includes(id))).toEqual([]);
    expect(mocks.print).not.toHaveBeenCalled();
  });

  it("reveals the fake fixtures with --all and prints one id per line in text mode", () => {
    expect(harnessCommand(parseArgs(["harness", "list", "--all"]), false)).toBe(0);
    const printed = mocks.print.mock.calls.map((call) => call[0] as string);
    for (const id of ["codex", ...FAKE_KINDS]) expect(printed).toContain(id);
    expect(printed).toEqual([...new Set(printed)]);
    expect(mocks.printJson).not.toHaveBeenCalled();
  });

  it("rejects flags the dispatched subcommand does not own with a loud exit-2 usage error", () => {
    // INV-021: `harness list --yes` and `harness install --all` must never
    // silently ignore the stray flag; the usage line names it.
    expect(harnessCommand(parseArgs(["harness", "list", "--yes"]), false)).toBe(2);
    expect(mocks.printUsageError).toHaveBeenLastCalledWith(false, expect.stringContaining("--yes"));
    expect(harnessCommand(parseArgs(["harness", "list", "--dry-run"]), true)).toBe(2);
    expect(mocks.printUsageError).toHaveBeenLastCalledWith(
      true,
      expect.stringContaining("--dry-run"),
    );
    expect(harnessCommand(parseArgs(["harness", "install", "codex", "--all"]), false)).toBe(2);
    expect(mocks.printUsageError).toHaveBeenLastCalledWith(false, expect.stringContaining("--all"));
    // Nothing was listed or installed on any of the refused paths.
    expect(mocks.print).not.toHaveBeenCalled();
    expect(mocks.printJson).not.toHaveBeenCalled();
  });

  it.each(["--release-tested", "--target=local", "--target=remote"])(
    "rejects the retired installer flag %s",
    (flag) => {
      expect(
        harnessCommand(parseArgs(["harness", "install", "codex", flag, "--dry-run"]), true),
      ).toBe(2);
      expect(mocks.printUsageError).toHaveBeenLastCalledWith(
        true,
        expect.stringContaining("retired"),
      );
    },
  );

  it("rejects unknown verbs with the capability-based usage", () => {
    expect(harnessCommand(parseArgs(["harness", "bogus"]), false)).toBe(2);
    expect(mocks.printUsageError).toHaveBeenCalledWith(
      false,
      expect.stringContaining("install <id>"),
    );
    expect(mocks.printUsageError.mock.calls[0]?.[1]).not.toMatch(/release-tested|--target/);
  });

  it("routes install to the vendor operation's nonterminal consent check", async () => {
    expect(await harnessCommand(parseArgs(["harness", "install", "codex"]), true)).toBe(2);
    expect(mocks.printUsageError).toHaveBeenCalledWith(true, expect.stringContaining("--yes"));
  });
});
