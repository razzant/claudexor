/**
 * The controller-side install as a state model over a purely programmatic
 * double: no process starts, no ssh exists here, and `fetch` answers only the
 * built-in release URLs (anything else fails the test). The double keeps the
 * server's `current` pointer and install lock, answers the shared scripts as
 * the server would (the one writing step carries the transaction in its
 * command and receives only the signed archive), refuses a pinned call from a
 * server without a
 * pinned key, and records which calls were pinned to which keys. Scenarios
 * cancel the operation at chosen points, change one field the confirmation
 * binds, cut or drop the step's answer, and let a competing install act at
 * the moment this one runs.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { signRemoteRuntimeManifest } from "../../../scripts/lib/remote-runtime-manifest-contract.mjs";
import { installRemoteHost } from "./remote-host-install.js";
import { type RemoteHostDeps, preflightRemoteHost } from "./remote-host-preflight.js";
import { UNREAD, parseHostFacts } from "./remote-host-facts.js";
import {
  REMOTE_RUNTIME_TARGETS,
  remoteRuntimeArchiveName,
  remoteRuntimeArchiveUrl,
  remoteRuntimeManifestUrl,
} from "./remote-host-manifest.js";
import {
  INSTALL_SCRIPT_ESCAPED,
  type InstallRefusal,
  RECIPIENT_MISMATCH,
  activationReceipt,
  refusalReceipt,
} from "./remote-host-scripts.js";
import {
  CANCELLED,
  type PinnableSshTransport,
  type SshRunInput,
  type SshRunResult,
} from "./remote-host-transport.js";

const VERSION = "9.0.1";
const BUILD_SHA = "ab".repeat(20);
const ARCHIVE = Buffer.from("synthetic runtime archive, never unpacked");
const SHA = createHash("sha256").update(ARCHIVE).digest("hex");

/** A synthetic SSH public key: the wire format names its own type first. */
function sshKey(seed: number, type = "ssh-ed25519"): string {
  const name = Buffer.from(type);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(name.length);
  const body = Buffer.alloc(36, seed);
  body.writeUInt32BE(32);
  return `${type} ${Buffer.concat([head, name, body]).toString("base64")}`;
}

/** What `ssh-keygen -l` prints for that key, computed independently. */
function fingerprint(key: string): string {
  const blob = Buffer.from(key.split(" ")[1]!, "base64");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

const KEY_A = sshKey(1);
const KEY_B = sshKey(2);

/** An installed runtime's `runtime.json`, as the release builder writes it. */
function runtimeMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    version: VERSION,
    buildSha: BUILD_SHA,
    protocolMajor: 3,
    target: "linux-x64",
    nodeVersion: "24.22.3",
    ...overrides,
  };
}

interface Host {
  hostname: string;
  user: string;
  uid: string;
  home: string;
  machine: string;
  keys: string[];
  current: string | null;
  lock: boolean;
  /** The files the read-only check reads in the pointed directory: an object
   * is the JSON a release writes, a string the file's raw text, `!` a read that
   * failed there, null no such file. */
  meta: Record<string, unknown> | string | null;
  /** The marker's digest (its one line), `!` for a failed read, or null. */
  marker: string | null;
}

/** One runtime file as the check reports it: the hex of all of its bytes, `!`
 * for a read that failed, nothing for no such file. */
function fileLine(key: string, content: string | null): string[] {
  if (content === null) return [];
  return [`${key}=${content === "!" ? "!" : Buffer.from(content).toString("hex")}`];
}

/** The read-only check's answer for this server state. */
function facts(host: Host): string {
  const meta =
    host.meta !== null && typeof host.meta === "object"
      ? JSON.stringify(host.meta, null, 2)
      : host.meta;
  const marker = host.marker === null || host.marker === "!" ? host.marker : `${host.marker}\n`;
  const current =
    host.current === null
      ? ["current=-"]
      : [`current=${host.current}`, ...fileLine("meta", meta), ...fileLine("marker", marker)];
  return [
    "claudexor-preflight-v3",
    `user=${host.user}`,
    `uid=${host.uid}`,
    `hostname=${host.hostname}`,
    `home=${host.home}`,
    "os=Linux",
    `machine=${host.machine}`,
    ...host.keys.map((key) => `hostkey=${key}`),
    "tools=yes",
    "writable=yes",
    `lock=${host.lock ? "present" : "absent"}`,
    ...current,
    "claudexor-preflight-end",
    "",
  ].join("\n");
}

