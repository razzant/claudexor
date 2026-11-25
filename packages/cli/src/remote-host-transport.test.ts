import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANCELLED,
  PINNED_HOST_ALIAS,
  SSH_OPTIONS,
  pinnedSshOptions,
  sshDestinationProblem,
  systemSshTransport,
  transportLost,
} from "./remote-host-transport.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A stand-in `ssh`: drops the options, records its pid and runs the remote
 * command with a local sh in a temporary directory. Every transport below is
 * built through `local`, which fails before any launch unless the transport
 * runs exactly this stub. */
function fakeSsh(): { dir: string; program: string } {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-ssh-transport-"));
  roots.push(dir);
  const program = join(dir, "ssh");
  writeFileSync(
    program,
    [
      "#!/bin/sh",
      'while test "$#" -gt 0 && test "$1" != "--"; do shift; done',
      `echo $$ > ${JSON.stringify(join(dir, "ssh.pid"))}`,
      `cd ${JSON.stringify(dir)}`,
      'exec /bin/sh -c "$3"',
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  return { dir, program };
}

function local(program: string) {
  const transport = systemSshTransport("build-box", program);
  expect(transport.program).toBe(program);
  return transport;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("system ssh transport", () => {
  it("streams either its text or a local file to the remote stdin whole", async () => {
    const { dir, program } = fakeSsh();
    const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
    const file = join(dir, "archive.bin");
    const archive = randomBytes(6 * 1024 * 1024 + 17);
    writeFileSync(file, archive);
    const fromFile = await local(program).run("cat > archive.received", {
      file,
      timeoutMs: 60_000,
    });
    expect(transportLost(fromFile)).toBe(false);
    expect(fromFile.status).toBe(0);
    expect(sha(readFileSync(join(dir, "archive.received")))).toBe(sha(archive));
    const text = "the read-only check's text\nits last line\n";
    const fromText = await local(program).run("cat > text.received", {
      bytes: text,
      timeoutMs: 60_000,
    });
    expect(transportLost(fromText)).toBe(false);
    expect(fromText.status).toBe(0);
    expect(readFileSync(join(dir, "text.received"))).toEqual(Buffer.from(text));
  });

  it("refuses a call that names both text and a file before ssh starts", async () => {
    const { dir, program } = fakeSsh();
    const file = join(dir, "archive.bin");
    writeFileSync(file, "archive bytes");
    await expect(
      local(program).run("cat > mixed.received", { bytes: "text", file, timeoutMs: 60_000 }),
    ).rejects.toThrow(/never both/);
    expect(existsSync(join(dir, "ssh.pid"))).toBe(false);
    expect(existsSync(join(dir, "mixed.received"))).toBe(false);
  });

  it("stops ssh and its process group at the timeout and reports the call as lost", async () => {
    const { dir, program } = fakeSsh();
    const started = Date.now();
    const result = await local(program).run("sleep 30 & echo $! > child.pid; wait", {
      timeoutMs: 500,
    });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.localFailure).toMatch(/did not finish within/);
    expect(transportLost(result)).toBe(true);
    const sshPid = Number(readFileSync(join(dir, "ssh.pid"), "utf8"));
    const childPid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
    expect(alive(sshPid)).toBe(false);
    expect(alive(childPid)).toBe(false);
  });

  it("stops ssh when the local file cannot be read, never reporting a clean end", async () => {
    const { dir, program } = fakeSsh();
    const result = await local(program).run("cat > received.bin", {
      file: join(dir, "missing.bin"),
      timeoutMs: 60_000,
    });
    expect(result.localFailure).toMatch(/could not read the local file/);
    expect(transportLost(result)).toBe(true);
  });

  it("refuses a missing program before any launch, without searching for another ssh", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-ssh-missing-"));
    roots.push(dir);
    expect(() => systemSshTransport("build-box", join(dir, "no-ssh"))).toThrow(
      expect.objectContaining({ code: "ssh_unavailable" }),
    );
  });

  it("starts nothing for an operation already cancelled", async () => {
    const { dir, program } = fakeSsh();
    const result = await local(program).run("true", { signal: AbortSignal.abort() });
    expect(result.localFailure).toBe(CANCELLED);
    expect(transportLost(result)).toBe(true);
    expect(existsSync(join(dir, "ssh.pid"))).toBe(false);
  });

  it("refuses a destination ssh would read as an option", () => {
    expect(() => systemSshTransport("-oProxyCommand=x")).toThrow(/must not start with '-'/);
  });

  it("gives a pinned call only the confirmed host keys, and removes them on close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-ssh-pinned-"));
    roots.push(dir);
    const program = join(dir, "ssh");
    // Records its options, then copies the known-hosts file ssh would check.
    writeFileSync(
      program,
      [
        "#!/bin/sh",
        `: > ${JSON.stringify(join(dir, "argv"))}`,
        'while test "$#" -gt 0 && test "$1" != "--"; do',
        `  printf '%s\\n' "$1" >> ${JSON.stringify(join(dir, "argv"))}`,
        '  case "$1" in UserKnownHostsFile=*) cp "${1#UserKnownHostsFile=}" ' +
          `${JSON.stringify(join(dir, "known"))};; esac`,
        "  shift",
        "done",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
    const keys = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA==", "ssh-rsa AAAAB3NzaC1yc2E="];
    const pinned = local(program).pinned(keys);
    const result = await pinned.run("true", { timeoutMs: 60_000 });
    expect(result.status).toBe(0);
    const argv = readFileSync(join(dir, "argv"), "utf8").trim().split("\n");
    expect(argv).toEqual(expect.arrayContaining(["BatchMode=yes", "StrictHostKeyChecking=yes"]));
    expect(argv).toContain(`HostKeyAlias=${PINNED_HOST_ALIAS}`);
    expect(argv).toContain("GlobalKnownHostsFile=/dev/null");
    const file = argv.find((arg) => arg.startsWith("UserKnownHostsFile="))!.slice(19);
    expect(readFileSync(join(dir, "known"), "utf8")).toBe(
      keys.map((key) => `${PINNED_HOST_ALIAS} ${key}\n`).join(""),
    );
    pinned.close();
    expect(existsSync(file)).toBe(false);
    expect(() => local(program).pinned([])).toThrow();
    expect(() => local(program).pinned(["ssh-ed25519 not base64!"])).toThrow();
  });
});

