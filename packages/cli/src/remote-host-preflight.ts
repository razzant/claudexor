/**
 * The read-only half of the controller-side first install of the SSH runtime
 * (`claudexor remote preflight`), for a client wizard other than the macOS
 * app; the confirmed write is remote-host-install.ts.
 *
 * `preflight` reports who and where the SSH login lands, the server's host
 * keys and one state: `empty` (THIS CLI's signed runtime is offered, bound by
 * a `digest`), `installed` (a runtime of this remote protocol; connecting is a
 * separate `remote bootstrap`) or `blocked` (a typed reason). An installed,
 * unknown, unreadable or locked runtime is reported and never changed.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { canonicalJson } from "@claudexor/util";
import {
  type HostFacts,
  UNREAD,
  readHostFacts,
  remoteHostFailure,
  runtimeIdentity,
  targetFor,
} from "./remote-host-facts.js";
import { REMOTE_RUNTIME_PROTOCOL_MAJOR, type RemoteRuntimeTarget } from "./remote-host-manifest.js";
import {
  type ReleaseSource,
  type SignedRelease,
  readSignedRelease,
} from "./remote-host-release.js";
import {
  type PinnableSshTransport,
  type SshTransport,
  sshDestinationProblem,
} from "./remote-host-transport.js";

/** `signal` (from ReleaseSource) is the operation's lifetime: once aborted,
 * running ssh and fetches stop and no further step starts. */
export interface RemoteHostDeps extends ReleaseSource {
  transport: PinnableSshTransport;
}

export interface RemoteHostServer {
  hostname: string;
  user: string;
  uid: number;
  home: string;
  target: RemoteRuntimeTarget | null;
  /** The server's SSH host keys, by fingerprint: the install writes only to
   * a server that proves one of them. */
  hostKeys: { type: string; fingerprint: string }[];
}

export interface RemoteHostRuntime {
  version: string;
  buildSha: string;
  protocolMajor: number;
  target: RemoteRuntimeTarget;
  pointer: string;
}

export interface RemoteHostInstallOffer {
  version: string;
  buildSha: string;
  archiveSha256: string;
  root: string;
  sudo: false;
}

export interface RemoteHostPreflight {
  ok: true;
  state: "empty" | "installed" | "blocked";
  destination: string;
  server: RemoteHostServer;
  runtime: RemoteHostRuntime | null;
  install: RemoteHostInstallOffer | null;
  digest: string | null;
  problem: { code: string; message: string } | null;
}

export const AGAIN = "Run `claudexor remote preflight <destination> --json` again before deciding.";

/** What is known of the host when this client stops before a step. */
const KNOWN = {
  nothing_written: "nothing was written to the server",
} as const;

export interface Observation {
  view: RemoteHostPreflight;
  facts: HostFacts;
  release?: SignedRelease;
}

/** The server identity a read shows, as the digest binds it. */
export function serverOf(facts: HostFacts): RemoteHostServer {
  const { hostname, user, uid, home } = facts;
  const hostKeys = facts.hostKeys.map(({ type, fingerprint }) => ({ type, fingerprint }));
  return { hostname, user, uid, home, target: targetFor(facts.os, facts.machine), hostKeys };
}

/** Every ssh call of one operation carries its lifetime. */
export function bound(deps: RemoteHostDeps, transport: SshTransport): SshTransport {
  const { signal } = deps;
  if (!signal) return transport;
  return {
    destination: transport.destination,
    run: (command, input = {}) => transport.run(command, { ...input, signal }),
  };
}

/** The operation was cancelled on this client before `step` started, before
 * anything was written: no new step starts, and nothing needs undoing. */
export function stopIfCancelled(
  deps: RemoteHostDeps,
  step: string,
  known: keyof typeof KNOWN,
): void {
  if (!deps.signal?.aborted) return;
  throw remoteHostFailure(
    "cancelled",
    `cancelled on this client before the ${step} step; ${KNOWN[known]}`,
    { context: { cancelled: true, notStarted: step, host: known } },
  );
}

function preflightDigest(
  destination: string,
  server: RemoteHostServer,
  install: RemoteHostInstallOffer,
): string {
  const bound = {
    kind: "claudexor-remote-preflight",
    schemaVersion: 2,
    destination,
    server,
    install,
  };
  return createHash("sha256").update(canonicalJson(bound)).digest("hex");
}

/** An installed runtime is reported from what its files declare, never run
 * and never replaced: whatever is there (unknown, unreadable, foreign or
 * another remote protocol) stays as it is. */