type Step = "read" | "install";

function stepOf(command: string): Step {
  if (command === "sh -s") return "read";
  if (command.includes("' claudexor-install '")) return "install";
  throw new Error(`unexpected remote command ${command}`);
}

/** The writing step's quoted arguments: the confirmed recipient first. */
function argsOf(command: string): string[] {
  const tail = command.slice(command.lastIndexOf("' claudexor-") + 1);
  return [...tail.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
}

const ok = (stdout: string): SshRunResult => ({
  status: 0,
  signal: null,
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
});

const stopped = (localFailure: string): SshRunResult => ({
  status: null,
  signal: null,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  localFailure,
});

/** ssh's own failure: the connection broke, no remote exit status. */
const dropped = (stderr: string): SshRunResult => ({
  status: 255,
  signal: null,
  stdout: Buffer.alloc(0),
  stderr: Buffer.from(stderr),
});

interface Turn {
  lifetime: AbortController;
  host: Host;
  /** The server's own answer to this command (the shared install's effect). */
  serve: () => SshRunResult;
}

/** Behaves like the system transport toward its caller: an aborted signal
 * starts nothing; a call in flight when it aborts ends as CANCELLED. */
function double(options: {
  lifetime: AbortController;
  host?: Partial<Host>;
  destination?: string;
  /** Replaces the answer to a step; `hang` waits for the cancellation. */
  answer?: Partial<Record<Step, (turn: Turn) => SshRunResult | "hang" | undefined>>;
}) {
  const host: Host = {
    hostname: "synthetic-host",
    user: "builder",
    uid: "1000",
    home: "/home/builder",
    machine: "x86_64",
    keys: [KEY_A],
    current: null,
    lock: false,
    meta: null,
    marker: null,
    ...options.host,
  };
  const calls: { step: Step; pinned: string[] | null }[] = [];
  let closes = 0;
  const serve = (step: Step, command: string, input: SshRunInput): SshRunResult => {
    if (step === "read") return ok(facts(host));
    // The writing step runs only on the confirmed server as the confirmed
    // account, else reads and writes nothing.
    const [uid, user, home, hostname, os, machine, ...rest] = argsOf(command);
    const shown = [host.uid, host.user, host.home, host.hostname, "Linux", host.machine];
    if ([uid, user, home, hostname, os, machine].some((value, index) => value !== shown[index])) {
      return { ...ok(`${RECIPIENT_MISMATCH}\n`), status: 77 };
    }
    // The shared script's first install, which the step's command carries,
    // with the archive as its whole input: refuse when those bytes are not the
    // signed digest, while locked or when occupied, saying so for this
    // pointer; otherwise activate it and print the receipt.
    const pointer = `versions/${VERSION}-${SHA}-${rest.at(-1)}`;
    const refusal = (reason: InstallRefusal, status = 75) => ({
      ...ok(`${refusalReceipt(pointer, reason)}\n`),
      status,
    });
    const archive = input.file === undefined ? null : readFileSync(input.file);
    const digest = archive && createHash("sha256").update(archive).digest("hex");
    const carried = command.includes(INSTALL_SCRIPT_ESCAPED) && input.bytes === undefined;
    if (!carried || digest !== rest[1]) return refusal("failed", 1);
    if (host.lock) return refusal("locked");
    if (host.current !== null) return refusal("changed");
    host.current = pointer;
    host.meta = runtimeMeta();
    host.marker = SHA;
    return ok(`${activationReceipt(pointer)}\n`);
  };
  const run =
    (pinned: string[] | null) =>
    async (command: string, input: SshRunInput = {}): Promise<SshRunResult> => {
      const step = stepOf(command);
      if (input.signal?.aborted) return stopped(CANCELLED);
      calls.push({ step, pinned });
      // ssh admits a pinned call only from a server that proves a pinned key.
      if (pinned && !host.keys.some((key) => pinned.includes(key))) {
        return dropped("Host key verification failed.");
      }
      const answer = options.answer?.[step]?.({
        lifetime: options.lifetime,
        host,
        serve: () => serve(step, command, input),
      });
      if (answer === "hang") {
        const signal = input.signal!;
        return new Promise<SshRunResult>((resolve) => {
          signal.addEventListener("abort", () => resolve(stopped(CANCELLED)), { once: true });
        });
      }
      return answer ?? serve(step, command, input);
    };
  const transport: PinnableSshTransport = {
    destination: options.destination ?? "synthetic-host",
    run: run(null),
    pinned: (keys) => ({
      destination: transport.destination,
      run: run([...keys].sort()),
      close: () => {
        closes += 1;
      },
    }),
  };
  return {
    transport,
    host,
    calls,
    closes: () => closes,
    started: () => calls.map(({ step, pinned }) => (pinned ? `pinned:${step}` : step)),
  };
}

function release(
  lifetime: AbortController,
  opts: { hangManifest?: boolean; buildSha?: string; archive?: Buffer; version?: string } = {},
) {
  const version = opts.version ?? VERSION;
  const archive = opts.archive ?? ARCHIVE;
  const sha = createHash("sha256").update(archive).digest("hex");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const authority = {
    keyId: "claudexor-remote-cancel-test-only",
    algorithm: "Ed25519" as const,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const manifest = signRemoteRuntimeManifest(
    {
      version,
      buildSha: opts.buildSha ?? BUILD_SHA,
      protocolMajor: 3,
      minAppVersion: version,
      notes: "",
      assets: REMOTE_RUNTIME_TARGETS.map((target) => ({
        target,
        platform: target.split("-")[0] as "linux" | "darwin",
        arch: target.split("-")[1] as "x64" | "arm64",
        nodeVersion: "24.22.3",
        archiveName: remoteRuntimeArchiveName(version, target),
        archiveUrl: remoteRuntimeArchiveUrl(version, target),
        sha256: sha,
      })),
    },
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    authority,
  );
  const fetches: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    fetches.push(url);
    if (url === remoteRuntimeManifestUrl(version)) {
      if (opts.hangManifest) {
        lifetime.abort();
        init?.signal?.throwIfAborted();
      }
      return new Response(JSON.stringify(manifest));
    }
    if (url === remoteRuntimeArchiveUrl(version, "linux-x64")) return new Response(archive);
    throw new Error(`the test fetch serves no ${url}`);
  }) as typeof fetch;
  return { source: { fetchImpl, authority, version }, fetches };
}

