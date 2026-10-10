import { describe, expect, it } from "vitest";
import { processMemoryFields } from "./memory-facts.js";

describe("processMemoryFields", () => {
  it("prints whole mebibytes for the three footprint numbers", () => {
    expect(
      processMemoryFields({
        rss: 412 * 1024 * 1024 + 1,
        heapUsed: 180.4 * 1024 * 1024,
        external: 0,
      }),
    ).toBe("rssMb=412 heapUsedMb=180 externalMb=0");
    expect(processMemoryFields()).toMatch(/^rssMb=\d+ heapUsedMb=\d+ externalMb=\d+$/);
  });
});
