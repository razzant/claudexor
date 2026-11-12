/**
 * Shared real-consumer fixture for the Raw API contract (#137, #395, #551): a
 * LOCAL chat-completions endpoint whose received bytes the tests read, disposable
 * Git projects, and a doctor-ok file-reading harness for the native side of a
 * pool. No provider, credential or real project is reached: every key is
 * synthetic and every root is owned by the test that made it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessAdapter } from "@claudexor/core";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  ConformanceReport,
  CredentialProfileStatus,
  HarnessManifest,
  RunFailure,
  RunTelemetry,
  type HarnessRunSpec,
  type RawContextPacket,
} from "@claudexor/schema";

export const KEY_ENV = "RAW_CONTRACT_TEST_KEY";

/** One POST's scripted answer; an exhausted script answers plain text. */
export interface Answer {
  patch?: string;
  text?: string;
  /** `usage.cost`, the provider's declared USD receipt. */
  cost?: number;
}

export interface Loopback {
  baseUrl: string;
  gets: string[];
  posts: Array<{ auth: string; body: any }>;
  answers: Answer[];
  /** What GET /models lists, or the HTTP status it answers instead. */
  catalog: string[] | number;
  contextWindow: number;
  reset(): void;
  stop(): Promise<void>;
}

export async function startLoopback(): Promise<Loopback> {
  const state: Omit<Loopback, "baseUrl" | "reset" | "stop"> = {
    gets: [],
    posts: [],
    answers: [],
    catalog: ["vendor/big"],
    contextWindow: 1_000_000,
  };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const auth = String(req.headers.authorization ?? "");
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/api/v1/models") {
        state.gets.push(auth);
        if (typeof state.catalog === "number") {
          res.statusCode = state.catalog;
          res.end("upstream down");
          return;
        }
        res.end(
          JSON.stringify({
            data: state.catalog.map((id) => ({ id, context_length: state.contextWindow })),
          }),
        );
        return;
      }
      const body = JSON.parse(raw) as { model: string };
      state.posts.push({ auth, body });
      const answer = state.answers.shift() ?? { text: "done" };
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [
            {
              message: {
                content: answer.patch
                  ? JSON.stringify({ patch: answer.patch })
                  : (answer.text ?? "done"),
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 10,
            ...(answer.cost !== undefined ? { cost: answer.cost } : {}),
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return Object.assign(state, {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`,
    reset() {
      state.gets.length = 0;
      state.posts.length = 0;
      state.answers = [];
      state.catalog = ["vendor/big"];
      state.contextWindow = 1_000_000;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  });
}

const roots: string[] = [];

export function ownedDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

export function removeOwnedDirs(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
}

/** A committed project: the README, `files` beside it, and optionally its config. */
export function committed(files: Record<string, string> = {}, config?: string): string {
  const root = ownedDir("cx-raw-contract-");
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "README.md"), "# repo\n");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  if (config !== undefined) {
    mkdirSync(join(root, ".claudexor"));
    writeFileSync(join(root, ".claudexor", "config.yaml"), config);
  }
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

/** Point the engine at a scratch config root holding `config` (the vitest setup
 * restores the sandbox root after each test). */
export function useConfig(config: Record<string, unknown>): string {
  const dir = ownedDir("cx-raw-config-");
  process.env.CLAUDEXOR_CONFIG_DIR = dir;
  writeFileSync(join(dir, "config.yaml"), JSON.stringify(config));
  return dir;
}

export const failureRecord = (runDir: string) =>
  RunFailure.parse(new ArtifactStore(runDir).readYaml(join(runDir, "final", "failure.yaml")));

export const telemetryRecord = (runDir: string) =>
  RunTelemetry.parse(new ArtifactStore(runDir).readYaml(join(runDir, "final", "telemetry.yaml")));

export const attemptRecord = (runDir: string, attemptId = "a01") =>
  readFileSync(join(runDir, "attempts", attemptId, "attempt.yaml"), "utf8");

export const runEvents = (runDir: string) =>
  readFileSync(join(runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; payload: Record<string, any> });

export function sentPacket(post: { body: any } | undefined): RawContextPacket {
  const content = post!.body.messages.at(-1).content as string;
  return JSON.parse(content.slice(content.indexOf("RAW_CONTEXT_PACKET:\n") + 20));
}

/** What Git names these exact bytes: a packet file's blob identity must equal it. */
export function blobOidOf(repo: string, content: string): string {
  return execFileSync("git", ["-C", repo, "hash-object", "--stdin"], {
    input: content,
    encoding: "utf8",
  }).trim();
}

/**
 * The real raw route with an admitting account probe. The shipped raw adapter has
 * no such probe, so a saved row stops at credential admission today; this fixture
 * proves the capability and model gates also hold for a route that gets past it.
 */
export function withProfileProbe(adapter: HarnessAdapter): HarnessAdapter {
  adapter.probeCredentialProfile = async (profile) =>
    CredentialProfileStatus.parse({
      profile_id: profile.profile_id,
      harness_id: profile.harness_id,
      availability: "available",
      verification: "passed",
      detail: "fixture",
      last_verified_at: null,
    });
  return adapter;
}

/**
 * The real raw route as if its doctor had proved it. Only that lets Auto consider
 * the route at all: its shipped doctor stays degraded, and Auto takes no API-key row.
 */
export function asDoctorOk(adapter: HarnessAdapter): HarnessAdapter {
  const doctor = adapter.doctor.bind(adapter);
  adapter.doctor = async (spec) => ({ ...(await doctor(spec)), status: "ok" });
  return adapter;
}

/**
 * A doctor-ok harness that reads and writes files itself, standing in for a
 * native agent: it plans, reviews and implements, and records every spec it is
 * handed. `implement` runs inside each producing round.
 */
export function nativeReader(
  id: string,
  family: "anthropic" | "google" | "openai",
  dispatched: HarnessRunSpec[],
  implement: (spec: HarnessRunSpec) => void = () => {},
): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        capabilities: {
          plan: true,
          implement: true,
          review: true,
          synthesize: true,
          read_files: true,
          web_policy: "tools",
        },
        access_profiles_supported: ["readonly", "workspace_write"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["plan", "spec", "implement", "repair", "review", "synthesize", "explain"],
      });
    },
    async *run(spec) {
      dispatched.push(spec);
      const ts = new Date().toISOString();
      if (spec.intent === "implement" || spec.intent === "repair") implement(spec);
      yield { type: "started", session_id: spec.session_id, ts };
      yield {
        type: "message",
        session_id: spec.session_id,
        ts,
        text:
          spec.intent === "review" ? "[]" : `# Plan from ${id}\n\n## Open Questions\n\n- (none)\n`,
        final: true,
      };
      yield { type: "completed", session_id: spec.session_id, ts, observed_model: `${id}-model` };
    },
  };
}

/**
 * A doctor-ok reviewer that declares review but not file reading, as any
 * adapter may: what the owner's contract turns away whatever the harness id.
 */
export function nonReadingReviewer(
  id: string,
  family: "openai" | "google",
  dispatched: HarnessRunSpec[],
): HarnessAdapter {
  const base = nativeReader(id, family as "google", dispatched);
  return {
    ...base,
    async discover() {
      const manifest = await base.discover();
      return HarnessManifest.parse({
        ...manifest,
        provider_family: family,
        capabilities: { ...manifest.capabilities, read_files: false },
      });
    },
  };
}