function installedView(
  current: Extract<HostFacts["current"], { kind: "link" }>,
  target: RemoteRuntimeTarget,
  root: string,
): { code: string; message: string } | RemoteHostRuntime {
  const where = `${root}/${current.target}`;
  const identity = runtimeIdentity(current);
  if (identity === UNREAD) {
    return {
      code: "runtime_unreadable",
      message: `a file of the runtime at ${where} could not be read; nothing there was run or changed and no install is offered over it: read the server again`,
    };
  }
  if (!identity) {
    return {
      code: "runtime_unrecognized",
      message: `the runtime at ${where} has no runtime.json and archive marker that agree with its name; it is left unchanged`,
    };
  }
  if (identity.target !== target) {
    return {
      code: "runtime_unrecognized",
      message: `the runtime at ${where} is built for ${identity.target}, not ${target}; it is left unchanged`,
    };
  }
  if (identity.protocolMajor !== REMOTE_RUNTIME_PROTOCOL_MAJOR) {
    return {
      code: "runtime_incompatible",
      message: `the runtime at ${where} (Claudexor ${identity.version}) speaks remote protocol ${identity.protocolMajor} and this Claudexor ${REMOTE_RUNTIME_PROTOCOL_MAJOR}; an installed runtime is never replaced from here`,
    };
  }
  return { ...identity, pointer: current.target };
}

/** What this host's facts mean for a first install. `release` is fetched
 * once per operation: a later read of the same install reuses it. */
async function viewOf(
  destination: string,
  deps: RemoteHostDeps,
  facts: HostFacts,
  release: SignedRelease | undefined,
): Promise<Observation> {
  const server = serverOf(facts);
  const { target, user, home, hostKeys } = server;
  const root = posix.join(home, ".claudexor/remote");
  // Field order is the reading order of the answer: state first.
  const view = (state: RemoteHostPreflight["state"], fields: Partial<RemoteHostPreflight>) => ({
    ok: true as const,
    state,
    destination,
    server,
    runtime: null,
    install: null,
    digest: null,
    problem: null,
    ...fields,
  });
  const blocked = (code: string, message: string): Observation => ({
    view: view("blocked", { problem: { code, message } }),
    facts,
  });
  if (!target) {
    return blocked(
      "unsupported_platform",
      `${facts.os} ${facts.machine} has no Claudexor runtime (Linux or macOS, x64 or arm64)`,
    );
  }
  if (facts.lock) {
    return blocked(
      "install_in_progress",
      `another install holds ${root}/.install-lock; Claudexor never removes it. An install releases it when it ends or its connection drops, but a killed install (a crash, a reboot) or a removal the filesystem refused can leave it: if it stays and no install still runs as ${user} there, remove that empty directory by hand and read again`,
    );
  }
  const current = facts.current;
  if (current.kind === "not_link") {
    return blocked(
      "runtime_unrecognized",
      `${root}/current exists but is not a link to an installed runtime; it is left unchanged`,
    );
  }
  if (current.kind === "foreign_link") {
    return blocked(
      "runtime_unrecognized",
      `${root}/current points outside the installed runtimes; it is left unchanged`,
    );
  }
  if (current.kind === "link") {
    const runtime = installedView(current, target, root);
    if ("code" in runtime) return blocked(runtime.code, runtime.message);
    return { view: view("installed", { runtime }), facts };
  }
  if (!facts.tools) {
    return blocked(
      "missing_tools",
      "the install needs tar, awk and sha256sum or shasum on the server",
    );
  }
  if (!facts.writable) return blocked("home_not_writable", `${user} cannot create ${root}`);
  if (hostKeys.length === 0) {
    return blocked(
      "host_key_unavailable",
      "no SSH host public key is readable in /etc/ssh to bind an install to this server",
    );
  }
  let signed = release;
  if (!signed) {
    const read = await readSignedRelease(target, deps);
    // An aborted fetch is this client's stop, never a property of the release.
    stopIfCancelled(deps, "preflight", "nothing_written");
    if (!read.ok) return blocked(read.code, read.message);
    signed = read.release;
  }
  const { manifest, asset } = signed;
  const install: RemoteHostInstallOffer = {
    version: manifest.version,
    buildSha: manifest.buildSha,
    archiveSha256: asset.sha256,
    root,
    sudo: false,
  };
  const digest = preflightDigest(destination, server, install);
  return { view: view("empty", { install, digest }), facts, release: signed };
}

export async function observeRemoteHost(
  destination: string,
  deps: RemoteHostDeps,
  transport: SshTransport,
  release?: SignedRelease,
): Promise<Observation> {
  // Parsed before any transport call, whoever built the transport.
  const problem = sshDestinationProblem(destination);
  if (problem) throw remoteHostFailure("invalid_argument", problem);
  // The digest binds the destination string; the facts must come from it too.
  if (transport.destination !== destination) {
    throw remoteHostFailure(
      "invalid_argument",
      "the SSH transport reaches a different destination than the one named",
    );
  }
  stopIfCancelled(deps, "preflight", "nothing_written");
  let facts: HostFacts;
  try {
    facts = await readHostFacts(bound(deps, transport));
  } catch (error) {
    stopIfCancelled(deps, "preflight", "nothing_written");
    throw error;
  }
  return viewOf(destination, deps, facts, release);
}

/** Read-only: what is on the server and what `install` would do there. */
export async function preflightRemoteHost(
  destination: string,
  deps: RemoteHostDeps,
): Promise<RemoteHostPreflight> {
  return (await observeRemoteHost(destination, deps, deps.transport)).view;
}