async function failure(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    return error as Record<string, unknown>;
  }
  throw new Error("expected a typed refusal");
}

async function digestFor(deps: Omit<RemoteHostDeps, "signal">): Promise<string> {
  const pre = await preflightRemoteHost("synthetic-host", deps);
  expect(pre.state).toBe("empty");
  return pre.digest!;
}

/** A double, its release and a confirmed digest, ready for `install`. */
async function confirmed(options: Omit<Parameters<typeof double>[0], "lifetime"> = {}) {
  const lifetime = new AbortController();
  const d = double({ ...options, lifetime });
  const deps = { transport: d.transport, ...release(lifetime).source };
  const digest = await digestFor(deps);
  const install = () =>
    installRemoteHost("synthetic-host", digest, { ...deps, signal: lifetime.signal });
  return { d, deps, digest, install };
}

describe("cancelling remote preflight and install", () => {
  it("starts nothing for an operation cancelled before it began", async () => {
    const lifetime = new AbortController();
    lifetime.abort();
    const d = double({ lifetime });
    const refused = await failure(
      preflightRemoteHost("synthetic-host", {
        transport: d.transport,
        ...release(lifetime).source,
        signal: lifetime.signal,
      }),
    );
    expect(refused).toMatchObject({
      code: "cancelled",
      context: { cancelled: true, notStarted: "preflight", host: "nothing_written" },
    });
    expect(d.started()).toEqual([]);
  });

  it("reports a fetch it cancelled as its own stop, never as a blocked release", async () => {
    const lifetime = new AbortController();
    const d = double({ lifetime });
    const refused = await failure(
      preflightRemoteHost("synthetic-host", {
        transport: d.transport,
        ...release(lifetime, { hangManifest: true }).source,
        signal: lifetime.signal,
      }),
    );
    expect(refused).toMatchObject({ code: "cancelled", context: { host: "nothing_written" } });
    expect(d.started()).toEqual(["read"]);
  });

  it("says nothing was written when cancelled before the writing step", async () => {
    let reads = 0;
    const { d, install } = await confirmed({
      answer: {
        read: ({ lifetime, serve }) => {
          reads += 1;
          if (reads === 3) lifetime.abort();
          return serve();
        },
      },
    });
    expect(await failure(install())).toMatchObject({
      code: "cancelled",
      context: { cancelled: true, notStarted: "install", activated: false },
    });
    expect(d.started()).toEqual(["read", "read", "pinned:read"]);
    expect(d.host).toMatchObject({ current: null, lock: false });
    expect(d.closes()).toBe(1);
  });

  it("stops the writing step while its archive streams as an unknown outcome, never as nothing activated", async () => {
    const { d, install } = await confirmed({
      answer: {
        install: ({ lifetime }) => {
          setTimeout(() => lifetime.abort(), 5);
          return "hang";
        },
      },
    });
    const refused = await failure(install());
    expect(refused).toMatchObject({
      code: "install_outcome_unknown",
      retryable: false,
      context: {
        step: "install",
        cancelled: true,
        pointer: expect.stringMatching(/^versions\/9\.0\.1-[0-9a-f]{64}-[0-9a-f]{32}$/),
      },
    });
    expect(refused).not.toHaveProperty("context.activated");
    expect(d.started()).toEqual(["read", "read", "pinned:read", "pinned:install"]);
    expect(d.closes()).toBe(1);
  });

  it("does not start the read-only check after a cancellation that arrived during activation", async () => {
    const { d, install } = await confirmed({
      answer: {
        install: ({ lifetime, serve }) => {
          lifetime.abort();
          return serve();
        },
      },
    });
    const refused = await failure(install());
    // Activated, with its check undone: an unknown result, never a success.
    expect(refused).toMatchObject({
      code: "install_outcome_unknown",
      context: { step: "verify", activated: true, cancelled: true, pointer: d.host.current },
      requiredActions: [expect.stringContaining("context.runtime")],
    });
    expect(d.started().at(-1)).toBe("pinned:install");
  });

  it("does not read the host again after an install exit it cannot place once cancelled", async () => {
    const { d, install } = await confirmed({
      answer: {
        install: ({ lifetime }) => {
          lifetime.abort();
          return { ...ok(""), status: 75 };
        },
      },
    });
    const refused = await failure(install());
    expect(refused).toMatchObject({
      code: "install_outcome_unknown",
      context: { step: "install", cancelled: true },
    });
    expect(d.started().at(-1)).toBe("pinned:install");
  });

  it("still reports the transaction's own refusal when cancelled after it", async () => {
    const { d, install } = await confirmed({
      answer: {
        install: ({ lifetime, host, serve }) => {
          host.lock = true;
          lifetime.abort();
          return serve();
        },
      },
    });
    expect(await failure(install())).toMatchObject({
      code: "install_in_progress",
      context: { step: "install", activated: false, reason: "locked" },
    });
    expect(d.started().at(-1)).toBe("pinned:install");
  });
});

