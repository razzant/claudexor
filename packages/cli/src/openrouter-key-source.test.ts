import { describe, expect, it, vi } from "vitest";
import type { QuotaRefreshCycle } from "@claudexor/daemon";
import type { KeyCredential, readKeyAllowance } from "@claudexor/harness-raw-api";
import { refreshOpenRouterKeyAllowance } from "./openrouter-key-source.js";

type Read = typeof readKeyAllowance;

const at = new Date("2026-10-29T08:00:00Z");
const credential = (profile_id: string | null, fingerprint: string): KeyCredential => ({
  target: { harness: "openrouter", profile_id },
  key: `sk-or-v1-synthetic-${profile_id ?? "default"}-${fingerprint}`,
  fingerprint,
});
const ok = { ok: true as const, body: { data: { limit: null, usage_monthly: 1 } } };
const base = (credentials: () => KeyCredential[], request = vi.fn<Read>(async () => ok)) => ({
  credentials,
  request,
  now: () => at,
});

describe("OpenRouter key allowance source", () => {
  it("reads each current key once, bound to its fingerprint; an exact target reads only itself", async () => {
    const keys = [credential(null, "aaaaaaaaaaaaaaaa"), credential("work", "bbbbbbbbbbbbbbbb")];
    const options = base(() => keys);
    const full = await refreshOpenRouterKeyAllowance(options, { foreground: true });
    expect(full.snapshots).toEqual([]);
    expect(full.resources?.map((r) => [r.target.profile_id, r.credential_fingerprint])).toEqual([
      [null, "aaaaaaaaaaaaaaaa"],
      ["work", "bbbbbbbbbbbbbbbb"],
    ]);
    expect(options.request.mock.calls.map((call) => call[1])).toEqual(keys.map((k) => k.key));
    const exact = await refreshOpenRouterKeyAllowance(options, {
      foreground: true,
      target: { harness: "openrouter", profile_id: null },
    });
    expect(exact.resources?.map((r) => r.target.profile_id)).toEqual([null]);
  });

  it("drops a read whose key was replaced while it was in flight", async () => {
    let current = [credential(null, "aaaaaaaaaaaaaaaa")];
    const request = vi.fn<Read>(async () => {
      current = [credential(null, "cccccccccccccccc")];
      return ok;
    });
    const diagnostic = vi.fn();
    const result = await refreshOpenRouterKeyAllowance({
      ...base(() => current, request),
      diagnostic,
    });
    expect(result.resources).toEqual([]);
    expect(diagnostic).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: "skipped",
        reason: "credential_changed",
        profileId: null,
      }),
    );
  });

  it("paces a rate-limited key and records a bound failure; a cooled key is not read", async () => {
    const keys = [credential("work", "bbbbbbbbbbbbbbbb")];
    const request = vi.fn<Read>(async () => ({
      ok: false as const,
      reason: "rate_limited",
      httpStatus: 429,
      retryAfterMs: 7000,
    }));
    const pacing = {
      bindCredentials: vi.fn(),
      cooldownUntil: vi.fn(() => null),
      noteRateLimited: vi.fn(),
    };
    const cycle: QuotaRefreshCycle = { foreground: true, pacing };
    const result = await refreshOpenRouterKeyAllowance(
      base(() => keys, request),
      cycle,
    );
    const subject = {
      harness: "openrouter",
      credential_route: "managed_api_key",
      subject_id: "work",
      plan_label: null,
    };
    expect(pacing.noteRateLimited).toHaveBeenCalledWith(subject, at.getTime(), 7000);
    expect(result.resources?.[0]).toMatchObject({
      credential_fingerprint: "bbbbbbbbbbbbbbbb",
      spending: { value: null, last_error: "rate_limited_429" },
    });
    pacing.cooldownUntil.mockReturnValue((at.getTime() + 7000) as never);
    request.mockClear();
    expect(
      (
        await refreshOpenRouterKeyAllowance(
          base(() => keys, request),
          cycle,
        )
      ).resources,
    ).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});
