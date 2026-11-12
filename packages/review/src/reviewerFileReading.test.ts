/**
 * The one owner of "a reviewer reads the candidate evidence files itself" (INV-042):
 * the whole list passes or none of it runs, a failed discovery proves nothing, and
 * only a positive declaration spares a reviewer the next probe.
 */
import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError } from "@claudexor/core";
import { HarnessManifest } from "@claudexor/schema";
import { admitFileReader, requireReadingReviewers } from "./reviewerFileReading.js";

function adapter(id: string, readFiles: boolean) {
  const seen = { discoveries: 0 };
  const value: HarnessAdapter = {
    id,
    async discover() {
      seen.discoveries += 1;
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        capabilities: { review: true, read_files: readFiles },
      });
    },
    async doctor() {
      throw new Error("not used");
    },
    // eslint-disable-next-line require-yield
    async *run() {
      throw new Error("not used");
    },
  };
  return { value, seen };
}

describe("requireReadingReviewers", () => {
  it("returns the list as given, and a reader's declaration is not asked for twice", async () => {
    const reader = adapter("reader", true);
    const list = [{ adapter: reader.value }];
    await expect(requireReadingReviewers(list)).resolves.toBe(list);
    await requireReadingReviewers(list);
    expect(reader.seen.discoveries).toBe(1);
  });

  it("refuses the whole list on a declared nonreader, typed and named", async () => {
    const blind = adapter("blind", false);
    const reader = adapter("reader", true);
    const refused = requireReadingReviewers([{ adapter: reader.value }, { adapter: blind.value }]);
    await expect(refused).rejects.toBeInstanceOf(HarnessUnavailableError);
    await expect(refused).rejects.toThrow(
      "reviewer harness 'blind' cannot read the candidate evidence files itself",
    );
  });

  it("asks a nonreader again: only a positive declaration is remembered", async () => {
    const blind = adapter("blind", false);
    const list = [{ adapter: blind.value }];
    await expect(requireReadingReviewers(list)).rejects.toThrow("cannot read");
    await expect(requireReadingReviewers(list)).rejects.toThrow("cannot read");
    expect(blind.seen.discoveries).toBe(2);
  });

  it("refuses on a failed discovery, masking its diagnostic, and remembers nothing", async () => {
    const value = { ...adapter("flaky", true).value };
    let failures = 1;
    const discover = value.discover.bind(value);
    value.discover = async () => {
      if (failures-- > 0) throw new Error(`probe failed sk-ant-${"a".repeat(40)}`);
      return discover();
    };
    const list = [{ adapter: value }];
    const refusal = await requireReadingReviewers(list).catch((error: Error) => error.message);
    expect(refusal).toContain("reviewer harness 'flaky' is unavailable: probe failed");
    expect(refusal).not.toContain("a".repeat(40));
    await expect(requireReadingReviewers(list)).resolves.toBe(list);
  });

  it("refuses a discovery that answers nothing, or an adapter without one", async () => {
    const empty = { ...adapter("empty", true).value, discover: async () => undefined };
    await expect(
      requireReadingReviewers([{ adapter: empty as unknown as HarnessAdapter }]),
    ).rejects.toThrow("reviewer harness 'empty' is unavailable");
    await expect(
      requireReadingReviewers([{ adapter: { id: "bare" } as HarnessAdapter }]),
    ).rejects.toThrow("reviewer harness 'bare' is unavailable");
  });

  it("an empty list passes: no reviewers is the no-review path, not a refusal", async () => {
    await expect(requireReadingReviewers([])).resolves.toEqual([]);
  });
});

describe("admitFileReader", () => {
  it("is the manifest's declaration, and a panel's positive read spares the entry a probe", async () => {
    const reader = adapter("reader", true);
    expect(admitFileReader(reader.value, await reader.value.discover())).toBe(true);
    expect(reader.seen.discoveries).toBe(1);
    await requireReadingReviewers([{ adapter: reader.value }]);
    expect(reader.seen.discoveries).toBe(1);
    const blind = adapter("blind", false);
    expect(admitFileReader(blind.value, await blind.value.discover())).toBe(false);
  });
});
