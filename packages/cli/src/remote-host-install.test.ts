import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signRemoteRuntimeManifest } from "../../../scripts/lib/remote-runtime-manifest-contract.mjs";
import { parseArgs } from "./args.js";
import { remoteCommand } from "./remote-command.js";
import { installRemoteHost } from "./remote-host-install.js";
import { type RemoteHostDeps, preflightRemoteHost } from "./remote-host-preflight.js";
import {
  REMOTE_RUNTIME_TARGETS,
  remoteRuntimeArchiveName,
  remoteRuntimeArchiveUrl,
  remoteRuntimeManifestUrl,
} from "./remote-host-manifest.js";
import { INSTALL_SCRIPT, posixQuote as q } from "./remote-host-scripts.js";
import { PINNED_HOST_ALIAS, systemSshTransport } from "./remote-host-transport.js";

const VERSION = "9.0.1";
const V = VERSION.replaceAll(".", "\\.");
const BUILD_SHA = "ab".repeat(20);
/** The fixture daemon's bearer: it must never appear in a wizard answer. */
const TOKEN = "fixture-bearer-6f1d0c";
const LOCAL_TARGET = REMOTE_RUNTIME_TARGETS.find(
  (target) => target === `${platform()}-${arch() === "x64" ? "x64" : arch()}`,
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);

/** A synthetic SSH public key: the wire format names its own type first. */
function sshKey(seed: number): string {
  const name = Buffer.from("ssh-ed25519");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(name.length);
  const body = Buffer.alloc(36, seed);
  body.writeUInt32BE(32);
  return `ssh-ed25519 ${Buffer.concat([head, name, body]).toString("base64")}`;
}
const HOST_KEY_A = sshKey(1);
const HOST_KEY_B = sshKey(2);