interface Variant {
  destination?: string;
  host?: Partial<Host>;
  release?: Parameters<typeof release>[1];
}

describe("what one confirmation binds", () => {
  async function offer(variant: Variant = {}): Promise<string> {
    const lifetime = new AbortController();
    const destination = variant.destination ?? "synthetic-host";
    const d = double({ lifetime, host: variant.host, destination });
    const pre = await preflightRemoteHost(destination, {
      transport: d.transport,
      ...release(lifetime, variant.release).source,
    });
    expect(pre.state).toBe("empty");
    return pre.digest!;
  }

  it("changes the digest with every field the person saw, and only with those", async () => {
    const base = await offer();
    expect(await offer()).toBe(base);
    expect(await offer({ host: { keys: [KEY_A, KEY_B] } })).toBe(
      await offer({ host: { keys: [KEY_B, KEY_A] } }),
    );
    const paired: Record<string, string> = {
      destination: await offer({ destination: "synthetic-alias" }),
      hostname: await offer({ host: { hostname: "renamed-host" } }),
      user: await offer({ host: { user: "other" } }),
      uid: await offer({ host: { uid: "1001" } }),
      home: await offer({ host: { home: "/srv/builder" } }),
      target: await offer({ host: { machine: "aarch64" } }),
      hostKey: await offer({ host: { keys: [KEY_B] } }),
      addedHostKey: await offer({ host: { keys: [KEY_A, KEY_B] } }),
      version: await offer({ release: { version: "9.0.2" } }),
      buildSha: await offer({ release: { buildSha: "cd".repeat(20) } }),
      archive: await offer({ release: { archive: Buffer.from("another signed archive") } }),
    };
    for (const [field, digest] of Object.entries(paired)) {
      expect({ field, same: digest === base }).toEqual({ field, same: false });
    }
    expect(new Set(Object.values(paired)).size).toBe(Object.keys(paired).length);
  });

  it("shows the server's host keys as OpenSSH fingerprints", async () => {
    const lifetime = new AbortController();
    const d = double({ lifetime, host: { keys: [KEY_B, KEY_A, KEY_A] } });
    const pre = await preflightRemoteHost("synthetic-host", {
      transport: d.transport,
      ...release(lifetime).source,
    });
    const expected = [KEY_A, KEY_B]
      .map((key) => ({ type: "ssh-ed25519", fingerprint: fingerprint(key) }))
      .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1));
    expect(pre.server.hostKeys).toEqual(expected);
    expect(JSON.stringify(pre)).not.toContain(KEY_A.split(" ")[1]);
  });

  it("reads the decision and makes every write over the confirmed host keys", async () => {
    const { d, install } = await confirmed({ host: { keys: [KEY_A, KEY_B] } });
    const installed = await install();
    expect(installed).toMatchObject({
      outcome: "installed",
      runtime: { version: VERSION, buildSha: BUILD_SHA, protocolMajor: 3, target: "linux-x64" },
    });
    expect(installed.runtime.pointer).toBe(d.host.current);
    const keys = [KEY_A, KEY_B].sort();
    // One writing step: the transaction and the signed archive it receives.
    expect(d.calls).toEqual([
      { step: "read", pinned: null },
      { step: "read", pinned: null },
      { step: "read", pinned: keys },
      { step: "install", pinned: keys },
      { step: "read", pinned: keys },
    ]);
    expect(d.closes()).toBe(1);
  });

  it("writes nothing to another server that answers under the same name", async () => {
    const moved = await confirmed();
    moved.d.host.keys = [KEY_B];
    expect(await failure(moved.install())).toMatchObject({
      code: "preflight_changed",
      context: { state: "empty", activated: false },
    });
    expect(moved.d.started()).toEqual(["read", "read"]);

    // The name moves between the install's first read and its pinned read.
    let reads = 0;
    const late = await confirmed({
      answer: {
        read: ({ host, serve }) => {
          reads += 1;
          if (reads !== 2) return undefined;
          const answer = serve();
          host.keys = [KEY_B];
          return answer;
        },
      },
    });
    expect(await failure(late.install())).toMatchObject({
      code: "host_identity_unconfirmed",
      retryable: false,
      context: { activated: false },
      requiredActions: [expect.stringContaining("remote preflight")],
    });
    expect(late.d.started()).toEqual(["read", "read", "pinned:read"]);
    expect(late.d.host.current).toBeNull();
    expect(late.d.closes()).toBe(1);
  });

  it("writes nothing as another account, nor takes its read for the confirmed one", async () => {
    // The login reaches another account, or the name another machine with the
    // same host key, right after the pinned decision read.
    for (const change of [
      (host: Host) => (host.uid = "1001"),
      (host: Host) => (host.hostname = "cloned-host"),
      (host: Host) => (host.machine = "aarch64"),
    ]) {
      let reads = 0;
      const moved = await confirmed({
        answer: {
          read: ({ host, serve }) => {
            reads += 1;
            if (reads !== 3) return undefined;
            const answer = serve();
            change(host);
            return answer;
          },
        },
      });
      expect(await failure(moved.install())).toMatchObject({
        code: "preflight_changed",
        context: { step: "install", activated: false, recipient: "changed" },
      });
      expect(moved.d.started().at(-1)).toBe("pinned:install");
      expect(moved.d.host).toMatchObject({ current: null, lock: false });
    }

    // The answer is lost, and the recovery read comes from another account.
    const lost = await confirmed({
      answer: {
        install: ({ host, serve }) => {
          serve();
          host.user = "other";
          return dropped("Connection reset by peer");
        },
      },
    });
    expect(await failure(lost.install())).toMatchObject({
      code: "install_outcome_unknown",
      context: {
        step: "install",
        reread: "another account answered",
        server: { user: "builder", uid: 1000, home: "/home/builder" },
        runtime: { version: VERSION, buildSha: BUILD_SHA, pointer: lost.d.host.current },
      },
      requiredActions: [expect.stringContaining("context.runtime")],
    });
  });
});

