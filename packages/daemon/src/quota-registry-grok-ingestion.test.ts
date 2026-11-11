import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessRunSpec } from "@claudexor/schema";
import { userConfigDir } from "@claudexor/util";
import { createGrokAdapter } from "../../harness-grok/src/index.js";
import { QuotaRegistry } from "./quota-registry.js";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";

describe("Grok quota ingestion through the real adapter", () => {
  it.each(["stream", "stderr"])(
    "persists a %s refusal with the selected profile",
    async (channel) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "grok-quota-")));
      const journal = new DurableJournal({ rootDir: root, partition: "global" });
      try {
        const registry = new QuotaRegistry(journal);
        const adapter = createGrokAdapter({
          probeLogin: async () => ({ authenticated: true, models: [], detail: "vendor confirmed" }),
          runCli: async function* (opts) {
            if (channel === "stream")
              yield* opts.parseEvent(
                {
                  type: "error",
                  error: {
                    code: "quota_exceeded",
                    message: "subscription exhausted",
                    retry_after: 300,
                  },
                },
                opts.spec.session_id,
              )!;
            else yield opts.parseStderrFailure!("HTTP 429: quota exhausted", opts.spec.session_id)!;
          },
        });
        const spec = HarnessRunSpec.parse({
          session_id: "grok-limit",
          intent: "implement",
          cwd: root,
          prompt: "x",
          credential_profile: {
            profile_id: "grok-work",
            harness_id: "grok",
            display_name: "work",
            credential_kind: "config_dir_login",
            isolation_locator: join(userConfigDir(), "profiles", "grok-work"),
            enabled: true,
            secret_ref: null,
            created_at: null,
          },
        });
        for await (const event of adapter.run(spec)) registry.ingest("grok", event);
        const snapshot = registry
          .read()
          .snapshots.find((snapshot) => snapshot.source === "grok_rate_limit");
        expect(snapshot?.subject).toMatchObject({
          harness: "grok",
          subject_id: "grok-work",
          credential_route: "vendor_native",
        });
        expect(snapshot?.constraints.some((constraint) => constraint.cooldown_until !== null)).toBe(
          true,
        );
      } finally {
        journal.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