function fingerprint(key: string): string {
  const blob = Buffer.from(key.split(" ")[1]!, "base64");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** A harmless stand-in for the runtime's `bin/claudexor`: it answers the
 * internal `remote` verbs the shared transaction calls, under the fake HOME.
 * `bootstrap` would start a daemon, so it only leaves a marker. */
function cliFixture(target: string): string {
  const [os, cpu] = target.split("-");
  return `#!/bin/sh
set -eu
root="$HOME/.claudexor/remote"
case "$1 $2" in
  "remote probe")
    printf '%s\\n' '{"ok":true,"target":"${target}","platform":"${os}","arch":"${cpu}","version":"${VERSION}","buildSha":"${BUILD_SHA}","protocolMajor":3}' ;;
  "remote bootstrap")
    : > "$HOME/daemon-started"
    printf '%s\\n' '{"ok":true,"target":"${target}","version":"${VERSION}","buildSha":"${BUILD_SHA}","protocolMajor":3,"engineVersion":"${VERSION}","engineBuildSha":"${BUILD_SHA}","endpoint":{"host":"127.0.0.1","port":43123,"token":"${TOKEN}"}}' ;;
  "remote activate")
    test "$3" = "-" && test ! -e "$root/current"
    ln -s "$4" "$root/current"
    printf '%s\\n' '{"ok":true}' ;;
  *) exit 64 ;;
esac
`;
}

interface FakeServer {
  /** Run a matching command to its end, then report a lost connection;
   * `down` keeps every later call lost until the test restores it, `closed`
   * gives the command an output whose reader has already gone. */
  lose?: { match: string; down?: boolean; closed?: boolean };
  refuse?: boolean;
  path?: string;
  /** Another client acts on the server just before a matching command. */
  before?: { match: string; run: string };
  /** From the first pinned call on, the name reaches a server with this key. */
  moveBeforePinned?: string;
}

/** Test double for the system ssh: it accepts the production argv, admits a
 * pinned call only when the server's host keys include a pinned one, and runs
 * the remote command with a local sh whose HOME is a temporary directory. The
 * read-only check finds the server's host keys in `keys`, not /etc/ssh. */
function fakeSsh(
  dir: string,
  opts: FakeServer & { remoteHome: string; log: string; keys: string },
): string {
  const file = join(dir, "ssh");
  const down = join(dir, "network-down");
  const moved = join(dir, "moved");
  const lines = [
    "#!/bin/sh",
    "pinned=no known=",
    'while test "$#" -gt 0 && test "$1" != "--"; do',
    '  case "$1" in',
    `    HostKeyAlias=${PINNED_HOST_ALIAS}) pinned=yes ;;`,
    "    UserKnownHostsFile=*) known=${1#UserKnownHostsFile=} ;;",
    "  esac",
    "  shift",
    "done",
    'test "$1" = "--" || exit 2',
    `printf '%s %s %s\\n' "$pinned" "$2" "$(printf '%s' "$3" | head -n 1)" >> ${q(opts.log)}`,
    `if test -e ${q(down)}; then echo 'ssh: connection lost' >&2; exit 255; fi`,
    opts.refuse ? "echo 'ssh: connect to host port 22: Connection refused' >&2; exit 255" : "",
    opts.moveBeforePinned
      ? `if test "$pinned" = yes && test ! -e ${q(moved)}; then : > ${q(moved)}; printf '%s\\n' ${q(`${opts.moveBeforePinned} x`)} > ${q(join(opts.keys, "ssh_host_k0_key.pub"))}; fi`
      : "",
    'if test "$pinned" = yes; then',
    "  proven=no",
    `  for pub in ${q(opts.keys)}/ssh_host_*_key.pub; do`,
    '    test -f "$pub" || continue',
    '    read -r kind blob rest < "$pub" || :',
    `    if grep -qxF "${PINNED_HOST_ALIAS} $kind $blob" "$known"; then proven=yes; fi`,
    "  done",
    "  if test \"$proven\" != yes; then echo 'Host key verification failed.' >&2; exit 255; fi",
    "fi",
    `export HOME=${q(opts.remoteHome)}`,
    opts.path ? `export PATH=${q(opts.path)}:"$PATH"` : "",
    'cd "$HOME"',
    opts.before
      ? `case "$3" in *${q(opts.before.match)}*) /bin/sh -c ${q(opts.before.run)} </dev/null >/dev/null || exit 3;; esac`
      : "",
    opts.lose
      ? `case "$3" in *${q(opts.lose.match)}*) ${opts.lose.closed ? '/bin/sh -c "$3" 2>/dev/null | :' : '/bin/sh -c "$3" >/dev/null 2>&1'}; ${opts.lose.down ? `: > ${q(down)}; ` : ""}exit 255;; esac`
      : "",
    `if test "$3" = "sh -s"; then sed 's#/etc/ssh/ssh_host_#'${q(`${opts.keys}/ssh_host_`)}'#' | /bin/sh -c "$3"; exit $?; fi`,
    'exec /bin/sh -c "$3"',
  ];
  writeFileSync(file, `${lines.filter(Boolean).join("\n")}\n`, { mode: 0o755 });
  return file;
}

interface HarnessOptions extends FakeServer {
  productionKey?: boolean;
  bytes?: Buffer;
  hostKeys?: string[];
  /** The build SHA the archive's own runtime.json declares. */
  runtimeBuild?: string;
}

/** The runtime.json the release builder writes beside the runtime. */
function runtimeJson(fields: Record<string, unknown> = {}): string {
  const runtime = {
    schemaVersion: 1,
    version: VERSION,
    buildSha: BUILD_SHA,
    protocolMajor: 3,
    target: LOCAL_TARGET,
    nodeVersion: "24.22.3",
    ...fields,
  };
  return `${JSON.stringify(runtime, null, 2)}\n`;
}

function harness(opts: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "claudexor-remote-install-"));
  roots.push(root);
  const remoteHome = join(root, "remote-home");
  const keys = join(root, "server-keys");
  const payload = join(root, "payload");
  mkdirSync(remoteHome);
  mkdirSync(keys);
  for (const [index, key] of (opts.hostKeys ?? [HOST_KEY_A]).entries()) {
    writeFileSync(join(keys, `ssh_host_k${index}_key.pub`), `${key} root@server\n`);
  }
  mkdirSync(join(payload, "bin"), { recursive: true });
  writeFileSync(join(payload, "bin", "claudexor"), cliFixture(LOCAL_TARGET!), { mode: 0o755 });
  const build = opts.runtimeBuild ?? BUILD_SHA;
  writeFileSync(join(payload, "runtime.json"), runtimeJson({ buildSha: build }), { mode: 0o644 });
  const archivePath = join(root, "runtime.tar.gz");
  execFileSync("tar", ["-czf", archivePath, "-C", payload, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const archive = readFileSync(archivePath);
  const sha = createHash("sha256").update(archive).digest("hex");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const authority = {
    keyId: "claudexor-remote-install-test-only",
    algorithm: "Ed25519" as const,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const manifest = signRemoteRuntimeManifest(
    {
      version: VERSION,
      buildSha: BUILD_SHA,
      protocolMajor: 3,
      minAppVersion: VERSION,
      notes: "",
      assets: REMOTE_RUNTIME_TARGETS.map((target) => ({
        target,
        platform: target.split("-")[0] as "linux" | "darwin",
        arch: target.split("-")[1] as "x64" | "arm64",
        nodeVersion: "24.22.3",
        archiveName: remoteRuntimeArchiveName(VERSION, target),
        archiveUrl: remoteRuntimeArchiveUrl(VERSION, target),
        sha256: sha,
      })),
    },
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    authority,
  );
  const fetches: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    fetches.push(url);
    if (url === remoteRuntimeManifestUrl(VERSION)) return new Response(JSON.stringify(manifest));
    if (REMOTE_RUNTIME_TARGETS.some((t) => url === remoteRuntimeArchiveUrl(VERSION, t))) {
      return new Response(opts.bytes ?? archive);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const log = join(root, "ssh.log");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const program = fakeSsh(bin, { remoteHome, log, keys, ...opts });
  // Constructively local: the transport launches exactly this stub or refuses
  // before any launch; nothing searches PATH for an ssh.
  const transport = systemSshTransport("build-box", program);
  expect(transport.program).toBe(program);
  const deps: RemoteHostDeps = {
    transport,
    fetchImpl,
    version: VERSION,
    ...(opts.productionKey ? {} : { authority }),
  };
  /** "<pinned yes|no> <destination> <first line of the remote command>" */
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const remoteRoot = join(remoteHome, ".claudexor", "remote");
  const write = (key: string) => writeFileSync(join(keys, "ssh_host_k0_key.pub"), `${key} x\n`);
  return { root, bin, remoteHome, remoteRoot, archivePath, deps, sha, fetches, calls, write };
}

async function codeOf(promise: Promise<unknown>): Promise<{ code?: string; context?: unknown }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; context?: unknown };
  }
  throw new Error("expected a typed refusal");
}