describe("an install racing an honest competing client", () => {
  it("does not take another install's held lock for success", async () => {
    const { d, install } = await confirmed({
      answer: {
        install: ({ host, serve }) => {
          host.lock = true;
          return serve();
        },
      },
    });
    expect(await failure(install())).toMatchObject({
      code: "install_in_progress",
      retryable: false,
      context: { step: "install", activated: false, reason: "locked", exitCode: 75 },
    });
    expect(d.host).toMatchObject({ current: null, lock: true });
    // The transaction's refusal settles it: no read follows.
    expect(d.started().at(-1)).toBe("pinned:install");
  });

  it("reads an exit without the transaction's refusal as unknown, whatever the server shows", async () => {
    for (const occupy of [
      (host: Host) => (host.lock = true),
      (host: Host) => (host.current = `versions/${VERSION}-${SHA}`),
      // Another pointer stays another's, also when its files could not be read.
      (host: Host) => Object.assign(host, { current: `versions/${VERSION}-${SHA}`, meta: "!" }),
    ]) {
      const { install } = await confirmed({
        answer: {
          install: ({ host }) => {
            occupy(host);
            return { ...ok(""), status: 75 };
          },
        },
      });
      const unknown = await failure(install());
      expect(unknown).toMatchObject({
        code: "install_outcome_unknown",
        context: { step: "install", exitCode: 75 },
      });
      expect(unknown).not.toHaveProperty("context.activated");
    }
  });

  it("never claims a runtime another client activated, even of the same release", async () => {
    const theirs = `versions/${VERSION}-${SHA}`;
    const { d, install } = await confirmed({
      answer: {
        install: ({ host, serve }) => {
          host.current = theirs;
          host.meta = runtimeMeta();
          host.marker = SHA;
          return serve();
        },
      },
    });
    expect(await failure(install())).toMatchObject({
      code: "preflight_changed",
      context: { step: "install", activated: false, reason: "changed" },
    });
    expect(d.host.current).toBe(theirs);
    expect(d.started().filter((step) => step === "pinned:read")).toHaveLength(1);
  });

  it("settles a lost answer by reading this install's own pointer, once", async () => {
    const { d, install } = await confirmed({
      answer: {
        install: ({ serve }) => {
          serve();
          return dropped("Connection reset by peer");
        },
      },
    });
    const installed = await install();
    expect(installed.runtime.pointer).toBe(d.host.current);
    expect(d.started().slice(-2)).toEqual(["pinned:install", "pinned:read"]);
  });

  it("leaves a lost answer unknown when the server shows nothing of this install", async () => {
    const { d, install } = await confirmed({
      answer: { install: () => dropped("Connection reset by peer") },
    });
    const refused = await failure(install());
    expect(refused).toMatchObject({
      code: "install_outcome_unknown",
      context: { step: "install", observed: "absent", lock: false, exitCode: 255 },
    });
    expect(refused).not.toHaveProperty("context.activated");
    expect(d.started().filter((step) => step === "pinned:install")).toHaveLength(1);
  });

  it("needs the signed identity from the activated runtime, and leaves it in place", async () => {
    // A runtime.json read whole that names another build fails the install,
    // also when the marker beside it could not be read.
    for (const marker of [SHA, "!"]) {
      const { d, install } = await confirmed({
        answer: {
          install: ({ host, serve }) => {
            const answer = serve();
            host.meta = runtimeMeta({ buildSha: "cd".repeat(20) });
            host.marker = marker;
            return answer;
          },
        },
      });
      expect(await failure(install())).toMatchObject({
        code: "install_failed",
        context: {
          step: "verify",
          activated: true,
          pointer: d.host.current,
          observed: { buildSha: "cd".repeat(20) },
        },
      });
      expect(d.host.current).not.toBeNull();
    }
  });

  it("leaves the result unknown, not failed, when this install's pointer shows but a runtime file could not be read", async () => {
    // With the receipt or without it: a full read of the confirmed account that
    // shows this install's own pointer proves the activation, never its result.
    for (const lost of [false, true]) {
      const { d, install } = await confirmed({
        answer: {
          install: ({ host, serve }) => {
            const answer = serve();
            host.meta = "!";
            return lost ? dropped("Connection reset by peer") : answer;
          },
        },
      });
      expect(await failure(install())).toMatchObject({
        code: "install_outcome_unknown",
        context: {
          step: "verify",
          activated: true,
          unread: ["runtime.json"],
          pointer: d.host.current,
          server: { user: "builder", uid: 1000, home: "/home/builder" },
          runtime: { version: VERSION, buildSha: BUILD_SHA, pointer: d.host.current },
        },
        requiredActions: [expect.stringContaining("context.runtime")],
      });
      expect(d.started().slice(-2)).toEqual(["pinned:install", "pinned:read"]);
    }
  });

  it("takes runtime files read whole but holding no identity as a definite failure", async () => {
    for (const meta of ["not json", "null", ""]) {
      const { d, install } = await confirmed({
        answer: {
          install: ({ host, serve }) => {
            const answer = serve();
            host.meta = meta;
            return answer;
          },
        },
      });
      expect(await failure(install())).toMatchObject({
        code: "install_failed",
        context: { step: "verify", activated: true, pointer: d.host.current, observed: null },
      });
    }
  });
});