describe("ssh options", () => {
  it("authenticate every call from known-hosts files only, with no shared or lasting session", () => {
    const pairs = SSH_OPTIONS.slice(1).filter((_, index) => index % 2 === 1);
    expect(pairs).toEqual(
      expect.arrayContaining([
        "StrictHostKeyChecking=yes",
        "NoHostAuthenticationForLocalhost=no",
        "UpdateHostKeys=no",
        "CheckHostIP=no",
        "VerifyHostKeyDNS=no",
        "KnownHostsCommand=none",
        "ControlMaster=no",
        "ControlPath=none",
      ]),
    );
  });

  it("bind the host key check to one file under a fixed alias", () => {
    expect(pinnedSshOptions("/tmp/pin/known_hosts")).toEqual([
      "-o",
      `HostKeyAlias=${PINNED_HOST_ALIAS}`,
      "-o",
      "UserKnownHostsFile=/tmp/pin/known_hosts",
      "-o",
      "GlobalKnownHostsFile=/dev/null",
    ]);
  });

  it("quote a path with spaces and refuse one ssh would expand", () => {
    expect(pinnedSshOptions("/tmp/my pin/known_hosts")).toContain(
      'UserKnownHostsFile="/tmp/my pin/known_hosts"',
    );
    expect(() => pinnedSshOptions("/tmp/%u/known_hosts")).toThrow(/cannot be given to ssh/);
  });
});

describe("SSH destination", () => {
  it("accepts aliases, user@host and ssh:// URIs with a port, IPv4 and IPv6", () => {
    for (const ok of [
      "build-box",
      "Prod-DB.example.com",
      "my_host.lan",
      "builder@192.0.2.10",
      "first.last@build-box",
      "builder@::1",
      "fe80::1%eth0",
      "developer@fe80::1%eth0",
      "ssh://build-box",
      "ssh://builder@host.example:2222",
      "ssh://remote@127.0.0.1:43022",
      "ssh://builder@[::1]:2222",
      "ssh://[2001:db8::1]",
    ]) {
      expect({ ok, problem: sshDestinationProblem(ok) }).toEqual({ ok, problem: null });
    }
  });

  it("refuses options, patterns, separators and forms ssh would read otherwise", () => {
    for (const bad of [
      "",
      "-oNoSuchOption=yes",
      "!box",
      "box*",
      "box?",
      "a b",
      "a\nb",
      "box;name",
      "box|name",
      "box,name",
      "box%name",
      "ssh://[fe80::1%eth0]",
      "ssh://developer@[fe80::1%25eth0]:22",
      "user$name@box",
      ".box",
      "-user@box",
      "user@",
      "@box",
      "a@b@box",
      "box:2222",
      "[::1]",
      "ssh://box:0",
      "ssh://box:65536",
      "ssh://box/path",
      "ssh://user;option@box",
      "ssh://[box]",
      "ssh://::1",
      "x".repeat(256),
    ]) {
      expect({ bad, refused: typeof sshDestinationProblem(bad) }).toEqual({
        bad,
        refused: "string",
      });
    }
  });
});