/** The one writing step's own name in its remote command. */
const INSTALL_CALL = " claudexor-install ";

/** Nothing of this install is left but its moved directory, if any. */
function released(h: ReturnType<typeof harness>): void {
  expect(existsSync(join(h.remoteRoot, ".install-lock"))).toBe(false);
  expect(readdirSync(join(h.remoteRoot, "incoming"))).toEqual([]);
  expect(readdirSync(join(h.remoteRoot, ".staging"))).toEqual([]);
}

describe.skipIf(process.platform === "win32" || !LOCAL_TARGET)(
  "remote preflight and install",
  () => {
    it("preflights an empty host without changing it, then installs that offer once and starts nothing", async () => {
      const h = harness();
      const pre = await preflightRemoteHost("build-box", h.deps);
      expect(pre).toMatchObject({
        ok: true,
        state: "empty",
        destination: "build-box",
        server: {
          user: userInfo().username,
          home: h.remoteHome,
          target: LOCAL_TARGET,
          hostKeys: [{ type: "ssh-ed25519", fingerprint: fingerprint(HOST_KEY_A) }],
        },
        runtime: null,
        install: { version: VERSION, buildSha: BUILD_SHA, archiveSha256: h.sha, sudo: false },
        problem: null,
      });
      expect(pre.install!.root).toBe(join(h.remoteHome, ".claudexor/remote"));
      expect(pre.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(join(h.remoteHome, ".claudexor"))).toBe(false);
      expect(h.calls()).toEqual(["no build-box sh -s"]);

      const installed = await installRemoteHost("build-box", pre.digest!, h.deps);
      const pointer = installed.runtime.pointer;
      expect(pointer).toMatch(new RegExp(`^versions/${V}-${h.sha}-[0-9a-f]{32}$`));
      expect(installed).toEqual({
        ok: true,
        outcome: "installed",
        destination: "build-box",
        server: pre.server,
        runtime: {
          version: VERSION,
          buildSha: BUILD_SHA,
          protocolMajor: 3,
          target: LOCAL_TARGET,
          pointer,
        },
      });
      expect(JSON.stringify([pre, installed])).not.toContain(TOKEN);
      expect(JSON.stringify([pre, installed])).not.toContain("token");
      expect(readlinkSync(join(h.remoteRoot, "current"))).toBe(pointer);
      // No daemon, and nothing of this install beside its runtime directory.
      expect(existsSync(join(h.remoteHome, "daemon-started"))).toBe(false);
      expect(existsSync(join(h.remoteRoot, ".install-lock"))).toBe(false);
      expect(readdirSync(join(h.remoteRoot, "incoming"))).toEqual([]);
      expect(readdirSync(join(h.remoteRoot, ".staging"))).toEqual([]);
      expect(readdirSync(join(h.remoteRoot, "versions"))).toEqual([pointer.slice(9)]);
      // One writing step, which carries the archive itself.
      expect(h.calls()).toEqual([
        "no build-box sh -s",
        "no build-box sh -s",
        "yes build-box sh -s",
        expect.stringMatching(
          new RegExp(
            `^yes build-box sh -c .* claudexor-install .* '${V}' '${h.sha}' '-' '-' '-' '[0-9a-f]{32}'$`,
          ),
        ),
        "yes build-box sh -s",
      ]);
      // The installed runtime answers its own probe, separately from the wizard.
      const probe = JSON.parse(
        execFileSync(
          join(h.remoteRoot, "current", "bin", "claudexor"),
          ["remote", "probe", "--json"],
          {
            env: { ...process.env, HOME: h.remoteHome },
            encoding: "utf8",
          },
        ),
      );
      expect(probe).toMatchObject({
        ok: true,
        version: VERSION,
        buildSha: BUILD_SHA,
        protocolMajor: 3,
      });

      const again = await preflightRemoteHost("build-box", h.deps);
      expect(again).toMatchObject({ state: "installed", digest: null, install: null });
      expect(again.runtime).toEqual(installed.runtime);
      const repeat = await codeOf(installRemoteHost("build-box", pre.digest!, h.deps));
      expect(repeat).toMatchObject({
        code: "preflight_changed",
        context: { state: "installed", activated: false },
      });
      expect(h.calls().filter((call) => call.includes(INSTALL_CALL))).toHaveLength(1);
    });

    it("changes nothing for a digest the preflight did not show", async () => {
      const h = harness();
      await preflightRemoteHost("build-box", h.deps);
      const refused = await codeOf(installRemoteHost("build-box", "0".repeat(64), h.deps));
      expect(refused).toMatchObject({
        code: "preflight_changed",
        context: { state: "empty", activated: false },
      });
      expect(refused.context).not.toHaveProperty("digest");
      expect(h.calls()).toEqual(["no build-box sh -s", "no build-box sh -s"]);
      expect(existsSync(join(h.remoteHome, ".claudexor"))).toBe(false);
    });

    it("never offers a manifest the pinned key did not sign, nor uploads bytes it did not sign", async () => {
      const production = harness({ productionKey: true });
      const pre = await preflightRemoteHost("build-box", production.deps);
      expect(pre).toMatchObject({
        state: "blocked",
        digest: null,
        problem: { code: "release_unverified" },
      });

      const swapped = harness({ bytes: Buffer.from("not the signed runtime") });
      const offer = await preflightRemoteHost("build-box", swapped.deps);
      const refused = await codeOf(installRemoteHost("build-box", offer.digest!, swapped.deps));
      expect(refused).toMatchObject({ code: "release_unverified", context: { activated: false } });
      expect(swapped.calls().some((call) => call.includes(INSTALL_CALL))).toBe(false);
      expect(existsSync(join(swapped.remoteHome, ".claudexor"))).toBe(false);
    });

    it("writes only to the server whose host keys the person confirmed", async () => {
      const replaced = harness();
      const pre = await preflightRemoteHost("build-box", replaced.deps);
      replaced.write(HOST_KEY_B);
      const changed = await codeOf(installRemoteHost("build-box", pre.digest!, replaced.deps));
      expect(changed).toMatchObject({ code: "preflight_changed" });
      expect(replaced.calls().filter((call) => call.startsWith("yes "))).toEqual([]);
      expect(existsSync(join(replaced.remoteHome, ".claudexor"))).toBe(false);

      // The name reaches another server from the install's pinned read on:
      // ssh refuses it, and nothing is uploaded or installed anywhere.
      const moved = harness({ moveBeforePinned: HOST_KEY_B });
      const offer = await preflightRemoteHost("build-box", moved.deps);
      const unproven = await codeOf(installRemoteHost("build-box", offer.digest!, moved.deps));
      expect(unproven).toMatchObject({ code: "host_identity_unconfirmed", retryable: false });
      expect(moved.calls()).toEqual([
        "no build-box sh -s",
        "no build-box sh -s",
        "yes build-box sh -s",
      ]);
      expect(existsSync(join(moved.remoteHome, ".claudexor"))).toBe(false);
    });

    it("reports an activated runtime without the signed identity and leaves it in place", async () => {
      // A signed archive whose own runtime.json names another build.
      const h = harness({ runtimeBuild: "cd".repeat(20) });
      const pre = await preflightRemoteHost("build-box", h.deps);
      const failed = await codeOf(installRemoteHost("build-box", pre.digest!, h.deps));
      expect(failed).toMatchObject({
        code: "install_failed",
        context: { step: "verify", activated: true, observed: { buildSha: "cd".repeat(20) } },
      });
      const pointer = (failed.context as { pointer: string }).pointer;
      expect(readlinkSync(join(h.remoteRoot, "current"))).toBe(pointer);
      expect(existsSync(join(h.remoteHome, "daemon-started"))).toBe(false);
    });

    it("settles an answer lost after the transaction's own output closed by reading its pointer, with its lock and archive released", async () => {
      // The transaction's reader is gone before it prints its receipt.
      const h = harness({ lose: { match: INSTALL_CALL, closed: true } });
      const pre = await preflightRemoteHost("build-box", h.deps);
      const installed = await installRemoteHost("build-box", pre.digest!, h.deps);
      expect(readlinkSync(join(h.remoteRoot, "current"))).toBe(installed.runtime.pointer);
      expect(h.calls().filter((call) => call.includes(INSTALL_CALL))).toHaveLength(1);
      // The read that showed this pointer is the one the identity check uses.
      expect(h.calls().slice(-2)).toEqual([
        expect.stringContaining(INSTALL_CALL),
        "yes build-box sh -s",
      ]);
      released(h);
    });

    it("reports a connection lost for good as unknown, names the pointer, and never retries", async () => {
      const h = harness({ lose: { match: INSTALL_CALL, down: true } });
      const pre = await preflightRemoteHost("build-box", h.deps);
      const lost = await codeOf(installRemoteHost("build-box", pre.digest!, h.deps));
      expect(lost).toMatchObject({
        code: "install_outcome_unknown",
        context: { step: "install", pointer: expect.stringMatching(/^versions\//) },
      });
      // A lost answer is no refusal: nothing here says "not activated".
      expect(lost.context).not.toHaveProperty("activated");
      expect(h.calls().filter((call) => call.includes(INSTALL_CALL))).toHaveLength(1);
      expect(h.calls().some((call) => call.includes("bootstrap"))).toBe(false);
      // Once ssh answers again, the pointer alone shows that this install finished.
      rmSync(join(h.bin, "network-down"));
      const after = await preflightRemoteHost("build-box", h.deps);
      expect(after.state).toBe("installed");
      expect(after.runtime?.pointer).toBe((lost.context as { pointer: string }).pointer);
    });

    it("reports the transaction's own refusal as nothing activated and only offers a fresh preflight", async () => {
      const refused = harness();
      mkdirSync(refused.remoteRoot, { recursive: true });
      writeFileSync(join(refused.remoteRoot, "incoming"), "");
      const offer = await preflightRemoteHost("build-box", refused.deps);
      expect(offer.state).toBe("empty");
      const failed = await codeOf(installRemoteHost("build-box", offer.digest!, refused.deps));
      expect(failed).toMatchObject({
        code: "install_failed",
        retryable: false,
        context: { step: "install", activated: false, reason: "failed" },
        requiredActions: [expect.stringContaining("remote preflight")],
      });
      expect(refused.calls().filter((call) => call.includes(INSTALL_CALL))).toHaveLength(1);
      expect(existsSync(join(refused.remoteRoot, "current"))).toBe(false);
      expect(existsSync(join(refused.remoteRoot, ".install-lock"))).toBe(false);
    });

    it.skipIf(process.getuid?.() === 0)(
      "reports a lock it could not create as a failure, never as another install",
      async () => {
        const readOnly = 'chmod 555 "$HOME/.claudexor/remote"';
        const h = harness({ before: { match: INSTALL_CALL, run: readOnly } });
        for (const dir of ["incoming", ".staging", "versions"]) {
          mkdirSync(join(h.remoteRoot, dir), { recursive: true });
        }
        const pre = await preflightRemoteHost("build-box", h.deps);
        const failed = await codeOf(installRemoteHost("build-box", pre.digest!, h.deps)).finally(
          () => chmodSync(h.remoteRoot, 0o700),
        );
        expect(failed).toMatchObject({
          code: "install_failed",
          context: { step: "install", activated: false, reason: "failed", exitCode: 73 },
        });
        expect((failed.context as { stderr: string }).stderr).toContain(
          "could not create the install lock",
        );
        expect(existsSync(join(h.remoteRoot, "current"))).toBe(false);
        released(h);
      },
    );

    it("keeps a missing ssh client's own failure, and for an install says nothing was activated", async () => {
      const dir = mkdtempSync(join(tmpdir(), "claudexor-no-ssh-"));
      roots.push(dir);
      // An absolute path with no program: refused before any launch.
      const depsFor = (destination: string) => ({
        transport: systemSshTransport(destination, join(dir, "ssh")),
      });
      const install = await codeOf(
        remoteCommand(
          parseArgs(["remote", "install", "build-box", "--digest", "0".repeat(64), "--json"]),
          true,
          depsFor,
        ),
      );
      expect(install).toMatchObject({ code: "ssh_unavailable", context: { activated: false } });
      const preflight = await codeOf(
        remoteCommand(parseArgs(["remote", "preflight", "build-box", "--json"]), true, depsFor),
      );
      expect(preflight).toMatchObject({ code: "ssh_unavailable" });
      expect(preflight.context ?? {}).not.toHaveProperty("activated");
    });

    it("binds preflight and install to the transport's own destination", async () => {
      const h = harness();
      const pre = await preflightRemoteHost("build-box", h.deps);
      for (const call of [
        preflightRemoteHost("other-box", h.deps),
        installRemoteHost("other-box", pre.digest!, h.deps),
      ]) {
        expect(await codeOf(call)).toMatchObject({ code: "invalid_argument" });
      }
      expect(h.calls()).toEqual(["no build-box sh -s"]);
    });

    it("names a refused SSH login and every blocked host state", async () => {
      const refused = harness({ refuse: true });
      expect(await codeOf(preflightRemoteHost("build-box", refused.deps))).toMatchObject({
        code: "ssh_unavailable",
      });

      const locked = harness();
      mkdirSync(join(locked.remoteRoot, ".install-lock"), { recursive: true });
      expect((await preflightRemoteHost("build-box", locked.deps)).problem?.code).toBe(
        "install_in_progress",
      );

      const occupied = harness();
      mkdirSync(occupied.remoteRoot, { recursive: true });
      writeFileSync(join(occupied.remoteRoot, "current"), "");
      expect((await preflightRemoteHost("build-box", occupied.deps)).problem?.code).toBe(
        "runtime_unrecognized",
      );

      const foreign = harness();
      mkdirSync(foreign.remoteRoot, { recursive: true });
      symlinkSync(foreign.root, join(foreign.remoteRoot, "current"));
      expect((await preflightRemoteHost("build-box", foreign.deps)).problem?.code).toBe(
        "runtime_unrecognized",
      );

      const keyless = harness({ hostKeys: [] });
      expect(await preflightRemoteHost("build-box", keyless.deps)).toMatchObject({
        state: "blocked",
        digest: null,
        problem: { code: "host_key_unavailable" },
      });
      expect(keyless.fetches).toEqual([]);

      const older = harness();
      const offer = await preflightRemoteHost("build-box", older.deps);
      await installRemoteHost("build-box", offer.digest!, older.deps);
      const installedDir = join(older.remoteRoot, readlinkSync(join(older.remoteRoot, "current")));
      writeFileSync(join(installedDir, "runtime.json"), runtimeJson({ protocolMajor: 2 }));
      expect(await preflightRemoteHost("build-box", older.deps)).toMatchObject({
        state: "blocked",
        runtime: null,
        problem: { code: "runtime_incompatible" },
      });

      const fakeBin = mkdtempSync(join(tmpdir(), "claudexor-uname-"));
      roots.push(fakeBin);
      writeFileSync(
        join(fakeBin, "uname"),
        '#!/bin/sh\ncase "$1" in -m) echo s390x;; -n) echo mainframe;; *) echo Linux;; esac\n',
        { mode: 0o755 },
      );
      const exotic = harness({ path: fakeBin });
      expect(await preflightRemoteHost("build-box", exotic.deps)).toMatchObject({
        state: "blocked",
        server: { hostname: "mainframe", target: null },
        problem: { code: "unsupported_platform" },
      });
      expect(exotic.fetches).toEqual([]);
    });

    it("serves the installed state through the real CLI handler and refuses bad arguments", async () => {
      const h = harness();
      const pre = await preflightRemoteHost("build-box", h.deps);
      await installRemoteHost("build-box", pre.digest!, h.deps);
      const out: string[] = [];
      const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
      });
      // The handler gets the test's own transport and fetch; it has no default
      // to fall back to, so no system ssh can be reached from here.
      const reached: string[] = [];
      const depsFor = (destination: string) => {
        reached.push(destination);
        if (destination !== "build-box") throw new Error(`unexpected ${destination}`);
        return h.deps;
      };
      const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
      try {
        expect(
          await remoteCommand(
            parseArgs(["remote", "preflight", "build-box", "--json"]),
            true,
            depsFor,
          ),
        ).toBe(0);
        expect(JSON.parse(out.join(""))).toMatchObject({
          state: "installed",
          runtime: { version: VERSION },
        });
        out.length = 0;
        expect(
          await remoteCommand(
            parseArgs(["remote", "install", "build-box", "--json"]),
            true,
            depsFor,
          ),
        ).toBe(2);
        expect(
          await remoteCommand(parseArgs(["remote", "preflight", "a b", "--json"]), true, depsFor),
        ).toBe(2);
        expect(
          await remoteCommand(
            parseArgs(["remote", "probe", "--digest", "0".repeat(64), "--json"]),
            true,
            depsFor,
          ),
        ).toBe(2);
        expect(out.map((chunk) => JSON.parse(chunk).code)).toEqual([
          "invalid_argument",
          "invalid_argument",
          "invalid_argument",
        ]);
      } finally {
        write.mockRestore();
      }
      expect(reached).toEqual(["build-box"]);
      // The operation's signal listeners exist only while it runs.
      expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(signals);
      expect(h.calls().filter((call) => call.endsWith("sh -s"))).toHaveLength(5);
    });
  },
);