describe("reading the writing step's answer", () => {
  it("takes a receipt cut off mid-line as none and settles activation by one confirmed read", async () => {
    const { d, install } = await confirmed({
      answer: {
        install: ({ serve }) => {
          const whole = serve().stdout.toString("utf8");
          return {
            ...dropped("Connection reset by peer"),
            stdout: Buffer.from(whole.slice(0, 24)),
          };
        },
      },
    });
    const installed = await install();
    expect(installed.runtime.pointer).toBe(d.host.current);
    expect(d.started().slice(-2)).toEqual(["pinned:install", "pinned:read"]);
  });

  it("takes a refusal cut off mid-line as none: unknown, never nothing activated", async () => {
    const { d, install } = await confirmed({
      answer: {
        install: ({ host, serve }) => {
          host.lock = true;
          const whole = serve().stdout.toString("utf8");
          return {
            ...dropped("Connection reset by peer"),
            stdout: Buffer.from(whole.slice(0, 30)),
          };
        },
      },
    });
    const unknown = await failure(install());
    expect(unknown).toMatchObject({
      code: "install_outcome_unknown",
      context: { step: "install", observed: "absent", lock: true, exitCode: 255 },
    });
    expect(unknown).not.toHaveProperty("context.activated");
    expect(d.host.current).toBeNull();
  });

  it("keeps a complete confirmed read of this install through a later cancellation", async () => {
    let reads = 0;
    const { d, install } = await confirmed({
      answer: {
        install: ({ serve }) => {
          serve();
          return dropped("Connection reset by peer");
        },
        // The fourth read is the one that settles the lost answer: the
        // operation is cancelled while it is answered in full.
        read: ({ lifetime, serve }) => {
          reads += 1;
          if (reads === 4) lifetime.abort();
          return serve();
        },
      },
    });
    const installed = await install();
    expect(installed).toMatchObject({ outcome: "installed", runtime: { pointer: d.host.current } });
    expect(d.started().slice(-2)).toEqual(["pinned:install", "pinned:read"]);
  });
});