describe.skipIf(process.platform === "win32" || !LOCAL_TARGET)(
  "an install beside an honest competing client",
  () => {
    it("leaves another client's upload alone and does not need it", async () => {
      const h = harness();
      const pre = await preflightRemoteHost("build-box", h.deps);
      const theirs = join(h.remoteRoot, "incoming", `${h.sha}.tar.gz`);
      mkdirSync(join(h.remoteRoot, "incoming"), { recursive: true });
      writeFileSync(theirs, "another client's upload in progress");
      const installed = await installRemoteHost("build-box", pre.digest!, h.deps);
      expect(installed.outcome).toBe("installed");
      expect(readFileSync(theirs, "utf8")).toBe("another client's upload in progress");
    });

    it("does not take another install's held lock for success, nor remove it", async () => {
      const lock = 'mkdir -p "$HOME/.claudexor/remote/.install-lock"';
      const h = harness({ before: { match: INSTALL_CALL, run: lock } });
      const pre = await preflightRemoteHost("build-box", h.deps);
      const busy = await codeOf(installRemoteHost("build-box", pre.digest!, h.deps));
      expect(busy).toMatchObject({
        code: "install_in_progress",
        context: { step: "install", activated: false, reason: "locked", exitCode: 75 },
      });
      expect(existsSync(join(h.remoteRoot, ".install-lock"))).toBe(true);
      expect(existsSync(join(h.remoteRoot, "current"))).toBe(false);
      // The archive this install received in its step went with it.
      expect(readdirSync(join(h.remoteRoot, "incoming"))).toEqual([]);
    });

    it("never claims a runtime the app activated first, even of the same release", async () => {
      // Just before this install's transaction, the app installs the same
      // signed archive with its own protocol: a digest-named upload and the
      // shared script with five arguments.
      const appInstall = [
        'archive="$HOME/../runtime.tar.gz"',
        `sha=$( (shasum -a 256 "$archive" 2>/dev/null || sha256sum "$archive") | awk '{print $1}')`,
        'mkdir -p "$HOME/.claudexor/remote/incoming"',
        'cp "$archive" "$HOME/.claudexor/remote/incoming/$sha.tar.gz"',
        `sh "$HOME/../app-install.sh" ${q(VERSION)} "$sha" - - -`,
      ].join(" && ");
      const racing = harness({ before: { match: INSTALL_CALL, run: appInstall } });
      writeFileSync(join(racing.root, "app-install.sh"), INSTALL_SCRIPT);
      const pre = await preflightRemoteHost("build-box", racing.deps);
      const refused = await codeOf(installRemoteHost("build-box", pre.digest!, racing.deps));
      expect(refused).toMatchObject({
        code: "preflight_changed",
        context: { step: "install", activated: false, reason: "changed", exitCode: 75 },
      });
      expect(readlinkSync(join(racing.remoteRoot, "current"))).toBe(
        `versions/${VERSION}-${racing.sha}`,
      );
      expect(readdirSync(join(racing.remoteRoot, "versions"))).toEqual([
        `${VERSION}-${racing.sha}`,
      ]);
      expect((await preflightRemoteHost("build-box", racing.deps)).runtime?.pointer).toBe(
        `versions/${VERSION}-${racing.sha}`,
      );
    });
  },
);