describe("a release the install cannot read", () => {
  it("reports a manifest it could not fetch as unavailable, not as a changed server", async () => {
    const lifetime = new AbortController();
    const d = double({ lifetime });
    const { source } = release(lifetime);
    const digest = await digestFor({ transport: d.transport, ...source });
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const refused = await failure(
      installRemoteHost("synthetic-host", digest, {
        transport: d.transport,
        ...source,
        fetchImpl: offline,
      }),
    );
    expect(refused).toMatchObject({
      code: "release_unavailable",
      retryable: true,
      context: { state: "blocked", problem: "release_unavailable", activated: false },
    });
    expect(d.started()).toEqual(["read", "read"]);
  });
});

describe("hosts the first install does not touch", () => {
  it("reads an unknown lock value as unreadable, never as an absent lock", () => {
    const text = facts(double({ lifetime: new AbortController() }).host);
    expect(parseHostFacts(text).lock).toBe(false);
    expect(parseHostFacts(text.replace("lock=absent", "lock=present")).lock).toBe(true);
    expect(() => parseHostFacts(text.replace("lock=absent", "lock=held"))).toThrow(
      expect.objectContaining({ code: "remote_unreadable" }),
    );
  });

  it("names an installed runtime only from files that agree with its directory", async () => {
    const theirs = `versions/${VERSION}-${SHA}`;
    const stateOf = async (host: Partial<Host>) => {
      const lifetime = new AbortController();
      const d = double({ lifetime, host: { current: theirs, ...host } });
      const pre = await preflightRemoteHost("synthetic-host", {
        transport: d.transport,
        ...release(lifetime).source,
      });
      return [pre.state, pre.problem?.code ?? null, pre.runtime?.pointer ?? null];
    };
    const agreed = { meta: runtimeMeta(), marker: SHA };
    expect(await stateOf(agreed)).toEqual(["installed", null, theirs]);
    // Files read whole that disagree, or that are not there: an established fact.
    for (const disagreeing of [
      { meta: null },
      { meta: "not json" },
      { meta: "null" },
      { marker: "f".repeat(64) },
      { marker: "" },
      { marker: null },
      { meta: runtimeMeta({ version: "9.0.2" }) },
      // A file read whole that disagrees stays a fact when the other is unread.
      { meta: "not json", marker: "!" },
      { meta: "!", marker: "f".repeat(64) },
    ]) {
      expect(await stateOf({ ...agreed, ...disagreeing })).toEqual([
        "blocked",
        "runtime_unrecognized",
        null,
      ]);
    }
  });

  it("never takes a failed read of a runtime's files for what they hold, nor drops the rest of the answer", async () => {
    const theirs = `versions/${VERSION}-${SHA}`;
    for (const unread of [{ meta: "!" }, { marker: "!" }]) {
      const lifetime = new AbortController();
      const d = double({
        lifetime,
        host: { current: theirs, meta: runtimeMeta(), marker: SHA, ...unread },
      });
      const { source, fetches } = release(lifetime);
      // Blocked with the server and the pointer as read: no install is offered
      // over it, and nothing there is run.
      expect(
        await preflightRemoteHost("synthetic-host", { transport: d.transport, ...source }),
      ).toMatchObject({
        state: "blocked",
        server: { hostname: "synthetic-host", user: "builder", uid: 1000 },
        runtime: null,
        install: null,
        digest: null,
        problem: { code: "runtime_unreadable", message: expect.stringContaining(theirs) },
      });
      expect(fetches).toEqual([]);
    }
    const text = facts(double({ lifetime: new AbortController(), host: { current: theirs } }).host);
    const withMeta = (hex: string) =>
      parseHostFacts(text.replace(`current=${theirs}`, `current=${theirs}\nmeta=${hex}`));
    // A completed read keeps its bytes, whatever they hold; an empty line is an
    // empty file, not a missing one.
    expect(withMeta("6e756c6c").current).toEqual({
      kind: "link",
      target: theirs,
      meta: Buffer.from("null"),
      marker: null,
    });
    expect(withMeta("").current).toEqual({
      kind: "link",
      target: theirs,
      meta: Buffer.alloc(0),
      marker: null,
    });
    // A failed or garbled read is no fact about the file and keeps every other.
    for (const hex of ["!", "6e7"]) {
      const read = withMeta(hex);
      expect(read.current).toEqual({ kind: "link", target: theirs, meta: UNREAD, marker: null });
      expect(read).toMatchObject({ user: "builder", uid: 1000, lock: false });
    }
  });

  it("reports a runtime of another remote protocol and never replaces it", async () => {
    const lifetime = new AbortController();
    const d = double({
      lifetime,
      host: {
        current: `versions/8.0.0-${"e".repeat(64)}`,
        meta: runtimeMeta({ version: "8.0.0", protocolMajor: 2 }),
        marker: "e".repeat(64),
      },
    });
    const { source, fetches } = release(lifetime);
    const deps = { transport: d.transport, ...source };
    expect(await preflightRemoteHost("synthetic-host", deps)).toMatchObject({
      state: "blocked",
      runtime: null,
      digest: null,
      problem: { code: "runtime_incompatible" },
    });
    const refused = await failure(installRemoteHost("synthetic-host", "0".repeat(64), deps));
    expect(refused).toMatchObject({
      code: "preflight_changed",
      context: { state: "blocked", problem: "runtime_incompatible" },
    });
    expect(fetches).toEqual([]);
    expect(d.started()).toEqual(["read", "read"]);
  });

  it("refuses to offer an install it could not bind to the server's host keys", async () => {
    const lifetime = new AbortController();
    const d = double({ lifetime, host: { keys: [] } });
    const { source, fetches } = release(lifetime);
    const pre = await preflightRemoteHost("synthetic-host", { transport: d.transport, ...source });
    expect(pre).toMatchObject({
      state: "blocked",
      digest: null,
      problem: { code: "host_key_unavailable" },
    });
    expect(fetches).toEqual([]);
  });
});
